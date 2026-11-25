// Goal: every provider in the catalog resolves to a vendored brand mark or to the explicit monogram
// fallback; the vendored marks are plain bounded path data with a six-digit brand colour; the component draws
// an aria-hidden svg for a mark and a monogram tile otherwise; and Webflow is not offered.
// Method: bundle the real module and component with esbuild, render them to static markup, and check the
// catalog ids against the marks table.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/provider-logo.cjs');
esbuild.buildSync({
  stdin: {
    contents: [
      "export { default as ProviderLogo } from './src/ui/ProviderLogo';",
      "export { PROVIDER_LOGOS, providerMark, markFill } from './src/ui/providerLogos';",
      "export { MCP_PROVIDERS } from './shared/properties/mcpProviders';",
    ].join('\n'),
    resolveDir: repoPath('package.json').replace(/package\.json$/, ''),
    loader: 'tsx',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/server'],
  logLevel: 'silent',
});
const lib = require(output);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const FALLBACK = ['context7', 'playwright'];

test('every catalog entry has a brand mark or is a listed monogram fallback, and Webflow is absent', () => {
  for (const provider of lib.MCP_PROVIDERS) {
    const hasMark = lib.providerMark(provider.id) !== undefined;
    assert.equal(hasMark, !FALLBACK.includes(provider.id), provider.id);
  }
  assert.ok(!lib.MCP_PROVIDERS.some((provider) => provider.id === 'webflow'));
  assert.ok(!('webflow' in lib.PROVIDER_LOGOS));
  for (const id of Object.keys(lib.PROVIDER_LOGOS)) {
    assert.ok(
      lib.MCP_PROVIDERS.some((provider) => provider.id === id),
      `${id} is a catalog provider`,
    );
  }
});

test('marks are bounded path data with only path characters and a six-digit colour', () => {
  for (const [id, mark] of Object.entries(lib.PROVIDER_LOGOS)) {
    assert.equal(typeof mark.path, 'string', id);
    assert.ok(mark.path.length > 0 && mark.path.length <= 6000, id);
    assert.match(mark.path, /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s-]+$/, id);
    assert.match(mark.hex, /^[0-9A-Fa-f]{6}$/, id);
  }
});

test('near-black brand colours fall back to the text colour on dark surfaces', () => {
  assert.equal(lib.markFill('000000'), 'currentColor');
  assert.equal(lib.markFill('181717'), 'currentColor');
  assert.equal(lib.markFill('F24E1E'), '#F24E1E');
});

test('the component draws an aria-hidden svg for a mark and a monogram tile otherwise', () => {
  const sanity = renderToStaticMarkup(React.createElement(lib.ProviderLogo, { id: 'sanity', name: 'Sanity', size: 18 }));
  assert.match(sanity, /<svg[^>]*viewBox="0 0 24 24"[^>]*aria-hidden="true"/);
  assert.ok(!sanity.includes('monogram'));
  const context7 = renderToStaticMarkup(React.createElement(lib.ProviderLogo, { id: 'context7', name: 'Context7' }));
  assert.ok(context7.includes('monogram') && !context7.includes('<svg'));
  assert.match(context7, />C</);
});
