// Goal: the link field's Page tab names every page exactly as the Pages panel does, and picking
// one still writes the route. The bug this holds shut: the dropdown drew its own label from the
// file name, so the panel's "Home" over `/` appeared as `index · /`.
// Method: check the option helper on root, nested, titled and dynamic pages, then mount the real
// LinkField and the real PageTreeView on one page list and compare the rows each one draws.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources');
const { installPopupDOM } = require('../../helpers/popupDom');
const load = require('../../helpers/rendererModule');

const { linkPageOptions } = load('src/features/props/linkType.ts');

const page = (name, route, title) => ({ path: `/site/src/pages/${name}`, name, route, title });
const PAGES = [
  page('index.astro', '/', 'Site title'),
  page('contact.astro', '/contact'),
  page('about/story.astro', '/about/story', 'Our Story'),
  page('about/team.md', '/about/team'),
  page('blog/index.mdx', '/blog'),
  page('blog/[slug].astro', '/blog/[slug]', 'Shared layout title'),
  page('docs/[...path].astro', '/docs/[...path]'),
];

test('index reads Home over its route, whatever title its layout gives', () => {
  assert.deepEqual(linkPageOptions([page('index.astro', '/', 'Site title')]), [{ value: '/', label: 'Home', description: '/' }]);
});

test('a nested page reads its title or its base name, never its folder path or extension', () => {
  const [story, team] = linkPageOptions([page('about/story.astro', '/about/story', 'Our Story'), page('about/team.mdx', '/about/team')]);
  assert.deepEqual(story, { value: '/about/story', label: 'Our Story', description: '/about/story' });
  assert.deepEqual(team, { value: '/about/team', label: 'team', description: '/about/team' });
});

test('a dynamic route reads as its template and keeps the literal route', () => {
  const [template, rest] = linkPageOptions([page('blog/[slug].astro', '/blog/[slug]', 'Layout title'), page('docs/[...path].astro', '/docs/[...path]')]);
  assert.deepEqual(template, { value: '/blog/[slug]', label: 'Blog Template', description: '/blog/[slug]' });
  assert.deepEqual(rest, { value: '/docs/[...path]', label: 'Docs Template', description: '/docs/[...path]' });
});

test('the option list is empty for no pages and refuses more pages than a scan can hold', () => {
  assert.deepEqual(linkPageOptions([]), []);
  assert.throws(() => linkPageOptions(Array(10001).fill(PAGES[0])), /linkPageOptions: page limit exceeded/);
});

test('the picker and the Pages panel draw the same rows, and a pick writes the route', async () => {
  const directory = repoPath('node_modules/.stacki-test/link-page-picker');
  fs.mkdirSync(directory, { recursive: true });
  const outfile = path.join(directory, 'test.cjs');
  await esbuild.build({
    stdin: {
      resolveDir: repoPath('src'),
      loader: 'tsx',
      contents: `
        export { default as LinkField } from './features/props/LinkField';
        export { PageTreeView } from './features/pages/PageTreeView';
        export { buildPageTree } from './features/pages/pageTree';
      `,
    },
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  const dom = new JSDOM('<!doctype html><div id="panel"></div><div id="field"></div>', { pretendToBeVisual: true });
  installPopupDOM(dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
    global[key] = key === 'window' ? dom.window : dom.window[key];
  }
  global.IS_REACT_ACT_ENVIRONMENT = true;
  // The DOM stand-in has no layout, so it has no scrollIntoView; the popup calls it for the highlighted row.
  dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const { LinkField, PageTreeView, buildPageTree } = require(outfile);

  const panelRoot = createRoot(document.getElementById('panel'));
  const noop = () => {};
  await act(async () => {
    panelRoot.render(
      React.createElement(PageTreeView, {
        order: { version: 1, entries: [] },
        reorder: { enabled: false, target: undefined, start: noop, finish: noop, clearTarget: noop },
        node: buildPageTree(PAGES, []),
        rel: '',
        depth: 0,
        currentPage: undefined,
        collapsed: new Set(),
        editing: { kind: 'none' },
        dropDirectory: undefined,
        actions: {},
      }),
    );
  });
  const panelRows = [...document.querySelectorAll('#panel .list-item:not(.folder) .page-list-copy')]
    .map((row) => [row.querySelector('.label').textContent, row.querySelector('.sub').textContent])
    .sort();
  assert.equal(panelRows.length, PAGES.length);
  assert.ok(panelRows.some(([name, route]) => name === 'Home' && route === '/'));

  const written = [];
  function Field() {
    const [value, setValue] = React.useState({ type: 'string', value: '/' });
    return React.createElement(LinkField, {
      value,
      context: { pages: PAGES, projectPath: '/site' },
      onChange: (next, immediate) => {
        written.push([next, immediate]);
        setValue(next);
      },
    });
  }
  const fieldRoot = createRoot(document.getElementById('field'));
  await act(async () => {
    fieldRoot.render(React.createElement(Field));
  });
  const trigger = () => document.querySelector('.dd-trigger');
  assert.equal(trigger().querySelector('.dd-label').textContent, 'Home');
  await act(async () => {
    trigger().click();
  });

  const rows = [...document.querySelectorAll('.dd-stacked .dd-option')];
  const pickerRows = rows.map((row) => [row.querySelector('.dd-option-label').textContent, row.querySelector('.dd-description').textContent]).sort();
  assert.deepEqual(pickerRows, panelRows);
  assert.ok(document.querySelector('.dd-option.selected .dd-check svg'), 'the check stays on the chosen row');
  const row = rows.find((candidate) => candidate.textContent.includes('Blog Template'));
  await act(async () => {
    row.click();
  });
  assert.deepEqual(written, [[{ type: 'string', value: '/blog/[slug]' }, true]]);
  assert.equal(trigger().querySelector('.dd-label').textContent, 'Blog Template');

  await act(async () => {
    panelRoot.unmount();
    fieldRoot.unmount();
  });
  dom.window.close();
});

test('the menu is measured at the two-line row height, so ten pages reach the height cap', async () => {
  const directory = repoPath('node_modules/.stacki-test/link-page-picker');
  const dom = new JSDOM('<!doctype html><div id="field"></div>', { pretendToBeVisual: true });
  installPopupDOM(dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
    global[key] = key === 'window' ? dom.window : dom.window[key];
  }
  dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const { LinkField } = require(path.join(directory, 'test.cjs'));
  const pages = Array.from({ length: 10 }, (_, index) => page(`page-${index}.astro`, `/page-${index}`));
  const root = createRoot(document.getElementById('field'));
  await act(async () => {
    root.render(
      React.createElement(LinkField, {
        value: { type: 'string', value: '/page-0' },
        context: { pages, projectPath: '/site' },
        onChange() {},
      }),
    );
  });
  await act(async () => {
    document.querySelector('.dd-trigger').click();
  });
  // Ten one-line rows are 268px and would leave the popup uncapped; ten two-line rows are 408px.
  assert.equal(document.querySelector('.dd-popup').style.maxHeight, '320px');
  await act(async () => {
    root.unmount();
  });
  dom.window.close();
});
