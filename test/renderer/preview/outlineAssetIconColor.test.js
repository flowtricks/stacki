// Goal: the canvas tag's icon wears the tag's colour for an Astro asset (Image, Picture), not Astro's
// brand orange, which read as an error beside the green label and outline. Palette, props and navigator
// keep the brand accent.
// Method: bundle the real PreviewOverlays module with esbuild, render outlineIcon for an astroAsset
// node on the server, and check the markup carries no inline colour (so the SVG's currentColor stroke
// follows the tag); then check astroAssetIcon's default still sets the accent.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

async function load(entry, name) {
  const { outputFiles } = await esbuild.build({
    entryPoints: [repoPath(entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
    external: ['react', 'react/jsx-runtime', 'react-dom/server'],
    write: false,
  });
  const bundled = outputFiles[0];
  assert.ok(bundled);
  const filename = repoPath(`node_modules/.stacki-test/${name}.cjs`);
  const bundleModule = { exports: {} };
  new Function('require', 'module', 'exports', bundled.text)(createRequire(filename), bundleModule, bundleModule.exports);
  return { exports: bundleModule.exports, render: createRequire(filename)('react-dom/server').renderToStaticMarkup };
}

const assetInfo = {
  label: 'Image',
  kind: 'component',
  tag: undefined,
  astroAsset: true,
  dynamicTag: false,
  nodeKind: 'component',
  childCount: 0,
  isLayout: false,
  bound: false,
};

test('the canvas tag icon for an Astro asset inherits the tag colour', async () => {
  const { exports, render } = await load('src/features/preview/PreviewOverlays.tsx', 'outline-asset-icon');
  const markup = render(exports.outlineIcon(assetInfo));
  assert.match(markup, /stroke="currentColor"/);
  assert.doesNotMatch(markup, /#ff5d01/i);
  assert.doesNotMatch(markup, /color:/);
});

test('the brand accent stays on the palette and props icon', async () => {
  const { exports, render } = await load('src/ui/Icons.tsx', 'asset-icon-brand');
  assert.match(render(exports.astroAssetIcon('Image', 16)), /#ff5d01/i);
});
