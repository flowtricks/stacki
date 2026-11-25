// The growing textarea under every long text field: it fits its text up to a
// height, and past that the text scrolls inside it rather than pushing the
// fields after it off screen.
//
// JSDOM lays nothing out, so each case sets the text's scroll height by hand
// and reads the height and overflow the textarea gave itself; a bound that is
// not a positive number is refused by its assertion.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/auto-textarea.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  entryPoints: [path.join(ROOT, 'src/ui/AutoTextarea.tsx')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});
const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
global.window = dom.window;
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
  global[name] = dom.window[name];
}
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const AutoTextarea = require(output).default;

let scrollPx = 0;
Object.defineProperty(window.HTMLTextAreaElement.prototype, 'scrollHeight', {
  get: () => scrollPx,
});

async function measure(props, textPx) {
  scrollPx = textPx;
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(AutoTextarea, { value: 'x', onChange() {}, ...props })));
  const area = document.querySelector('textarea');
  const shown = { height: area.style.height, overflowY: area.style.overflowY };
  await act(async () => root.unmount());
  return shown;
}

test('short text fits without a scrollbar', async () => {
  assert.deepEqual(await measure({}, 100), { height: '102px', overflowY: 'hidden' });
});

test('long text stops at the bound and scrolls inside the field', async () => {
  assert.deepEqual(await measure({}, 5000), { height: '360px', overflowY: 'auto' });
  assert.deepEqual(await measure({ heightPxMax: 120 }, 400), {
    height: '120px',
    overflowY: 'auto',
  });
  assert.deepEqual(await measure({ heightPxMax: 120 }, 118), {
    height: '120px',
    overflowY: 'hidden',
  });
});

test('a height bound must be a positive number', async () => {
  await assert.rejects(() => measure({ heightPxMax: 0 }, 10), /A textarea height bound is positive/);
  await assert.rejects(() => measure({ heightPxMax: Number.NaN }, 10), /is a number/);
});
