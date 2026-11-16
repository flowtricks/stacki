// Goal: pin the tag-to-icon table so the p element wears Central's text-1 drawing (exported as
// `text`, Figma component set 6213:50769) and nothing else.
// Method: bundle the real ElementIcons module with esbuild, render elementIcon('p') on the server
// and compare its markup with the text-1 geometry, then check the SVG strokes with currentColor
// and that heading and span rows still resolve to their own icons.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

async function loadElementIcon() {
  const { outputFiles } = await esbuild.build({
    entryPoints: [repoPath('src/ui/ElementIcons.tsx')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom/server'],
    write: false,
  });
  const bundled = outputFiles[0];
  assert.ok(bundled);
  const filename = repoPath('node_modules/.stacki-test/paragraph-tag-icon.cjs');
  const bundleModule = { exports: {} };
  new Function('require', 'module', 'exports', bundled.text)(createRequire(filename), bundleModule, bundleModule.exports);
  const { renderToStaticMarkup } = createRequire(filename)('react-dom/server');
  return (tag, size) => renderToStaticMarkup(bundleModule.exports.elementIcon(tag, size));
}

test('the p tag renders the Central text-1 drawing with currentColor', async () => {
  const render = await loadElementIcon();
  const compact = render('p', 12);
  assert.match(compact, /data-central-icon="text"/);
  assert.match(compact, /stroke="currentColor"/);
  assert.match(compact, /d="M3.75 6.25V3.75H12H20.25V6.25"/);
  assert.match(compact, /stroke-width="1.5"/);
  const standard = render('p', 20);
  assert.match(standard, /d="M3.5 5.5V3.5H12H20.5V5.5"/);
  assert.match(standard, /stroke="currentColor"/);
  assert.doesNotMatch(compact, /fill="currentColor"/);
});

test('other text tags keep their own icons and p matches case-insensitively', async () => {
  const render = await loadElementIcon();
  assert.equal(render('P', 12), render('p', 12));
  assert.doesNotMatch(render('h1', 12), /data-central-icon="text"/);
  assert.doesNotMatch(render('blockquote', 12), /data-central-icon="text"/);
  assert.match(render('span', 12), /data-central-icon="text"/);
});
