// Goal: the Git panel's list of changes under the commit box is closed each time it opens, counts every change, shows
// each file once with the Files panel's letters (deleted files included), opens only files that are still there, caps
// its rows and says how many are left out, follows the tree without redrawing an unchanged list, and draws nothing
// at all for a clean tree.
//
// Method: the real ChangesList, bundled with esbuild and mounted in jsdom over a fake `window.avb.gitStatus` whose
// reply goes through the real boundary parser. The tree changing is announced as the app announces it (a new git info
// or a new signal), and mutations of the list are watched to prove an unchanged answer draws nothing.
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
global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
global.cancelAnimationFrame = clearTimeout;
global.IS_REACT_ACT_ENVIRONMENT = true;

const entry = (file, status, extra = {}) => ({ path: file, status, staged: false, untracked: false, kind: 'file', label: file, ...extra });
const main = { files: [], reads: 0, fail: false };
dom.window.avb = {
  platform: 'darwin',
  gitStatus: async () => {
    main.reads += 1;
    if (main.fail) {
      throw new Error('status failed');
    }
    return structuredClone(main.files);
  },
};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');

let modules;
test.before(async () => {
  const outfile = repoPath('node_modules/.stacki-test/git-changes-list.cjs');
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  await esbuild.build({
    stdin: { contents: `export { ChangesList, changeState, CHANGE_ROWS_MAX } from './src/features/git/CommitFilePicker';`, resolveDir: ROOT, loader: 'ts' },
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

const settle = () =>
  act(async () => {
    await waitForSteady({ what: 'the list goes quiet', read: () => `${main.reads}:${document.body.innerHTML}`, until: () => true });
  });
const one = (selector) => document.querySelector(selector) ?? undefined;
const all = (selector) => [...document.querySelectorAll(selector)];

test('closed by default, counted, one row per file with its letter, deleted included, and only present files open', async (context) => {
  const root = createRoot(document.getElementById('root'));
  context.after(() => act(() => root.unmount()));
  const opened = [];
  const toasts = [];
  const render = (projectPath, extra) =>
    act(async () =>
      root.render(
        React.createElement(modules.ChangesList, {
          key: projectPath,
          projectPath,
          info: { dirty: true },
          onOpenFile: (file) => opened.push(file),
          showToast: (message) => toasts.push(message),
          ...extra,
        }),
      ),
    );
  main.files = [
    entry('src/components/Navbar.astro', 'M', { state: 'modified' }),
    entry('src/lib/format coins ü.ts', 'A', { untracked: true, state: 'untracked' }),
    entry('src/old/removed.ts', 'D', { state: 'deleted' }),
    entry('src/lib/new.ts', 'R', { from: 'src/lib/old.ts', state: 'renamed' }),
    // Removed from the index and still on disk: git names it twice, the list once.
    entry('kept.txt', 'D', { state: 'deleted' }),
    entry('kept.txt', 'A', { untracked: true, state: 'untracked' }),
  ];
  await render('/one');
  await settle();
  const head = () => one('.git-changes button[aria-expanded]');
  assert.equal(head().getAttribute('aria-expanded'), 'false');
  assert.equal(head().textContent, 'Changes5');
  assert.equal(one('.git-changes-list'), undefined);

  await act(async () => head().click());
  assert.equal(head().getAttribute('aria-expanded'), 'true');
  const rows = all('.git-change');
  assert.deepEqual(
    rows.map((row) => [row.dataset.git, row.querySelector('.git-badge').textContent, row.tagName]),
    [
      ['modified', 'M', 'BUTTON'],
      ['untracked', 'U', 'BUTTON'],
      ['deleted', 'D', 'DIV'],
      ['renamed', 'R', 'BUTTON'],
      ['untracked', 'U', 'BUTTON'],
    ],
  );
  assert.equal(rows[0].querySelector('.git-change-name').textContent, 'Navbar.astro');
  assert.equal(rows[0].querySelector('.git-change-folder').textContent, 'src/components');
  assert.match(rows[3].textContent, /Renamed or moved from src\/lib\/old\.ts/);
  await act(async () => rows[0].click());
  assert.deepEqual(opened, ['src/components/Navbar.astro']);

  const mutations = [];
  const observer = new window.MutationObserver((records) => mutations.push(...records));
  observer.observe(one('.git-changes'), { subtree: true, childList: true, attributes: true, characterData: true });
  const before = main.reads;
  await render('/one', { info: { dirty: true } });
  await settle();
  assert.ok(main.reads > before, 'new git info reads the list again');
  assert.equal(mutations.length, 0, 'the same list draws nothing again');
  observer.disconnect();

  main.files = [main.files[0]];
  await render('/one', { signal: 'the tree changed' });
  await settle();
  assert.equal(head().textContent, 'Changes1');

  // Leaving the panel and coming back: closed again, and the held count is in the first frame.
  await act(async () => root.render(React.createElement('div')));
  await render('/one');
  assert.equal(head().getAttribute('aria-expanded'), 'false');
  assert.equal(head().textContent, 'Changes1');

  // A read that fails shows no list that could be stale, and says so once.
  main.fail = true;
  await render('/one', { signal: 'again' });
  await settle();
  await render('/one', { signal: 'and again' });
  await settle();
  assert.equal(toasts.length, 1);
  assert.equal(one('.git-change'), undefined);
  main.fail = false;

  main.files = [];
  await render('/one', { info: { dirty: false } });
  await settle();
  assert.equal(document.getElementById('root').innerHTML, '', 'a clean tree draws nothing');

  main.files = Array.from({ length: modules.CHANGE_ROWS_MAX + 7 }, (_each, index) => entry(`f/${index}.ts`, 'M'));
  await render('/many');
  await settle();
  assert.equal(head().textContent, `Changes${modules.CHANGE_ROWS_MAX + 7}`);
  await act(async () => head().click());
  assert.equal(all('.git-change').length, modules.CHANGE_ROWS_MAX);
  assert.equal(one('.git-changes-more').textContent, '7 more files not shown');
});

test('a reply without a state (Studio) reads its letter', () => {
  const read = (status, untracked = false) => modules.changeState({ status, untracked });
  assert.equal(read('A', true), 'untracked');
  assert.deepEqual(
    ['A', 'C', 'D', 'R', 'U', 'M', 'T'].map((status) => read(status)),
    ['added', 'added', 'deleted', 'renamed', 'conflicted', 'modified', 'modified'],
  );
});
