// Render the real rail icon components on the server to verify the shared mapping
// and the outline weights used in compact controls and on the rail.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

test('every panel and More use a distinct outline on the rail', async () => {
  const { outputFiles } = await esbuild.build({
    entryPoints: [repoPath('src/app/featureIcons.tsx')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime'],
    write: false,
  });
  const bundled = outputFiles[0];
  assert.ok(bundled);
  const filename = repoPath('node_modules/.stacki-test/rail-icons.cjs');
  const bundleModule = { exports: {} };
  new Function('require', 'module', 'exports', bundled.text)(createRequire(filename), bundleModule, bundleModule.exports);
  const { FEATURE_ICONS, RailMoreIcon } = bundleModule.exports;
  const icons = Object.entries(FEATURE_ICONS)
    .filter(([key]) => key.startsWith('panel:') && key !== 'panel:style' && key !== 'panel:settings')
    .map(([, Icon]) => Icon);
  icons.push(RailMoreIcon);
  assert.equal(icons.length, 15);
  const rail = icons.map((Icon) => renderToStaticMarkup(createElement(Icon, { size: 20 })));
  assert.equal(new Set(rail).size, rail.length);
  for (const markup of rail) {
    assert.match(markup, /width="20" height="20" viewBox="0 0 (16 16|24 24)"/);
    assert.match(markup, /(stroke|fill)="currentColor"/);
  }
  const compact = renderToStaticMarkup(createElement(FEATURE_ICONS['panel:pages'], { size: 11 }));
  assert.match(compact, /width="12" height="12"/);
  assert.match(compact, /stroke-width="1.5"/);
  assert.match(rail[0], /stroke-width="1"/);
});
