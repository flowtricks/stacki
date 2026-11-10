// Getting rid of an asset.
//
//   node test/renderer/assets/assetDelete.test.js
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
const { repoPath } = require('../../helpers/sources.js');
const { readSource } = require('../../helpers/sourceText.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const entry = path.join(buildDirectory, 'asset-delete.entry.jsx');
  fs.writeFileSync(
    entry,
    `export { default as AssetsPanel } from ${JSON.stringify(repoPath('src/features/assets/AssetsPanel.tsx'))};\n` +
      `export { ConfirmHost } from ${JSON.stringify(repoPath('src/ui/ConfirmDialog.tsx'))};\n`,
  );
  const bundle = path.join(buildDirectory, 'asset-delete.bundle.js');
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
  require('../../helpers/popupDom').installPopupDOM(dom.window);
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
  dom.window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  global.ResizeObserver = dom.window.ResizeObserver;

  // The listing the main process sends: every entry knows the folder it is in,
  // and the panel shows the ones whose parent is the folder it is looking at.
  const FILES = [
    {
      rel: 'public/photo.jpg',
      name: 'photo.jpg',
      parent: 'public',
      abs: '/p/public/photo.jpg',
      isDir: false,
      size: 12,
    },
    {
      rel: 'public/notes.txt',
      name: 'notes.txt',
      parent: 'public',
      abs: '/p/public/notes.txt',
      isDir: false,
      size: 4,
    },
  ];
  FILES.push(
    ...['arrow.svg', 'type.woff2', 'clip.mp4'].map((name) => ({
      rel: 'public/' + name,
      name,
      parent: 'public',
      abs: '/p/public/' + name,
      isDir: false,
      size: 12,
    })),
  );
  const deleted = [];
  const toasts = [];
  dom.window.avb = {
    listAssets: async () => ({
      entries: [
        {
          rel: 'public',
          name: 'public',
          parent: '',
          root: 'public',
          isDir: true,
          isRoot: true,
        },
        ...FILES.map((file) => ({ ...file, root: 'public' })),
      ],
      missing: false,
    }),
    onAssetsChanged: () => () => {},
    deleteAsset: async ({ rel }) => {
      deleted.push(rel);
      return { ok: true };
    },
    renameAsset: async () => ({ ok: true }),
    moveAsset: async () => ({ ok: true }),
    assetThumb: async () => ({ dataUrl: undefined }),
    getFilePath: () => '',
    // No media hosts connected: the panel shows the project alone.
    mediaConnections: async () => ({ encryption: 'available', connections: [] }),
  };

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  // The app mounts one of these for the whole window; the confirm resolves
  // through it, so a test that asks a question needs it too.
  const { AssetsPanel, ConfirmHost } = require(bundle);
  const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

  const container = document.getElementById('root');
  const root = createRoot(container);
  const render = async (props) => {
    await act(async () => {
      root.render(
        React.createElement(
          React.Fragment,
          {},
          React.createElement(AssetsPanel, {
            project: { path: '/p' },
            showToast: (message) => toasts.push(message),
            onOpenFile: () => {},
            onRecordUndo: () => {},
            ...props,
          }),
          React.createElement(ConfirmHost),
        ),
      );
      await settle(60);
    });
  };
  await render({});
  // The panel opens on the project, its trail starting with the source picker.
  check('the heading is the project source', container.querySelector('.panel-header [aria-label="Switch source"]')?.textContent.trim() === 'Project');
  // The project opens above the roots, where there are only folders. Step into
  // the one holding the files.
  await act(async () => {
    container.querySelector('.asset-folder')?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await settle(30);
  });

  const tiles = () => [...container.querySelectorAll('.asset-tile')];
  const menuButton = (i) => tiles()[i]?.querySelector('.asset-tile-menu');
  const rows = () => [...document.querySelectorAll('.more-menu-item')].map((item) => item.textContent.trim());
  // A missing button is a FAILURE to report, not a stack trace: every check
  // after it would otherwise be lost.
  const press = async (element, what = 'something to press') => {
    if (!element) {
      check(`there is ${what}`, false);
      return false;
    }
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await settle(20);
    });
    return true;
  };

  // --- the tile has one, and only one thing in it ---------------------------------
  check('the assets are on screen', tiles().length === 5, String(tiles().length));
  check(
    'every tile has a menu button',
    tiles().every((tile) => tile.querySelector('.asset-tile-menu')),
  );
  check('which says what it is for', /photo\.jpg/.test(menuButton(0)?.getAttribute('aria-label') || ''), menuButton(0)?.getAttribute('aria-label'));
  check('and nothing is open yet', rows().length === 0, rows().join());

  await press(menuButton(0), 'a menu button on the first tile');
  check('pressing it opens a menu', rows().length > 0, container.innerHTML.slice(0, 160));
  check('with Delete in it', rows().includes('Delete'), rows().join());
  check('with link, compression and replacement before it', rows().join('|') === 'Copy link|Compress…|Replace…|Delete', rows().join());

  // --- it asks before it does it ---------------------------------------------------
  //
  // The confirm is the app's own dialog, which resolves when a button in it is
  // pressed. Answering no is the case that matters most here.
  const dialog = () => document.querySelector('.confirm-dialog, .confirm, [role="alertdialog"]');
  const answer = async (label) => {
    const button = [...document.querySelectorAll('button')].find((button) => button.textContent.trim().toLowerCase() === label);
    if (!button) {
      return false;
    }
    await press(button, `a "${label}" button`);
    await act(async () => {
      await settle(40);
    });
    return true;
  };

  const deleteRow = () => [...document.querySelectorAll('.more-menu-item')].find((button) => button.textContent.trim() === 'Delete');
  await press(deleteRow(), 'a Delete row');
  check('choosing Delete asks first', !!dialog(), document.body.innerHTML.slice(-200));
  check('and has not deleted anything yet', deleted.length === 0, deleted.join());

  check('the dialog says where it went', /moves to your Bin/.test(dialog()?.textContent ?? ''), 'the confirm does not say what happens');
  const said = await answer('cancel');
  check('the dialog can be answered', said, [...document.querySelectorAll('button')].map((button) => button.textContent).join('|'));
  check('saying no deletes nothing', deleted.length === 0, deleted.join());

  await press(menuButton(0), 'the menu button again');
  await press(deleteRow(), 'the Delete row again');
  await answer('delete');
  check('saying yes deletes the file it was opened on', deleted.join() === 'public/photo.jpg', deleted.join());

  // Selection uses the whole tile and takes every kind of file: Delete applies
  // to all of them. Compress takes the images it can re-encode and says what it skips.
  await answer('select');
  const byName = (name) => tiles().find((tile) => tile.querySelector('.asset-name')?.textContent === name);
  check(
    'no tile is disabled or dimmed',
    tiles().every((tile) => !tile.querySelector('input').disabled && !tile.classList.contains('is-disabled')),
  );
  for (const name of ['arrow.svg', 'type.woff2', 'clip.mp4']) {
    await press(byName(name)?.querySelector('.asset-name'), `the ${name} tile`);
    check(`${name} can be selected`, byName(name)?.querySelector('input').checked === true);
  }
  await press(byName('photo.jpg')?.querySelector('.asset-name'));
  check('clicking the name selects the entire image tile', byName('photo.jpg')?.querySelector('input').checked === true);
  await press(byName('photo.jpg')?.querySelector('input'));
  check('clicking the checkbox toggles only once', !byName('photo.jpg')?.querySelector('input').checked);
  const compressButton = () => container.querySelector('[aria-label="Compress selected assets"]');
  check('Compress is off with no image selected', compressButton()?.disabled === true);
  check('and says why', /only PNG, JPEG, WebP, AVIF and TIFF/.test(compressButton()?.title ?? ''), compressButton()?.title);
  await press(container.querySelector('.asset-select-all'));
  check(
    'select all takes every file',
    tiles().every((tile) => tile.querySelector('input').checked),
  );
  check('Compress now names what it skips', /Compress 1 image; 4 other files are skipped/.test(compressButton()?.title ?? ''), compressButton()?.title);
  await press(compressButton());
  const compression = () => document.querySelector('.asset-compression-dialog');
  check('compression opens one format dialog', !!compression());
  check('AVIF is selected by default', compression().querySelector('[value=avif]').checked);
  const converted = [];
  dom.window.avb.convertAsset = async (payload) => {
    converted.push(payload);
    return { rel: 'public/photo.webp', references: 1, bytesBefore: 12, bytesAfter: 8 };
  };
  await press(compression().querySelector('[value=webp]'));
  await press(compression().querySelector('button.primary'));
  check(
    'compress converts only the image, skipping SVG, text, font and video',
    converted.length === 1 && converted[0].rel === 'public/photo.jpg' && converted[0].format === 'webp',
  );
  check('compression closes its dialog without a second confirmation', !compression() && !dialog());
  // Delete takes the rest, whatever their kind.
  deleted.length = 0;
  for (const name of ['arrow.svg', 'type.woff2', 'clip.mp4', 'notes.txt']) {
    if (!byName(name)?.querySelector('input').checked) {
      await press(byName(name)?.querySelector('.asset-name'), `the ${name} tile`);
    }
  }
  await press(container.querySelector('[aria-label="Delete selected assets"]'));
  await answer('delete');
  await act(async () => {
    await settle(60);
  });
  check(
    'Delete removes SVG, font, video and text files',
    ['public/arrow.svg', 'public/type.woff2', 'public/clip.mp4', 'public/notes.txt'].every((rel) => deleted.includes(rel)),
    deleted.join(),
  );
  await answer('cancel');

  // --- and never while an asset is being picked -------------------------------------
  //
  // Choosing an asset for a prop is the whole gesture then, and a menu in the
  // corner of the tile is a way to lose the file instead of using it.
  await render({ pick: { mediaKind: 'image', current: 'public/photo.jpg', onPick: () => {} } });
  check(
    'picking hides the menus',
    tiles().every((tile) => !tile.querySelector('.asset-tile-menu')),
    container.innerHTML.slice(0, 200),
  );

  // --- the file goes somewhere it can be got back from --------------------------------
  const handlers = readSource('electron/handlers/assetHandlers.ts');
  const handler = handlers.slice(handlers.indexOf("ipcMain.handle('assets:delete'"), handlers.indexOf('// Text assets (css/js'));
  check('deleting sends the file to the bin', /shell\.trashItem\(abs\)/.test(handler), handler.slice(0, 300));
  check('never unlinks it outright', !/unlinkSync|rmSync/.test(handler), handler.slice(0, 300));
  check('and only inside the asset roots', /assetAbs\(projectPath, rel\)/.test(handler), handler.slice(0, 200));

  if (failures.length) {
    console.error(`\nasset-delete: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`asset-delete: ${checked} passed  [the ⋯ on a tile]`);
  process.exit(0);
})();
