// Goal: the Props panel never appends an error, notice or hint paragraph. A failure is one toast (and the field wears the error
// look, a tinted fill, never a border); an explanation is a "?" tooltip a keyboard can reach; what must persist replaces existing
// UI at the same height. Valid input shows nothing at all.
// Method: (1) a source scan of src/features/props and the shared stylesheets: no role="alert", no notice-class elements except the
// two listed legitimate ones, and none of the removed class names left in any stylesheet (dead CSS). (2) The real TypedFieldForm
// renders in jsdom, bundled as the app bundles it, over the real toast channel: a refused path gives one toast with the message
// and an error-look field, editing takes the look off, a valid path calls onUse and toasts nothing, and the form holds no
// note, alert or problem element in any of those states (negative space: invalid, then invalid made valid).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { installPopupDOM } = require('../../helpers/popupDom.js');
const { installToastLog } = require('../../helpers/toastLog.js');

const REMOVED_CLASSES = [
  'loop-bind-problem',
  'loop-bind-note',
  'loop-lineage-note',
  'loop-settings-notice',
  'loop-settings-code-problem',
  'loop-typed-note',
  'new-prop-note',
  'attr-name-note',
  'attr-spread-note',
  'list-item-note',
  'prop-field-note',
];
const LEGITIMATE = ['link-note', 'props-code-row-note'];
const FILES_MAX = 2000;

// Iterative, bounded by FILES_MAX: a directory is read once and its subdirectories queued.
function walk(directory, extension, found) {
  const queue = [directory];
  for (let index = 0; index < queue.length; index += 1) {
    assert(index < FILES_MAX, 'walk: too many directories');
    for (const entry of fs.readdirSync(queue[index], { withFileTypes: true })) {
      const full = path.join(queue[index], entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.name.endsWith(extension)) {
        found.push(full);
      }
    }
    assert(found.length < FILES_MAX, 'walk: too many files');
  }
  return found;
}

test('the Props panel sources hold no alert and no notice element beyond the two empty-state rows', () => {
  const offenders = [];
  for (const file of walk(repoPath('src/features/props'), '.tsx', [])) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
        return;
      }
      const named = /className=(?:"[^"]*|\{[^}]*)\b[\w-]+-(?:note|notice|problem|hint|warning)\b/.test(line);
      const alerting = /role="alert"/.test(line);
      if ((named || alerting) && !LEGITIMATE.some((name) => line.includes(name))) {
        offenders.push(`${path.relative(ROOT, file)}:${index + 1}  ${trimmed}`);
      }
    });
  }
  assert.deepEqual(offenders, []);
});

test('no stylesheet keeps a rule for a removed notice class', () => {
  const sheets = walk(repoPath('src'), '.css', []);
  const left = [];
  for (const sheet of sheets) {
    const text = fs.readFileSync(sheet, 'utf8');
    for (const name of REMOVED_CLASSES) {
      if (new RegExp(`\\.${name}(?![\\w-])`).test(text)) {
        left.push(`${path.relative(ROOT, sheet)}: .${name}`);
      }
    }
  }
  assert.deepEqual(left, []);
  // Negative space: the legitimate rows keep their rules, so the check above is not simply deleting everything.
  const all = sheets.map((sheet) => fs.readFileSync(sheet, 'utf8')).join('\n');
  for (const name of LEGITIMATE) {
    assert.match(all, new RegExp(`\\.${name}\\b`), `${name} is still styled`);
  }
});

const directory = repoPath('node_modules/.stacki-test/no-appended-notices');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'no-appended-notices.cjs');
buildSync({
  stdin: {
    contents: [
      "export { TypedFieldForm } from './src/features/props/LoopTypedFieldForm';",
      "export { subscribeErrorToasts } from './src/ui/errorNotices';",
      "export { EditorView } from '@codemirror/view';",
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

test('a refused field path is one toast and an error look, never a note in the form', async (context) => {
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
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const modules = require(output);

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const toasts = installToastLog(modules.subscribeErrorToasts);
  context.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    toasts.uninstall();
  });
  const used = [];
  await act(async () => root.render(React.createElement(modules.TypedFieldForm, { item: 'card', onUse: (field) => used.push(field) })));

  const type = async (text) => {
    const view = modules.EditorView.findFromDOM(host.querySelector('.loop-typed-input .cm-content'));
    await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }));
  };
  const use = () => act(async () => host.querySelector('button.primary').click());
  const holdsNotice = () => host.querySelector('[role="alert"], [role="status"], [class*="-note"], [class*="-problem"]') !== null;

  assert.equal(holdsNotice(), false, 'valid (empty) state shows nothing');
  assert.deepEqual(toasts.messages(), []);

  await type('card.');
  await use();
  assert.equal(used.length, 0, 'a refused path is not used');
  assert.equal(toasts.messages().length, 1, 'the refusal is one toast');
  assert.ok(toasts.messages()[0].length > 0, 'with its message');
  assert.equal(holdsNotice(), false, 'and nothing is appended to the form');
  assert.ok(host.querySelector('.loop-typed-input .expr-input.invalid'), 'the field takes the error look');

  await type('card.title');
  assert.equal(host.querySelector('.loop-typed-input .expr-input.invalid') ?? undefined, undefined, 'editing takes the error look off');
  assert.equal(toasts.messages().length, 1, 'and says nothing more');
  await use();
  assert.equal(used.length, 1, 'a valid path is used');
  assert.equal(toasts.messages().length, 1, 'without a toast');
  assert.equal(holdsNotice(), false);
});
