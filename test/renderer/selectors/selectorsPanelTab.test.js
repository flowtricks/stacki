// Goal: the Style selectors panel opens on the tab the person last picked in that project, drawn in
// the first frame that has tabs, never after a frame of another tab; a project with no pick opens on
// Unused when it has any, else Locked when it has any, else All, once, and never over a pick or a
// stored tab, even one whose count is 0; each project keeps its own tab.
// Method: render the real panel in JSDOM over temporary projects on disk, wired to the real
// main-process check as selectorsPanel.test.js is, with a real jsdom local storage. A mutation
// observer records every tab that is selected in any frame, so a flash of another tab is a failure.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkSelectorUsage } = require('#dist/electron/properties/selectorRemoval.js');
const { readProjectMetadata, writeProjectMetadata } = require('#dist/electron/project/projectMetadata.js');
const { EMPTY_KEEP_LIST, parseStyleKeepList, serializeStyleKeepList } = require('#dist/shared/properties/styleKeepList.js');
const { repoPath } = require('../../helpers/sources.js');

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const TAB_KEY = 'stacki.selectorsPanel.tabs';

const FILES = {
  unused: { 'src/styles/global.css': '.hero { a: b }\n.ghost { a: b }\n', 'src/pages/index.astro': '---\n---\n<h1 class="hero">Hi</h1>\n' },
  locked: { 'src/styles/global.css': '.hero { a: b }\n.is-open { a: b }\n', 'src/pages/index.astro': '---\n---\n<h1 class="hero">Hi</h1>\n' },
  plain: { 'src/styles/global.css': '.hero { a: b }\n', 'src/pages/index.astro': '---\n---\n<h1 class="hero">Hi</h1>\n' },
};

function project(kind) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `stacki-selectors-tab-${kind}-`));
  for (const [rel, text] of Object.entries({ ...FILES[kind], 'node_modules/lib/index.js': 'export {};\n' })) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  if (kind === 'locked') {
    const written = writeProjectMetadata(root, { kind: 'styles', source: serializeStyleKeepList({ ...EMPTY_KEEP_LIST, keep: ['is-open'] }) });
    assert.equal(written.ok, true);
  }
  return root;
}

function keepList(root) {
  const stored = readProjectMetadata(root, 'styles');
  return stored.ok && stored.value.source !== undefined ? parseStyleKeepList(JSON.parse(stored.value.source)) : EMPTY_KEEP_LIST;
}

function bridge(roots) {
  return {
    selectorUsage: async (input) => ({ ok: true, value: (await checkSelectorUsage(input.projectPath, keepList(input.projectPath))).report }),
    projectMetadata: async (input) => readProjectMetadata(input.projectPath ?? roots[0], input.kind),
    writeProjectMetadata: async () => ({ ok: false, error: { code: 'unused', message: 'unused' } }),
    onCssChanged: () => () => {},
    onFsChanged: () => () => {},
  };
}

async function load() {
  const bundle = repoPath('node_modules/.stacki-test/selectors-panel-tab.bundle.js');
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  await require('esbuild').build({
    entryPoints: [repoPath('src/features/selectors/SelectorsPanel.tsx')],
    outfile: bundle,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  return bundle;
}

// One window for the whole test, so storage outlives each mounted panel as it does in the app.
async function harness(roots) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  Object.defineProperty(globalThis, 'localStorage', { value: dom.window.localStorage, configurable: true });
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.avb = bridge(roots);
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const SelectorsPanel = require(await load()).default;
  const container = document.getElementById('root');
  const reactRoot = createRoot(container);
  const seen = new Set();
  const selected = () => [...container.querySelectorAll('.selectors-tab[aria-selected="true"]')].map((tabElement) => tabElement.getAttribute('data-tab'));
  const observer = new dom.window.MutationObserver(() => selected().forEach((name) => seen.add(name)));
  observer.observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-selected'] });
  // Every open mounts the panel afresh (it is closed first), as opening it from the rail does.
  const open = async (root) => {
    await act(async () => reactRoot.render(React.createElement(React.Fragment)));
    seen.clear();
    await act(async () => {
      reactRoot.render(React.createElement(SelectorsPanel, { project: { path: root }, showToast: () => {}, onRecordUndo: () => {} }));
      await settle(60);
    });
    // The full check lands; wait for the tabs, within a bound.
    for (let attempt = 0; attempt < 100 && selected().length === 0; attempt += 1) {
      await act(async () => settle(40));
    }
    await act(async () => settle(120));
    return [...seen];
  };
  const pick = async (name) =>
    act(async () => {
      container.querySelector(`[data-tab="${name}"]`).click();
      await settle(60);
    });
  const finish = async () => {
    observer.disconnect();
    await act(async () => reactRoot.unmount());
    dom.window.close();
  };
  return { open, pick, selected, finish, storage: dom.window.localStorage };
}

test('first open picks Unused, else Locked, else All; a picked tab then wins everywhere, per project', async () => {
  const unused = project('unused');
  const locked = project('locked');
  const plain = project('plain');
  const panel = await harness([unused, locked, plain]);
  try {
    assert.deepEqual(await panel.open(unused), ['unused'], 'unused when any: never a frame of another tab');
    assert.deepEqual(await panel.open(locked), ['kept'], 'locked when nothing is unused');
    assert.deepEqual(await panel.open(plain), ['all'], 'all when nothing is unused or locked');
    assert.equal(panel.storage.getItem(TAB_KEY) ?? undefined, undefined, 'the default is not stored: only a pick is');

    // A pick is stored, wins on reopen (same session) and in the first frame that has tabs.
    await panel.open(unused);
    await panel.pick('all');
    assert.deepEqual(JSON.parse(panel.storage.getItem(TAB_KEY)), [[unused, 'all']]);
    assert.deepEqual(await panel.open(unused), ['all'], 'reopening shows the picked tab, never the default first');

    // Each project keeps its own tab.
    assert.deepEqual(await panel.open(locked), ['kept'], 'another project still has no pick');
    await panel.pick('all');
    assert.deepEqual(await panel.open(unused), ['all']);
    assert.deepEqual(await panel.open(locked), ['all']);

    // A stored tab wins even when its count is 0 (Locked in a project with nothing locked).
    panel.storage.setItem(TAB_KEY, JSON.stringify([[plain, 'kept']]));
    assert.deepEqual(await panel.open(plain), ['kept']);
    assert.ok(panel.selected().includes('kept'));

    // A stored value that is not a tab is absent: the first-open default applies.
    panel.storage.setItem(TAB_KEY, JSON.stringify([[unused, 'locked']]));
    assert.deepEqual(await panel.open(unused), ['unused']);
    panel.storage.setItem(TAB_KEY, 'not json');
    assert.deepEqual(await panel.open(unused), ['unused']);
  } finally {
    await panel.finish();
  }
});

// A locked file locks every row in it: the rows in use are as blue and locked as the unused ones, the
// Locked tab counts and lists the same rows the file's heading holds. Unlocking the file is held by the
// real-project test in selectorsPanel.test.js.
test('every row of a locked file is locked, and the Locked tab counts and lists the same rows', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-selectors-lockedfile-'));
  const sheet = '.heading:has(+ .text) { a: b }\n.text { a: b }\n.heading + .text { a: b }\n.section > :where(:not(.container)) { a: b }\n.ghost { a: b }\n';
  const files = {
    'src/styles/patterns.css': sheet,
    'src/pages/index.astro': '---\n---\n<h1 class="heading text section container">Hi</h1>\n',
    'node_modules/lib/index.js': 'export {};\n',
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  const written = writeProjectMetadata(root, {
    kind: 'styles',
    source: serializeStyleKeepList({ ...EMPTY_KEEP_LIST, lockedStylesheets: ['src/styles/patterns.css'] }),
  });
  assert.equal(written.ok, true);
  const panel = await harness([root]);
  try {
    await panel.open(root);
    const rowStates = () =>
      [...document.querySelectorAll('.selectors-row')].map(
        (row) => `${/is-(\w+)/.exec(row.className)[1]}:${row.querySelector('.selectors-lock')?.classList.contains('on')}`,
      );
    const count = (tab) => Number(document.querySelector(`[data-tab="${tab}"] .selectors-tab-count`)?.textContent);
    await panel.pick('all');
    assert.deepEqual(
      rowStates(),
      ['kept:true', 'kept:true', 'kept:true', 'kept:true', 'kept:true'],
      'every shape, used or not, is locked with its lock closed',
    );
    assert.equal(count('all'), 5);
    assert.equal(count('kept'), 5, 'the Locked count includes them all');
    await panel.pick('kept');
    assert.equal(document.querySelectorAll('.selectors-row').length, 5, 'and the Locked list shows them all');
    assert.equal(count('unused'), 0);
  } finally {
    await panel.finish();
  }
});
