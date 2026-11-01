// Parse real Git conflict parts through the renderer boundary, then exercise
// the merge dialog's default, per-hunk, whole-file, and busy choices. Invalid
// wire shapes and cumulative bounds must fail before choices reach a write.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const load = require('../../helpers/rendererModule');
const { BOUNDARY_LIMITS } = require('#dist/shared/core/boundary.js');
const { parseMergeResult, parseConflictPart } = load('src/features/git/gitBridge.ts');
const { initialConflictPicks, choicesForSend, conflictHunks } = load('src/features/git/gitConflictModel.ts');
const { parseConflict } = require('#dist/electron/git/conflicts.js');
const { repoPath } = require('../../helpers/sources.js');

// Null as a boundary receives it, parsed from JSON: inputs may hold it; our values never do.
const jsonNull = JSON.parse('null');
const clash = { kind: 'clash', ours: 'ours', theirs: 'theirs', changedBy: 'both' };
const file = (parts) => ({ path: 'a.astro', ours: 'ours', theirs: 'theirs', parts });
const conflict = (files) => ({ ok: false, conflicted: true, from: 'main', branch: 'topic', files });

test('real conflict output survives the renderer parser and preserves each choice', () => {
  const parts = parseConflict('before\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic\nafter');
  const value = conflict([file(parts)]);
  assert.deepEqual(parseMergeResult(value), value);
  const picks = initialConflictPicks(value);
  assert.deepEqual(choicesForSend(value, picks), { 'a.astro': ['ours'] });
  const hunks = conflictHunks(parts);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].before, 'before');
  assert.equal(hunks[0].after, 'after');
  const automatic = conflict([
    file([
      { ...clash, changedBy: 'theirs' },
      { ...clash, merged: 'combined' },
    ]),
  ]);
  assert.deepEqual(initialConflictPicks(automatic), { 'a.astro': ['theirs', 'merged'] });
  assert.throws(() => choicesForSend(automatic, { 'a.astro': ['ours'] }), /choice count changed/);
  assert.deepEqual(choicesForSend(conflict([file(undefined)]), { 'a.astro': ['theirs'] }), {
    'a.astro': 'theirs',
  });
});

test('merge contracts reject unknown parts and bound total files plus parts', () => {
  for (const part of [jsonNull, {}, { kind: 'same', text: 1 }, { ...clash, changedBy: 'someone' }, { ...clash, ours: jsonNull }, { ...clash, merged: false }]) {
    assert.throws(() => parseConflictPart(part));
  }
  assert.throws(() => parseMergeResult(conflict([])), /at least one conflict/);
  assert.throws(() => parseMergeResult(conflict([file([{ kind: 'unknown' }])])));
  assert.throws(() => parseMergeResult(conflict([file(Array(100001).fill(clash))])), /limit/);
  assert.throws(
    () => parseMergeResult(conflict([file(Array(50000).fill(clash)), { ...file(Array(50000).fill(clash)), path: 'b.astro' }])),
    /item limit exceeded/,
  );
  assert.throws(() => parseConflictPart({ kind: 'same', text: 'x'.repeat(BOUNDARY_LIMITS.textLengthMax + 1) }), /String exceeds limit/);
  assert.throws(() => initialConflictPicks(conflict([])), /at least one file/);
  assert.throws(() => conflictHunks(Array(100001).fill(clash)), /part limit exceeded/);
});

test('merge dialog sends exact selected choices and locks binary choices while busy', async () => {
  const output = repoPath('node_modules/.stacki-test/git-conflict.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  buildSync({
    stdin: {
      contents: `export {default} from './src/features/git/MergeConflictModal';
      export {EditorView} from '@codemirror/view';
      export {undo, redo} from '@codemirror/commands';`,
      resolveDir: repoPath('.'),
      loader: 'tsx',
    },
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  for (const name of ['MutationObserver', 'HTMLElement', 'Element', 'Node', 'DOMRect', 'Window']) {
    global[name] = dom.window[name];
  }
  global.getComputedStyle = dom.window.getComputedStyle;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  dom.window.Range.prototype.getClientRects = () => [];
  dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();

  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const { default: Modal, EditorView, undo, redo } = require(output);
  const root = createRoot(document.getElementById('root'));
  const value = conflict([file([clash, { ...clash, merged: 'combined' }]), { ...file(undefined), path: 'image.png' }]);
  const resolutions = [];
  let cancellations = 0;
  const show = (busy) =>
    act(async () =>
      root.render(
        React.createElement(Modal, {
          conflict: value,
          busy,
          onResolve: (choices) => resolutions.push(choices),
          onCancel: () => cancellations++,
        }),
      ),
    );
  const click = (element) => act(async () => element.click());
  const button = (selector, label) => [...document.querySelectorAll(selector)].find((entry) => entry.textContent.trim() === label);
  try {
    await show();
    assert.equal(document.querySelectorAll('.merge-result-editor .cm-editor').length, 1);
    assert.equal(document.querySelector('.modal-footer .primary').disabled, true);
    const view = EditorView.findFromDOM(document.querySelector('.merge-result-editor .cm-editor'));
    assert.ok(view);
    assert.equal(view.state.doc.toString(), 'ours\ncombined');
    await act(async () =>
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: 'Manual replacement across both changes',
        },
      }),
    );
    assert.equal(button('.merge-change-options button', 'Keep main').disabled, true);
    await act(async () => undo(view));
    assert.equal(button('.merge-change-options button', 'Keep main').disabled, false);
    assert.equal(view.state.doc.toString(), 'ours\ncombined');

    await click(button('.merge-change-options button', 'Keep both blocks'));
    assert.equal(view.state.doc.toString(), 'ours\ntheirs\ncombined');
    await act(async () => view.dispatch({ changes: { from: view.state.doc.length, insert: '\n<!-- Override -->' } }));
    assert.match(view.state.doc.toString(), /Override/);
    await act(async () => undo(view));
    assert.equal(view.state.doc.toString(), 'ours\ntheirs\ncombined');
    await act(async () => redo(view));
    assert.match(view.state.doc.toString(), /Override/);
    await click(document.querySelector('[title="image.png"]'));
    await click(button('.conflict-whole button', 'topic'));
    await click(document.querySelector('.modal-footer .primary'));
    assert.equal(resolutions[0]['a.astro'].kind, 'text');
    assert.equal(resolutions[0]['a.astro'].text, 'ours\ntheirs\ncombined\n<!-- Override -->');
    assert.equal(resolutions[0]['image.png'], 'theirs');
    await click(document.querySelector('[title="a.astro"]'));
    const restored = EditorView.findFromDOM(document.querySelector('.merge-result-editor .cm-editor'));
    assert.match(restored.state.doc.toString(), /Override/);
    await show('Merging…');
    const beforeBusy = restored.state.doc.toString();
    await act(async () => restored.dispatch({ changes: { from: 0, insert: 'Blocked' } }));
    assert.equal(restored.state.doc.toString(), beforeBusy);
    await click(document.querySelector('[title="image.png"]'));
    assert.ok([...document.querySelectorAll('.conflict-whole button')].every((entry) => entry.disabled));
    await act(async () => {
      const dialog = document.querySelector('dialog.popup-dialog');
      dialog.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
      dialog.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(cancellations, 0);
    await show();
    await act(async () => {
      const dialog = document.querySelector('dialog.popup-dialog');
      dialog.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
      dialog.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(cancellations, 1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
