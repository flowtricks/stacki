// Goal: the shared loading placeholder (src/ui/Skeleton.tsx) is accessible and quiet. A group says it is
// busy once, in the person's language, and its shapes are hidden from assistive technology; it draws a
// bounded number of rows in a fixed order of widths, so the layout never changes between renders; it is
// fill only (no borders); its shimmer stops under reduced motion; and it never shows a plain-text
// "Loading…" the way the old screens did.
// Method: bundle the real component with esbuild, mount it in jsdom, and read the DOM. The stylesheet is
// read as text for the reduced-motion rule and for the absence of borders, because jsdom runs no animation.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/skeleton');
fs.mkdirSync(directory, { recursive: true });
const bundle = path.join(directory, 'skeleton.cjs');
buildSync({
  stdin: { contents: "export * from './src/ui/Skeleton';", resolveDir: repoPath('.'), loader: 'ts' },
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
const { Skeleton, SkeletonRows, SKELETON_ROWS_MAX, SKELETON_WIDTHS_PERCENT } = require(bundle);

async function render(element) {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return { container, unmount: () => act(async () => root.unmount()) };
}

test('a group is busy, says Loading once, and hides every shape from assistive technology', async () => {
  const view = await render(React.createElement(SkeletonRows, { count: 3 }));
  const group = view.container.querySelector('.ui-skeleton-rows');
  assert.equal(group.getAttribute('aria-busy'), 'true');
  assert.equal(group.getAttribute('role'), 'status');
  assert.equal(group.querySelectorAll('.ui-skeleton-status').length, 1);
  assert.equal(group.querySelector('.ui-skeleton-status').textContent, 'Loading');
  const shapes = [...group.querySelectorAll('.ui-skeleton')];
  assert.equal(shapes.length, 3);
  assert.ok(
    shapes.every((shape) => shape.getAttribute('aria-hidden') === 'true'),
    'every shape is hidden',
  );
  await view.unmount();
});

test('rows take their widths from the fixed list in order, and cycle', async () => {
  const count = SKELETON_WIDTHS_PERCENT.length + 2;
  const view = await render(React.createElement(SkeletonRows, { count }));
  const widths = [...view.container.querySelectorAll('.ui-skeleton')].map((shape) => shape.style.width);
  const expected = Array.from({ length: count }, (_, index) => `${SKELETON_WIDTHS_PERCENT[index % SKELETON_WIDTHS_PERCENT.length]}%`);
  assert.deepEqual(widths, expected);
  const again = await render(React.createElement(SkeletonRows, { count }));
  assert.deepEqual(
    [...again.container.querySelectorAll('.ui-skeleton')].map((shape) => shape.style.width),
    expected,
    'no randomness',
  );
  await view.unmount();
  await again.unmount();
});

test('a caller can draw its own row shape and receives the width and the index', async () => {
  const seen = [];
  const row = (widthPercent, index) => {
    seen.push([widthPercent, index]);
    return React.createElement('span', { className: 'custom-row' }, index);
  };
  const view = await render(React.createElement(SkeletonRows, { count: 2, row }));
  assert.equal(view.container.querySelectorAll('.custom-row').length, 2);
  assert.deepEqual(seen.slice(0, 2), [
    [SKELETON_WIDTHS_PERCENT[0], 0],
    [SKELETON_WIDTHS_PERCENT[1], 1],
  ]);
  await view.unmount();
});

test('the count is bounded: zero, a fraction, a negative and past the limit all assert', async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    for (const count of [0, -1, 1.5, Number.NaN, SKELETON_ROWS_MAX + 1]) {
      await assert.rejects(() => render(React.createElement(SkeletonRows, { count })), /SkeletonRows/);
    }
    const view = await render(React.createElement(SkeletonRows, { count: SKELETON_ROWS_MAX }));
    assert.equal(view.container.querySelectorAll('.ui-skeleton').length, SKELETON_ROWS_MAX);
    await view.unmount();
  } finally {
    console.error = quiet;
  }
});

test('a lone shape takes its size from its options and is hidden, with no text of its own', async () => {
  const view = await render(React.createElement(Skeleton, { width: '14px', height: '14px', radius: '4px' }));
  const shape = view.container.querySelector('.ui-skeleton');
  assert.equal(shape.style.width, '14px');
  assert.equal(shape.style.height, '14px');
  assert.equal(shape.style.borderRadius, '4px');
  assert.equal(shape.getAttribute('aria-hidden'), 'true');
  assert.equal(shape.textContent, '');
  const bare = await render(React.createElement(Skeleton, {}));
  assert.equal(bare.container.querySelector('.ui-skeleton').getAttribute('style') ?? '', '', 'no inline size unless asked');
  await view.unmount();
  await bare.unmount();
});

test('the shimmer stops under reduced motion, and the shapes are fills with no border', () => {
  const css = fs.readFileSync(repoPath('src/ui/skeleton.css'), 'utf8');
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.ui-skeleton::after\s*{[^}]*animation:\s*none/);
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /border(?!-radius)/, 'fill only, never a border');
  assert.match(css, /background:\s*var\(--bg-active\)/);
});

test('the visually hidden status text is translated in every catalog', () => {
  for (const locale of ['en', 'es', 'fr', 'de', 'ptBR']) {
    const catalog = fs.readFileSync(repoPath(`shared/properties/i18n/messages/${locale}.ts`), 'utf8');
    assert.match(catalog, /'ui\.loading': '[^']+'/, `${locale} has ui.loading`);
  }
});
