// Goal: one harness that runs the prop zoo (test/fixtures/propZoo) through the
// code paths the app uses for component props, so propZoo.test.js can state
// what each prop should do and record where Stacki falls short.
//
// Method, stage by stage, all on a temporary copy of the fixture:
//   scan      main's real `project:scan` handler (windowless main harness):
//             the schema, slots, rest and extended tag the palette and the
//             instance Settings panel read.
//   panel     the Properties panel's model, `readComponentProperties`, from
//             the built main modules, plus a no-op save of every property
//             through `editPropertyDefinition` (it must leave the file alone).
//   readers   the renderer's frontmatter readers: the props destructure
//             (loopProps.ts), the list-setting props (listProps.ts) and each
//             prop's JSDoc settings (propDocumentation.ts).
//   settings  the real PropsPanel, mounted in jsdom for each instance on the
//             index page with the schema the app gives it (schemaFor). The
//             control module is wrapped so every control that renders tags
//             itself with its kind and hands over its change handler.
//   edit      for each control, the value that control writes, sent through
//             its own change handler, captured from onSetProp and written by
//             main's real `page:edit`; the page is read back and the
//             instance's attribute compared with what was sent.
// Every stage catches its own exceptions and records them verbatim, so one
// crash shows up as a finding instead of hiding the rest.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('./sources.js');

const FIXTURE = repoPath('test/fixtures/propZoo');
const CONTROLS_SOURCE = repoPath('src/features/props/PropControls.tsx');
const LIST_FIELD_SOURCE = repoPath('src/features/props/ListPropField.tsx');
const ZOO_LIMITS = { componentsMax: 200, editsMax: 1000, copyEntriesMax: 500 };
// Every control PropControls.tsx exports, read from its source so a control
// added there is wrapped (and reported) without touching this harness.
const controlNames = () => [...fs.readFileSync(CONTROLS_SOURCE, 'utf8').matchAll(/^export function (\w+Control)\(/gm)].map((match) => match[1]);

/** The fixture's component names, read synchronously so tests can be declared up front. */
function zooComponentNames() {
  const names = fs
    .readdirSync(path.join(FIXTURE, 'src/components'))
    .filter((file) => file.endsWith('.astro'))
    .map((file) => file.slice(0, -'.astro'.length))
    .sort();
  if (names.length > ZOO_LIMITS.componentsMax) {
    throw new Error('propZoo: too many components');
  }
  return names;
}

// Copies the fixture without recursion: a queue of directories, bounded.
function copyFixture(target) {
  const pending = [''];
  for (let visited = 0; visited < pending.length; visited++) {
    if (visited >= ZOO_LIMITS.copyEntriesMax) {
      throw new Error('propZoo: fixture copy exceeds its bound');
    }
    const relative = pending[visited];
    fs.mkdirSync(path.join(target, relative), { recursive: true });
    for (const entry of fs.readdirSync(path.join(FIXTURE, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        pending.push(child);
      } else {
        fs.copyFileSync(path.join(FIXTURE, child), path.join(target, child));
      }
    }
  }
}

// PropControls.tsx, with every control wrapped: the wrapper renders the real
// control inside a tagged div and records the control's state, so the test
// knows which control a prop got and can call that control's own onChange.
function wrappedControlsSource() {
  const real = JSON.stringify(`${CONTROLS_SOURCE}?zoo-real`);
  const lines = [
    "import React from 'react';",
    `import * as Real from ${real};`,
    'export * from ' + real + ';',
    'const record = (name, state) => { const zoo = globalThis.__zoo; if (zoo) { zoo.controls.set(state.field.name, { control: name, state }); } };',
    "const wrap = (name, state, element) => React.createElement('div', { 'data-zoo-control': name, 'data-zoo-prop': state.field.name }, element);",
  ];
  for (const name of controlNames()) {
    if (name === 'AttributeControl') {
      // Called as a function by PropField: undefined means "fall through".
      lines.push(
        `export function ${name}(props) { const out = Real.${name}(props); if (out === undefined) { return undefined; } record('${name}', props.state); return wrap('${name}', props.state, out); }`,
      );
    } else {
      lines.push(
        `export function ${name}(props) { record('${name}', props.state); return wrap('${name}', props.state, React.createElement(Real.${name}, props)); }`,
      );
    }
  }
  return lines.join('\n');
}

// ListPropField needs the collection bridge; the zoo only needs to know it was chosen.
const LIST_FIELD_STUB = [
  "import React from 'react';",
  'export function ListPropField(props) {',
  '  const zoo = globalThis.__zoo;',
  "  if (zoo) { zoo.controls.set(props.name, { control: 'ListPropField', state: { onChange: props.onChange, field: { name: props.name } } }); }",
  "  return React.createElement('div', { 'data-zoo-control': 'ListPropField', 'data-zoo-prop': props.name });",
  '}',
].join('\n');

function zooPlugin() {
  return {
    name: 'prop-zoo',
    setup(build) {
      build.onResolve({ filter: /\?zoo-real$/ }, (args) => ({ path: args.path.replace(/\?zoo-real$/, ''), namespace: 'zoo-real' }));
      build.onLoad({ filter: /.*/, namespace: 'zoo-real' }, (args) => ({
        contents: fs.readFileSync(args.path, 'utf8'),
        loader: 'tsx',
        resolveDir: path.dirname(args.path),
      }));
      build.onLoad({ filter: /\.tsx$/ }, (args) => {
        const file = path.resolve(args.path);
        if (file === CONTROLS_SOURCE) {
          return { contents: wrappedControlsSource(), loader: 'jsx', resolveDir: path.dirname(file) };
        }
        if (file === LIST_FIELD_SOURCE) {
          return { contents: LIST_FIELD_STUB, loader: 'jsx', resolveDir: path.dirname(file) };
        }
        return undefined;
      });
    },
  };
}

async function buildRendererBundle() {
  const directory = repoPath('node_modules/.stacki-test/prop-zoo');
  fs.mkdirSync(directory, { recursive: true });
  const outfile = path.join(directory, 'zoo.cjs');
  const exports = [
    ['default as PropsPanel', 'src/features/props/PropsPanel.tsx'],
    ['schemaFor', 'src/app/model/pageGestures.ts'],
    ['listPropsOf', 'src/editor/listProps.ts'],
    ['readPropsDestructure', 'src/editor/loopProps.ts'],
    ['readPropDocumentation', 'src/editor/propDocumentation.ts'],
    ['resolveInstanceProps', 'src/editor/instanceProps.ts'],
  ];
  await esbuild.build({
    stdin: {
      contents: exports.map(([name, file]) => `export { ${name} } from ${JSON.stringify(repoPath(file))};`).join('\n'),
      resolveDir: repoPath('src'),
      loader: 'ts',
    },
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
    logLevel: 'silent',
    plugins: [zooPlugin()],
  });
  return outfile;
}

function installDom() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
  require('./popupDom').installPopupDOM(dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'Window', 'DOMRect']) {
    global[key] = key === 'window' ? dom.window : dom.window[key];
  }
  global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.ResizeObserver = dom.window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // The preload bridge: asset fields subscribe to it. Subscriptions do nothing and
  // every request fails as an unreachable main would, which callers must handle.
  const unavailable = async () => {
    throw new Error('propZoo: no preload bridge');
  };
  const bridge = new Proxy({}, { get: (_target, key) => (String(key).startsWith('on') ? () => () => undefined : unavailable) });
  dom.window.avb = bridge;
  global.avb = bridge;
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
  dom.window.Range.prototype.getClientRects = () => [];
  return dom;
}

const frontmatterOf = (source) => /^\s*---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1] ?? '';
const describe = (error) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

// Every node of a page tree with its structural path, walked without recursion.
function placedNodes(nodes) {
  const out = [];
  const pending = nodes.map((node, index) => ({ node, path: [index] }));
  for (let visited = 0; visited < pending.length; visited++) {
    const entry = pending[visited];
    out.push(entry);
    (entry.node.children ?? []).forEach((child, index) => pending.push({ node: child, path: [...entry.path, index] }));
  }
  return out;
}

const instanceOf = (model, name) => placedNodes(model.nodes).find((entry) => entry.node.kind === 'component' && entry.node.name === name);

/** The value a control of `kind` writes when a designer uses it, for the field it shows. */
function editFor(kind, field, current) {
  switch (kind) {
    case 'TextControl':
    case 'ClassControl':
      return { type: 'string', value: 'Zoo "edit" & <b>' };
    case 'LinkControl':
      return { type: 'string', value: '/zoo-edit' };
    case 'ColorControl':
      return { type: 'string', value: '#00aa55' };
    case 'MediaControl':
      return { type: 'string', value: '/zoo-edit.png' };
    case 'StyleControl':
      return { type: 'string', value: 'color: teal;' };
    case 'NumberControl':
      return { type: 'expr', value: '7' };
    case 'BooleanControl': {
      const now = current === undefined ? field.default === true : current.type === 'bare' || current.value === 'true';
      return { type: 'expr', value: now ? 'false' : 'true' };
    }
    case 'EnumControl': {
      // Something other than what is set, preferring something other than the default too.
      const options = (field.options ?? []).filter((candidate) => candidate !== current?.value);
      const option = options.find((candidate) => candidate !== String(field.default)) ?? options[0];
      return option === undefined ? undefined : { type: field.numeric ? 'expr' : 'string', value: option };
    }
    case 'ListControl':
      return { type: 'expr', value: '["zoo", "edit"]' };
    case 'AttributeControl':
      return { type: 'expr', value: '{ "data-zoo": "1" }' };
    default:
      // Expression, binding, object, imported-asset and list-setting fields take
      // code a designer would not type; the spec supplies one where it matters.
      return undefined;
  }
}

/**
 * Runs every stage over a fresh copy of the fixture. `editsFor(component, prop)`
 * may supply an edit value (an Attr) or `false` to skip; undefined uses editFor.
 */
async function runZoo({ editsFor }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-prop-zoo-'));
  const project = path.join(root, 'site');
  copyFixture(project);
  fs.mkdirSync(path.join(root, 'user'));
  const { mainHarness } = await import('./mainHarness.ts');
  const harness = mainHarness(path.join(root, 'user'));
  const { readComponentProperties, editPropertyDefinition } = require('#dist/electron/properties/propertyDefinitions.js');
  const { parseScanResult } = require('#dist/shared/properties/projectScan.js');
  const { parsePageDiskRead, parsePageEditResult } = require('#dist/shared/ipc/pageSave.js');
  const bundle = await buildRendererBundle();
  const dom = installDom();
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const zoo = require(bundle);
  const pagePath = path.join(project, 'src/pages/index.astro');
  const pageText = fs.readFileSync(pagePath, 'utf8');
  const records = new Map();
  const crashes = [];
  const crash = (where, error) => crashes.push({ where, error: describe(error) });

  try {
    const scan = parseScanResult(await harness.invoke('project:scan', project));
    const readPage = async () => parsePageDiskRead(await harness.invoke('page:read', pagePath));
    const initial = await readPage();
    for (const name of zooComponentNames()) {
      const component = scan.components.find((entry) => entry.name === name);
      const file = path.join(project, 'src/components', `${name}.astro`);
      const source = fs.readFileSync(file, 'utf8');
      const record = {
        name,
        scan: component,
        schema: component?.schema ?? [],
        panel: undefined,
        panelSave: new Map(),
        destructure: undefined,
        listProps: new Map(),
        docs: new Map(),
        controls: new Map(),
        edits: new Map(),
        instance: undefined,
        resolved: undefined,
      };
      records.set(name, record);
      try {
        const properties = readComponentProperties(source);
        record.panel = properties.properties;
        for (const property of properties.properties) {
          try {
            const saved = editPropertyDefinition(source, { kind: 'save', originalName: property.name, property });
            record.panelSave.set(
              property.name,
              saved.ok
                ? saved.value === source
                  ? 'unchanged'
                  : `changed:${firstDifference(source, saved.value)}`
                : `refused: ${saved.error.message ?? saved.error}`,
            );
          } catch (error) {
            record.panelSave.set(property.name, `threw: ${describe(error)}`);
            crash(`${name}.${property.name} panel save`, error);
          }
        }
      } catch (error) {
        crash(`${name} readComponentProperties`, error);
      }
      try {
        record.destructure = zoo.readPropsDestructure(frontmatterOf(source))?.entries.map((entry) => entry.key);
      } catch (error) {
        crash(`${name} readPropsDestructure`, error);
      }
      try {
        record.listProps = zoo.listPropsOf(frontmatterOf(source));
      } catch (error) {
        crash(`${name} listPropsOf`, error);
      }
      for (const field of record.schema) {
        try {
          record.docs.set(field.name, zoo.readPropDocumentation(field.doc));
        } catch (error) {
          crash(`${name}.${field.name} readPropDocumentation`, error);
        }
      }
      const placed = instanceOf(initial.model, name);
      record.instance = placed?.node;
      if (placed) {
        try {
          record.resolved = zoo.resolveInstanceProps(placed.node);
        } catch (error) {
          crash(`${name} resolveInstanceProps`, error);
        }
      }
    }

    const host = document.getElementById('root');
    const reactRoot = createRoot(host);
    const settingsFor = async (record, node) => {
      const sets = [];
      global.__zoo = { controls: new Map() };
      const schema = zoo.schemaFor(record.scan);
      await act(async () => {
        reactRoot.render(
          React.createElement(zoo.PropsPanel, {
            node,
            schema,
            listProps: record.listProps,
            slotOptions: record.scan?.slots ?? [],
            takesSlotText: (record.scan?.slots ?? []).includes('default'),
            tagOptions: [],
            projectClasses: [],
            layouts: [],
            bindContext: {},
            allowAttrs: !!record.scan?.hasRest,
            linkContext: { pages: scan.pages, sectionIds: [], projectPath: project },
            projectPath: project,
            filePath: pagePath,
            frontmatterSource: frontmatterOf(pageText),
            frontmatterImports: initial.model.imports,
            onSetProp: (prop, value, immediate) => sets.push({ prop, value, immediate }),
            onSetProps: (_nodeId, patch) => Object.entries(patch).forEach(([prop, value]) => sets.push({ prop, value, immediate: true })),
            onRenameProp: () => undefined,
            onSetText: () => undefined,
            onSetContent: () => undefined,
            onSetInline: () => undefined,
            onSetComment: () => undefined,
          }),
        );
      });
      // Class and style sit in the collapsed Settings group; open it once (it stays open).
      const closed = host.querySelector('.props-group-head[aria-expanded="false"]');
      if (closed) {
        await act(async () => closed.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
      }
      const shown = new Map(
        [...host.querySelectorAll('[data-zoo-control]')].map((element) => [element.getAttribute('data-zoo-prop'), element.getAttribute('data-zoo-control')]),
      );
      return { schema, shown, states: global.__zoo.controls, sets };
    };

    let edits = 0;
    for (const record of records.values()) {
      if (!record.instance) {
        continue;
      }
      let settings;
      try {
        settings = await settingsFor(record, record.instance);
      } catch (error) {
        crash(`${record.name} settings panel`, error);
        continue;
      }
      record.settingsSchema = settings.schema.map((field) => field.name);
      for (const field of settings.schema) {
        record.controls.set(field.name, settings.shown.get(field.name) ?? 'hidden');
      }
      for (const field of settings.schema) {
        const kind = record.controls.get(field.name);
        const entry = settings.states.get(field.name);
        if (kind === 'hidden' || !entry) {
          continue;
        }
        const override = editsFor(record.name, field.name);
        if (override === false) {
          continue;
        }
        const wanted = override ?? editFor(kind, field, record.instance.props?.[field.name]);
        if (wanted === undefined) {
          record.edits.set(field.name, { status: 'not attempted', control: kind });
          continue;
        }
        if (edits++ >= ZOO_LIMITS.editsMax) {
          throw new Error('propZoo: edit count exceeds its bound');
        }
        record.edits.set(field.name, await editOnce({ record, field, kind, wanted, entry }));
      }
    }

    async function editOnce({ record, field, kind, wanted, entry }) {
      // Rendered again so the captured onChange belongs to a live panel.
      const live = await settingsFor(record, record.instance);
      const state = live.states.get(field.name)?.state ?? entry.state;
      await act(async () => state.onChange(wanted, true));
      const sent = live.sets.filter((set) => set.prop === field.name).at(-1);
      if (!sent) {
        return { status: 'no write', control: kind, wanted };
      }
      try {
        const before = await readPage();
        const placed = instanceOf(before.model, record.name);
        const target = { path: placed.path, kind: placed.node.kind, span: { start: placed.node.start, end: placed.node.end } };
        const edit =
          sent.value === undefined
            ? { tag: 'remove-attribute', target, name: field.name }
            : { tag: 'set-attribute', target, name: field.name, value: sent.value };
        const answer = parsePageEditResult(await harness.invoke('page:edit', { pagePath, authoredChecksum: before.checksum, edit }));
        if (!answer.ok) {
          return { status: 'refused', control: kind, wanted, sent: sent.value, error: String(answer.error?.message ?? answer.error) };
        }
        const after = await readPage();
        const node = instanceOf(after.model, record.name)?.node;
        const text = fs.readFileSync(pagePath, 'utf8');
        const reread = node?.props?.[field.name];
        const others = Object.keys(record.instance.props ?? {}).filter((key) => key !== field.name);
        const othersKept = others.every((key) => JSON.stringify(node?.props?.[key]) === JSON.stringify(record.instance.props[key]));
        let controlAfter = 'unread';
        try {
          controlAfter = (await settingsFor(record, node)).shown.get(field.name) ?? 'hidden';
        } catch (error) {
          crash(`${record.name}.${field.name} settings after edit`, error);
        }
        return {
          status: JSON.stringify(reread) === JSON.stringify(sent.value) && othersKept ? 'ok' : 'mismatch',
          control: kind,
          wanted,
          sent: sent.value,
          reread,
          othersKept,
          controlAfter,
          line: text
            .split('\n')
            .find((line) => line.includes(`<${record.name}`))
            ?.trim(),
        };
      } catch (error) {
        crash(`${record.name}.${field.name} edit`, error);
        return { status: 'threw', control: kind, wanted, error: describe(error) };
      } finally {
        fs.writeFileSync(pagePath, pageText);
      }
    }
    await act(async () => reactRoot.unmount());
  } finally {
    harness.dispose();
    dom.window.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  return { records, crashes };
}

// Where two texts first part, as a short excerpt of the second, for findings.
function firstDifference(before, after) {
  let index = 0;
  while (index < before.length && before[index] === after[index]) {
    index++;
  }
  return JSON.stringify(after.slice(Math.max(0, index - 20), index + 40));
}

module.exports = { runZoo, zooComponentNames, FIXTURE };
