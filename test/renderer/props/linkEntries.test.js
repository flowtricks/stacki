// Goal: the link field's Page tab lists a template's CMS entries as concrete links, not the template.
// Method: feed the pure model a host's answer (good, then every known-bad shape) and read back the
// rows; then mount the real LinkField with a stub entry loader and drive the menu through DOM events:
// skeleton while loading, search by title and by path, the "N more" row, the check on a matched href,
// the fallback row, and that only a click writes anything.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources');
const { installPopupDOM } = require('../../helpers/popupDom');
const load = require('../../helpers/rendererModule');

const { linkEntriesFromAnswer, linkChoices, entryTitle, LINK_ENTRIES_PER_TEMPLATE_MAX } = load('src/features/props/linkEntries.ts');
const { routeMatchesTemplate, detectLinkType } = load('src/features/props/linkType.ts');

const page = (name, route, title) => ({ path: `/site/src/pages/${name}`, name, route, title });
const HOME = page('index.astro', '/');
const POSTS = page('posts/[slug].astro', '/posts/[slug]');
const entry = (slug, props) => ({ route: `/posts/${slug}`, label: slug, props });

test('an answer becomes titled rows over concrete routes', () => {
  const state = linkEntriesFromAnswer('/posts/[slug]', { entries: [entry('a', { data: { title: 'Alpha' } }), entry('b', undefined)] });
  assert.deepEqual(state, {
    kind: 'ready',
    omitted: 0,
    entries: [
      { route: '/posts/a', title: 'Alpha' },
      { route: '/posts/b', title: 'b' },
    ],
  });
});

test('negative space: entries that are not links of this template are dropped', () => {
  const bad = [
    { route: '', label: 'x' },
    { route: 'posts/rel', label: 'x' },
    { route: '/posts/[slug]', label: 'x' },
    { route: '/other/a', label: 'x' },
    { route: '/posts/a b', label: 'x' },
    { route: '/posts/a?x=1', label: 'x' },
    { route: `/posts/${'a'.repeat(3000)}`, label: 'x' },
    entry('ok'),
    entry('ok'),
  ];
  const state = linkEntriesFromAnswer('/posts/[slug]', { entries: bad });
  assert.deepEqual(
    state.entries.map((row) => row.route),
    ['/posts/ok'],
  );
});

test('no usable entry, or an error, leaves the template unresolved', () => {
  assert.deepEqual(linkEntriesFromAnswer('/posts/[slug]', { entries: [] }), { kind: 'unavailable' });
  assert.deepEqual(linkEntriesFromAnswer('/posts/[slug]', { entries: [], error: 'boom' }), { kind: 'unavailable' });
  assert.throws(() => linkEntriesFromAnswer('/posts', { entries: [] }), /template route/);
});

test('the per-template cap counts what it left off', () => {
  const entries = Array.from({ length: LINK_ENTRIES_PER_TEMPLATE_MAX + 5 }, (_, index) => entry(`p${index}`));
  const state = linkEntriesFromAnswer('/posts/[slug]', { entries });
  assert.equal(state.entries.length, LINK_ENTRIES_PER_TEMPLATE_MAX);
  assert.equal(state.omitted, 5);
});

test('titles come from title, name or data.title, one level down, and only as non-empty text', () => {
  assert.equal(entryTitle({ title: ' T ' }), 'T');
  assert.equal(entryTitle({ post: { data: { name: 'N' } } }), 'N');
  assert.equal(entryTitle({ title: '  ' }), undefined);
  assert.equal(entryTitle({ title: 4 }), undefined);
  assert.equal(entryTitle(undefined), undefined);
  assert.equal(entryTitle(['x']), undefined);
});

test('route patterns: one segment per name, a rest takes one or more, nothing else matches', () => {
  assert.ok(routeMatchesTemplate('/posts/a', '/posts/[slug]'));
  assert.ok(!routeMatchesTemplate('/posts', '/posts/[slug]'));
  assert.ok(!routeMatchesTemplate('/posts/a/b', '/posts/[slug]'));
  assert.ok(!routeMatchesTemplate('/posts/', '/posts/[slug]'));
  assert.ok(routeMatchesTemplate('/docs/a/b', '/docs/[...path]'));
  assert.ok(!routeMatchesTemplate('/docs', '/docs/[...path]'));
  assert.ok(!routeMatchesTemplate('posts/a', '/posts/[slug]'));
  assert.equal(detectLinkType('/posts/a', { routes: ['/', '/posts/[slug]'], sectionIds: [] }), 'page');
  assert.equal(detectLinkType('/posts/a.png', { routes: ['/posts/[slug]'], sectionIds: [] }), 'asset');
});

test('rows: pages first, then each template as a group; unresolved templates stay one muted row', () => {
  const states = new Map([[POSTS.route, linkEntriesFromAnswer(POSTS.route, { entries: [entry('a', { title: 'Alpha' })] })]]);
  const rows = linkChoices([POSTS, HOME], states, '/');
  assert.deepEqual(
    rows.map((row) => [row.value, row.label, row.group]),
    [
      ['/', 'Home', undefined],
      ['/posts/a', 'Alpha', 'Posts Template'],
    ],
  );
  const fallback = linkChoices([POSTS], new Map(), '/');
  assert.equal(fallback[0].value, '/posts/[slug]');
  assert.equal(fallback[0].hint, 'Entries unavailable');
  assert.deepEqual(linkChoices([POSTS], new Map([[POSTS.route, { kind: 'loading' }]]), '/'), []);
  assert.equal(linkChoices([POSTS], new Map([[POSTS.route, { kind: 'loading' }]]), '/posts/zz')[0].value, '/posts/zz');
});

test('the menu searches entries, shows the check, caps rows and writes only on a pick', async () => {
  const directory = repoPath('node_modules/.stacki-test/link-entries');
  fs.mkdirSync(directory, { recursive: true });
  const outfile = path.join(directory, 'test.cjs');
  await esbuild.build({
    stdin: { resolveDir: repoPath('src'), loader: 'tsx', contents: `export { default as LinkField } from './features/props/LinkField';` },
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  const dom = new JSDOM('<!doctype html><div id="field"></div>', { pretendToBeVisual: true });
  installPopupDOM(dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
    global[key] = key === 'window' ? dom.window : dom.window[key];
  }
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const { LinkField } = require(outfile);

  const many = Array.from({ length: 150 }, (_, index) => entry(`post-${index}`, { title: `Post ${index}` }));
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const loadEntries = async (route) => {
    await gate;
    return linkEntriesFromAnswer(route, { entries: [entry('first-post', { title: 'My First Post' }), ...many] });
  };
  const written = [];
  function Field() {
    const [value, setValue] = React.useState({ type: 'string', value: '/posts/first-post' });
    return React.createElement(LinkField, {
      value,
      context: { pages: [HOME, POSTS], projectPath: '/site', loadEntries },
      onChange: (next, immediate) => {
        written.push([next, immediate]);
        setValue(next);
      },
    });
  }
  const root = createRoot(document.getElementById('field'));
  await act(async () => {
    root.render(React.createElement(Field));
  });
  const trigger = () => document.querySelector('.dd-trigger');
  assert.equal(trigger().querySelector('.dd-label').textContent, '/posts/first-post', 'the href shows before entries arrive');
  await act(async () => {
    trigger().click();
  });
  assert.ok(document.querySelector('.dd-loading .ui-skeleton'), 'a skeleton, not text, stands for loading rows');
  assert.ok(document.querySelector('.dd-search'), 'the list is searchable');
  await act(async () => {
    release();
    await gate;
  });
  assert.ok(!document.querySelector('.dd-loading'));
  assert.equal(trigger().querySelector('.dd-label').textContent, 'My First Post', 'the matching entry is shown as selected');
  assert.ok(document.querySelector('.dd-option.selected .dd-check svg'));
  assert.ok(document.querySelector('.dd-group-label').textContent.includes('Posts Template'));
  assert.equal(document.querySelectorAll('.dd-option').length, 100, 'rows are capped');
  assert.match(document.querySelector('.dd-more').textContent, /52 more, keep typing/);

  const search = document.querySelector('.dd-search');
  const type = async (text) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
      setter.call(search, text);
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };
  await type('post-149');
  assert.deepEqual(
    [...document.querySelectorAll('.dd-option-label')].map((row) => row.textContent),
    ['Post 149'],
    'a path finds an entry beyond the cap',
  );
  await type('zzz');
  assert.equal(document.querySelectorAll('.dd-option').length, 0);
  assert.ok(document.querySelector('.dd-empty'), 'an empty state when nothing matches');
  await type('my first');
  assert.equal(document.querySelectorAll('.dd-option').length, 1, 'a title finds its entry');
  assert.deepEqual(written, [], 'searching and hovering write nothing');
  await act(async () => {
    document.querySelector('.dd-option').dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
  });
  assert.deepEqual(written, []);
  await type('Home');
  await act(async () => {
    document.querySelector('.dd-option').click();
  });
  assert.deepEqual(written, [[{ type: 'string', value: '/' }, true]]);
  await act(async () => {
    root.unmount();
  });
  dom.window.close();
});
