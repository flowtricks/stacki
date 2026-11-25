// Goal: a font file's tile draws "Aa" in that font on a plain tile, falls back
// to the file tile when the font cannot load, gives every file its own family,
// and takes each face out of the document once no tile shows it — never
// holding more faces than its cap.
// Method: the real AssetThumb and HostedThumb, bundled as the app bundles them,
// render in jsdom with FontFace and document.fonts stood in: a face loads when
// its URL names a good font and rejects otherwise, and document.fonts is a set
// the test reads. Tiles are mounted, unmounted and multiplied past the cap
// through the registry (src/ui/fontPreview.ts) the tiles use.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const buildDirectory = repoPath('node_modules/.stacki-test/font-preview');
const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

async function bundle() {
  fs.mkdirSync(buildDirectory, { recursive: true });
  const entry = path.join(buildDirectory, 'entry.jsx');
  fs.writeFileSync(
    entry,
    [
      `export { default as AssetThumb } from ${JSON.stringify(repoPath('src/ui/AssetThumb.tsx'))};`,
      `export { HostedThumb } from ${JSON.stringify(repoPath('src/features/assets/HostedMediaBrowser.tsx'))};`,
      `export * from ${JSON.stringify(repoPath('src/ui/fontPreview.ts'))};`,
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

test('font tiles: "Aa" in the font, a fallback, one family per file, cleanup and a cap', async () => {
  const outfile = await bundle();
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  for (const key of ['window', 'document', 'Element', 'HTMLElement', 'Node']) {
    global[key] = key === 'window' ? dom.window : dom.window[key];
  }
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const registered = new Set();
  Object.defineProperty(dom.window.document, 'fonts', {
    value: { add: (face) => registered.add(face), delete: (face) => registered.delete(face) },
  });
  global.FontFace = class {
    constructor(family, source) {
      this.family = family;
      this.source = source;
    }
    load() {
      return /broken/.test(this.source) ? Promise.reject(new Error('not a font')) : Promise.resolve(this);
    }
  };
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const { AssetThumb, HostedThumb, FONT_FACES_MAX, acquireFontPreview, releaseFontPreview, heldFontPreviewCount } = require(outfile);
  const root = createRoot(document.getElementById('root'));
  const render = (element) =>
    act(async () => {
      root.render(element);
      await settle();
    });
  const font = (abs) => React.createElement(AssetThumb, { file: { abs, name: path.basename(abs) } });

  await render(React.createElement('div', {}, font('/p/src/assets/fonts/inter.woff2'), font('/p/src/assets/fonts/serif.ttf')));
  const tiles = [...document.querySelectorAll('.asset-thumb')];
  assert.deepEqual(
    tiles.map((tile) => tile.textContent),
    ['Aa', 'Aa'],
  );
  assert.ok(
    tiles.every((tile) => tile.classList.contains('is-font')),
    'a plain tile, not the checkerboard',
  );
  const families = tiles.map((tile) => tile.querySelector('.asset-font').style.fontFamily);
  assert.notEqual(families[0], families[1], 'each file has its own family');
  assert.equal(registered.size, 2);
  assert.match([...registered][0].source, /stacki-asset:\/\/local\//, 'the project file loads through the tiles’ asset URL');

  await render(font('/p/src/assets/fonts/broken.otf'));
  assert.match(document.querySelector('.asset-thumb').textContent, /OTF/, 'a font that cannot load is the file tile');
  assert.equal(document.querySelector('.asset-thumb').classList.contains('is-font'), false);
  assert.equal(registered.size, 0, 'unmounted tiles took their faces out of the document');

  const hosted = {
    name: 'brand.woff',
    key: 'fonts/brand.woff',
    kind: 'file',
    sizeBytes: 1,
    modified: undefined,
    url: 'https://cdn.example.com/fonts/brand.woff',
  };
  await render(React.createElement(HostedThumb, { file: hosted }));
  assert.equal(document.querySelector('.asset-thumb').textContent, 'Aa', 'a host’s font loads from its public URL');
  assert.match([...registered][0].source, /cdn\.example\.com\/fonts\/brand\.woff/);
  await render(React.createElement(HostedThumb, { file: { ...hosted, url: 'https://cdn.example.com/broken.woff' } }));
  assert.match(document.querySelector('.asset-thumb').textContent, /WOFF/);
  await render(React.createElement('div'));
  assert.equal(registered.size, 0);
  assert.equal(heldFontPreviewCount(), 0);

  // The cap: past FONT_FACES_MAX held faces, a tile shows the file tile instead.
  const keys = Array.from({ length: FONT_FACES_MAX }, (_, index) => `cap-${index}`);
  await Promise.all(keys.map((key) => acquireFontPreview(key, [`stacki-asset://local/${key}.woff2`])));
  assert.equal(heldFontPreviewCount(), FONT_FACES_MAX);
  assert.equal(await acquireFontPreview('one-more', ['stacki-asset://local/one-more.woff2']), undefined);
  keys.forEach(releaseFontPreview);
  await settle();
  assert.equal(registered.size, 0, 'released faces leave the document');
  assert.throws(() => acquireFontPreview('x', ['a', 'b', 'c', 'd', 'e']), /Assertion failed: A font is tried from a bounded set of sources/);
  await act(async () => root.unmount());
});
