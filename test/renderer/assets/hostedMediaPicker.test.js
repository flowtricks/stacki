// Goal: a connected media host is a source the Assets panel browses and the
// "Choose …" buttons pick from, writing the file's public URL; a field that
// cannot hold a URL is never offered one; and every tile's menu copies the
// asset's link and replaces it in place — for project files and hosted ones.
//
// Method: the real AssetField and AssetsPanel, bundled as the app bundles them,
// render together in jsdom with the window bridge stubbed: one project image,
// one R2 connection holding an image, a PDF and a sub-folder. The app's
// request plumbing (assetPick.ts) is wired as appLifecycle.ts wires it: a
// request re-renders the panel in pick mode, and a pick ends it. Clipboard
// writes, replace calls and toasts are recorded. The pure helpers behind the
// browser (hostedMediaModel.ts, assetLinks.ts) are checked directly first.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const buildDirectory = repoPath('node_modules/.stacki-test/hosted-media-picker');
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const CONNECTION_ID = '00000000-0000-4000-8000-0000000000aa';
const CONNECTION = {
  kind: 'r2',
  id: CONNECTION_ID,
  label: 'Site media',
  accountId: 'a'.repeat(32),
  bucket: 'media',
  publicBaseUrl: 'https://cdn.example.com',
};
const listing = (folder) => ({
  ok: true,
  value: {
    folder,
    folders: folder === '' ? [{ name: 'press', path: 'press' }] : [],
    files:
      folder === ''
        ? [
            { name: 'hero.png', key: 'hero.png', kind: 'image', sizeBytes: 10, modified: undefined, url: 'https://cdn.example.com/hero.png' },
            { name: 'guide.pdf', key: 'guide.pdf', kind: 'file', sizeBytes: 20, modified: undefined, url: 'https://cdn.example.com/guide.pdf' },
          ]
        : [],
    truncated: false,
  },
});

async function bundle() {
  fs.mkdirSync(buildDirectory, { recursive: true });
  const entry = path.join(buildDirectory, 'entry.jsx');
  fs.writeFileSync(
    entry,
    [
      `export { default as AssetsPanel } from ${JSON.stringify(repoPath('src/features/assets/AssetsPanel.tsx'))};`,
      `export { default as AssetField } from ${JSON.stringify(repoPath('src/ui/AssetField.tsx'))};`,
      `export { onAssetRequest, requestAsset, clearAssetRequest } from ${JSON.stringify(repoPath('src/ui/assetPick.ts'))};`,
      `export { ConfirmHost } from ${JSON.stringify(repoPath('src/ui/ConfirmDialog.tsx'))};`,
      `export * from ${JSON.stringify(repoPath('src/features/assets/hostedMediaModel.ts'))};`,
      `export { localAssetLink } from ${JSON.stringify(repoPath('src/features/assets/assetLinks.ts'))};`,
      `export { parseMediaConnectionDraft } from ${JSON.stringify(repoPath('shared/properties/mediaHosting.ts'))};`,
    ].join('\n'),
  );
  const outfile = path.join(buildDirectory, 'bundle.js');
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  return outfile;
}

function installDOM() {
  const dom = new JSDOM('<!doctype html><div id="field"></div><div id="panel"></div>', { pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  for (const key of ['window', 'document', 'Element', 'HTMLElement', 'Node', 'MouseEvent']) {
    global[key] = key === 'window' ? dom.window : dom.window[key];
  }
  // Node has a navigator of its own that plain assignment does not replace.
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  global.ResizeObserver = dom.window.ResizeObserver;
  return dom;
}

test('the model: kinds a pick may choose, drag order, crumbs, drafts and links', async () => {
  const model = require(await bundle());
  assert.equal(model.hostedKindMatches('image', 'image'), true);
  assert.equal(model.hostedKindMatches('image', 'video'), false);
  assert.equal(model.hostedKindMatches('asset', 'file'), true);
  assert.deepEqual(model.movedOrder(['a', 'b', 'c'], { moved: 'c', before: 'a' }), ['c', 'a', 'b']);
  assert.deepEqual(model.movedOrder(['a', 'b', 'c'], { moved: 'a', before: undefined }), ['b', 'c', 'a']);
  const same = ['a', 'b'];
  assert.equal(model.movedOrder(same, { moved: 'a', before: 'a' }), same, 'a drop onto itself changes nothing');
  assert.equal(model.movedOrder(same, { moved: 'gone', before: 'a' }), same);
  assert.deepEqual(
    model.hostedCrumbs('Media', 'a/b').map((crumb) => crumb.folder),
    ['', 'a', 'a/b'],
  );
  const bunny = model.parseMediaConnectionDraft(
    model.draftFields('bunny', { ...model.EMPTY_CONNECT_FIELDS, storageZone: 'zone', publicBaseUrl: 'https://z.b-cdn.net', accessKey: 'pw' }),
  );
  assert.equal(bunny.label, 'Bunny Storage', 'an unnamed connection takes its host’s name');
  assert.equal(bunny.region, 'de');
  assert.throws(() => model.parseMediaConnectionDraft(model.draftFields('r2', model.EMPTY_CONNECT_FIELDS)), /account id/);
  assert.equal(model.localAssetLink('public/images/x.png'), '/images/x.png');
  assert.equal(model.localAssetLink('src/assets/x.png'), '/src/assets/x.png');
  assert.equal(model.formatBytes(2048), '2.0 KB');
});

test('choosing an image from a connected host writes its public URL; menus copy links and replace in place', async () => {
  const outfile = await bundle();
  const dom = installDOM();
  const calls = { replaced: [], hostedReplaced: [], listed: [], clipboard: [], toasts: [], changes: [] };
  dom.window.avb = {
    listAssets: async () => ({
      entries: [
        { rel: 'public', name: 'public', parent: '', root: 'public', isDir: true, isRoot: true },
        { rel: 'public/photo.jpg', name: 'photo.jpg', parent: 'public', root: 'public', abs: '/p/public/photo.jpg', isDir: false, size: 12 },
      ],
      missing: false,
    }),
    onAssetsChanged: () => () => {},
    getFilePath: () => '',
    mediaConnections: async () => ({ encryption: 'available', connections: [CONNECTION] }),
    listHostedMedia: async (input) => {
      calls.listed.push(input);
      return listing(input.folder);
    },
    replaceAsset: async (input) => {
      calls.replaced.push(input.rel);
      return { ok: true, value: true };
    },
    replaceHostedMedia: async (input) => {
      calls.hostedReplaced.push(`${input.folder}|${input.name}`);
      return listing(input.folder);
    },
  };
  Object.defineProperty(dom.window.navigator, 'clipboard', {
    value: { writeText: async (text) => calls.clipboard.push(text) },
  });
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const { AssetsPanel, AssetField, ConfirmHost, onAssetRequest, clearAssetRequest } = require(outfile);
  const fieldRoot = createRoot(document.getElementById('field'));
  const panelRoot = createRoot(document.getElementById('panel'));
  let pick;
  const renderPanel = () =>
    act(async () => {
      panelRoot.render(
        React.createElement(
          React.Fragment,
          {},
          React.createElement(AssetsPanel, {
            project: { path: '/p' },
            showToast: (message, kind) => calls.toasts.push(`${kind}:${message}`),
            pick,
            onPickCancel: () => clearAssetRequest(),
          }),
          React.createElement(ConfirmHost),
        ),
      );
      await settle(60);
    });
  // As appLifecycle.ts does: each pick ends the request.
  onAssetRequest((request) => {
    pick =
      request &&
      Object.assign({}, request, {
        onPick: (rel, entry) => {
          request.onPick(rel, entry);
          clearAssetRequest();
        },
        ...(request.onPickURL ? { onPickURL: (url) => (request.onPickURL(url), clearAssetRequest()) } : {}),
      });
    void renderPanel();
  });
  const click = (element) =>
    act(async () => {
      assert.ok(element, 'the element to press is on screen');
      element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await settle(40);
    });
  // The heading is the source switcher, one shared Dropdown trigger labelled
  // "Switch source", whose options list every source. The trail below starts at
  // "Assets", the source's top.
  const picker = () => document.querySelector('#panel .panel-header [aria-label="Switch source"]');
  const heading = () => picker()?.textContent.trim();
  const crumb = (label) => [...document.querySelectorAll('#panel .asset-crumbs .crumb')].find((item) => item.textContent.trim() === label);
  const options = () => [...document.querySelectorAll('.dd-option')];
  const sources = async () => {
    await click(picker());
    const listed = options().map((option) => ({ label: option.textContent.trim(), checked: Boolean(option.querySelector('.dd-check svg')) }));
    await act(async () => {
      document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      picker()?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle(20);
    });
    return listed;
  };
  const pickSource = async (label) => {
    await click(picker());
    await click(options().find((option) => option.textContent.trim() === label));
  };
  const crumbs = () => [...document.querySelectorAll('#panel .asset-crumbs .crumb')].map((crumb) => crumb.textContent.trim());
  const menuRows = () => [...document.querySelectorAll('.more-menu-item')];
  const row = (label) => menuRows().find((item) => item.textContent.trim() === label);

  await act(async () => {
    fieldRoot.render(
      React.createElement(AssetField, { projectPath: '/p', mediaKind: 'image', onChange: (value, immediate) => calls.changes.push([value, immediate]) }),
    );
    await settle(30);
  });
  await renderPanel();
  assert.deepEqual(
    await sources(),
    [
      { label: 'Project', checked: true },
      { label: 'Cloudflare R2 · media', checked: false },
      { label: 'Add connector', checked: false },
    ],
    'the project, each host with its logo, the current one checked, and Add connector',
  );

  // --- Project files: Copy link and Replace on the tile's menu ---------------------
  await click(document.querySelector('#panel .asset-folder'));
  assert.equal(heading(), 'Project', 'the heading names the source');
  assert.ok(document.querySelector('#panel [role="region"][aria-label="Assets"]'), 'the panel is still named Assets');
  assert.deepEqual(crumbs(), ['Assets', 'public'], 'the trail starts at Assets, the source’s top');
  await click(crumb('Assets'));
  assert.deepEqual(crumbs(), ['Assets'], 'the Assets crumb goes to the top, where public/ and src/ are');
  assert.ok(document.querySelector('#panel .asset-folder'), 'which lists the roots');
  await click(picker());
  assert.ok(document.querySelector('.dd-popup'), 'the heading opens the list of sources');
  await act(async () => {
    picker()?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(20);
  });
  await click(document.querySelector('#panel .asset-folder'));
  await click(document.querySelector('#panel .asset-tile .asset-tile-menu'));
  assert.deepEqual(
    menuRows().map((item) => item.textContent.trim()),
    ['Copy link', 'Compress…', 'Replace…', 'Delete'],
  );
  await click(row('Copy link'));
  assert.deepEqual(calls.clipboard, ['/photo.jpg'], 'a public/ file links from the site root');
  assert.deepEqual(calls.toasts, ['success:Link copied']);
  await click(document.querySelector('#panel .asset-tile .asset-tile-menu'));
  await click(row('Replace…'));
  assert.deepEqual(calls.replaced, ['public/photo.jpg'], 'the replacement goes to the same path');
  assert.equal(calls.toasts.at(-1), 'success:Replaced photo.jpg.');

  // --- A hosted source: browse, Copy link, Replace --------------------------------
  await pickSource('Cloudflare R2 · media');
  assert.equal(heading(), 'Cloudflare R2 · media');
  assert.deepEqual(crumbs(), ['Assets'], 'a host’s top is Assets too');
  assert.equal(calls.listed.at(-1)?.connectionId, CONNECTION_ID);
  assert.deepEqual(
    [...document.querySelectorAll('#panel .asset-tile .asset-name')].map((name) => name.textContent),
    ['hero.png', 'guide.pdf'],
  );
  assert.ok(document.querySelector('#panel .asset-tile img[src="https://cdn.example.com/hero.png"]'), 'an image previews from its public URL');
  assert.match(document.querySelector('#panel .asset-tile:nth-child(2) .asset-ext')?.textContent ?? '', /PDF/, 'any other file is a tile with its extension');
  assert.deepEqual(
    [...document.querySelectorAll('#panel .asset-folder-name')].map((name) => name.textContent),
    ['press'],
  );
  await click(document.querySelector('#panel .asset-tile .asset-tile-menu'));
  assert.deepEqual(
    menuRows().map((item) => item.textContent.trim()),
    ['Copy link', 'Open link', 'Replace…', 'Rename', 'Delete'],
  );
  await click(row('Copy link'));
  assert.equal(calls.clipboard.at(-1), 'https://cdn.example.com/hero.png');
  await click(document.querySelector('#panel .asset-tile .asset-tile-menu'));
  await click(row('Replace…'));
  assert.deepEqual(calls.hostedReplaced, ['|hero.png'], 'the replacement goes to the same key');

  // --- Choosing from the field: only matching media, and the URL is written ------
  await click(document.querySelector('#field .af-choose'));
  assert.ok(pick?.onPickURL, 'the field asks with a URL answer');
  assert.ok(document.querySelector('#panel .asset-picking'), 'the panel says it is choosing');
  assert.deepEqual(
    [...document.querySelectorAll('#panel .asset-tile .asset-name')].map((name) => name.textContent),
    ['hero.png'],
    'an image pick hides the PDF',
  );
  await click(document.querySelector('#panel .asset-tile'));
  assert.deepEqual(calls.changes.at(-1), ['https://cdn.example.com/hero.png', true]);
  assert.equal(pick, undefined, 'the pick ended');

  // --- A request that cannot take a URL offers the project only --------------------
  const { requestAsset } = require(outfile);
  const listedBefore = calls.listed.length;
  await act(async () => {
    requestAsset({ mediaKind: 'image', current: '', onPick: () => {} });
    await settle(60);
  });
  assert.deepEqual(
    (await sources()).map((option) => option.label),
    ['Project'],
    'the project alone, with no connector action',
  );
  assert.equal(calls.listed.length, listedBefore, 'and no host is listed for it');
  assert.ok(document.querySelector('#panel .asset-folder, #panel .asset-tile'), 'the project files show instead');
  await act(async () => {
    clearAssetRequest();
    fieldRoot.unmount();
    panelRoot.unmount();
    await settle(10);
  });
});
