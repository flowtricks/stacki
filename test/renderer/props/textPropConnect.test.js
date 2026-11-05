// Goal: a plain text node in a component — `Text` between a <slot /> and a
// <span> — connects to a component prop from the Settings Text panel the way
// every other field does: the purple dot offers the component's string props
// and a new one; pressed from outside the field it replaces the whole text with
// `{prop}`, pressed while the caret is in the field it puts `{prop}` at the
// caret or over the selection. The connected text shows its chip and a set
// label, and disconnecting writes the words back. On a page the dot offers no
// props, and an expression there stays code.
//
// Method: the real TextPanel, bundled as the app bundles it, rendered in jsdom
// with React over a component read by main's real page parser in the
// windowless harness. Each case presses the dot (pointerdown, mousedown, click
// — the order a browser sends them, so focus is read before it could move),
// picks a row or makes a prop through the form, and does what the app does
// with the edits: the held frontmatter gesture and the text's gesture
// (textPiecesGesture) are sequenced into one and sent through sendGesture to
// main. The file is then compared as text, so the bytes beside the text — the
// slot, the span — are proven untouched.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { installPopupDOM } = require('../../helpers/popupDom.js');

const directory = repoPath('node_modules/.stacki-test/text-prop-connect');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'text-prop-connect.cjs');
buildSync({
  stdin: {
    contents: [
      "export { default as PropsPanel } from './src/features/props/PropsPanel';",
      "export { CodeAccess } from './src/ui/CodeAccess';",
      "export { newPropGesture } from './src/app/model/newPropGesture';",
      "export { textPiecesGesture } from './src/app/model/textPieces';",
      "export { sequence } from './src/editor/editGestures';",
      "export { sendGesture } from './src/editor/pageEdits';",
      "export { connectedPieces, connectedPath, disconnectedText } from './src/features/props/textConnect';",
      "export { textWithChip } from './src/features/props/fieldFocus';",
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
  shown?: boolean;
}
const { title = "Hello", shown = true } = Astro.props;
---
<a class="button"><slot />Text<span class="icon">→</span></a>
`;

async function project(context, source = COMPONENT) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-text-prop-'));
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
  fs.writeFileSync(file, source);
  return { harness, file };
}

const anchorOf = (nodes) => nodes.find((node) => node.kind === 'element' && node.name === 'a');
const event = (element, Type, name) => act(async () => element.dispatchEvent(new Type(name, { bubbles: true, cancelable: true })));
const click = (element) => event(element, dom.window.MouseEvent, 'click');
// The dot as a browser presses it: focus is read on pointerdown, before anything moves it.
async function pressDot() {
  const dot = document.querySelector('.props-field .bind-handle');
  assert.ok(dot, 'the Content field has the purple dot');
  await event(dot, dom.window.PointerEvent ?? dom.window.MouseEvent, 'pointerdown');
  await event(dot, dom.window.MouseEvent, 'mousedown');
  await click(dot);
}
const type = (input, value) =>
  act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
const byText = (text) =>
  [...document.querySelectorAll('button')].find((element) => element.textContent.trim() === text) ??
  [...document.querySelectorAll('div, span')].find((element) => element.textContent.trim() === text);
const rowNamed = (name) => [...document.querySelectorAll('.bind-menu .dp-row')].find((row) => row.querySelector('.dp-key')?.textContent === name);

// One edit session over the file: the panel for a node, and the app's way of writing what it asks for.
async function session(harness, file, component) {
  const read = parsePageDiskRead(await harness.invoke('page:read', file));
  assert.ok(read.editable);
  installDom();
  const model = read.model;
  let held;
  let sent;
  const host = {
    componentName: 'Button.astro',
    propKeys: ['title', 'shown'],
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
  const context = {
    frontmatter: model.extraFrontmatter,
    // A page has no props of its own to list: the app gives it no schema (App.tsx, schemaFor).
    ...(component
      ? {
          propsSchema: [
            { name: 'title', type: 'string' },
            { name: 'shown', type: 'boolean' },
          ],
        }
      : {}),
    collections: [{ name: 'posts', count: 3 }],
    origin: { file: 'src/components/Button.astro', page: undefined },
    ...(component ? { newProp: host } : {}),
  };
  const container = document.getElementById('root');
  const root = createRoot(container);
  const render = (node) =>
    act(async () =>
      root.render(
        React.createElement(
          modules.CodeAccess.Provider,
          { value: true },
          React.createElement(modules.PropsPanel, {
            node,
            bindContext: context,
            onSetProp() {},
            onRenameProp() {},
            onSetText() {},
            onSetContent() {},
            onSetInline() {},
            onSetTextPieces: (pieces) => {
              const text = modules.textPiecesGesture(model, node.id, pieces);
              assert.ok(text, 'the text node is found');
              sent = held === undefined ? text : modules.sequence(held, text);
              held = undefined;
            },
          }),
        ),
      ),
    );
  const write = async () => {
    assert.ok(sent, 'the panel asked for an edit');
    const record = { outcome: { tag: 'pending', waiting: 1, applied: [] } };
    const send = async (request) => parsePageEditResult(await harness.invoke('page:edit', request));
    const outcome = await modules.sendGesture({ path: file, origin: { checksum: read.checksum, source: read.source, model }, gesture: sent, record, send });
    assert.equal(outcome.tag, 'applied', JSON.stringify(outcome));
    return fs.readFileSync(file, 'utf8');
  };
  const textNode = anchorOf(model.nodes).children.find((child) => child.kind === 'text');
  assert.equal(textNode.value, 'Text');
  return { model, render, write, textNode, unmount: () => act(async () => root.unmount()) };
}

test('pressed from outside the field: a picked prop replaces the whole text, and nothing beside it moves', async (context) => {
  const { harness, file } = await project(context);
  const edit = await session(harness, file, true);
  await edit.render(edit.textNode);
  assert.equal(document.querySelector('.panel-header h2').textContent, 'Text');
  await pressDot();
  const rows = [...document.querySelectorAll('.bind-menu .dp-row .dp-key')].map((row) => row.textContent);
  assert.ok(rows.includes('title'), 'the component’s string prop is offered');
  assert.ok(!rows.includes('shown'), 'a switch does not fit words');
  assert.ok(document.querySelector('.bind-menu .dp-new-prop'), 'a new prop can be made for the text');
  await click(rowNamed('title'));
  assert.equal(await edit.write(), COMPONENT.replace('<slot />Text<span', '<slot />{title}<span'));
  await edit.unmount();
});

test('a new prop: declared as a string with the text as its default, connected, then disconnected back to the words', async (context) => {
  const { harness, file } = await project(context);
  const edit = await session(harness, file, true);
  await edit.render(edit.textNode);
  await pressDot();
  await click(byText('New Text property'));
  assert.equal(document.querySelector('.new-prop-form textarea[aria-label="Default"]').value, 'Text', 'the default is the current text');
  await type(document.querySelector('.new-prop-form input[aria-label="Name"]'), 'label');
  await click(byText('Create'));
  const connected = COMPONENT.replace('  shown?: boolean;\n', '  shown?: boolean;\n  label?: string;\n')
    .replace('shown = true }', 'shown = true, label = "Text" }')
    .replace('<slot />Text<span', '<slot />{label}<span');
  assert.equal(await edit.write(), connected, 'the prop is declared and the text reads it; nothing else moved');
  await edit.unmount();

  // The connected text, opened again: its chip, a set label, and the way back.
  const read = parsePageDiskRead(await harness.invoke('page:read', file));
  const expression = anchorOf(read.model.nodes).children.find((child) => child.kind === 'expr');
  assert.equal(expression.value, '{label}');
  const container = document.getElementById('root');
  const root = createRoot(container);
  let pieces;
  const context2 = {
    frontmatter: read.model.extraFrontmatter,
    newProp: { componentName: 'Button.astro', propKeys: ['title', 'shown', 'label'], restLocal: undefined, create: () => ({ ok: false, error: 'unused' }) },
  };
  await act(async () =>
    root.render(
      React.createElement(
        modules.CodeAccess.Provider,
        { value: true },
        React.createElement(modules.PropsPanel, {
          node: expression,
          bindContext: context2,
          onSetProp() {},
          onRenameProp() {},
          onSetText() {},
          onSetContent() {},
          onSetInline() {},
          onSetTextPieces: (next) => {
            pieces = next;
          },
        }),
      ),
    ),
  );
  assert.equal(document.querySelector('.panel-header h2').textContent, 'Text', 'a connected text keeps the Text panel');
  assert.equal(document.querySelector('.text-connection .expr-chip').textContent, 'label', 'the connection shows as its chip');
  const label = document.querySelector('.props-field .prop-label');
  assert.ok(label.classList.contains('set'), 'the label reads as set');
  await click(label);
  await click(document.querySelector('.prop-menu .prop-menu-item'));
  assert.deepEqual(pieces, [{ kind: 'text', value: 'Text' }], 'disconnecting writes the default back as words');
  const record = { outcome: { tag: 'pending', waiting: 1, applied: [] } };
  const send = async (request) => parsePageEditResult(await harness.invoke('page:edit', request));
  const gesture = modules.textPiecesGesture(read.model, expression.id, pieces);
  const outcome = await modules.sendGesture({ path: file, origin: { checksum: read.checksum, source: read.source, model: read.model }, gesture, record, send });
  assert.equal(outcome.tag, 'applied');
  assert.equal(fs.readFileSync(file, 'utf8'), connected.replace('<slot />{label}<span', '<slot />Text<span'), 'the words are back; the prop stays declared');
  await act(async () => root.unmount());
});

test('pressed while typing: the chip lands at the caret, or over the selection', async (context) => {
  for (const [range, expected] of [
    [[2, 2], 'Te{title}xt'],
    [[1, 3], 'T{title}t'],
  ]) {
    const { harness, file } = await project(context);
    const edit = await session(harness, file, true);
    await edit.render(edit.textNode);
    const field = document.querySelector('.props-field textarea');
    field.focus();
    field.setSelectionRange(range[0], range[1]);
    assert.equal(document.activeElement, field);
    await pressDot();
    await click(rowNamed('title'));
    assert.equal(await edit.write(), COMPONENT.replace('<slot />Text<span', `<slot />${expected}<span`), `caret ${range.join('–')}`);
    await edit.unmount();
  }
});

test('on a page: the dot offers no props, and an expression stays code', async (context) => {
  const { harness, file } = await project(context);
  const edit = await session(harness, file, false);
  await edit.render(edit.textNode);
  await pressDot();
  assert.equal(document.querySelector('.bind-menu .dp-new-prop') ?? undefined, undefined, 'no new property on a page');
  // The rows the file's own Astro.props destructure gives are data a page may read; what a
  // page lacks is a component to give a new prop to, as every other field's picker shows.
  assert.ok([...document.querySelectorAll('.bind-menu .dp-section')].some((heading) => heading.textContent === 'Content Collections'));
  await edit.render({ id: edit.textNode.id, kind: 'expr', value: '{title}' });
  assert.equal(document.querySelector('.panel-header h2').textContent, 'Expression', 'without a component, `{title}` is code');
  await edit.unmount();
});

test('the pieces: whole, at the caret, over a selection; a connection’s path and the words it goes back to', () => {
  installDom();
  const unfocused = { kind: 'unfocused' };
  const at = (start, end) => ({ kind: 'focused', textRange: { start, end } });
  assert.deepEqual(modules.connectedPieces('Some text', unfocused, 'label'), [{ kind: 'expr', value: '{label}' }]);
  assert.deepEqual(modules.connectedPieces('Some text', at(5, 5), 'label'), [
    { kind: 'text', value: 'Some ' },
    { kind: 'expr', value: '{label}' },
    { kind: 'text', value: 'text' },
  ]);
  assert.deepEqual(modules.connectedPieces('Some text', at(0, 9), 'label'), [{ kind: 'expr', value: '{label}' }], 'a selection of everything is the whole');
  assert.deepEqual(modules.connectedPieces('Some text', { kind: 'focused', textRange: undefined }, 'label'), [
    { kind: 'text', value: 'Some text' },
    { kind: 'expr', value: '{label}' },
  ]);
  assert.deepEqual(modules.textWithChip('abc', at(5, 9), 'x'), { before: 'abc', after: '' }, 'a range past the end is clamped');
  assert.throws(() => modules.connectedPieces('Text', unfocused, 'a b'), /Assertion failed: connectedPieces: a picked chip is a path/);
  assert.equal(modules.connectedPath('{label}'), 'label');
  assert.equal(modules.connectedPath('{ post.data.title }'), 'post.data.title');
  assert.equal(modules.connectedPath('{a ? b : c}'), undefined, 'code is not a connection');
  assert.equal(modules.connectedPath('{fn()}'), undefined);
  const frontmatter = 'const { label = "Buy \\"now\\"", other = \'It\\\'s\', count = 2, broken = "\\x" } = Astro.props;';
  assert.equal(modules.disconnectedText('label', frontmatter), 'Buy "now"');
  assert.equal(modules.disconnectedText('other', frontmatter), "It's");
  assert.equal(modules.disconnectedText('count', frontmatter), 'count', 'a default that is not words gives the name');
  assert.equal(modules.disconnectedText('broken', frontmatter), 'broken', 'a malformed literal gives the name');
  assert.equal(modules.disconnectedText('missing', frontmatter), 'missing');
});
