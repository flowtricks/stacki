// Goal: undoing an asset move puts back the file that moved. A move onto a taken name lands as `name-1`, so Undo must move that
// file, leave the one already in the folder where it is, and give the returned file its own name again, since pages still
// reference it. A move onto a free name undoes and redoes as it always has.
// Method: mount the real Assets panel in jsdom over the real asset handlers on a temporary project, drop a file on a folder
// tile, run the undo step the panel recorded, and read the files on disk.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { waitFor } = require('../../helpers/waitFor.js');
const { registerAssetHandlers } = require('#dist/electron/handlers/assetHandlers.js');

const output = repoPath('node_modules/.stacki-test/asset-move-undo.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  entryPoints: [repoPath('src/features/assets/AssetsPanel.tsx')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty', '.svg': 'empty' },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
require('../../helpers/popupDom').installPopupDOM(dom.window);
global.window = dom.window;
for (const name of ['document', 'navigator', 'Element', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'localStorage']) {
  Object.defineProperty(global, name, { value: dom.window[name], configurable: true, writable: true });
}
global.IS_REACT_ACT_ENVIRONMENT = true;
global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
dom.window.ResizeObserver = global.ResizeObserver;

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const AssetsPanel = require(output).default;

test('undoing a move onto a taken name returns the moved file under its own name', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-asset-move-'));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
    fs.writeFileSync(path.join(project, rel), text);
  };
  const read = (rel) => (fs.existsSync(path.join(project, rel)) ? fs.readFileSync(path.join(project, rel), 'utf8') : undefined);
  write('public/hero.txt', 'moved');
  write('public/images/hero.txt', 'already there');
  const handlers = new Map();
  registerAssetHandlers({
    assertInProject: (file) => file,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    noteAppWrite: () => {},
    send: () => {},
    shell: { trashItem: async () => {} },
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  });
  const call = (channel) => async (payload) => handlers.get(channel)({}, typeof payload === 'string' ? payload : { ...payload });
  dom.window.avb = {
    listAssets: call('assets:list'),
    moveAsset: call('assets:move'),
    renameAsset: call('assets:rename'),
    assetThumb: async () => ({ dataUrl: undefined }),
    onAssetsChanged: () => () => {},
    mediaConnections: async () => ({ encryption: 'available', connections: [] }),
  };
  const steps = [];
  const toasts = [];
  const root = createRoot(document.getElementById('root'));
  const folder = (name) => [...document.querySelectorAll('.asset-folder')].find((tile) => tile.textContent.includes(name));
  const shown = (what, read) =>
    waitFor({
      what,
      read: async () => {
        await act(async () => undefined);
        return read() !== undefined;
      },
      until: Boolean,
    });
  try {
    await act(async () =>
      root.render(
        React.createElement(AssetsPanel, {
          project: { path: project },
          showToast: (message) => toasts.push(message),
          onOpenFile: () => {},
          onRecordUndo: (step) => steps.push(step),
        }),
      ),
    );
    await shown('the public root', () => folder('public'));
    await act(async () => folder('public').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    await shown('the images folder', () => folder('images'));
    const drop = new dom.window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', {
      value: { getData: (type) => (type === 'avb/asset' ? 'public/hero.txt' : ''), types: ['avb/asset'], files: [] },
    });
    await act(async () => folder('images').dispatchEvent(drop));
    await shown('the recorded undo step', () => steps[0]);
    assert.equal(read('public/images/hero-1.txt'), 'moved');

    await act(async () => steps[0].undo());
    assert.equal(read('public/hero.txt'), 'moved', 'the moved file is back under its own name');
    assert.equal(read('public/images/hero.txt'), 'already there', 'the file that was already there never moved');
    assert.equal(read('public/images/hero-1.txt'), undefined);

    await act(async () => steps[0].redo());
    assert.equal(read('public/images/hero-1.txt'), 'moved');
    await act(async () => steps[0].undo());
    assert.equal(read('public/hero.txt'), 'moved');
    assert.equal(read('public/images/hero.txt'), 'already there');
    assert.deepEqual(toasts, []);
  } finally {
    await act(async () => root.unmount());
    fs.rmSync(project, { recursive: true, force: true });
  }
});
