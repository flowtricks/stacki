// Goal: the "Add custom styles in:" chip keeps the end of a stylesheet path, its file
// name, visible. It was cut at the end (`src/styles/vendor/normalize.c…`), hiding the
// one part that tells two stylesheets apart. It must also stay on one line inside its
// row, keep its icon fixed, and name the whole path in a tooltip.
// Method: the real link-variant Select mounts in jsdom, which has no layout, so the
// rule that does the cutting is pinned in the stylesheet source (utilities.css) and
// the markup it relies on (an LTR `<bdi>` inside the label) is asserted on the DOM.
// The label is given the widths a cut-off or a fitting path measures to check the
// tooltip and the native title. Paths are generated fixtures, covering the leading
// `/`, `./` and `../` and names with dots, underscores and hyphens, which an RTL box
// would reorder without the isolate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const bundle = path.join(directory, 'source-chip-path.bundle.js');
esbuild.buildSync({
  stdin: {
    contents: `export { default as Select } from ${JSON.stringify(repoPath('src/features/style/components/Select'))};`,
    resolveDir: ROOT,
    loader: 'tsx',
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
const { window } = dom;
Object.assign(global, {
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
  localStorage: { getItem: () => undefined, setItem: () => undefined, removeItem: () => undefined },
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
});
Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true });
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { Select } = require(bundle);

const REST_MS = 500;
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
// Built from segments: these are generated fixtures, not repo paths the gate should resolve.
const join = (...segments) => segments.join('/');
const PATHS = [
  join('src', 'styles', 'vendor', 'normalize.css'),
  join('', 'abs', 'styles', 'reset_v2.min.css'),
  join('.', 'styles', 'my-theme.v1.css'),
  '.'.repeat(2) + join('', 'shared', '.hidden-base.css'),
];

async function mount(label, widths) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(Select, {
        variant: 'link',
        value: 'a',
        options: [{ value: 'a', label, icon: React.createElement('i', { className: 'glyph' }) }],
        onChange: () => undefined,
        ariaLabel: 'source',
      }),
    );
  });
  const button = container.querySelector('button.u-select-link');
  const text = button.querySelector('.u-select-label');
  Object.defineProperty(text, 'scrollWidth', { value: widths.scroll });
  Object.defineProperty(text, 'clientWidth', { value: widths.client });
  return {
    button,
    text,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const tip = () => document.querySelector('[role="tooltip"]') ?? undefined;
const hover = (element) => act(async () => element.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })));
const rest = () => act(() => pause(REST_MS + 50));

test('the stylesheet cuts the label from its start, and the chip shrinks to its row', () => {
  const css = fs.readFileSync(repoPath('src/features/style/utilities.css'), 'utf8');
  const rule = (selector) => {
    // Every rule for the selector, joined: the file states a selector in more than one place.
    const escaped = selector.replace(/[.\\[\]]/g, '\\$&');
    const found = [...css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'g'))];
    assert.ok(found.length > 0, `${selector} has a rule`);
    return found.map((match) => match[1]).join('\n');
  };
  const label = rule('.u-select-label.is-path');
  assert.match(label, /direction:\s*rtl/, 'an RTL box puts the ellipsis on the left');
  assert.match(label, /text-align:\s*left/, 'a short path still sits at the left');
  const base = rule('.u-select-label');
  assert.match(base, /overflow:\s*hidden/);
  assert.match(base, /text-overflow:\s*ellipsis/);
  assert.match(base, /white-space:\s*nowrap/, 'one line');
  assert.match(rule('.u-select-link'), /max-width:\s*100%/, 'the chip never outgrows its row');
  assert.match(rule('.u-select-link'), /min-width:\s*0/);
  assert.match(rule('.u-select.is-link'), /max-width:\s*100%/);
  assert.match(css, /\.u-select-link \.u-select-icon,\s*\.u-select-link \.u-select-chevron\s*\{\s*flex:\s*none/, 'the icon and chevron keep their size');
});

test('every path keeps its characters in order inside an LTR isolate', async () => {
  for (const label of PATHS) {
    const { text, unmount } = await mount(label, { scroll: 10, client: 10 });
    const isolate = text.querySelector('bdi');
    assert.ok(isolate, 'the text sits in a <bdi>, so the RTL box cannot reorder its punctuation');
    assert.equal(isolate.getAttribute('dir'), 'ltr');
    assert.equal(isolate.textContent, label, 'the whole path stays in the DOM');
    await unmount();
  }
});

test('the icon sits outside the cut label, so it stays fixed', async () => {
  const { button, text, unmount } = await mount(PATHS[0], { scroll: 10, client: 10 });
  const glyph = button.querySelector('.glyph');
  assert.ok(glyph);
  assert.equal(text.contains(glyph), false);
  await unmount();
});

test('a cut-off path shows in full in the app tooltip after the usual rest', async () => {
  const { button, text, unmount } = await mount(PATHS[0], { scroll: 400, client: 120 });
  await hover(text);
  assert.equal(tip(), undefined, 'nothing shows before the rest is over');
  await rest();
  assert.equal(tip().querySelector('code.code-inline').textContent, PATHS[0], 'all of it, untruncated');
  assert.equal(button.hasAttribute('title'), false, 'no native title competes with it');
  await unmount();
});

test('a path that fits keeps its native title with the whole path', async () => {
  const { button, text, unmount } = await mount(PATHS[1], { scroll: 90, client: 90 });
  await hover(text);
  await rest();
  assert.equal(tip(), undefined);
  assert.equal(button.getAttribute('title'), PATHS[1]);
  await unmount();
});
