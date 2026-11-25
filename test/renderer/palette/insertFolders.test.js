// Goal: the insert grid filters by the project's component folders and moves its highlight by pure rules,
// and the folder pill is remembered per project. Astro's own components are cards in no folder: no pill.
// Methodology: bundle the pure modules, then feed them the shapes a project produces: components at the
// root, in folders and in nested folders, Astro's own components, searches that empty a folder, a remembered
// folder the project no longer has, storage holding junk, many projects, and every edge of a three-column grid.
const test = require('node:test');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const path = require('node:path');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

function bundle(entry, name) {
  const outfile = path.join(repoPath('node_modules/.stacki-test'), `${name}.cjs`);
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  esbuild.buildSync({ entryPoints: [repoPath(entry)], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  return require(outfile);
}

const folders = bundle('src/features/palette/insertFolders.ts', 'insert-folders');
const grid = bundle('src/features/palette/insertGrid.ts', 'insert-grid');
const preferences = bundle('src/features/palette/insertPreferences.ts', 'insert-preferences');

test('a component belongs to its top-level folder; the root has a pill of its own', () => {
  assert.equal(folders.insertFolderOf(''), 'root');
  assert.equal(folders.insertFolderOf('sections'), 'folder:sections');
  assert.equal(folders.insertFolderOf('sections/hero'), 'folder:sections', 'nested folders count toward the top one');
  assert.equal(folders.insertFolderOf('ui\\forms'), 'folder:ui');
  assert.equal(folders.insertFolderLabel('root'), 'components');
  assert.equal(folders.insertFolderLabel('folder:sections'), 'sections');
  assert.deepEqual(folders.insertFolderKeys(['folder:ui', 'root', 'folder:sections', 'folder:ui']), ['root', 'folder:sections', 'folder:ui']);
});

test('negative space: only well-formed folder keys parse', () => {
  for (const key of ['root', 'folder:ui']) {
    assert.equal(folders.parseInsertFolderKey(key), key);
  }
  for (const junk of [undefined, 3, '', 'astro', 'sections', 'folder:', 'folder:a/b', `folder:${'x'.repeat(folders.insertFolderNameCharsMax + 1)}`]) {
    assert.equal(folders.parseInsertFolderKey(junk), undefined, String(junk));
  }
});

const item = (name, folder) => ({ name, cat: 'components', card: { folder } });

test('the view: no pill shows every card; a pill filters; counts follow the search; a vanished folder selects nothing', () => {
  const ranked = [item('Hero', 'folder:sections'), item('Button', 'folder:ui'), item('Card', 'root'), item('Image', undefined), item('Faq', 'folder:sections')];
  const present = ranked.flatMap((entry) => (entry.card.folder === undefined ? [] : [entry.card.folder]));
  const all = grid.insertView(ranked, 'components', { chosen: undefined, present });
  assert.deepEqual(
    all.shown.map((entry) => entry.name),
    ['Hero', 'Button', 'Card', 'Image', 'Faq'],
    'every card, in rank order',
  );
  assert.deepEqual(all.folders, {
    selected: undefined,
    pills: [
      { key: 'root', count: 1 },
      { key: 'folder:sections', count: 2 },
      { key: 'folder:ui', count: 1 },
    ],
  });
  const sections = grid.insertView(ranked, 'components', { chosen: 'folder:sections', present });
  assert.deepEqual(
    sections.shown.map((entry) => entry.name),
    ['Hero', 'Faq'],
  );
  assert.equal(sections.folders.selected, 'folder:sections');
  // A search that hits nothing in the folder keeps the pill (count 0) and the selection.
  const searched = grid.insertView([item('Button', 'folder:ui')], 'components', { chosen: 'folder:sections', present });
  assert.deepEqual(searched.shown, []);
  assert.deepEqual(
    searched.folders.pills.map((pill) => pill.count),
    [0, 0, 1],
  );
  const vanished = grid.insertView(ranked, 'components', { chosen: 'folder:gone', present });
  assert.equal(vanished.folders.selected, undefined);
  assert.equal(vanished.shown.length, 5);
  assert.equal(grid.insertView(ranked, 'all', { chosen: 'folder:sections', present }).folders, undefined, 'only the Components tab filters');
});

test('the view is capped at the named limit', () => {
  const many = Array.from({ length: grid.insertResultsMax + 30 }, (_, at) => item(`C${at}`, 'root'));
  const view = grid.insertView(many, 'components', { chosen: undefined, present: ['root'] });
  assert.equal(view.shown.length, grid.insertResultsMax);
  assert.equal(view.folders.pills[0].count, grid.insertResultsMax + 30, 'the pill counts every hit');
  assert.equal(grid.insertView(many, 'elements', { chosen: undefined, present: [] }).shown.length, grid.insertResultsMax);
});

test('the folder pill is remembered per project, bounded, and storage junk is ignored', () => {
  const dom = new JSDOM('', { url: 'http://localhost' });
  global.localStorage = dom.window.localStorage;
  try {
    assert.equal(preferences.loadInsertFolder('/a'), undefined, 'none by default');
    preferences.saveInsertFolder('/a', 'folder:sections');
    preferences.saveInsertFolder('/b', 'root');
    assert.equal(preferences.loadInsertFolder('/a'), 'folder:sections');
    assert.equal(preferences.loadInsertFolder('/b'), 'root');
    preferences.saveInsertFolder('/a', undefined);
    assert.equal(preferences.loadInsertFolder('/a'), undefined, 'clearing forgets the project');
    assert.equal(preferences.loadInsertFolder(undefined), undefined);
    for (let at = 0; at < preferences.insertFolderProjectsMax + 5; at++) {
      preferences.saveInsertFolder(`/p${at}`, 'root');
    }
    const stored = JSON.parse(localStorage.getItem('stacki.insertPalette.folders'));
    assert.equal(stored.length, preferences.insertFolderProjectsMax);
    assert.equal(preferences.loadInsertFolder('/b'), undefined, 'the oldest project is forgotten first');
    for (const junk of ['{', '{}', '[["/a"]]', '[[3,"root"]]', '[["/a","sections"]]']) {
      assert.deepEqual(preferences.parseStoredInsertFolders(junk), [], junk);
    }
    global.localStorage = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    };
    assert.equal(preferences.loadInsertFolder('/a'), undefined, 'storage that throws reads as none');
    preferences.saveInsertFolder('/a', 'root');
  } finally {
    delete global.localStorage;
    dom.window.close();
  }
});

test('the highlight moves by cards and rows and stays at the edges', () => {
  assert.equal(grid.INSERT_COLUMNS, 3);
  const move = (current, count, direction) => grid.moveHighlight(current, count, direction);
  // Eight cards: rows of 3, 3 and 2.
  assert.equal(move(0, 8, 'right'), 1);
  assert.equal(move(7, 8, 'right'), 7, 'right at the end stays');
  assert.equal(move(0, 8, 'left'), 0, 'left at the start stays');
  assert.equal(move(4, 8, 'left'), 3);
  assert.equal(move(4, 8, 'up'), 1);
  assert.equal(move(1, 8, 'up'), 1, 'up from the first row stays');
  assert.equal(move(1, 8, 'down'), 4);
  assert.equal(move(4, 8, 'down'), 7);
  assert.equal(move(5, 8, 'down'), 7, 'down into a shorter last row lands on its last card');
  assert.equal(move(7, 8, 'down'), 7, 'down from the last row stays');
  assert.equal(move(0, 1, 'down'), 0);
  assert.equal(move(0, 1, 'up'), 0);
});

test('negative space: moving needs a card, and the highlight must be on one', () => {
  assert.throws(() => grid.moveHighlight(0, 0, 'right'), /at least one card/);
  assert.throws(() => grid.moveHighlight(-1, 3, 'right'), /highlight is a position/);
  assert.throws(() => grid.moveHighlight(3, 3, 'right'), /highlight sits on a card/);
});
