// Goal: a quick page-menu press selects the page before focus or rerender can
// remove the row and swallow its later click.
// Method: mount the real switcher, open it, send a primary mouse pointerdown to
// another page, and verify the selected page and closed menu immediately.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/page-switcher');
fs.mkdirSync(directory, { recursive: true });
esbuild.buildSync({
  entryPoints: [repoPath('src/features/pages/PageSwitcher.tsx')],
  outfile: path.join(directory, 'pageSwitcher.js'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});

test('a quick press commits a page choice', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node']) {
    global[key] = key === 'window' ? dom.window : dom.window[key];
  }
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const PageSwitcher = require(path.join(directory, 'pageSwitcher.js')).default;
  const pages = [
    { name: 'index.astro', path: '/index.astro', route: '/' },
    { name: 'about.astro', path: '/about.astro', route: '/about' },
  ];
  const picks = [];
  const root = createRoot(document.getElementById('root'));
  function Harness() {
    const [currentPage, setCurrentPage] = React.useState(pages[0]);
    return React.createElement(PageSwitcher, {
      pages,
      currentPage,
      onSelect: (page) => {
        picks.push(page.path);
        setCurrentPage(page);
      },
    });
  }
  const act = (action) =>
    React.act(async () => {
      await action();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  try {
    await act(() => root.render(React.createElement(Harness)));
    await act(() => document.querySelector('.page-switch-btn').click());
    const row = [...document.querySelectorAll('.page-menu-item')].find((item) => item.textContent.includes('about'));
    assert.ok(row);
    await act(() => {
      const down = new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0 });
      Object.defineProperty(down, 'pointerType', { value: 'mouse' });
      row.dispatchEvent(down);
    });
    assert.deepEqual(picks, ['/about.astro']);
    assert.match(document.querySelector('.page-switch-btn').textContent, /about/);
    assert.equal(document.querySelector('.page-menu') ?? undefined, undefined);
  } finally {
    await act(() => root.unmount());
    dom.window.close();
  }
});

// Goal: the menu opens with the page being edited highlighted, not the first
// row, so the highlight agrees with the check and Enter keeps the page.
// Method: pick the second page, reopen the menu, and read which row is
// highlighted; then check the pure opening-row helper at its edges.
test('the menu opens on the current page', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node']) {
    global[key] = key === 'window' ? dom.window : dom.window[key];
  }
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const PageSwitcher = require(path.join(directory, 'pageSwitcher.js')).default;
  const pages = [
    { name: 'about.astro', path: '/about.astro', route: '/about' },
    { name: 'index.astro', path: '/index.astro', route: '/' },
    { name: 'studio.astro', path: '/studio.astro', route: '/studio' },
  ];
  const root = createRoot(document.getElementById('root'));
  const act = (action) =>
    React.act(async () => {
      await action();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  try {
    await act(() => root.render(React.createElement(PageSwitcher, { pages, currentPage: pages[2], onSelect: () => undefined })));
    await act(() => document.querySelector('.page-switch-btn').click());
    const highlighted = document.querySelector('.page-menu-item.highlight');
    assert.ok(highlighted);
    assert.match(highlighted.textContent, /studio/);
    assert.ok(highlighted.classList.contains('current'));
  } finally {
    await act(() => root.unmount());
    dom.window.close();
  }
});

test('the opening row falls back to the first row', () => {
  const { pageSwitcherOpeningIndex } = require(path.join(directory, 'pageSwitcher.js'));
  const pages = [
    { name: 'a.astro', path: '/a.astro', route: '/a' },
    { name: 'b.astro', path: '/b.astro', route: '/b' },
  ];
  assert.equal(pageSwitcherOpeningIndex(pages, pages[1]), 1);
  assert.equal(pageSwitcherOpeningIndex(pages, undefined), 0);
  assert.equal(pageSwitcherOpeningIndex(pages, { name: 'x.astro', path: '/x.astro', route: '/x' }), 0);
  assert.equal(pageSwitcherOpeningIndex([], undefined), 0);
});
