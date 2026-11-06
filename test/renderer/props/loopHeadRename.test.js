// Goal: the Loop panel's Code row and the Source row's code popup refuse what
// would crash the page, say why under the field and keep what was typed, and hand
// a rename to the file-wide rename. The popup opens under the Source row, not the
// row it used to measure, and names the file the frontmatter is in.
//
// Method: the real MapEditor, bundled as the app bundles it, renders in jsdom over
// a host that holds a real page: each commit runs the real check and plan against
// main's real parser, and the page is parsed again from what was written. Boxes
// are stubbed, since jsdom lays nothing out; CodeMirror is driven through its view.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { installPopupDOM } = require('../../helpers/popupDom.js');
const load = require('../../helpers/rendererModule');
const { parsePage } = require('#dist/electron/parse/astroParser.js');

const { checkLoopHead, planVariableRename } = load('src/editor/variableRename.ts');
const { sourceFileLabel } = load('src/features/props/sourceFileLabel.ts');

const directory = repoPath('node_modules/.stacki-test/loop-head-rename');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'loop-head-rename.cjs');
buildSync({
  stdin: {
    contents: ["export { MapEditor } from './src/features/props/propNodeEditors';", "export { EditorView } from '@codemirror/view';"].join('\n'),
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

const SOURCE = `---
import { getCollection } from 'astro:content';
const statsEntries2 = await getCollection('stats');
const other = [];
---
<p>{statsEntries2.length}</p>
{statsEntries2.map((item) => <i>{item.title}</i>)}
`;

let React;
let act;
let createRoot;
let modules;
function installDom() {
  if (modules !== undefined) {
    return;
  }
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  for (const name of ['Node', 'Element', 'HTMLElement', 'MutationObserver', 'DOMRect', 'Window', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent']) {
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
  dom.window.Range.prototype.getClientRects = () => [];
  dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
  installPopupDOM(dom.window);
  React = require('react');
  ({ createRoot } = require('react-dom/client'));
  ({ act } = React);
  modules = require(output);
}

const parsed = (source) => {
  const page = parsePage(source, { locs: true });
  assert.equal(page.editable, true, page.reason);
  return page.model;
};
const loopIn = (model) => model.nodes.find((node) => node.kind === 'map');

// A host that writes what the panel asks through the real check and plan.
async function panel(context, filePath = 'src/components/PricingCard.astro') {
  installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const state = { source: SOURCE, writes: 0, texts: [] };
  context.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const rename = (change) => {
    const plan = planVariableRename({ source: state.source, model: parsed(state.source) }, change);
    if (!plan.ok) {
      return plan.message;
    }
    state.source = plan.text;
    state.writes += 1;
    render();
    return undefined;
  };
  const onCommitHead = (value) => {
    const model = parsed(state.source);
    const loop = loopIn(model);
    const checked = checkLoopHead({ source: state.source, model }, { id: loop.id, before: loop.head, after: value });
    if (checked.kind === 'problem') {
      return checked.message;
    }
    if (checked.kind === 'rename') {
      return rename(checked.rename);
    }
    state.source = state.source.replace(loop.head.slice(0, -1).trimEnd(), value.slice(0, -1).trimEnd());
    state.writes += 1;
    render();
    return undefined;
  };
  const render = () => {
    const model = parsed(state.source);
    root.render(
      React.createElement(modules.MapEditor, {
        node: loopIn(model),
        imports: model.imports,
        onSetText: (text) => state.texts.push(text),
        onCommitHead,
        onSetLoopSource: () => ({ ok: true, unbound: 0, lost: [], restored: false }),
        dataContext: {
          frontmatter: model.extraFrontmatter,
          imports: "import { getCollection } from 'astro:content';",
          filePath,
          onSetFrontmatter: (code) => state.texts.push(code),
          onRenameVariable: rename,
        },
      }),
    );
  };
  await act(async () => render());
  return { host, state };
}

const codeRow = (host) => [...host.querySelectorAll('.loop-settings-row')].find((row) => row.textContent.includes('Code'));
const sourceRow = (host) => [...host.querySelectorAll('.loop-settings-row')].find((row) => row.textContent.includes('Source'));
const editorOf = (row) => row.querySelector('.cm-content');
const textOf = (editor) => modules.EditorView.findFromDOM(editor).state.doc.toString();
const noteOf = (host) => host.querySelector('.prop-field-note.problem')?.textContent;

async function type(editor, text) {
  const view = modules.EditorView.findFromDOM(editor);
  await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }));
}
const leave = (editor) => act(async () => editor.dispatchEvent(new window.FocusEvent('blur')));

async function commit(host, text) {
  const editor = editorOf(codeRow(host));
  await type(editor, text);
  await leave(editor);
}

const box = (element, rect) => {
  element.getBoundingClientRect = () => ({ top: rect.bottom - 30, right: rect.left + rect.width, height: 30, x: rect.left, y: rect.bottom - 30, ...rect });
};

async function openPopup(host) {
  const button = sourceRow(host).querySelector('button[title^="Edit "]');
  assert.ok(button, 'The Source row has the pencil');
  await act(async () => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  const popup = sourceRow(host).querySelector('.var-src') ?? document.querySelector('.var-src');
  assert.ok(popup, 'The popup is open');
  return popup;
}

test('renaming in the Code row reaches the rest of the file and shows no error', async (context) => {
  const { host, state } = await panel(context);
  await commit(host, 'stats.map((item) => (');
  assert.equal(noteOf(host), undefined);
  assert.equal(state.writes, 1);
  assert.equal(state.source, SOURCE.replaceAll('statsEntries2', 'stats'));
  assert.equal(textOf(editorOf(codeRow(host))), 'stats.map((item) => (');
});

test('a collision blocks the write, shows the reason and keeps the text', async (context) => {
  const { host, state } = await panel(context);
  await commit(host, 'other.map((item) => (');
  assert.equal(noteOf(host), '“other” already exists in this file. To loop over it, choose it in the Source menu.');
  assert.equal(host.querySelector('.prop-field-note.problem').getAttribute('role'), 'alert');
  assert.equal(state.writes, 0);
  assert.equal(state.source, SOURCE);
  assert.equal(textOf(editorOf(codeRow(host))), 'other.map((item) => (', 'The text stays to be corrected');
  assert.ok(codeRow(host).querySelector('.expr-input.invalid'), 'The field shows it is refused');
});

test('every refusal lands in the same note, and typing clears it', async (context) => {
  const { host, state } = await panel(context);
  const cases = [
    ['class.map((item) => (', /reserved word/],
    ['2stats.map((item) => (', /isn’t a valid variable name/],
    ['statsEntries2.filter(missing).map((item) => (', /“missing” isn’t declared in this file/],
    ['statsEntries2.map((item => (', /doesn’t parse/],
  ];
  for (const [text, message] of cases) {
    await commit(host, text);
    assert.match(noteOf(host), message, text);
    assert.equal(textOf(editorOf(codeRow(host))), text);
  }
  assert.equal(state.writes, 0);
  await type(editorOf(codeRow(host)), 'statsEntries2.map((item) =');
  assert.equal(noteOf(host), undefined, 'A correction in progress is not nagged about');
});

test('an ordinary edit still writes, through the same commit', async (context) => {
  const { host, state } = await panel(context);
  await commit(host, 'statsEntries2.slice(0, 3).map((item) => (');
  assert.equal(noteOf(host), undefined);
  assert.equal(state.writes, 1);
  assert.match(state.source, /\{statsEntries2\.slice\(0, 3\)\.map\(\(item\) =>/);
});

test('a host with no check keeps writing the head as it did', async (context) => {
  installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  context.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const texts = [];
  const node = { id: 'n0', kind: 'map', head: 'list.map((item) => (', children: [] };
  await act(async () => root.render(React.createElement(modules.MapEditor, { node, onSetText: (text) => texts.push(text) })));
  await commit(host, 'list.map((row) => (');
  assert.deepEqual(texts, ['list.map((row) => (']);
});

test('the pencil opens the popup under the Source row, not under the Code row', async (context) => {
  const { host } = await panel(context);
  box(sourceRow(host), { left: 500, bottom: 120, width: 280 });
  box(codeRow(host), { left: 500, bottom: 400, width: 280 });
  const popup = await openPopup(host);
  assert.equal(popup.style.top, '124px');
  assert.equal(popup.style.left, '500px');
  assert.equal(popup.style.width, '280px');
});

test('the popup stays inside the window near its edges', async (context) => {
  const { host } = await panel(context);
  box(sourceRow(host), { left: window.innerWidth - 100, bottom: window.innerHeight - 10, width: 200 });
  const popup = await openPopup(host);
  const left = Number.parseFloat(popup.style.left);
  const width = Number.parseFloat(popup.style.width);
  assert.ok(left + width <= window.innerWidth - 8, 'Inside the right edge');
  assert.equal(popup.style.top, `${window.innerHeight - 240}px`, 'Clear of the bottom edge');
});

test('the popup names the component its frontmatter is in, with the cube', async (context) => {
  const { host } = await panel(context);
  const popup = await openPopup(host);
  const chip = popup.querySelector('.var-src-file');
  assert.ok(chip.classList.contains('component'));
  assert.equal(chip.textContent, 'PricingCard');
  assert.equal(chip.title, 'In the component PricingCard');
  assert.ok(chip.querySelector('svg'), 'It wears the icon');
});

test('the popup names a page the same way', async (context) => {
  const { host } = await panel(context, '/site/src/pages/about/index.astro');
  const popup = await openPopup(host);
  const chip = popup.querySelector('.var-src-file');
  assert.ok(chip.classList.contains('page'));
  assert.equal(chip.textContent, 'about');
});

test('a file is labelled by where it lives', () => {
  assert.deepEqual(sourceFileLabel('/x/src/components/PricingCard.astro'), { kind: 'component', name: 'PricingCard' });
  assert.deepEqual(sourceFileLabel('/x/src/layouts/Base.astro'), { kind: 'component', name: 'Base' });
  assert.deepEqual(sourceFileLabel('/x/src/pages/index.astro'), { kind: 'page', name: 'index' });
  assert.deepEqual(sourceFileLabel('/x/src/pages/blog/[slug].astro'), { kind: 'page', name: '[slug]' });
  assert.deepEqual(sourceFileLabel('C:\\x\\src\\pages\\blog\\index.astro'), { kind: 'page', name: 'blog' });
  assert.equal(sourceFileLabel(undefined), undefined);
  assert.equal(sourceFileLabel(''), undefined);
});

test('a new name in the popup goes through the same rename', async (context) => {
  const { host, state } = await panel(context);
  const popup = await openPopup(host);
  const editor = editorOf(popup);
  await type(editor, "const stats = await getCollection('stats');");
  await leave(editor);
  assert.equal(state.source, SOURCE.replaceAll('statsEntries2', 'stats'));
  assert.deepEqual(state.texts, [], 'Not written as a change to that line alone');
});

test('the popup refuses a collision and keeps the text', async (context) => {
  const { host, state } = await panel(context);
  const popup = await openPopup(host);
  const editor = editorOf(popup);
  const text = "const other = await getCollection('stats');";
  await type(editor, text);
  await leave(editor);
  assert.match(popup.querySelector('.prop-field-note.problem').textContent, /“other” already exists in this file\./);
  assert.equal(state.source, SOURCE);
  assert.deepEqual(state.texts, []);
  assert.equal(textOf(editor), text);
});

test('the popup will not mix a rename with another change', async (context) => {
  const { host, state } = await panel(context);
  const popup = await openPopup(host);
  const editor = editorOf(popup);
  await type(editor, "const stats = await getCollection('other');");
  await leave(editor);
  assert.match(popup.querySelector('.prop-field-note.problem').textContent, /Rename the variable on its own/);
  assert.equal(state.source, SOURCE);
});

test('an edit that keeps the name is still a change to that line', async (context) => {
  const { host, state } = await panel(context);
  const popup = await openPopup(host);
  const editor = editorOf(popup);
  await type(editor, "const statsEntries2 = await getCollection('other');");
  await leave(editor);
  assert.equal(state.texts.length, 1);
  assert.match(state.texts[0], /getCollection\('other'\)/);
  assert.equal(state.writes, 0);
});
