// Goal: every Studio sign-in provider (each kind plus the custom provider) has an icon, so no row of the
// sign-in picker or the Settings "Sign-in" line draws a blank, and an id with no icon fails loudly.
// Method: bundle the real mapping with esbuild, render each provider's icon to static markup and expect an
// svg, then ask for an unknown id and expect the assertion to throw with its message.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/sign-in-provider-icons.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  entryPoints: [repoPath('src/features/studioSetup/signInProviderIcons.tsx')],
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

test('every sign-in provider draws an svg icon', () => {
  assert.deepEqual([...lib.SIGN_IN_PROVIDERS].sort(), ['access', 'custom', 'github', 'google', 'oidc', 'passkey']);
  for (const provider of lib.SIGN_IN_PROVIDERS) {
    const markup = renderToStaticMarkup(React.createElement(lib.SignInProviderIcon, { provider, size: 16 }));
    assert.match(markup, /^<svg/, `${provider} draws an svg`);
  }
});

test('GitHub and Google draw different marks', () => {
  const draw = (provider) => renderToStaticMarkup(React.createElement(lib.SignInProviderIcon, { provider, size: 16 }));
  assert.notEqual(draw('github'), draw('google'));
});

test('an unknown provider fails loudly instead of drawing nothing', () => {
  assert.throws(() => lib.signInProviderIcon('gitlab'), /Assertion failed: Sign-in provider has an icon: gitlab/);
  assert.throws(() => lib.signInProviderIcon(''), /Assertion failed/);
});
