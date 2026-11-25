// Goal: the style prop's field draws the code editors' CSS chips, and the attribute it writes is the
// CSS as the source spells it: never chip markup, and nothing reformatted around an edit. Its
// highlighter reads a number with any CSS unit as one token (`100svh` was `100s` and `vh`).
//
//   node test/renderer/props/styleFieldChips.test.js
//
// Method: the real StyleEditor, with the real chips installed as the shells install them, renders in
// jsdom over a stub variable list. A chip is checked as drawn, a copy event is replayed across it,
// a reference is swapped through writeChipValue as a pick does, then undone, and a delete beside the
// chip takes it whole. The spelling kept by an edit (rewriteDeclarations) and the tokens of the
// highlighter are checked as pure functions, beside the chips of a conditional branch's `${name}`
// holes. Last, both shells are read to hold that each installs the chips.

const assert = require('node:assert/strict');
const { before, test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath, stubSources } = require('../../helpers/sources.js');
const { installPopupDOM } = require('../../helpers/popupDom.js');

const VARIABLES_STUB = {
  'src/features/style/model/webflow.ts': () => ({
    contents: `
      export async function getProjectFontFamilies() { return []; }
      export async function getImageAssets() { return []; }
      export async function streamProjectVariables(onAdd) {
        onAdd({ name: 'nav-height', collection: 'Sizes', group: '', value: '4rem', binding: 'var(--nav-height)', type: 'Size' });
        return [];
      }
    `,
    loader: 'js',
  }),
};

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
installPopupDOM(dom.window);
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
for (const name of [
  'Node',
  'Element',
  'HTMLElement',
  'Text',
  'Range',
  'MutationObserver',
  'DOMRect',
  'DOMParser',
  'Window',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
]) {
  global[name] = dom.window[name];
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
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = React;

let modules;
before(async () => {
  const output = repoPath('node_modules/.stacki-test/style-field-chips.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await build({
    stdin: {
      contents: `
        export { default as StyleEditor, rewriteDeclarations, declarationTokens } from './src/features/props/StyleEditor';
        export { installCssFieldChips } from './src/ui/cssFieldChips';
        export { useCodeChips } from './src/features/style/codeChips/CodeChips';
        export { setOpenChip, writeChipValue } from './src/features/style/codeChips/codeChipsExtension';
        export { cssValueChips } from './src/features/style/codeChips/cssValueChips';
        export { EditorView } from '@codemirror/view';
        export { undo, deleteCharBackward } from '@codemirror/commands';
      `,
      resolveDir: ROOT,
      loader: 'ts',
    },
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react-dom/server', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
    plugins: [stubSources('stub-variables', VARIABLES_STUB)],
  });
  modules = require(output);
  modules.installCssFieldChips(modules.useCodeChips);
});

const SOURCE = 'min-height:calc(100svh - var(--nav-height))';

async function mount(context, value) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const changes = [];
  const render = (next) => root.render(React.createElement(modules.StyleEditor, { value: next, onChange: (text) => changes.push(text) }));
  await act(async () => render(value));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  context.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return { host, changes, view: modules.EditorView.findFromDOM(host.querySelector('.cm-editor')) };
}

test('a variable in the style field is the purple chip, and drawing and copying keep the CSS', async (context) => {
  const { view, changes } = await mount(context, SOURCE);
  const token = view.contentDOM.querySelector('.embed-editor_varconnect-token');
  assert.ok(token, 'the reference is drawn as the chip');
  assert.equal(token.textContent, 'nav-height');
  const text = view.state.doc.toString();
  assert.equal(text, `${SOURCE};`, 'the document is text, never chip markup');
  view.focus();
  view.dispatch({ selection: { anchor: 0, head: text.length } });
  view.observer.readSelectionRange();
  const copied = new Map();
  const event = new dom.window.Event('copy', { bubbles: true, cancelable: true });
  event.clipboardData = { setData: (type, data) => copied.set(type, data), clearData: () => copied.clear(), getData: () => '' };
  view.contentDOM.dispatchEvent(event);
  assert.equal(copied.get('text/plain'), text, 'the copy is the CSS as written');
  assert.deepEqual(changes, [], 'looking and copying write nothing');
});

test('connecting another variable writes that reference alone, and undo puts the source back', async (context) => {
  const { view, changes } = await mount(context, SOURCE);
  const from = SOURCE.indexOf('var(');
  await act(async () => {
    modules.setOpenChip(view, { from, to: from + 'var(--nav-height)'.length });
    modules.writeChipValue(view, 'var(--gap)');
  });
  assert.equal(changes.at(-1), SOURCE.replace('--nav-height', '--gap'), 'no space, `;` or line break is added to the source');
  await act(async () => modules.undo(view));
  assert.equal(changes.at(-1), SOURCE);
});

test('Backspace after a chip takes the whole reference', async (context) => {
  const { view, changes } = await mount(context, SOURCE);
  const to = SOURCE.indexOf('var(') + 'var(--nav-height)'.length;
  await act(async () => {
    view.dispatch({ selection: { anchor: to } });
    modules.deleteCharBackward(view);
  });
  assert.equal(changes.at(-1), 'min-height:calc(100svh - )');
});

test('an edit keeps the spelling of everything it did not change', () => {
  const rewrite = (source, edit) => {
    const lines = source
      .split(';')
      .map((piece) => piece.trim())
      .filter(Boolean)
      .map((piece) => `${piece};`)
      .join('\n');
    return modules.rewriteDeclarations(source, edit(lines));
  };
  const source = 'color:red;\n  margin : 0 ;gap: 1px';
  assert.equal(
    rewrite(source, (lines) => lines),
    source,
  );
  assert.equal(
    rewrite(source, (lines) => lines.replace('0', '2px')),
    'color:red;\n  margin : 2px ;gap: 1px',
  );
  assert.equal(
    rewrite(source, (lines) => `${lines}\nwidth: 1px;`),
    'color:red;\n  margin : 0 ;gap: 1px; width: 1px',
  );
  assert.equal(
    rewrite(source, (lines) => lines.replace('margin : 0;\n', '')),
    'color:red;gap: 1px',
  );
  assert.equal(modules.rewriteDeclarations('a: 1;', 'a: 2;'), 'a: 2;', 'a last `;` stays');
  assert.equal(modules.rewriteDeclarations('', 'a: 1;\nb: 2;'), 'a: 1; b: 2;', 'a new attribute is one line');
  assert.equal(modules.rewriteDeclarations('a: 1', ''), '', 'nothing left is no attribute');
});

test('a number and any CSS unit are one highlighted token', () => {
  const units = ['svh', 'lvh', 'dvh', 'svw', 'lvw', 'dvw', 'svmin', 'dvmax', 'vi', 'vb', 'cqw', 'cqh', 'cqi', 'cqb', 'cqmin', 'cqmax', 'lh', 'rlh', 'cap'];
  for (const unit of [...units, 'px', 'rem', 'em', 'vmin', 'vmax', 'ms', 's', 'turn', 'dppx', 'khz', 'q', 'fr', '%']) {
    const tokens = modules.declarationTokens(`a: 100${unit};`).map((token) => token.text);
    assert.ok(tokens.includes(`100${unit}`), `100${unit} is one token: ${tokens.join('|')}`);
  }
});

test('a conditional branch keeps its chips beside a `${name}` hole, and a hole is never inside a chip', () => {
  const text = 'margin: ${space} var(--nav-height); gap: var(--a, ${fallback});';
  const found = modules.cssValueChips(text, 'stylesheet').filter((chip) => chip.kind === 'variable');
  assert.deepEqual(
    found.map((chip) => chip.value),
    ['var(--nav-height)'],
  );
});

test('Desktop and Studio both install the field chips', () => {
  for (const file of ['src/app/shell/AppPanes.tsx', 'studio/src/features/settings/Settings.tsx']) {
    assert.match(fs.readFileSync(repoPath(file), 'utf8'), /^installCssFieldChips\(useCodeChips\);$/m, file);
  }
});
