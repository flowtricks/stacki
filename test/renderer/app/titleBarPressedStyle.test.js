// Goal: the title bar's terminal and Play buttons are pressed exactly like the preview toolbar's pointer and guide buttons:
// they expose aria-pressed and the `on` class only while active, and every one of these pressed fills comes from the single
// --bg-pressed token, not a colour of its own.
// Method: bundle the real TitleActions with esbuild and render it to static markup for the active and inactive cases (pure
// string checks, no layout, no pointer, so it holds on Windows and Linux too); then read the shared stylesheets and assert the
// token is defined once, both pressed rules use it, and the old accent fill for Play is gone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/title-bar-pressed.cjs');
esbuild.buildSync({
  stdin: {
    contents: "export { TitleActions } from './src/app/shell/AppShell';",
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
const { TitleActions } = require(output);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function buttons(app) {
  const html = renderToStaticMarkup(
    React.createElement(TitleActions, { app: { devUrl: 'http://localhost:4321', previewRef: undefined, inPreview: false, termOpen: false, ...app } }),
  );
  return [...html.matchAll(/<button[^>]*>/g)].map((match) => match[0]);
}

test('terminal and Play are pressed (class and aria-pressed) only while active', () => {
  const idle = buttons({}).slice(0, 2); // Terminal, Play; Settings is no toggle.
  assert.equal(idle.length, 2, 'terminal and Play both render');
  for (const tag of idle) {
    assert.match(tag, /aria-pressed="false"/);
    assert.doesNotMatch(tag, /\bon\b/);
  }
  const terminalOn = buttons({ termOpen: true });
  assert.match(terminalOn[0], /aria-pressed="true"/);
  assert.match(terminalOn[0], /titlebar-btn on/);
  assert.match(terminalOn[1], /aria-pressed="false"/);
  const playOn = buttons({ inPreview: true });
  assert.match(playOn[1], /aria-pressed="true"/);
  assert.match(playOn[1], /preview-btn on/);
  assert.match(playOn[0], /aria-pressed="false"/);
});

test('every pressed fill is the one --bg-pressed token, with no colour of its own', () => {
  const styles = fs.readFileSync(repoPath('src/app/styles.css'), 'utf8');
  const guide = fs.readFileSync(repoPath('src/features/preview/guide.css'), 'utf8');
  assert.equal(styles.match(/--bg-pressed:/g).length, 1, 'defined once');
  const titleRule = styles.match(/\.titlebar-btn\.on,[^{]*\{[^}]*\}/)[0];
  const guideRule = guide.match(/\.device-btns\.guide-btns button\[aria-pressed='true'\],[^{]*\{[^}]*\}/)[0];
  for (const rule of [titleRule, guideRule]) {
    assert.match(rule, /background: var\(--bg-pressed\);/);
    assert.doesNotMatch(rule, /#[0-9a-f]{3,8}\b|rgba?\(/i);
  }
  assert.match(titleRule, /:hover:not\(:disabled\)/, 'held on hover');
  assert.doesNotMatch(styles, /\.preview-btn\.on/, 'Play has no accent fill of its own');
});
