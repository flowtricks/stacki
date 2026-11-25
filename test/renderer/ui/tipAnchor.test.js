// Goal: TipAnchor, the wrapper that turns an explanation into a tooltip, holds the explanation the way the owner rule asks: the text is
// reachable by keyboard focus (the tip appears at once and Escape closes it), by a screen reader (aria-describedby on the wrapper),
// and takes no room: with nothing to say it renders no description, no tooltip and no extra box (display: contents wrapper), and a
// control inside is never remounted when the text comes and goes.
// Method: bundle the real component, mount it in jsdom around a button and drive focus, blur, Escape and text changes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'tip-anchor.cjs');
buildSync({
  stdin: { contents: "export { default as TipAnchor } from './src/ui/TipAnchor';", resolveDir: repoPath('.'), loader: 'ts' },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  logLevel: 'silent',
  loader: { '.css': 'empty' },
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
});
const { TipAnchor } = require(output);

async function mount(text) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { Simulate } = require('react-dom/test-utils');
  const container = document.getElementById('root');
  const root = createRoot(container);
  const render = (value) =>
    React.act(async () => root.render(React.createElement(TipAnchor, { text: value }, React.createElement('button', { type: 'button' }, 'Go'))));
  await render(text);
  return {
    container,
    render,
    button: () => container.querySelector('button'),
    tip: () => document.querySelector('[role="tooltip"]'),
    focus: () => React.act(async () => Simulate.focus(container.querySelector('button'))),
    blur: () => React.act(async () => Simulate.blur(container.querySelector('button'))),
    escape: () => React.act(async () => Simulate.keyDown(container.querySelector('button'), { key: 'Escape' })),
    async unmount() {
      await React.act(async () => root.unmount());
      dom.window.close();
    },
  };
}

test('keyboard focus shows the explanation at once, Escape and blur hide it, and a screen reader reads it', async () => {
  const view = await mount('Why this is off.');
  try {
    const wrapper = view.container.querySelector('.tip-anchor');
    assert.equal(document.getElementById(wrapper.getAttribute('aria-describedby')).textContent, 'Why this is off.');
    assert.equal(view.tip() ?? undefined, undefined, 'nothing shows before the focus');
    await view.focus();
    assert.equal(view.tip()?.textContent, 'Why this is off.');
    await view.escape();
    assert.equal(view.tip() ?? undefined, undefined, 'Escape closes it');
    await view.focus();
    await view.blur();
    assert.equal(view.tip() ?? undefined, undefined, 'blur closes it');
  } finally {
    await view.unmount();
  }
});

test('with no text there is no description and no tooltip, and the control survives the text coming and going', async () => {
  const view = await mount(undefined);
  try {
    const before = view.button();
    const wrapper = view.container.querySelector('.tip-anchor');
    assert.equal(wrapper.getAttribute('aria-describedby') ?? undefined, undefined);
    assert.equal(view.container.querySelector('.info-hint-text') ?? undefined, undefined);
    await view.focus();
    assert.equal(view.tip() ?? undefined, undefined, 'valid state shows nothing');
    await view.render('Now there is a reason.');
    assert.equal(view.button(), before, 'the control is the same element');
    await view.render(undefined);
    assert.equal(view.button(), before, 'and again after the text goes');
    assert.equal(view.container.querySelector('.info-hint-text') ?? undefined, undefined);
  } finally {
    await view.unmount();
  }
});

test('an empty string is a caller bug and crashes', async () => {
  await assert.rejects(() => mount(''), /TipAnchor: the explanation is not empty/);
});
