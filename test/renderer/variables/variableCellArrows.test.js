// Goal: an arrow key in a Variables cell writes the value on its release only when
// it nudged the value. While a typed `var(--` shows the variable chooser, the
// arrows move the chooser's marked row; writing on their release put the half-
// typed reference (`var(--`) into the stylesheet.
// Method: the real VariableCell is bundled with a project of two variables and
// mounted in jsdom. Typing is replayed as the browser sends it (beforeinput, the
// DOM change, input); each arrow is a keydown and a keyup. The saves the cell
// asks for are recorded: none while the chooser takes the arrows, one for a nudge
// of a plain number.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath, stubSources } = require('../../helpers/sources.js');

const SHARED_VARS = 'src/features/style/sharedVars.ts';
const STREAM_IMPORT = "import { streamProjectVariables, type ProjectVariable } from './model/webflow';";
// The project's variables, without a project: the chooser only needs rows to mark.
const STREAM_STAND_IN = `import type { ProjectVariable } from './model/webflow';
async function streamProjectVariables(onAdd: (variable: ProjectVariable) => void): Promise<ProjectVariable[]> {
  const all: ProjectVariable[] = [
    { name: 'space-1', collection: 'Sizes', group: '', value: '1rem', binding: 'var(--space-1)', type: 'Size' },
    { name: 'space-2', collection: 'Sizes', group: '', value: '2rem', binding: 'var(--space-2)', type: 'Size' },
  ];
  all.forEach(onAdd);
  return all;
}`;

const TEXT = ':root { --gap: 40px; }';
const CELL = {
  name: '--gap',
  value: '40px',
  file: 'src/styles/global.css',
  selector: ':root',
  valueStart: TEXT.indexOf('40px'),
  valueEnd: TEXT.indexOf('40px') + 4,
  line: 1,
  column: 'c0',
};

async function bundleCell() {
  const output = repoPath('node_modules/.stacki-test/variable-cell-arrows.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const source = fs.readFileSync(repoPath(SHARED_VARS), 'utf8');
  assert.ok(source.includes(STREAM_IMPORT), 'sharedVars.ts still imports the variable stream this test stands in for');
  await build({
    stdin: {
      contents: "export { default as Cell } from './src/features/variables/VariableCell.tsx';\nexport * as shared from './src/features/style/sharedVars.ts';\n",
      resolveDir: repoPath('.'),
      loader: 'ts',
    },
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
    plugins: [
      stubSources('stand-in-variables', {
        [SHARED_VARS]: () => ({ contents: source.replace(STREAM_IMPORT, STREAM_STAND_IN), loader: 'ts', resolveDir: path.dirname(repoPath(SHARED_VARS)) }),
      }),
    ],
  });
  delete require.cache[output];
  return require(output);
}

function installDom() {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.getComputedStyle = dom.window.getComputedStyle;
  global.MutationObserver = dom.window.MutationObserver;
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  dom.window.ResizeObserver = global.ResizeObserver;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

test('an arrow the variable chooser takes writes nothing; an arrow that nudges writes on release', async () => {
  const dom = installDom();
  const { Cell, shared } = await bundleCell();
  // Loaded up front, as any open style panel or var() cell has it loaded: a bare
  // `var(--` being typed does not start the load on its own.
  shared.ensureSharedVars();
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');

  const saves = [];
  const onSave = async (_cell, value) => {
    saves.push(value);
  };
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(Cell, { cell: CELL, onSave })));
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  await settle();
  const editor = document.querySelector('.embed-editor_varconnect-editor');
  assert.ok(editor, 'the cell edits through the code field');

  const caretAtEnd = () => {
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  };
  const replaceWith = async (text) => {
    await act(async () => {
      editor.focus();
      editor.dispatchEvent(new dom.window.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
      editor.textContent = text;
      caretAtEnd();
      editor.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    });
    await settle();
  };
  const arrow = async (key) => {
    await act(async () => {
      editor.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
    await act(async () => {
      editor.dispatchEvent(new dom.window.KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
    });
    await settle();
  };

  await replaceWith('var(--');
  assert.ok(document.querySelector('.embed-editor_varpicker'), 'typing var(-- shows the chooser');
  const marked = () => document.querySelector('.embed-editor_varpicker-item.is-active')?.textContent ?? '';
  assert.match(marked(), /space-1/);
  await arrow('ArrowDown');
  assert.match(marked(), /space-2/, '↓ moved the chooser’s mark');
  await arrow('ArrowUp');
  assert.deepEqual(saves, [], 'nothing half-typed is written when the chooser takes the arrows');

  await act(async () => {
    editor.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await replaceWith('41');
  assert.ok(document.querySelector('.embed-editor_varpicker') === null, 'a plain number shows no chooser');
  await arrow('ArrowUp');
  assert.deepEqual(saves, ['42'], 'a nudge is written once, on the key’s release');

  await act(async () => root.unmount());
});
