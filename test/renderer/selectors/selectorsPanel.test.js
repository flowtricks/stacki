// Goal: the style selectors panel shows what the check found, locks a name into
// .stacki/styles.json, and cleans up only unused selectors with a working undo.
// A stylesheet or folder locked from its heading is written to the same file,
// leaves the Unused count and the cleanup, and comes back when unlocked.
// Method: render the real panel in JSDOM with its bridge wired to the real
// main-process functions over a temporary project on disk, click through
// lock, clean-up and undo, and compare the files' bytes after each step.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkSelectorUsage, removeUnusedSelectors, restoreSelectorFiles } = require('#dist/electron/properties/selectorRemoval.js');
const { readProjectMetadata, writeProjectMetadata } = require('#dist/electron/project/projectMetadata.js');
const { EMPTY_KEEP_LIST, parseStyleKeepList } = require('#dist/shared/properties/styleKeepList.js');
const { repoPath } = require('../../helpers/sources.js');

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const CSS = '.hero { a: b }\n.ghost { a: b }\n.is-open { a: b }\n';

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-selectors-panel-'));
  const files = {
    'src/styles/global.css': CSS,
    'src/pages/index.astro': '---\n---\n<h1 class="hero">Hi</h1>\n',
    'node_modules/lib/index.js': 'export {};\n',
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

function keepList(root) {
  const stored = readProjectMetadata(root, 'styles');
  return stored.ok && stored.value.source !== undefined ? parseStyleKeepList(JSON.parse(stored.value.source)) : EMPTY_KEEP_LIST;
}

function bridge(root) {
  return {
    selectorUsage: async () => ({ ok: true, value: (await checkSelectorUsage(root, keepList(root))).report }),
    removeSelectors: async (input) => removeUnusedSelectors(root, keepList(root), { ids: input.ids, files: input.files }),
    restoreSelectors: async (input) => restoreSelectorFiles(root, input.changes, input.to),
    projectMetadata: async (input) => readProjectMetadata(root, input.kind),
    writeProjectMetadata: async (input) => writeProjectMetadata(root, input.write),
    onCssChanged: () => () => {},
    onFsChanged: () => () => {},
  };
}

async function load() {
  const esbuild = require('esbuild');
  const bundle = repoPath('node_modules/.stacki-test/selectors-panel.bundle.js');
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  await esbuild.build({
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

test('lock, clean up and undo go through to the project files', async () => {
  const root = project();
  const bundle = await load();
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.avb = bridge(root);
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const SelectorsPanel = require(bundle).default;
  const toasts = [];
  const undos = [];
  const container = document.getElementById('root');
  const reactRoot = createRoot(container);
  const rows = () =>
    [...container.querySelectorAll('.selectors-row')].map(
      (row) => `${row.querySelector('.selectors-selector').textContent}:${/is-(\w+)/.exec(row.className)[1]}`,
    );
  // The panel re-reads the project after each write; a slow runner (Windows CI)
  // can take longer than one click's settle, so rows are awaited, within a bound.
  const rowsAre = async (expected) => {
    for (let attempt = 0; attempt < 50 && JSON.stringify(rows()) !== JSON.stringify(expected); attempt += 1) {
      await act(async () => settle(40));
    }
    assert.deepEqual(rows(), expected);
  };
  const click = async (element) =>
    act(async () => {
      element.click();
      await settle(80);
    });
  try {
    await act(async () => {
      reactRoot.render(
        React.createElement(SelectorsPanel, {
          project: { path: root },
          showToast: (message, kind) => toasts.push([message, kind]),
          onRecordUndo: (command) => undos.push(command),
        }),
      );
      await settle(120);
    });
    // The first check reads the whole project; wait for it, within a bound.
    for (let attempt = 0; attempt < 50 && rows().length === 0; attempt += 1) {
      await act(async () => settle(40));
    }
    // It opens on the clean-up: only what can go.
    await rowsAre(['.ghost:unused', '.is-open:unused']);

    // One row's trash removes just that style, and undo puts it back.
    const ghostRow = [...container.querySelectorAll('.selectors-row')].find((row) => row.textContent.includes('.ghost'));
    await click(ghostRow.querySelector('.selectors-remove-one'));
    assert.equal(fs.readFileSync(path.join(root, 'src/styles/global.css'), 'utf8'), '.hero { a: b }\n.is-open { a: b }\n');
    assert.deepEqual(toasts.at(-1), ['Removed 1 unused style', 'success']);
    await act(async () => {
      await undos[0].undo();
      await settle(80);
    });
    assert.equal(fs.readFileSync(path.join(root, 'src/styles/global.css'), 'utf8'), CSS);
    await click([...container.querySelectorAll('.selectors-tab')].find((tab) => tab.textContent.startsWith('All')));
    await rowsAre(['.hero:used', '.ghost:unused', '.is-open:unused']);

    const openRow = [...container.querySelectorAll('.selectors-row')].find((row) => row.textContent.includes('.is-open'));
    await click(openRow.querySelector('.selectors-lock'));
    assert.deepEqual(keepList(root).keep, ['is-open']);
    await rowsAre(['.hero:used', '.ghost:unused', '.is-open:kept']);
    // A Locked tab appears once something is locked, and unlocking from it works.
    await click([...container.querySelectorAll('.selectors-tab')].find((tab) => tab.textContent.startsWith('Locked')));
    await rowsAre(['.is-open:kept']);
    await click(container.querySelector('.selectors-lock'));
    assert.deepEqual(keepList(root).keep, []);
    await click([...container.querySelectorAll('.selectors-tab')].find((tab) => tab.textContent.startsWith('All')));
    await click([...container.querySelectorAll('.selectors-row')].find((row) => row.textContent.includes('.is-open')).querySelector('.selectors-lock'));
    assert.deepEqual(keepList(root).keep, ['is-open']);

    await click(container.querySelector('[aria-label="Clean up unused styles"]'));
    const listed = [...container.querySelectorAll('.selectors-selector')].map((selector) => selector.textContent);
    assert.deepEqual(listed, ['.ghost'], 'the confirmation lists only unused selectors');
    await click([...container.querySelectorAll('button')].find((button) => button.textContent === 'Remove style'));
    assert.equal(fs.readFileSync(path.join(root, 'src/styles/global.css'), 'utf8'), '.hero { a: b }\n.is-open { a: b }\n');
    assert.deepEqual(toasts.at(-1), ['Removed 1 unused style', 'success']);
    await rowsAre(['.hero:used', '.is-open:kept']);

    assert.equal(undos.length, 2);
    await act(async () => {
      await undos[1].undo();
      await settle(80);
    });
    assert.equal(fs.readFileSync(path.join(root, 'src/styles/global.css'), 'utf8'), CSS);
    await act(async () => {
      await undos[1].redo();
      await settle(80);
    });
    assert.equal(fs.readFileSync(path.join(root, 'src/styles/global.css'), 'utf8'), '.hero { a: b }\n.is-open { a: b }\n');
  } finally {
    await act(async () => reactRoot.unmount());
    dom.window.close();
  }
});

async function mountPanel(root, bundle) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.avb = bridge(root);
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const SelectorsPanel = require(bundle).default;
  const container = document.getElementById('root');
  const reactRoot = createRoot(container);
  await act(async () => {
    reactRoot.render(React.createElement(SelectorsPanel, { project: { path: root }, showToast: () => undefined, onRecordUndo: () => undefined }));
    await settle(120);
  });
  const waitFor = async (check) => {
    for (let attempt = 0; attempt < 50 && !check(); attempt += 1) {
      await act(async () => settle(40));
    }
    assert.ok(check(), container.innerHTML.slice(0, 2000));
  };
  const click = async (element) =>
    act(async () => {
      element.click();
      await settle(80);
    });
  const close = async () => {
    await act(async () => reactRoot.unmount());
    dom.window.close();
  };
  return { container, waitFor, click, close };
}

test('a stylesheet or folder locked from its heading is kept out of the Unused count and the cleanup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-selectors-locks-'));
  const files = {
    'src/styles/patterns.css': '.pattern-a { a: b }\n.pattern-b { a: b }\n',
    'src/styles/global.css': '.gone { a: b }\n',
    'src/components/Card.astro': '---\n---\n<div class="card">x</div>\n<style>\n.card { a: b }\n.title { a: b }\n</style>\n',
    'node_modules/lib/index.js': 'export {};\n',
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  const panel = await mountPanel(root, await load());
  const { container, waitFor, click } = panel;
  const unusedCount = () => container.querySelector('[data-tab="unused"] .selectors-tab-count')?.textContent;
  const lockedTabCount = () => container.querySelector('[data-tab="kept"] .selectors-tab-count')?.textContent;
  const button = (label) => container.querySelector(`[aria-label="${label}"]`);
  const lockedSheets = () => keepList(root).lockedStylesheets;
  try {
    await waitFor(() => unusedCount() === '4');
    // Two folders, so each has a heading with its own lock; the root files have none.
    assert.deepEqual([...container.querySelectorAll('.selectors-folder .selectors-heading-name')].map((heading) => heading.textContent).sort(), [
      'src/components/',
      'src/styles/',
    ]);
    assert.ok(button('Lock src/styles/ from cleanup'));
    const lock = button('Lock patterns.css from cleanup');
    assert.equal(lock.closest('[title]').getAttribute('title'), 'Lock patterns.css from cleanup');

    // Lock the file: persisted, folded into a note, out of the Unused count.
    await click(lock);
    assert.deepEqual(lockedSheets(), ['src/styles/patterns.css']);
    await waitFor(() => unusedCount() === '2');
    assert.equal(lockedTabCount(), '2');
    assert.match(container.textContent, /Locked: 2 unused styles kept/);
    assert.equal(button('Unlock patterns.css').closest('[title]').getAttribute('title'), 'Unlock');
    assert.equal(button('Unlock patterns.css').getAttribute('aria-pressed'), 'true');

    // The cleanup lists only what it will remove.
    await click(button('Clean up unused styles'));
    assert.deepEqual([...container.querySelectorAll('.selectors-selector')].map((selector) => selector.textContent).sort(), ['.gone', '.title']);
    await click([...container.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Cancel'));

    // Lock the folder: every sheet under it, the file's own lock held by the folder.
    await click(button('Lock src/styles/ from cleanup'));
    assert.deepEqual(lockedSheets(), ['src/styles/', 'src/styles/patterns.css']);
    await waitFor(() => unusedCount() === '1');
    // global.css is locked through the folder: shown locked, toggled at the folder.
    assert.equal(button('Locked with src/styles/').disabled, true);
    assert.match(container.textContent, /Locked: 1 unused style kept/);
    // patterns.css keeps its own entry, so it can still be unlocked on its own.
    assert.ok(button('Unlock patterns.css'));

    // Unlock both: normal behaviour returns.
    await click(button('Unlock src/styles/'));
    await click(button('Unlock patterns.css'));
    assert.deepEqual(lockedSheets(), []);
    await waitFor(() => unusedCount() === '4');
    assert.doesNotMatch(container.textContent, /Locked:/);
    assert.equal(fs.readFileSync(path.join(root, 'src/styles/patterns.css'), 'utf8'), files['src/styles/patterns.css']);
  } finally {
    await panel.close();
  }
});
