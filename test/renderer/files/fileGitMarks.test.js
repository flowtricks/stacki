// Goal: the Files panel's rows wear VS Code's git marks, stay live without flicker, and show nothing outside a
// repository: letters on files, a strongest-wins dot on the folders above, inherited marks inside untracked and ignored
// folders, the same marks on find results and the open file's header, and one toast when there is too much to mark.
//
// Method: the real marks model, panel, tree and keeper, bundled with esbuild and mounted in jsdom over a fake
// `window.avb` whose replies go through the real boundary parsers. The git answer is changed and then announced the two
// ways the app announces one: a new `gitSignal` (the Git panel's read) and `files:changed` with no folders (the git
// directory). Mutations of the tree are watched to prove an unchanged answer draws nothing again.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { waitForSteady } = require('../../helpers/waitFor.js');

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.HTMLElement = dom.window.HTMLElement;
global.Element = dom.window.Element;
global.Node = dom.window.Node;
global.MutationObserver = dom.window.MutationObserver;
global.getComputedStyle = dom.window.getComputedStyle;
global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
global.cancelAnimationFrame = clearTimeout;
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
dom.window.ResizeObserver = global.ResizeObserver;
dom.window.HTMLElement.prototype.scrollIntoView = () => undefined;
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
global.IS_REACT_ACT_ENVIRONMENT = true;

const disk = new Map([
  ['', ['gone/', 'new/', 'node_modules/', 'src/', 'café.txt', 'clean.txt']],
  ['new', ['inside.txt']],
  ['node_modules', ['package.json']],
  ['src', ['index.astro']],
]);
const change = (changed, state, extra = {}) => ({ path: changed, state, folder: false, ...extra });
const answer = (changes, ignored = []) => ({ kind: 'repository', whole: 'tracked', changes, ignored });
const main = { git: { kind: 'none' }, reads: 0, held: false, changed: new Set() };
dom.window.avb = {
  platform: 'darwin',
  listFiles: async ({ path: folder }) => {
    const entries = (disk.get(folder) ?? []).map((name) => ({ name: name.replace(/\/$/, ''), kind: name.endsWith('/') ? 'directory' : 'file' }));
    return { ok: true, value: { path: folder, entries, totalCount: entries.length } };
  },
  fileGitStatus: () => {
    main.reads += 1;
    return main.held ? new Promise(() => {}) : Promise.resolve(structuredClone(main.git));
  },
  watchFiles: async ({ directories }) => ({ watching: directories.length }),
  onFilesChanged: (callback) => {
    main.changed.add(callback);
    return () => main.changed.delete(callback);
  },
};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const create = React.createElement;

let modules;
test.before(async () => {
  const outfile = repoPath('node_modules/.stacki-test/files-git-marks.cjs');
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  await esbuild.build({
    stdin: {
      contents: [
        `export { default as FilesPanel } from './src/features/files/FilesPanel';`,
        `export { FilesKeeper } from './src/features/files/FilesKeeper';`,
        `export * as marks from './src/features/files/fileGitMarks';`,
        `export { updateFilesView } from './src/features/files/filesState';`,
      ].join('\n'),
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    outfile,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    loader: { '.css': 'empty', '.svg': 'text' },
    external: ['react', 'react-dom'],
    logLevel: 'silent',
  });
  modules = require(outfile);
});

// Until the document and the count of git reads both stop changing: the replies are in and drawn.
const settle = () =>
  act(async () => {
    await waitForSteady({ what: 'the panel goes quiet', read: () => `${main.reads}:${document.body.innerHTML}`, until: () => true });
  });

test('marks: letters, strongest folder state, inheritance, deleted and renamed parents, Unicode forms', () => {
  const { buildFileGitMarks, fileGitMark } = modules.marks;
  const marks = buildFileGitMarks({
    kind: 'repository',
    whole: 'tracked',
    changes: [
      change('a/b/new.txt', 'untracked'),
      change('a/b/edited.txt', 'modified'),
      change('a/clash.txt', 'conflicted'),
      change('gone/old.txt', 'deleted'),
      change('to/name.txt', 'renamed', { from: 'from/name.txt' }),
      change('fresh', 'untracked', { folder: true }),
      change('café.txt', 'modified'),
    ],
    ignored: [
      { path: 'dist', folder: true },
      { path: 'fresh/x.log', folder: false },
    ],
  });
  const at = (target, folder = false) => fileGitMark(marks, target, { folder });
  assert.equal(at('a', true).state, 'conflicted');
  assert.equal(at('a/b', true).state, 'modified');
  assert.deepEqual([at('gone', true).kind, at('gone', true).state], ['contains', 'deleted']);
  assert.equal(at('from', true).state, 'renamed');
  assert.equal(at('fresh', true).state, 'untracked');
  assert.deepEqual([at('fresh/deep/file.txt').kind, at('fresh/deep/file.txt').state], ['change', 'untracked']);
  assert.equal(at('fresh/x.log').kind, 'ignored');
  assert.equal(at('dist/deep/app.js').kind, 'ignored');
  // The disk holds the accent decomposed; git reported it composed.
  assert.equal(at('café.txt'.normalize('NFD')).state, 'modified');
  assert.equal(at('clean.txt'), undefined);
  assert.equal(at('a-sibling', true), undefined);
  assert.equal(at('.git', true), undefined);
  assert.equal(fileGitMark(undefined, 'a', { folder: true }), undefined);
  const wholeProject = buildFileGitMarks({ kind: 'repository', whole: 'untracked', changes: [], ignored: [] });
  assert.equal(fileGitMark(wholeProject, 'anything.txt', { folder: false }).state, 'untracked');
  assert.equal(fileGitMark(wholeProject, '.git', { folder: true }), undefined);
});

test('the tree shows the marks, never waits for git, redraws nothing for the same answer, and follows a new one', async (context) => {
  const toasts = [];
  const root = createRoot(document.getElementById('root'));
  context.after(() => act(() => root.unmount()));
  // One project at a time, each with its own keeper and panel, as the app mounts them.
  const open = (projectPath, gitSignal) => {
    const host = { projectPath, platform: 'darwin', showToast: (message) => toasts.push(message), recordUndo: () => {}, referenceMove: () => undefined };
    return act(async () =>
      root.render(create(React.Fragment, { key: projectPath }, create(modules.FilesKeeper, { projectPath, gitSignal }), create(modules.FilesPanel, { host }))),
    );
  };
  const row = (target) => document.querySelector(`.files-row[data-path="${target}"]`);
  const badge = (target) => row(target).querySelector('.git-badge');

  main.held = true;
  await open('/fixtures/marks-waiting', 1);
  await settle();
  assert.ok(row('clean.txt'), 'the tree is drawn while git has not answered');
  assert.equal(document.querySelector('[data-git]') ?? undefined, undefined);

  main.held = false;
  const second = '/fixtures/marks-answered';
  main.git = answer(
    [change('src/index.astro', 'modified'), change('café.txt', 'untracked'), change('gone/old.txt', 'deleted'), change('new', 'untracked', { folder: true })],
    [{ path: 'node_modules', folder: true }],
  );
  const renderSecond = (gitSignal) => open(second, gitSignal);
  await renderSecond(1);
  await settle();
  assert.equal(row('src').dataset.git, 'modified');
  assert.ok(badge('src').querySelector('.git-badge-dot'), 'a closed folder with changes wears a dot');
  assert.equal(badge('café.txt').textContent, 'U');
  assert.equal(row('gone').dataset.git, 'deleted');
  assert.equal(row('node_modules').dataset.git, 'ignored');
  assert.equal(badge('node_modules') ?? undefined, undefined);
  assert.equal(row('node_modules').getAttribute('aria-description'), 'Ignored by Git');
  assert.equal(row('clean.txt').dataset.git, undefined);
  assert.match(badge('src').parentElement.textContent, /Contains modified files/);
  await act(async () => modules.updateFilesView(second, (view) => ({ ...view, open: new Set(['src', 'new', 'node_modules']) })));
  await settle();
  assert.equal(badge('src/index.astro').textContent, 'M');
  assert.equal(badge('new/inside.txt').textContent, 'U');
  assert.equal(row('node_modules/package.json').dataset.git, 'ignored');

  const mutations = [];
  const observer = new window.MutationObserver((records) => mutations.push(...records));
  observer.observe(document.querySelector('.files-tree'), { subtree: true, childList: true, attributes: true, characterData: true });
  const readsBefore = main.reads;
  await renderSecond(2);
  await settle();
  assert.ok(main.reads > readsBefore, 'a new git read by the app reads the marks again');
  assert.equal(mutations.length, 0, 'the same answer draws nothing again');
  observer.disconnect();

  main.git = answer([change('src/index.astro', 'conflicted')]);
  await act(async () => main.changed.forEach((callback) => callback({ directories: [] })));
  await settle();
  assert.equal(badge('src/index.astro').textContent, '!');
  assert.equal(row('src').dataset.git, 'conflicted');
  assert.equal(badge('café.txt') ?? undefined, undefined);

  main.git = { kind: 'too-many', limit: 20000 };
  await renderSecond(3);
  await settle();
  assert.equal(document.querySelector('[data-git]') ?? undefined, undefined);
  assert.equal(toasts.filter((message) => /no Git marks/.test(message)).length, 1);
  await renderSecond(4);
  await settle();
  assert.equal(toasts.filter((message) => /no Git marks/.test(message)).length, 1);

  main.git = { kind: 'none' };
  await renderSecond(5);
  await settle();
  assert.equal(document.querySelector('[data-git]') ?? undefined, undefined);
});
