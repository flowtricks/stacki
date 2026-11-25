// Goal: the Files panel's tree behaves as a WAI-ARIA tree and its edits are guarded: the rows on screen follow the open
// folders (with a "more" row past a listing's bound), the keyboard moves as the tree pattern says, Shift and ⌘ build a
// selection, a drop never lands in `.git` or inside itself, and the editor's unsaved text is never replaced or closed
// without the settler's answer.
// Method: the real modules bundled by the app's bundler (test/helpers/rendererModule.js), driven with plain values.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule.js');

const tree = loadRenderer('src/features/files/fileTreeModel.ts');
const control = loadRenderer('src/features/files/fileEditorControl.ts');

function listing(path, names, totalCount) {
  return {
    path,
    entries: names.map((name) => ({ name: name.replace(/\/$/, ''), kind: name.endsWith('/') ? 'directory' : 'file' })),
    totalCount: totalCount ?? names.length,
  };
}

const listings = new Map([
  ['', listing('', ['.git/', 'src/', '.env', 'package.json'])],
  ['src', listing('src', ['pages/', 'a.ts'], 9)],
  ['.git', listing('.git', ['HEAD'])],
]);

test('rows follow open folders, depth first, with a more row past the bound', () => {
  const closed = tree.visibleRows({ listings, open: new Set() });
  assert.deepEqual(
    closed.map((row) => row.path),
    ['.git', 'src', '.env', 'package.json'],
  );
  assert.equal(closed[0].protected, true, '.git is listed, read-only');
  const open = tree.visibleRows({ listings, open: new Set(['src', 'src/pages']) });
  assert.deepEqual(
    open.map((row) => `${row.kind}:${row.path}:${row.depth}`),
    ['entry:.git:0', 'entry:src:0', 'entry:src/pages:1', 'entry:src/a.ts:1', 'more:src:1', 'entry:.env:0', 'entry:package.json:0'],
  );
  assert.equal(open[2].loading, true, 'an open folder with no listing yet is loading');
  assert.equal(open[4].hidden, 7);
});

test('the keyboard moves as the tree pattern says', () => {
  const rows = tree.visibleRows({ listings, open: new Set(['src']) });
  assert.deepEqual(tree.keyMove(rows, undefined, 'ArrowDown', 5), { kind: 'focus', path: '.git' });
  assert.deepEqual(tree.keyMove(rows, '.git', 'ArrowDown', 5), { kind: 'focus', path: 'src' });
  assert.deepEqual(tree.keyMove(rows, 'src', 'ArrowRight', 5), { kind: 'focus', path: 'src/pages' });
  assert.deepEqual(tree.keyMove(rows, 'src/pages', 'ArrowRight', 5), { kind: 'open', path: 'src/pages' });
  assert.deepEqual(tree.keyMove(rows, 'src/a.ts', 'ArrowLeft', 5), { kind: 'focus', path: 'src' });
  assert.deepEqual(tree.keyMove(rows, 'src', 'ArrowLeft', 5), { kind: 'close', path: 'src' });
  assert.deepEqual(tree.keyMove(rows, 'src', 'End', 5), { kind: 'focus', path: 'package.json' });
  assert.deepEqual(tree.keyMove(rows, 'package.json', 'Home', 5), { kind: 'focus', path: '.git' });
  assert.deepEqual(tree.keyMove(rows, '.git', 'PageDown', 3), { kind: 'focus', path: 'src/a.ts' });
  assert.deepEqual(tree.keyMove([], undefined, 'ArrowDown', 3), { kind: 'none' });
});

test('clicks build a selection: plain, toggle and range', () => {
  const rows = tree.visibleRows({ listings, open: new Set() });
  const one = tree.clickSelection(rows, new Set(), { path: 'src', anchor: undefined, toggle: false, extend: false });
  assert.deepEqual([...one], ['src']);
  const toggled = tree.clickSelection(rows, one, { path: '.env', anchor: 'src', toggle: true, extend: false });
  assert.deepEqual([...toggled], ['src', '.env']);
  const range = tree.clickSelection(rows, one, { path: 'package.json', anchor: 'src', toggle: false, extend: true });
  assert.deepEqual([...range], ['src', '.env', 'package.json']);
});

test('drops land in a folder, never in .git or inside themselves', () => {
  const rows = tree.visibleRows({ listings, open: new Set(['src']) });
  const file = rows.find((row) => row.path === 'src/a.ts');
  assert.equal(tree.dropFolderOf(file), 'src');
  assert.equal(tree.dropFolderOf(undefined), '');
  assert.deepEqual(tree.dropVerdict(['.env'], '.git', 'move'), { kind: 'refused', reason: 'protected' });
  assert.deepEqual(tree.dropVerdict(['.git'], 'src', 'copy'), { kind: 'refused', reason: 'protected' });
  assert.deepEqual(tree.dropVerdict(['src'], 'src/pages', 'move'), { kind: 'refused', reason: 'into-itself' });
  assert.deepEqual(tree.dropVerdict(['src/a.ts'], 'src', 'move'), { kind: 'refused', reason: 'same-folder' });
  assert.deepEqual(tree.dropVerdict(['src/a.ts'], 'src', 'copy'), { kind: 'allowed' });
  assert.deepEqual(tree.dropVerdict(['.env'], 'src', 'move'), { kind: 'allowed' });
});

test('wanted folders skip a folder whose parent is closed', () => {
  assert.deepEqual(tree.wantedFolders(new Set(['src/pages', 'src', 'lost/deep'])), ['', 'src', 'src/pages']);
  assert.deepEqual([...tree.rebaseOpen(new Set(['src', 'src/pages', 'other']), 'src', 'code')], ['code', 'code/pages', 'other']);
});

test('the editor is never replaced or closed over unsaved text without the settler saying so', async () => {
  const project = '/tmp/files-guard';
  let answer = 'cancel';
  let asked = 0;
  const release = control.registerEditorSettler(async () => {
    asked += 1;
    return answer;
  });
  await control.openInEditor(project, 'a.txt');
  assert.equal(asked, 1);
  answer = 'proceed';
  await control.openInEditor(project, 'a.txt');
  assert.equal(asked, 2, 'opening asks the settler of the file shown');
  await control.openInEditor(project, 'a.txt');
  assert.equal(asked, 2, 'reopening the shown file asks nothing');
  answer = 'cancel';
  await control.openInEditor(project, 'b.txt');
  assert.equal(await control.closeEditor(project), false, 'a cancelled close keeps the editor');
  answer = 'proceed';
  assert.equal(await control.closeEditor(project), true);
  release();
  assert.equal(await control.settleOpenEditor(), 'proceed', 'no editor, nothing to settle');
});
