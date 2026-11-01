// Goal: the style selectors panel shows what the check found, locks a name into
// .stacki/styles.json, and cleans up only unused selectors with a working undo.
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
      (row) => `${row.querySelector('.selectors-chip').textContent}:${row.className.split('selectors-')[2].trim()}`,
    );
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
    assert.deepEqual(rows(), ['.ghost:unused', '.is-open:unused']);
    assert.match(container.querySelector('.selectors-summary').textContent, /2 unused styles/);
    await click([...container.querySelectorAll('.selectors-tab')].find((tab) => tab.textContent.startsWith('All')));
    assert.deepEqual(rows(), ['.hero:used', '.ghost:unused', '.is-open:unused']);

    const openRow = [...container.querySelectorAll('.selectors-row')].find((row) => row.textContent.includes('.is-open'));
    await click(openRow.querySelector('.selectors-lock'));
    assert.deepEqual(keepList(root).keep, ['is-open']);
    assert.deepEqual(rows(), ['.hero:used', '.ghost:unused', '.is-open:kept']);

    await click([...container.querySelectorAll('button')].find((button) => button.textContent.includes('Review')));
    const listed = [...container.querySelectorAll('.selectors-confirm .selectors-chip')].map((chip) => chip.textContent);
    assert.deepEqual(listed, ['.ghost'], 'the confirmation lists only unused selectors');
    await click([...container.querySelectorAll('button')].find((button) => button.textContent === 'Remove style'));
    assert.equal(fs.readFileSync(path.join(root, 'src/styles/global.css'), 'utf8'), '.hero { a: b }\n.is-open { a: b }\n');
    assert.deepEqual(toasts.at(-1), ['Removed 1 unused style', 'success']);
    assert.deepEqual(rows(), ['.hero:used', '.is-open:kept']);

    assert.equal(undos.length, 1);
    await act(async () => {
      await undos[0].undo();
      await settle(80);
    });
    assert.equal(fs.readFileSync(path.join(root, 'src/styles/global.css'), 'utf8'), CSS);
    await act(async () => {
      await undos[0].redo();
      await settle(80);
    });
    assert.equal(fs.readFileSync(path.join(root, 'src/styles/global.css'), 'utf8'), '.hero { a: b }\n.is-open { a: b }\n');
  } finally {
    await act(async () => reactRoot.unmount());
    dom.window.close();
  }
});
