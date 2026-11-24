// Goal: the preview bar's width field asks for a width only when the person typed one. Before this, clicking
// into the field and leaving it asked for the width already drawn, which took the canvas off Desktop (or off a
// breakpoint) onto a fixed custom width that no longer followed the window.
// Method: the real PreviewSizeControls, bundled with esbuild, is mounted in jsdom. The field is focused,
// typed into and blurred as a person does; every width it asks for is collected. The negative cases (no edit,
// an edit undone by Escape, an edit overtaken by a new canvas width, an unusable entry) must ask for nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/preview-width-field');
fs.mkdirSync(directory, { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: "export { PreviewSizeControls } from './src/features/preview/PreviewSizeControls.tsx';",
    resolveDir: ROOT,
    loader: 'jsx',
  },
  outfile: path.join(directory, 'controls.js'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

test('the width field asks for a width only after an edit', async (context) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
  const { window } = dom;
  global.window = window;
  global.document = window.document;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const { PreviewSizeControls } = require(path.join(directory, 'controls.js'));
  const root = createRoot(document.getElementById('root'));
  context.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
  });
  const asked = [];
  const draw = (width) =>
    act(async () => root.render(React.createElement(PreviewSizeControls, { width, scale: 1, onWidth: (next) => asked.push(next), onFit: () => undefined })));
  await draw(1182);
  const field = document.querySelector('input');
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  const type = (text) =>
    act(async () => {
      setValue.call(field, text);
      field.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  const press = (key) => act(async () => void field.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true })));
  const focus = () => act(async () => field.focus());
  const blur = () => act(async () => field.blur());

  await focus();
  await blur();
  assert.deepEqual(asked, [], 'looking at the field changes nothing');
  await focus();
  await press('Enter');
  assert.deepEqual(asked, [], 'Enter on the untouched field changes nothing');

  await focus();
  await type('900');
  await press('Escape');
  await blur();
  assert.deepEqual(asked, [], 'Escape takes the edit back');
  assert.equal(field.value, '1182');

  await focus();
  await type('900');
  await draw(1000);
  await blur();
  assert.deepEqual(asked, [], 'a new canvas width replaces a half-typed one');

  await focus();
  await type('12');
  await blur();
  assert.deepEqual(asked, [], 'an unusable entry is dropped');
  assert.equal(field.value, '1000');

  await focus();
  await type('900');
  await press('Enter');
  assert.deepEqual(asked, [900]);
  await focus();
  await blur();
  assert.deepEqual(asked, [900], 'one edit is asked for once');

  // Typing the width already drawn is still a choice: it pins the canvas at it.
  await focus();
  await type('100');
  await type('1000');
  await blur();
  assert.deepEqual(asked, [900, 1000]);
});
