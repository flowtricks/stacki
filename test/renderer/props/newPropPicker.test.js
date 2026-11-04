// Goal: in a component, the bind dot's menu lists the component's props that
// fit the field above the CMS data it always listed, and "New … property"
// declares a prop and binds the field to it as one undo step; on a page the
// menu is the data it always was.
//
// Method: the real Attributes section, bundled as the app bundles it, rendered
// in jsdom with React, over a component read by main's real page parser in
// the windowless harness. The test opens an attribute's value editor, presses
// its purple dot, and reads the menu: the props heading with the text props
// (and the number prop, which prints as words, but not the switch), and the
// collections heading. It creates a prop through the form, then does what the
// app does with the two edits (appHistory.ts holdForNextEdit): the held
// frontmatter gesture and the attribute edit are sequenced into one gesture
// and sent through sendGesture to main. The file is checked as text, then the
// step's inverses are sent as undo sends them and the file must be back byte
// for byte. The page case renders the same section with no component host.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { installPopupDOM } = require('../../helpers/popupDom.js');

const directory = repoPath('node_modules/.stacki-test/new-prop-picker');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'new-prop-picker.cjs');
buildSync({
  stdin: {
    contents: [
      "export { AttributesSection } from './src/features/props/propAttributes';",
      "export { newPropGesture } from './src/app/model/newPropGesture';",
      "export { nodeGesture, propsGesture, sequence } from './src/editor/editGestures';",
      "export { sendGesture } from './src/editor/pageEdits';",
      "export { readRestBinding } from './src/editor/propDeclaration';",
      "export { withAttributes } from './src/editor/attributesBinding';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

// The DOM is installed after main's harness has read the file: the Astro
// compiler main loads takes a global `document` as a browser and fails.
let dom;
let React;
let act;
let createRoot;
let modules;
function installDom() {
  if (dom !== undefined) {
    return;
  }
  dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  for (const name of ['Node', 'Element', 'HTMLElement', 'MutationObserver', 'DOMRect', 'Window', 'KeyboardEvent', 'MouseEvent', 'PointerEvent']) {
    global[name] = dom.window[name];
  }
  global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.ResizeObserver = dom.window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  installPopupDOM(dom.window);
  React = require('react');
  ({ createRoot } = require('react-dom/client'));
  ({ act } = React);
  modules = require(output);
}
const { parsePageDiskRead, parsePageEditResult } = require('#dist/shared/ipc/pageSave.js');

const COMPONENT = `---
interface Props {
  title?: string;
  count?: number;
  shown?: boolean;
}
const { title = "Hello", count = 2, shown = true } = Astro.props;
---
<a class="button" data-label="Click me">{title}</a>
<style>
  .button { color: red; }
</style>
`;

async function project(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-new-prop-'));
  fs.mkdirSync(path.join(root, 'src/components'), { recursive: true });
  fs.mkdirSync(path.join(root, 'user'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  const { mainHarness } = await import('../../helpers/mainHarness.ts');
  const harness = mainHarness(path.join(root, 'user'));
  context.after(() => {
    harness.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = path.join(root, 'src/components/Button.astro');
  fs.writeFileSync(file, COMPONENT);
  return { harness, file };
}

const anchorOf = (nodes) => nodes.find((node) => node.kind === 'element' && node.name === 'a');
const click = (element) => act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
const type = (input, value) =>
  act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
// Buttons first: a box holding only a button reads as the button's words too.
const byText = (text) =>
  [...document.querySelectorAll('button')].find((element) => element.textContent.trim() === text) ??
  [...document.querySelectorAll('div, span')].find((element) => element.textContent.trim() === text);

// The section for the anchor, with a bind context as App.tsx builds one.
async function renderSection(model, host, onSetProp) {
  const anchor = anchorOf(model.nodes);
  const context = {
    frontmatter: model.extraFrontmatter,
    propsSchema: [
      { name: 'title', type: 'string' },
      { name: 'count', type: 'number' },
      { name: 'shown', type: 'boolean' },
    ],
    collections: [{ name: 'posts', count: 3 }],
    origin: { file: 'src/components/Button.astro', page: undefined },
    ...(host === undefined ? {} : { newProp: host }),
  };
  const container = document.getElementById('root');
  const root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(modules.AttributesSection, {
        node: anchor,
        names: ['data-label'],
        bindContext: context,
        tag: 'a',
        onSetProp,
        onRenameProp() {},
      }),
    ),
  );
  await click(container.querySelector('.attr-row'));
  await click(document.querySelector('.attr-value-field .bind-handle'));
  return root;
}

test('in a component: fitting props, CMS data, and a new prop bound in one undo step', async (context) => {
  const { harness, file } = await project(context);
  const read = parsePageDiskRead(await harness.invoke('page:read', file));
  installDom();
  assert.ok(read.editable);
  const model = read.model;
  let held;
  let sent;
  const host = {
    componentName: 'Button.astro',
    propKeys: ['title', 'count', 'shown'],
    restLocal: undefined,
    create: (declaration) => {
      const made = modules.newPropGesture(model, declaration);
      if (!made.ok) {
        return made;
      }
      held = made.value.gesture;
      return { ok: true, value: made.value.local };
    },
  };
  const anchor = anchorOf(model.nodes);
  const writes = [];
  const root = await renderSection(model, host, (name, value) => {
    writes.push({ name, value });
    const field = modules.propsGesture(anchor.id, { [name]: value }, { coalesceKey: undefined, urgency: true });
    sent = held === undefined ? field : modules.sequence(held, field);
    held = undefined;
  });

  const menu = document.querySelector('.bind-menu');
  assert.ok(menu, 'the purple dot opens the menu');
  const rows = [...menu.querySelectorAll('.dp-row .dp-key')].map((row) => row.textContent);
  assert.ok(rows.includes('title'), 'a text prop is listed');
  assert.ok(rows.includes('count'), 'a number prop prints as words, so it is listed');
  assert.ok(!rows.includes('shown'), 'a switch does not fit a text field');
  const headings = [...menu.querySelectorAll('.dp-section')].map((heading) => heading.textContent);
  assert.deepEqual(headings, ['Button.astro props', 'Content Collections'], 'props first, then the CMS data');
  assert.ok(menu.querySelector('.dp-kind-icon'), 'each prop row leads with its type icon');

  await click(byText('New Plain Text property'));
  const name = document.querySelector('.new-prop-form input[aria-label="Name"]');
  assert.equal(name.value, 'dataLabel', 'named from the attribute');
  assert.equal(document.querySelector('.new-prop-form textarea[aria-label="Default"]').value, 'Click me', 'the default is the current value');
  await type(name, 'title');
  assert.equal(document.querySelector('.new-prop-form .loop-bind-problem').textContent, 'This component already has a title property.');
  assert.ok(byText('Create').disabled);
  await type(name, 'label');
  await type(document.querySelector('.new-prop-form textarea[aria-label="Tooltip"]'), 'The link’s label');
  await click(byText('Create'));

  assert.deepEqual(writes, [{ name: 'data-label', value: { type: 'expr', value: 'label' } }], 'the field is bound to the new prop');
  assert.ok(sent, 'one gesture carries both edits');
  const record = { outcome: { tag: 'pending', waiting: 1, applied: [] } };
  const send = async (request) => parsePageEditResult(await harness.invoke('page:edit', request));
  const origin = { checksum: read.checksum, source: read.source, model };
  const outcome = await modules.sendGesture({ path: file, origin, gesture: sent, record, send });
  assert.equal(outcome.tag, 'applied');
  const written = fs.readFileSync(file, 'utf8');
  assert.equal(
    written,
    COMPONENT.replace('  shown?: boolean;\n', '  shown?: boolean;\n  /** The link’s label */\n  label?: string;\n')
      .replace('shown = true }', 'shown = true, label = "Click me" }')
      .replace('data-label="Click me"', 'data-label={label}'),
    'the prop is declared and the attribute reads it; nothing else moved',
  );

  for (const step of [...record.outcome.applied].reverse()) {
    if (step.inverse.length > 0) {
      const answer = await send({ pagePath: file, authoredChecksum: step.checksum, edit: { tag: 'revert', hunks: step.inverse } });
      assert.ok(answer.ok, 'main reverted the write');
    }
  }
  assert.equal(fs.readFileSync(file, 'utf8'), COMPONENT, 'one undo takes back the declaration and the binding');
  await act(async () => root.unmount());
});

test('on a page: the CMS data as before, and no new property', async (context) => {
  const { harness, file } = await project(context);
  const read = parsePageDiskRead(await harness.invoke('page:read', file));
  installDom();
  const root = await renderSection(read.model, undefined, () => {});
  const menu = document.querySelector('.bind-menu');
  assert.ok(menu);
  assert.equal(menu.querySelector('.dp-new-prop') ?? undefined, undefined, 'no new property on a page');
  const rows = [...menu.querySelectorAll('.dp-row .dp-key')].map((row) => row.textContent);
  assert.ok(rows.includes('shown'), 'nothing is narrowed away on a page');
  assert.ok([...menu.querySelectorAll('.dp-section')].some((heading) => heading.textContent === 'Content Collections'));
  await act(async () => root.unmount());
});

test('an attributes prop: the header dot makes it, the element spreads it after its defaults, and the chip shows it', async (context) => {
  const { harness, file } = await project(context);
  const read = parsePageDiskRead(await harness.invoke('page:read', file));
  installDom();
  const model = read.model;
  let held;
  const host = {
    componentName: 'Button.astro',
    propKeys: ['title', 'count', 'shown'],
    restLocal: undefined,
    create: (declaration) => {
      const made = modules.newPropGesture(model, declaration);
      if (!made.ok) {
        return made;
      }
      held = made.value;
      return { ok: true, value: made.value.local };
    },
  };
  const anchor = anchorOf(model.nodes);
  const replaced = [];
  const container = document.getElementById('root');
  const root = createRoot(container);
  const draw = (node, restLocal) =>
    act(async () =>
      root.render(
        React.createElement(modules.AttributesSection, {
          node,
          names: Object.keys(node.props ?? {}).filter((name) => name !== 'class'),
          bindContext: { frontmatter: model.extraFrontmatter, newProp: { ...host, restLocal } },
          tag: 'a',
          onSetProp() {},
          onRenameProp() {},
          onReplaceProps: (props) => replaced.push(props),
        }),
      ),
    );
  await draw(anchor, undefined);
  await click(container.querySelector('.props-label-row .bind-handle'));
  await click(byText('New Attributes property'));
  assert.equal(document.querySelector('.new-prop-form input[aria-label="Name"]').value, 'rest', 'named as Astro names it');
  await click(byText('Add attribute'));
  await type(document.querySelector('.new-prop-form input[aria-label="Attribute name"]'), 'data-testing');
  await type(document.querySelector('.new-prop-form input[aria-label="Attribute value"]'), '1');
  await click(byText('Create'));

  assert.equal(held.local, 'rest');
  const frontmatter = held.gesture.apply(model);
  assert.match(frontmatter.extraFrontmatter, /^interface Props extends HTMLAttributes<"a"> \{/);
  assert.match(frontmatter.extraFrontmatter, /const \{ title = "Hello", count = 2, shown = true, \.\.\.rest \} = Astro\.props;/);
  assert.equal(
    frontmatter.imports.filter((entry) => entry.name === 'HTMLAttributes' && entry.path === 'astro/types' && entry.typeOnly).length,
    1,
    'the type is imported once',
  );
  assert.equal(replaced.length, 1);
  assert.deepEqual(Object.keys(replaced[0]), ['data-testing', '...rest', 'class', 'data-label'], 'defaults before the spread, the element’s own after');

  // Written as the app writes it: the held declaration and the node rewrite, one gesture.
  const rewrite = modules.nodeGesture(anchor.id, modules.withAttributes(anchor, replaced[0]), { coalesceKey: undefined, urgency: true });
  const record = { outcome: { tag: 'pending', waiting: 1, applied: [] } };
  const send = async (request) => parsePageEditResult(await harness.invoke('page:edit', request));
  const outcome = await modules.sendGesture({
    path: file,
    origin: { checksum: read.checksum, source: read.source, model },
    gesture: modules.sequence(held.gesture, rewrite),
    record,
    send,
  });
  assert.equal(outcome.tag, 'applied');
  const written = fs.readFileSync(file, 'utf8');
  // The printer spells a type-only named import inline; TypeScript reads both spellings alike.
  assert.match(written, /import (type \{ HTMLAttributes \}|\{ type HTMLAttributes \}) from "astro\/types";/);
  assert.match(written, /<a data-testing="1" \{\.\.\.rest\} class="button" data-label="Click me">\{title\}<\/a>/);
  assert.ok(written.includes('<style>\n  .button { color: red; }\n</style>'), 'the CSS is untouched');
  const reread = parsePageDiskRead(await harness.invoke('page:read', file));
  assert.equal(modules.readRestBinding(reread.model.extraFrontmatter).local, 'rest', 'the rest binding parses back');
  assert.deepEqual(
    Object.keys(anchorOf(reread.model.nodes).props),
    ['data-testing', '...rest', 'class', 'data-label'],
    'and so does the order around the spread',
  );

  // Drawn connected: the chip in the dot's place, its own rows, the note.
  await draw({ ...anchor, props: replaced[0] }, 'rest');
  assert.equal(container.querySelector('.attrs-bound-chip').textContent.trim(), 'rest');
  const rows = [...container.querySelectorAll('.attr-row .attr-name')].map((row) => row.textContent);
  assert.deepEqual(rows, ['data-label'], 'the spread and its defaults are the prop’s, not rows');
  assert.ok(container.querySelector('.attrs-bound-note'), 'the line says where an instance’s attributes go');
  await click(container.querySelector('.attrs-bound-chip'));
  await click(byText('Disconnect'));
  assert.deepEqual(replaced[1], { class: anchor.props.class, 'data-label': anchor.props['data-label'] }, 'disconnecting leaves the element’s own attributes');
  await act(async () => root.unmount());
});

test('an attribute name the tag does not take gets a muted note under the Name field', async (context) => {
  const { harness, file } = await project(context);
  const read = parsePageDiskRead(await harness.invoke('page:read', file));
  installDom();
  const anchor = anchorOf(read.model.nodes);
  const container = document.getElementById('root');
  const root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(modules.AttributesSection, { node: anchor, names: ['data-label'], bindContext: {}, tag: 'a', onSetProp() {}, onRenameProp() {} }),
    ),
  );
  await click(container.querySelector('.props-label-row button[title="Add attribute"]'));
  const input = document.querySelector('.attr-editor-row input');
  await type(input, 'required');
  assert.equal(document.querySelector('.attr-name-note').textContent, 'required isn’t an attribute of <a>.');
  await type(input, 'set:html');
  assert.equal(document.querySelector('.attr-name-note').textContent, 'This is a reserved name.');
  await type(input, 'href');
  assert.equal(document.querySelector('.attr-name-note') ?? undefined, undefined, 'a valid name has no note');
  await act(async () => root.unmount());
});

test('a component with no frontmatter gets one holding the new prop', async (context) => {
  const { harness, file } = await project(context);
  const bare = '<a href="#" class="button"\n  ><slot></slot><span>→</span></a\n>\n';
  fs.writeFileSync(file, bare);
  const read = parsePageDiskRead(await harness.invoke('page:read', file));
  installDom();
  const model = read.model;
  const declaration = {
    key: 'href',
    tooltip: 'Where the button goes',
    kind: 'string',
    defaultText: '#',
    options: [],
    number: { min: undefined, max: undefined, decimals: undefined },
    switch: { onLabel: 'On', offLabel: 'Off' },
    attributes: [],
    tag: '',
  };
  const made = modules.newPropGesture(model, declaration);
  assert.ok(made.ok);
  const anchor = anchorOf(model.nodes);
  const bind = modules.propsGesture(anchor.id, { href: { type: 'expr', value: made.value.local } }, { coalesceKey: undefined, urgency: true });
  const record = { outcome: { tag: 'pending', waiting: 1, applied: [] } };
  const send = async (request) => parsePageEditResult(await harness.invoke('page:edit', request));
  const outcome = await modules.sendGesture({
    path: file,
    origin: { checksum: read.checksum, source: read.source, model },
    gesture: modules.sequence(made.value.gesture, bind),
    record,
    send,
  });
  assert.equal(outcome.tag, 'applied');
  const written = fs.readFileSync(file, 'utf8');
  assert.match(written, /^---\ninterface Props \{\n {2}\/\*\* Where the button goes \*\/\n {2}href\?: string;\n\}\nconst \{ href = "#" \} = Astro\.props;\n/);
  assert.ok(written.includes('<a href={href} class="button"\n  ><slot></slot><span>→</span></a\n>'), 'the markup keeps its own line breaks');
});
