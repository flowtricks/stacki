// Getting rid of an asset.
//
//   node test/asset-delete.js
//
// The assets panel could upload, rename, move and make folders, and had no way
// at all to delete one — the only way out was the Finder.
//
// A `⋯` on the tile opens a menu with Delete in it. On the tile, because that
// is the thing being deleted; only while the pointer is on it, because an asset
// grid is a wall of pictures and a button in the corner of every one of them is
// a wall of buttons. And it asks first: the app holds no copy of the file, the
// pages pointing at it are files this panel never reads, and the answer to
// "where did it go" has to be somewhere the person can go and get it.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const entry = path.join(buildDir, 'asset-delete.entry.jsx');
  fs.writeFileSync(
    entry,
    `export { default as AssetsPanel } from ${JSON.stringify(
      path.join(__dirname, '..', 'src', 'panels', 'AssetsPanel.jsx')
    )};\n` +
      `export { ConfirmHost } from ${JSON.stringify(
        path.join(__dirname, '..', 'src', 'ui', 'ConfirmDialog.jsx')
      )};\n`
  );
  const bundle = path.join(buildDir, 'asset-delete.bundle.js');
  await esbuild.build({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.MouseEvent = dom.window.MouseEvent;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  global.ResizeObserver = dom.window.ResizeObserver;

  // The listing the main process sends: every entry knows the folder it is in,
  // and the panel shows the ones whose parent is the folder it is looking at.
  const FILES = [
    { rel: 'public/photo.jpg', name: 'photo.jpg', parent: 'public', abs: '/p/public/photo.jpg', isDir: false, size: 12 },
    { rel: 'public/notes.txt', name: 'notes.txt', parent: 'public', abs: '/p/public/notes.txt', isDir: false, size: 4 },
  ];
  const deleted = [];
  const toasts = [];
  dom.window.avb = {
    listAssets: async () => ({
      entries: [{ rel: 'public', name: 'public', parent: '', isDir: true }, ...FILES],
    }),
    onAssetsChanged: () => () => {},
    deleteAsset: async ({ rel }) => { deleted.push(rel); return { ok: true } },
    renameAsset: async () => ({ ok: true }),
    moveAsset: async () => ({ ok: true }),
    assetThumb: async () => ({ dataUrl: null }),
    getFilePath: () => '',
  };

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  // The app mounts one of these for the whole window; the confirm resolves
  // through it, so a test that asks a question needs it too.
  const { AssetsPanel, ConfirmHost } = require(bundle);
  const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

  const container = document.getElementById('root');
  const root = createRoot(container);
  const render = async (props) => {
    await act(async () => {
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(AssetsPanel, {
            project: { path: '/p' },
            showToast: (m) => toasts.push(m),
            onOpenFile: () => {},
            onRecordUndo: () => {},
            ...props,
          }),
          React.createElement(ConfirmHost)
        )
      );
      await settle(60);
    });
  };
  await render({});
  // The panel opens above the roots, where there are only folders. Step into
  // the one holding the files.
  await act(async () => {
    container.querySelector('.asset-folder')?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await settle(30);
  });

  const tiles = () => [...container.querySelectorAll('.asset-tile')];
  const menuButton = (i) => tiles()[i]?.querySelector('.asset-tile-menu');
  const rows = () => [...document.querySelectorAll('.more-menu-item')].map((b) => b.textContent.trim());
  // A missing button is a FAILURE to report, not a stack trace: every check
  // after it would otherwise be lost.
  const press = async (el, what = 'something to press') => {
    if (!el) { check(`there is ${what}`, false); return false }
    await act(async () => {
      el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await settle(20);
    });
    return true;
  };

  // --- the tile has one, and only one thing in it ---------------------------------
  check('the assets are on screen', tiles().length === 2, String(tiles().length));
  check('every tile has a menu button', tiles().every((t) => t.querySelector('.asset-tile-menu')));
  check('which says what it is for', /photo\.jpg/.test(menuButton(0)?.getAttribute('aria-label') || ''), menuButton(0)?.getAttribute('aria-label'));
  check('and nothing is open yet', rows().length === 0, rows().join());

  await press(menuButton(0), 'a menu button on the first tile');
  check('pressing it opens a menu', rows().length > 0, container.innerHTML.slice(0, 160));
  check('with Delete in it', rows().includes('Delete'), rows().join());
  check('and nothing else', rows().length === 1, rows().join());

  // --- it asks before it does it ---------------------------------------------------
  //
  // The confirm is the app's own dialog, which resolves when a button in it is
  // pressed. Answering no is the case that matters most here.
  const dialog = () => document.querySelector('.confirm-dialog, .confirm, [role="alertdialog"]');
  const answer = async (label) => {
    const button = [...document.querySelectorAll('button')].find(
      (b) => b.textContent.trim().toLowerCase() === label
    );
    if (!button) return false;
    await press(button, `a "${label}" button`);
    await act(async () => { await settle(40) });
    return true;
  };

  const deleteRow = () => [...document.querySelectorAll('.more-menu-item')].find((b) => b.textContent.trim() === 'Delete');
  await press(deleteRow(), 'a Delete row');
  check('choosing Delete asks first', !!dialog(), document.body.innerHTML.slice(-200));
  check('and has not deleted anything yet', deleted.length === 0, deleted.join());

  const said = await answer('cancel');
  check('the dialog can be answered', said, [...document.querySelectorAll('button')].map((b) => b.textContent).join('|'));
  check('saying no deletes nothing', deleted.length === 0, deleted.join());

  await press(menuButton(0), 'the menu button again');
  await press(deleteRow(), 'the Delete row again');
  await answer('delete');
  check('saying yes deletes the file it was opened on', deleted.join() === 'public/photo.jpg', deleted.join());

  // --- and never while an asset is being picked -------------------------------------
  //
  // Choosing an asset for a prop is the whole gesture then, and a menu in the
  // corner of the tile is a way to lose the file instead of using it.
  await render({ pick: { mediaKind: 'image', current: 'public/photo.jpg', onPick: () => {} } });
  check('picking hides the menus', tiles().every((t) => !t.querySelector('.asset-tile-menu')), container.innerHTML.slice(0, 200));

  // --- the file goes somewhere it can be got back from --------------------------------
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const handler = main.slice(main.indexOf("ipcMain.handle('assets:delete'"), main.indexOf("// Text assets (css/js"));
  check('deleting sends the file to the bin', /shell\.trashItem\(abs\)/.test(handler), handler.slice(0, 300));
  check('never unlinks it outright', !/unlinkSync|rmSync/.test(handler), handler.slice(0, 300));
  check('and only inside the asset roots', /assetAbs\(projectPath, rel\)/.test(handler), handler.slice(0, 200));
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'panels', 'AssetsPanel.jsx'), 'utf8');
  check('the dialog says where it went', /moves to your Bin/.test(panel), 'the confirm does not say what happens');

  if (failures.length) {
    console.error(`\nasset-delete: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`asset-delete: ${checked} passed  [the ⋯ on a tile]`);
  process.exit(0);
})();
