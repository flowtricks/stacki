// Goal: the style selectors panel shows what the check found, locks a name into
// .stacki/styles.json, and cleans up only unused selectors with a working undo.
// A stylesheet or folder locked from its heading is written to the same file,
// leaves the Unused tab and the cleanup, shows its rows locked under Locked,
// keeps each row's own lock (which splits the sheet lock) and trash, and
// comes back when unlocked.
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
// Polls a condition the panel reaches through its bridge (a file written, an undo recorded, a
// dialog mounted), within a bound, so a busy machine is waited for instead of failing a fixed pause.
// The assertion that follows is unchanged: this only waits until it can be told.
async function eventually(act, check) {
  for (let attempt = 0; attempt < 200 && !check(); attempt += 1) {
    await act(async () => settle(25));
  }
}
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
    // As electron/handlers/selectorHandlers.ts: a row's own trash (`chosen`) is checked as if no stylesheet were locked.
    removeSelectors: async (input) =>
      removeUnusedSelectors(root, input.reach === 'chosen' ? { ...keepList(root), lockedStylesheets: [] } : keepList(root), {
        ids: input.ids,
        files: input.files,
      }),
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
    await eventually(
      act,
      () =>
        fs.readFileSync(path.join(root, 'src/styles/global.css'), 'utf8') === '.hero { a: b }\n.is-open { a: b }\n' && toasts.length > 0 && undos.length > 0,
    );
    assert.equal(fs.readFileSync(path.join(root, 'src/styles/global.css'), 'utf8'), '.hero { a: b }\n.is-open { a: b }\n');
    assert.deepEqual(toasts.at(-1), ['Removed 1 unused style', 'success']);
    await act(async () => {
      await undos[0].undo();
      await settle(80);
    });
    await eventually(act, () => fs.readFileSync(path.join(root, 'src/styles/global.css'), 'utf8') === CSS);
    assert.equal(fs.readFileSync(path.join(root, 'src/styles/global.css'), 'utf8'), CSS);
    await click([...container.querySelectorAll('.selectors-tab')].find((tab) => tab.textContent.startsWith('All')));
    await rowsAre(['.hero:used', '.ghost:unused', '.is-open:unused']);

    const openRow = [...container.querySelectorAll('.selectors-row')].find((row) => row.textContent.includes('.is-open'));
    await click(openRow.querySelector('.selectors-lock'));
    await eventually(act, () => keepList(root).keep.length === 1);
    assert.deepEqual(keepList(root).keep, ['is-open']);
    await rowsAre(['.hero:used', '.ghost:unused', '.is-open:kept']);
    // A Locked tab appears once something is locked, and unlocking from it works.
    await click([...container.querySelectorAll('.selectors-tab')].find((tab) => tab.textContent.startsWith('Locked')));
    await rowsAre(['.is-open:kept']);
    await click(container.querySelector('.selectors-lock'));
    await eventually(act, () => keepList(root).keep.length === 0);
    assert.deepEqual(keepList(root).keep, []);
    await click([...container.querySelectorAll('.selectors-tab')].find((tab) => tab.textContent.startsWith('All')));
    await click([...container.querySelectorAll('.selectors-row')].find((row) => row.textContent.includes('.is-open')).querySelector('.selectors-lock'));
    await eventually(act, () => keepList(root).keep.length === 1);
    assert.deepEqual(keepList(root).keep, ['is-open']);

    await click(container.querySelector('[aria-label="Clean up unused styles"]'));
    await eventually(act, () => [...container.querySelectorAll('button')].some((button) => button.textContent === 'Remove style'));
    const listed = [...container.querySelectorAll('.selectors-selector')].map((selector) => selector.textContent);
    assert.deepEqual(listed, ['.ghost'], 'the confirmation lists only unused selectors');
    await click([...container.querySelectorAll('button')].find((button) => button.textContent === 'Remove style'));
    await eventually(
      act,
      () => fs.readFileSync(path.join(root, 'src/styles/global.css'), 'utf8') === '.hero { a: b }\n.is-open { a: b }\n' && undos.length === 2,
    );
    assert.equal(fs.readFileSync(path.join(root, 'src/styles/global.css'), 'utf8'), '.hero { a: b }\n.is-open { a: b }\n');
    assert.deepEqual(toasts.at(-1), ['Removed 1 unused style', 'success']);
    await rowsAre(['.hero:used', '.is-open:kept']);

    assert.equal(undos.length, 2);
    await act(async () => {
      await undos[1].undo();
      await settle(80);
    });
    await eventually(act, () => fs.readFileSync(path.join(root, 'src/styles/global.css'), 'utf8') === CSS);
    assert.equal(fs.readFileSync(path.join(root, 'src/styles/global.css'), 'utf8'), CSS);
    await act(async () => {
      await undos[1].redo();
      await settle(80);
    });
    await eventually(act, () => fs.readFileSync(path.join(root, 'src/styles/global.css'), 'utf8') === '.hero { a: b }\n.is-open { a: b }\n');
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
  const undos = [];
  const toasts = [];
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
  const waitFor = async (check) => {
    for (let attempt = 0; attempt < 50 && !check(); attempt += 1) {
      await act(async () => settle(40));
    }
    assert.ok(check(), container.innerHTML.slice(0, 3000));
  };
  const click = async (element) =>
    act(async () => {
      element.click();
      await settle(80);
    });
  const run = async (step) =>
    act(async () => {
      await step();
      await settle(80);
    });
  const close = async () => {
    await act(async () => reactRoot.unmount());
    dom.window.close();
  };
  return { container, waitFor, click, run, undos, toasts, close };
}

test('a stylesheet or folder locked from its heading leaves the Unused tab and the cleanup, and its rows stay lockable and deletable', async () => {
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
  const { container, waitFor, click, run, undos } = panel;
  const count = (tab) => container.querySelector(`[data-tab="${tab}"] .selectors-tab-count`)?.textContent;
  const button = (label) => container.querySelector(`[aria-label="${label}"]`);
  const tab = (name) => [...container.querySelectorAll('.selectors-tab')].find((candidate) => candidate.textContent.startsWith(name));
  const rows = () =>
    [...container.querySelectorAll('.selectors-row')].map((row) => {
      const lock = row.querySelector('.selectors-lock');
      const state = lock === null ? '' : lock.classList.contains('on') ? ':locked' : ':open';
      return `${row.querySelector('.selectors-selector').textContent}:${/is-(\w+)/.exec(row.className)[1]}${state}`;
    });
  const rowOf = (selector) =>
    [...container.querySelectorAll('.selectors-row')].find((row) => row.querySelector('.selectors-selector').textContent === selector);
  const stored = () => keepList(root);
  const patterns = () => fs.readFileSync(path.join(root, 'src/styles/patterns.css'), 'utf8');
  try {
    await waitFor(() => count('unused') === '4');
    // Two folders, so each has a heading with its own lock.
    assert.deepEqual([...container.querySelectorAll('.selectors-folder .selectors-heading-name')].map((heading) => heading.textContent).sort(), [
      'src/components/',
      'src/styles/',
    ]);
    const lock = button('Lock patterns.css from cleanup');
    assert.equal(lock.closest('[title]').getAttribute('title'), 'Lock patterns.css from cleanup');

    // Lock the file: persisted, gone from Unused (no group, no note), counted under Locked.
    // Its rows turn blue in place, then the group closes and is removed.
    await click(lock);
    await waitFor(() => stored().lockedStylesheets.length === 1);
    assert.deepEqual(stored().lockedStylesheets, ['src/styles/patterns.css']);
    await waitFor(() => count('unused') === '2');
    assert.equal(count('kept'), '2');
    await waitFor(() => !/patterns\.css/.test(container.textContent));
    assert.ok(container.querySelector('[aria-label="Unlock patterns.css"]') === null, 'the Unused tab does not list the locked sheet');
    assert.doesNotMatch(container.textContent, /patterns\.css|Locked:/);

    // The cleanup lists only what it will remove.
    await click(button('Clean up unused styles'));
    await waitFor(() => [...container.querySelectorAll('button')].some((candidate) => candidate.textContent === 'Cancel'));
    assert.deepEqual([...container.querySelectorAll('.selectors-selector')].map((selector) => selector.textContent).sort(), ['.gone', '.title']);
    await click([...container.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Cancel'));

    // Under Locked, every row of the locked sheet is blue with its lock closed.
    await click(tab('Locked'));
    await waitFor(() => rows().length === 2);
    assert.deepEqual(rows(), ['.pattern-a:kept:locked', '.pattern-b:kept:locked']);
    assert.equal(button('Unlock patterns.css').closest('[title]').getAttribute('title'), 'Unlock');
    assert.equal(button('Unlock patterns.css').getAttribute('aria-pressed'), 'true');

    // Hover actions: the row's trash deletes that one selector though its sheet is locked.
    const trash = rowOf('.pattern-b').querySelector('.selectors-remove-one');
    assert.ok(trash, 'a sheet-locked row has a trash button');
    await click(trash);
    await waitFor(() => patterns() === '.pattern-a { a: b }\n');
    assert.equal(patterns(), '.pattern-a { a: b }\n');
    await waitFor(() => rows().length === 1);
    await run(() => undos.at(-1).undo());
    await waitFor(() => patterns() === files['src/styles/patterns.css']);
    assert.equal(patterns(), files['src/styles/patterns.css']);
    await waitFor(() => rows().length === 2);

    // Hover actions: the row's lock unlocks it alone, splitting the sheet lock in one write and one undo step.
    const undoCount = undos.length;
    await click(rowOf('.pattern-a').querySelector('.selectors-lock'));
    await waitFor(() => stored().keep.length === 1 && undos.length === undoCount + 1);
    assert.deepEqual(stored().lockedStylesheets, []);
    assert.deepEqual(stored().keep, ['pattern-b']);
    assert.equal(undos.length, undoCount + 1);
    await click(tab('All'));
    await waitFor(() => rows().includes('.pattern-a:unused:open'));
    assert.ok(rows().includes('.pattern-b:kept:locked'));
    assert.ok(button('Lock patterns.css from cleanup'), 'the heading shows the sheet unlocked');
    assert.equal(count('unused'), '3');
    await run(() => undos.at(-1).undo());
    await waitFor(() => stored().keep.length === 0);
    assert.deepEqual(stored().lockedStylesheets, ['src/styles/patterns.css']);
    assert.deepEqual(stored().keep, []);
    await run(() => undos.at(-1).redo());
    await waitFor(() => stored().keep.length === 1);
    assert.deepEqual(stored().keep, ['pattern-b']);

    // Relocking the sheet folds the name lock back into the sheet lock.
    await click(button('Lock patterns.css from cleanup'));
    await waitFor(() => stored().keep.length === 0);
    assert.deepEqual(stored(), { version: 1, keep: [], lockedStylesheets: ['src/styles/patterns.css'] });

    // A folder lock covers every sheet under it; a sheet inside shows it, toggled at the folder.
    await click(button('Lock src/styles/ from cleanup'));
    await waitFor(() => stored().lockedStylesheets.length === 2);
    assert.deepEqual(stored().lockedStylesheets, ['src/styles/', 'src/styles/patterns.css']);
    await waitFor(() => count('unused') === '1');
    assert.equal(button('Locked with src/styles/').disabled, true);
    assert.ok(rows().includes('.gone:kept:locked'));

    // Unlock both: normal behaviour returns.
    await click(button('Unlock src/styles/'));
    await waitFor(() => button('Unlock patterns.css') !== null);
    await click(button('Unlock patterns.css'));
    await waitFor(() => stored().lockedStylesheets.length === 0);
    assert.deepEqual(stored().lockedStylesheets, []);
    await waitFor(() => count('unused') === '4');
    assert.equal(patterns(), files['src/styles/patterns.css']);
  } finally {
    await panel.close();
  }
});

test('locking the last unused stylesheet leaves the user on the Unused tab and shows its empty state', async () => {
  // Goal: the tab only changes when the user picks it. The opening tab (Unused while there is a clean-up)
  // used to be derived live, so emptying Unused jumped the panel to All.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-selectors-lasttab-'));
  const files = {
    'src/styles/patterns.css': '.pattern-a { a: b }\n.pattern-b { a: b }\n',
    'src/pages/index.astro': '---\n---\n<h1 class="hero">Hi</h1>\n',
    'node_modules/lib/index.js': 'export {};\n',
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  const panel = await mountPanel(root, await load());
  const { container, waitFor, click } = panel;
  const count = (tab) => container.querySelector(`[data-tab="${tab}"] .selectors-tab-count`)?.textContent;
  const selected = () => container.querySelector('.selectors-tab.on')?.getAttribute('data-tab');
  try {
    await waitFor(() => count('unused') === '2');
    assert.equal(selected(), 'unused');
    await click(container.querySelector('[aria-label="Lock patterns.css from cleanup"]'));
    await waitFor(() => count('unused') === '0');
    assert.equal(count('kept'), '2');
    // Still on Unused, now empty, instead of All.
    assert.equal(selected(), 'unused');
    await waitFor(() => /No unused styles/.test(container.textContent));
    assert.equal(container.querySelectorAll('.selectors-row').length, 0);
  } finally {
    await panel.close();
  }
});
