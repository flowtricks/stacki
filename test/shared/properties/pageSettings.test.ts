// Goal: the Page settings contract answers the same way in the dialog and in main: which page is the homepage, which
// page may become it (and the two moves that makes), what a URL name may be, and which wire shapes cross IPC.
// Method: tables of inputs with the expected answer each, including the negative space (refusals with pinned
// sentences, malformed replies, out-of-bound lists), so a new rule shows up as a changed row rather than a new test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkUrlName,
  folderOf,
  homePagesOf,
  homeSwapPlan,
  homeSwapRefusalText,
  isHomePage,
  parsePageSettingsApplied,
  parsePageSettingsDirection,
  parsePageSettingsRequest,
  parsePageSettingsSummary,
  PAGE_SETTINGS_LIMITS,
  urlNameOf,
  type HomeSwapRefusal,
} from '#dist/shared/properties/pageSettings.js';
import { parseTemplateReading } from '#dist/shared/properties/pageTemplateReading.js';

test('only a root index page is the homepage', () => {
  const table: readonly (readonly [string, boolean])[] = [
    ['index.astro', true],
    ['index.md', true],
    ['index.mdx', true],
    ['INDEX.astro', true],
    ['blog/index.astro', false],
    ['indexes.astro', false],
    ['about.astro', false],
  ];
  for (const [name, expected] of table) {
    assert.equal(isHomePage(name), expected, name);
  }
  assert.deepEqual(homePagesOf(['index.astro', 'about.astro', 'blog/index.astro']), ['index.astro']);
});

test('a homepage swap moves each file with its own extension, into the page’s folder', () => {
  const table: readonly (readonly [readonly string[], string, { home: { from: string; to: string }; page: { from: string; to: string } }])[] = [
    [['index.astro', 'about.astro'], 'about.astro', { home: { from: 'index.astro', to: 'about.astro' }, page: { from: 'about.astro', to: 'index.astro' } }],
    [['index.astro', 'about.md'], 'about.md', { home: { from: 'index.astro', to: 'about.astro' }, page: { from: 'about.md', to: 'index.md' } }],
    [['index.md', 'about.mdx'], 'about.mdx', { home: { from: 'index.md', to: 'about.md' }, page: { from: 'about.mdx', to: 'index.mdx' } }],
    [
      ['index.astro', 'blog/post.astro'],
      'blog/post.astro',
      { home: { from: 'index.astro', to: 'blog/post.astro' }, page: { from: 'blog/post.astro', to: 'index.astro' } },
    ],
  ];
  for (const [pages, page, expected] of table) {
    const plan = homeSwapPlan(page, { pages, locales: [] });
    assert.ok(plan.ok, page);
    assert.deepEqual(plan.value, expected);
  }
});

test('a homepage swap is refused with a reason for pages that cannot be the homepage', () => {
  const table: readonly (readonly [readonly string[], string, readonly string[], HomeSwapRefusal, string])[] = [
    [['index.astro'], 'index.astro', [], 'already-home', 'This page is already the homepage.'],
    [['index.astro', 'blog/[slug].astro'], 'blog/[slug].astro', [], 'dynamic', 'Dynamic pages can’t be the homepage.'],
    [['index.astro', '404.astro'], '404.astro', [], 'error-page', 'Error pages (404, 500) can’t be the homepage.'],
    [['index.astro', '500.md'], '500.md', [], 'error-page', 'Error pages (404, 500) can’t be the homepage.'],
    [['index.astro', 'fr/about.astro'], 'fr/about.astro', ['fr'], 'locale', 'Pages in a language folder can’t be the homepage.'],
    [['about.astro'], 'about.astro', [], 'no-home', 'This site has no homepage file (src/pages/index.astro) to swap with.'],
    [
      ['index.astro', 'index.md', 'about.astro'],
      'about.astro',
      [],
      'two-homes',
      'Both index.astro and index.md exist. Keep one homepage file, then try again.',
    ],
    [
      ['index.astro', 'About.astro', 'about/index.astro'],
      'About.astro',
      [],
      'collision',
      'Another page already answers at this page’s address. Resolve that first.',
    ],
    [['index.astro', 'about.md', 'about.astro'], 'about.md', [], 'collision', 'Another page already answers at this page’s address. Resolve that first.'],
    [['index.astro'], 'notes.txt', [], 'not-a-page', 'Only Astro and Markdown pages can be the homepage.'],
  ];
  for (const [pages, page, locales, refusal, sentence] of table) {
    const plan = homeSwapPlan(page, { pages, locales });
    assert.equal(plan.ok, false, page);
    assert.equal(plan.ok ? '' : plan.error, refusal, page);
    assert.equal(homeSwapRefusalText(refusal).message, sentence);
  }
  // A folder that is not a locale is an ordinary folder.
  assert.ok(homeSwapPlan('fr/about.astro', { pages: ['index.astro', 'fr/about.astro'], locales: ['de'] }).ok);
});

test('a URL name is checked as main checks it, with index reserved beside the homepage', () => {
  const inventory = { pages: ['index.astro', 'about.astro', 'blog/post.astro', 'contact.md'], folders: ['blog', 'empty'] };
  const table: readonly (readonly [string, string, string])[] = [
    ['about.astro', 'about', 'unchanged'],
    ['about.astro', ' about ', 'unchanged'],
    ['about.astro', 'company', 'valid'],
    ['about.astro', 'company.astro', 'valid'],
    ['about.astro', '', 'Enter a URL name.'],
    ['about.astro', '   ', 'Enter a URL name.'],
    ['about.astro', 'a/b', 'Enter a name without folder separators.'],
    ['about.astro', 'a\\b', 'Enter a name without folder separators.'],
    ['about.astro', '..', 'Page paths must stay inside the pages folder.'],
    ['about.astro', 'index', '“index” is the homepage’s file name. Use “Make this page the homepage” instead.'],
    ['about.astro', 'INDEX', '“index” is the homepage’s file name. Use “Make this page the homepage” instead.'],
    ['about.astro', 'Contact', 'The URL /Contact is already used by another page or folder.'],
    ['about.astro', 'empty', 'The URL /empty is already used by another page or folder.'],
    ['about.astro', 'a?b', 'Enter a valid page or folder path.'],
    ['about.astro', 'a*b', 'Use letters, numbers, spaces or dashes in page paths.'],
    ['blog/post.astro', 'story', 'valid'],
  ];
  for (const [page, typed, expected] of table) {
    const check = checkUrlName(page, typed, inventory);
    const answer = check.kind === 'invalid' ? check.problem.message : check.kind;
    assert.equal(answer, expected, `${page} ← ${JSON.stringify(typed)}`);
  }
  const valid = checkUrlName('blog/post.astro', 'story', inventory);
  assert.equal(valid.kind === 'valid' ? valid.change.to : '', 'blog/story.astro');
  assert.equal(urlNameOf('blog/post.astro'), 'post');
  assert.equal(urlNameOf('index.md'), 'index');
});

test('page settings requests parse each kind and refuse the rest', () => {
  assert.deepEqual(parsePageSettingsRequest({ kind: 'home', page: 'about.md' }), { kind: 'home', page: 'about.md' });
  assert.deepEqual(parsePageSettingsRequest({ kind: 'rename', from: 'a.astro', to: 'b.astro' }), { kind: 'rename', from: 'a.astro', to: 'b.astro' });
  assert.deepEqual(parsePageSettingsRequest({ kind: 'duplicate', page: 'blog/a.mdx' }), { kind: 'duplicate', page: 'blog/a.mdx' });
  assert.deepEqual(parsePageSettingsRequest({ kind: 'remove', page: '404.astro' }), { kind: 'remove', page: '404.astro' });
  for (const input of [
    undefined,
    'home',
    { kind: 'home', page: 7 },
    { kind: 'home', page: '../a.astro' },
    { kind: 'remove', page: 'a.css' },
    { kind: 'nope', page: 'a.astro' },
  ]) {
    assert.throws(() => parsePageSettingsRequest(input), JSON.stringify(input) ?? 'undefined');
  }
  assert.equal(parsePageSettingsDirection('undo'), 'undo');
  assert.equal(parsePageSettingsDirection('redo'), 'redo');
  assert.throws(() => parsePageSettingsDirection('again'));
});

test('a settings summary is bounded, 1-based and complete', () => {
  const good = {
    files: 2,
    links: 5,
    moves: [{ from: 'src/pages/index.astro', to: 'src/pages/about.astro' }],
    reviews: [{ file: 'astro.config.mjs', line: 3, text: "'/old': '/'" }],
    reviewsMore: 0,
  };
  assert.deepEqual(parsePageSettingsSummary(good), good);
  const bad: readonly unknown[] = [
    { ...good, files: -1 },
    { ...good, links: 1.5 },
    { ...good, moves: [good.moves[0], good.moves[0], good.moves[0]] },
    { ...good, reviews: [{ file: 'a', line: 0, text: '' }] },
    { ...good, reviews: [{ file: 'a', line: 1, text: 'x'.repeat(PAGE_SETTINGS_LIMITS.reviewLineCharsMax + 1) }] },
    { ...good, reviews: Array.from({ length: PAGE_SETTINGS_LIMITS.reviewsMax + 1 }, () => ({ file: 'a', line: 1, text: '' })) },
    { ...good, reviewsMore: undefined },
  ];
  for (const input of bad) {
    assert.throws(() => parsePageSettingsSummary(input));
  }
  assert.deepEqual(parsePageSettingsApplied({ summary: good, undo: 'page-settings-1', page: 'index.md' }).page, 'index.md');
  assert.throws(() => parsePageSettingsApplied({ summary: good, undo: '', page: 'index.md' }));
  assert.throws(() => parsePageSettingsApplied({ summary: good, undo: 'page-settings-1', page: '../index.md' }));
});

test('a template reading parses each kind and refuses malformed replies', () => {
  assert.deepEqual(parseTemplateReading({ kind: 'none' }), { kind: 'none' });
  assert.deepEqual(parseTemplateReading({ kind: 'custom', code: 'const x = 1;' }), { kind: 'custom', code: 'const x = 1;' });
  const content = {
    kind: 'content',
    collection: 'posts',
    slug: { kind: 'field', name: 'title', treatment: 'slugified' },
    param: 'slug',
    api: 'current',
    code: '',
  };
  assert.deepEqual(parseTemplateReading(content), content);
  const bad: readonly unknown[] = [
    { kind: 'other' },
    { kind: 'custom' },
    { ...content, collection: '' },
    { ...content, param: '1slug' },
    { ...content, api: 'future' },
    { ...content, slug: { kind: 'field' } },
  ];
  for (const input of bad) {
    assert.throws(() => parseTemplateReading(input), JSON.stringify(input));
  }
});

test('a URL name in another folder is a move, checked against that folder', () => {
  const inventory = { pages: ['index.astro', 'about.astro', 'blog/post.astro', 'blog/about.md'], folders: ['blog', 'empty'] };
  const table: readonly (readonly [string, string, string, string])[] = [
    ['about.astro', 'about', 'empty', 'empty/about.astro'],
    ['blog/post.astro', 'post', '', 'post.astro'],
    ['blog/post.astro', 'post', 'blog', 'unchanged'],
    ['about.astro', 'about', 'blog', 'The URL /blog/about is already used by another page or folder.'],
    ['blog/post.astro', 'index', '', '“index” is the homepage’s file name. Use “Make this page the homepage” instead.'],
    ['about.astro', 'about', 'missing', 'This page or folder no longer exists. Refresh the list.'],
  ];
  for (const [page, typed, folder, expected] of table) {
    const check = checkUrlName(page, typed, inventory, { folder });
    const answer = check.kind === 'invalid' ? check.problem.message : check.kind === 'valid' ? check.change.to : check.kind;
    assert.equal(answer, expected, `${page} → ${folder}/${typed}`);
  }
  assert.equal(folderOf('blog/post.astro'), 'blog');
  assert.equal(folderOf('about.astro'), '');
});
