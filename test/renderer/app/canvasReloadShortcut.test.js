// Goal: the toolbar's refresh button names its shortcut only in its custom tip, and the menu's refresh request runs the button's
// own action.
// Method: bundle the real ReloadButton and render it to static markup (no title attribute, no key text on the button itself);
// then read the menu-shortcut hook and assert the `refreshPreview` menu event bumps the same refresh key the button bumps.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/canvas-reload-shortcut.cjs');
esbuild.buildSync({
  stdin: {
    contents: "export { ReloadButton } from './src/app/shell/AppShell';",
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
const { ReloadButton } = require(output);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

test('the refresh button draws no shortcut and no native title; no tip until a pointer rests on it', () => {
  const html = renderToStaticMarkup(React.createElement(ReloadButton, { disabled: false, onReload: () => undefined }));
  assert.match(html, /url-reload/);
  assert.match(html, /aria-label="/);
  assert.doesNotMatch(html, /\btitle=/);
  assert.doesNotMatch(html, /rail-tooltip/);
  assert.doesNotMatch(html, /⌘|Ctrl/);
});

test('the menu event refreshes the preview with the same bump as the button', () => {
  const shortcuts = fs.readFileSync(repoPath('src/app/state/appShortcuts.ts'), 'utf8');
  const shell = fs.readFileSync(repoPath('src/app/shell/AppShell.tsx'), 'utf8');
  const handler = shortcuts.slice(shortcuts.indexOf("window.avb.onMenu('refreshPreview'"));
  assert.match(handler.slice(0, 300), /setRefreshKey\(\(count\) => count \+ 1\)/);
  assert.match(shell, /onReload=\{\(\) => app\.setRefreshKey\(\(count\) => count \+ 1\)\}/);
});
