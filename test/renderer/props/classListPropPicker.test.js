// Goal: in a component, the class field's purple dot and a `class:list`
// attribute's both offer "New Class list property" beside the rows they
// always had; Create declares `class` read as `className` and rewrites the
// element to `class:list`, as one undo step that puts the file back byte for
// byte; a component tag offers the row disabled, with the reason.
//
// Method: the real class field (PropField) and Attributes section, bundled as
// the app bundles them and rendered in jsdom with React, over a component read
// by main's real page parser in the windowless harness. The test presses the
// dot, reads the menu's lead rows, creates the prop through the form, then
// does what the app does with the two edits (appHistory.ts holdForNextEdit):
// the held frontmatter gesture and the element's rewrite are sequenced into
// one gesture and sent through sendGesture to main. The file is checked as
// text, then the step's inverses are sent as undo sends them.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { installPopupDOM } = require('../../helpers/popupDom.js');

const directory = repoPath('node_modules/.stacki-test/class-list-prop-picker');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'class-list-prop-picker.cjs');
buildSync({
  stdin: {
    contents: [
      "export { default as PropField } from './src/features/props/PropField';",
      "export { AttributesSection } from './src/features/props/propAttributes';",
      "export { classListOfferOf } from './src/features/props/classListProp';",
      "export { newPropGesture } from './src/app/model/newPropGesture';",
      "export { nodeGesture, sequence } from './src/editor/editGestures';",
      "export { sendGesture } from './src/editor/pageEdits';",
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
}
const { title = "Hello" } = Astro.props;
---
<div id="card" class="card hero" data-tone="warm">
  <h2 class:list={["card_title", title && "is-set"]}>{title}</h2>
</div>
<style>
  .card { color: red; }
</style>
`;

async function project(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-class-list-prop-'));
  fs.mkdirSync(path.join(root, 'src/components'), { recursive: true });
  fs.mkdirSync(path.join(root, 'user'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  const { mainHarness } = await import('../../helpers/mainHarness.ts');
  const harness = mainHarness(path.join(root, 'user'));
  context.after(() => {
    harness.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = path.join(root, 'src/components/Card.astro');
  fs.writeFileSync(file, COMPONENT);
  const read = parsePageDiskRead(await harness.invoke('page:read', file));
  assert.ok(read.editable);
  return { harness, file, read };
}

const elementNamed = (nodes, name) => {
  const pending = [...nodes];
  for (let visited = 0; pending.length > 0 && visited < 1000; visited++) {
    const node = pending.shift();
    if (node.kind === 'element' && node.name === name) {
      return node;
    }
    pending.push(...(node.children ?? []));
  }
  return undefined;
};
const click = (element) => act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
const byText = (text) => [...document.querySelectorAll('button')].find((element) => element.textContent.trim() === text);
const leadRows = () => [...document.querySelectorAll('.bind-menu .dp-lead .dp-new-prop')].map((row) => row.textContent.trim());

// The host the app gives a component's picker, holding the declaration as appPageOps.ts does.
function hostOf(model, holder) {
  return {
    componentName: 'Card.astro',
    propKeys: ['title'],
    restLocal: undefined,
    create: (declaration) => {
      const made = modules.newPropGesture(model, declaration);
      if (!made.ok) {
        return made;
      }
      holder.held = made.value.gesture;
      return { ok: true, value: made.value.local };
    },
  };
}

// Sends the held declaration and the element's rewrite as one gesture, then undoes it.
async function sendAndUndo({ harness, file, read }, node, held, props) {
  const rewrite = modules.nodeGesture(node.id, modules.withAttributes(node, props), { coalesceKey: undefined, urgency: true });
  const record = { outcome: { tag: 'pending', waiting: 1, applied: [] } };
  const send = async (request) => parsePageEditResult(await harness.invoke('page:edit', request));
  const outcome = await modules.sendGesture({
    path: file,
    origin: { checksum: read.checksum, source: read.source, model: read.model },
    gesture: modules.sequence(held, rewrite),
    record,
    send,
  });
  assert.equal(outcome.tag, 'applied');
  const written = fs.readFileSync(file, 'utf8');
  for (const step of [...record.outcome.applied].reverse()) {
    if (step.inverse.length > 0) {
      const answer = await send({ pagePath: file, authoredChecksum: step.checksum, edit: { tag: 'revert', hunks: step.inverse } });
      assert.ok(answer.ok, 'main reverted the write');
    }
  }
  return written;
}

test('the class field offers a class list prop, and Create rewrites the element in one undo step', async (context) => {
  const files = await project(context);
  installDom();
  const model = files.read.model;
  const holder = { held: undefined };
  const host = hostOf(model, holder);
  const card = elementNamed(model.nodes, 'div');
  const replaced = [];
  const container = document.getElementById('root');
  const root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(modules.PropField, {
        field: { name: 'class', type: 'string' },
        value: card.props.class,
        bindContext: { frontmatter: model.extraFrontmatter, origin: { file: 'src/components/Card.astro', page: undefined }, newProp: host },
        classList: modules.classListOfferOf(card, host, (props) => replaced.push(props)),
        onChange() {},
      }),
    ),
  );
  await click(container.querySelector('.bind-handle'));
  assert.deepEqual(leadRows().slice(0, 2), ['New Plain Text property', 'New Class list property'], 'the class list row sits under the Plain Text one');

  await click(byText('New Class list property'));
  assert.equal(document.querySelector('.new-prop-form input[aria-label="Name"]').value, 'class', 'named as an instance passes it');
  await click(byText('Create'));
  assert.equal(replaced.length, 1, 'the element is written once');
  assert.deepEqual(Object.keys(replaced[0]), ['id', 'class:list', 'data-tone'], 'the list takes the class’s place');

  const written = await sendAndUndo(files, card, holder.held, replaced[0]);
  assert.equal(
    written,
    COMPONENT.replace('  title?: string;\n', '  title?: string;\n  class?: string;\n')
      .replace('const { title = "Hello" }', 'const { title = "Hello", class: className }')
      .replace('class="card hero"', 'class:list={["card", "hero", className]}'),
    'the prop is declared and the element reads it; nothing else moved',
  );
  assert.equal(fs.readFileSync(files.file, 'utf8'), COMPONENT, 'one undo takes back the declaration and the rewrite');
  await act(async () => root.unmount());
});

test('a class:list attribute offers the row too, and the prop joins its list', async (context) => {
  const files = await project(context);
  installDom();
  const model = files.read.model;
  const holder = { held: undefined };
  const host = hostOf(model, holder);
  const heading = elementNamed(model.nodes, 'h2');
  const replaced = [];
  const container = document.getElementById('root');
  const root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(modules.AttributesSection, {
        node: heading,
        names: ['class:list'],
        bindContext: { frontmatter: model.extraFrontmatter, newProp: host },
        tag: 'h2',
        onSetProp() {},
        onRenameProp() {},
        onReplaceAttributes: (props) => replaced.push(props),
      }),
    ),
  );
  assert.ok(container.querySelector('.attr-row .conditional-badge, .attr-row .attr-value'), 'the row is drawn');
  await click(container.querySelector('.attr-row'));
  await click(document.querySelector('.attr-editor .attr-value-field .bind-handle'));
  assert.ok(leadRows().includes('New Class list property'), 'the list’s own dot offers the row');
  await click(byText('New Class list property'));
  await click(byText('Create'));
  assert.equal(replaced.length, 1);
  const written = await sendAndUndo(files, heading, holder.held, replaced[0]);
  assert.ok(written.includes('<h2 class:list={["card_title", title && "is-set", className]}>{title}</h2>'), 'appended, the rest of the list as written');
  assert.ok(written.includes('<div id="card" class="card hero" data-tone="warm">'), 'the other element is untouched');
  assert.equal(fs.readFileSync(files.file, 'utf8'), COMPONENT, 'one undo restores the bytes');
  await act(async () => root.unmount());
});

test('a component tag offers the row disabled, saying why', async (context) => {
  const files = await project(context);
  installDom();
  const host = hostOf(files.read.model, { held: undefined });
  const container = document.getElementById('root');
  const root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(modules.PropField, {
        field: { name: 'class', type: 'string' },
        value: { type: 'string', value: 'featured' },
        bindContext: { frontmatter: files.read.model.extraFrontmatter, newProp: host },
        classList: modules.classListOfferOf({ kind: 'component', name: 'Button', props: { class: { type: 'string', value: 'featured' } } }, host, () => {}),
        onChange() {},
      }),
    ),
  );
  await click(container.querySelector('.bind-handle'));
  const row = byText('New Class list property');
  assert.ok(row.disabled, 'nothing can be made');
  assert.equal(
    document.querySelector('.bind-menu .dp-new-prop-reason').textContent,
    'Only an HTML element can take a class list property: a component reads its class its own way.',
  );
  await act(async () => root.unmount());
});
