// Goal: the two small status indicators, the four-dot loader and the progress ring, are
// accessible, honest about their value, and still under reduced motion.
// Method: the ring's pure functions (tone thresholds, drawn length with out-of-range and
// non-finite values) are called directly; both components are mounted in jsdom and read
// through their roles and labels (a ring is an image named by its caller; the loader is
// hidden from assistive technology unless it is given a label); the stylesheet is checked
// for the reduced-motion rule, because jsdom runs no animation to observe.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/status-indicators');
fs.mkdirSync(directory, { recursive: true });
const bundle = path.join(directory, 'indicators.cjs');
buildSync({
  stdin: {
    contents: "export * from './src/ui/ProgressRing'; export * from './src/ui/LoaderDots';",
    resolveDir: repoPath('.'),
    loader: 'ts',
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
});

const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
require('../../helpers/popupDom').installPopupDOM(dom.window);
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.Node = dom.window.Node;
global.Element = dom.window.Element;
global.HTMLElement = dom.window.HTMLElement;
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');
const { ProgressRing, LoaderDots, ringToneFor, ringDrawnLength, RING_AMBER_FROM, RING_RED_FROM } = require(bundle);

async function render(element) {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return { container, unmount: () => act(async () => root.unmount()) };
}

test('the ring turns amber at 70% and red at 90%, and stays neutral when the value is unknown', () => {
  assert.equal(ringToneFor(undefined), 'neutral');
  assert.equal(ringToneFor(0), 'neutral');
  assert.equal(ringToneFor(RING_AMBER_FROM - 0.001), 'neutral');
  assert.equal(ringToneFor(RING_AMBER_FROM), 'amber');
  assert.equal(ringToneFor(RING_RED_FROM - 0.001), 'amber');
  assert.equal(ringToneFor(RING_RED_FROM), 'red');
  assert.equal(ringToneFor(1.7), 'red', 'overshoot reads as full');
  assert.throws(() => ringToneFor(Number.NaN), /value is finite/);
});

test('the drawn arc is proportional, clamped, and empty when unknown', () => {
  const full = ringDrawnLength(1);
  assert.ok(full > 0);
  assert.equal(ringDrawnLength(undefined), 0);
  assert.equal(ringDrawnLength(0), 0);
  assert.ok(Math.abs(ringDrawnLength(0.5) - full / 2) < 1e-9);
  assert.equal(ringDrawnLength(3), full);
  assert.equal(ringDrawnLength(-1), 0);
  assert.throws(() => ringDrawnLength(Number.POSITIVE_INFINITY), /value is finite/);
});

test('a ring is an image with the name its caller gave and the tone its value implies', async () => {
  const view = await render(React.createElement(ProgressRing, { value: 0.95, label: 'Context 95% used' }));
  const ring = view.container.querySelector('[role="img"]');
  assert.equal(ring.getAttribute('aria-label'), 'Context 95% used');
  assert.equal(ring.getAttribute('data-tone'), 'red');
  assert.equal(ring.hasAttribute('tabindex'), false, 'not focusable without a tooltip');
  await view.unmount();
  const explicit = await render(React.createElement(ProgressRing, { value: 0.1, tone: 'amber', label: 'x' }));
  assert.equal(explicit.container.querySelector('[role="img"]').getAttribute('data-tone'), 'amber');
  await explicit.unmount();
});

test('a ring with a tooltip is focusable and shows it on focus and hover', async () => {
  const view = await render(React.createElement(ProgressRing, { value: 0.4, label: 'Context', tooltip: '41,250 of 1,000,000 tokens' }));
  const ring = view.container.querySelector('[role="img"]');
  assert.equal(ring.getAttribute('tabindex'), '0');
  assert.equal(dom.window.document.querySelector('[role="tooltip"]') === null, true);
  await act(async () => ring.dispatchEvent(new dom.window.FocusEvent('focus', { bubbles: false })));
  await act(async () => ring.dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true })));
  const tip = dom.window.document.querySelector('[role="tooltip"]');
  assert.ok(tip, 'the tooltip opens');
  assert.equal(tip.textContent, '41,250 of 1,000,000 tokens');
  await view.unmount();
});

test('the loader is four dots, hidden from assistive technology unless it is named', async () => {
  const quiet = await render(React.createElement(LoaderDots));
  assert.equal(quiet.container.querySelectorAll('.loader-dot').length, 4);
  assert.equal(quiet.container.querySelector('.loader-dots').getAttribute('aria-hidden'), 'true');
  assert.equal(quiet.container.querySelector('.loader-dots').hasAttribute('role'), false);
  await quiet.unmount();
  const named = await render(React.createElement(LoaderDots, { label: 'Running a command', dotPx: 6 }));
  const loader = named.container.querySelector('.loader-dots');
  assert.equal(loader.getAttribute('role'), 'img');
  assert.equal(loader.getAttribute('aria-label'), 'Running a command');
  assert.equal(loader.hasAttribute('aria-hidden'), false);
  assert.equal(loader.style.getPropertyValue('--loader-dot'), '6px');
  await named.unmount();
});

test('under reduced motion the dots and the ring stop moving', () => {
  const loader = fs.readFileSync(repoPath('src/ui/loaderDots.css'), 'utf8');
  const reduced = loader.slice(loader.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.loader-dot\s*{[^}]*animation:\s*none/);
  assert.match(reduced, /opacity:\s*1/, 'the last dot is solid, so the still loader is not blank');
  const ring = fs.readFileSync(repoPath('src/ui/progressRing.css'), 'utf8');
  assert.match(ring.slice(ring.indexOf('@media (prefers-reduced-motion: reduce)')), /transition:\s*none/);
  const menu = fs.readFileSync(repoPath('src/ui/menu.css'), 'utf8');
  assert.match(menu.slice(menu.indexOf('@media (prefers-reduced-motion: reduce)')), /transition:\s*none/);
});

test('no border is drawn by the new primitives', () => {
  for (const file of ['menu.css', 'progressRing.css', 'loaderDots.css', 'chipEditor/chipEditor.css']) {
    const css = fs.readFileSync(repoPath(`src/ui/${file}`), 'utf8');
    for (const match of css.matchAll(/(?<![-\w])border(?:-(?:top|right|bottom|left))?\s*:\s*([^;]+);/g)) {
      assert.match(match[1].trim(), /^(0|none|0 solid.*)$/, `${file}: ${match[0]}`);
    }
  }
});
