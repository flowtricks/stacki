// Goal: the copy's plan sends every file of a plain website where its old address keeps working: pages to
// src/pages as .astro, everything else to public/, pages Astro cannot route as themselves to public/ unchanged,
// and a forwarding page at every old .htm address. The scaffold is a working Astro project, and the bounds
// refuse a folder before anything is written.
// Method: pure plans from synthetic listings, asserted as exact target paths. URL resolution is checked with
// the WHATWG URL parser: a relative link resolves to the same address from the old page's URL and from the URL
// Astro serves the copied page at (the file name under src/pages, built with format 'preserve'), and that
// address names the file under public/. Negative space: collisions, `_` and `[` names, project files, an empty
// folder, and each bound at its limit and one past it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  ASTRO_COPY_ASTRO_RANGE,
  ASTRO_COPY_FILE_LIMITS,
  forwardingPage,
  packageNameFor,
  planAstroCopy,
  routePages,
} from '#dist/electron/project/astroCopyPlan.js';

const file = (relative: string, sizeBytes = 10) => ({ relative, absolute: `/site/${relative}`, sizeBytes, mode: 0o644 });
const listing = (paths: readonly string[], skipped = 0) => ({
  files: paths.map((relative) => file(relative)),
  skipped: Array.from({ length: skipped }, (_, index) => ({ relative: `.hidden-${index}`, reason: 'hidden' as const })),
  truncated: false,
});

function targets(paths: readonly string[]): Readonly<Record<string, string>> {
  const plan = planAstroCopy(listing(paths), 'shop-astro');
  assert.ok(plan.ok);
  return Object.fromEntries(plan.value.entries.flatMap((entry) => (entry.kind === 'generated' ? [] : [[entry.source.relative, entry.target]])));
}

test('pages go to src/pages as .astro at the same path, everything else to public/ at the same path', () => {
  assert.deepEqual(
    targets([
      'index.html',
      'about/index.html',
      'contact.html',
      'Blog Post.HTML',
      'café/menu.html',
      'css/site.css',
      'js/app.js',
      'img/logo.png',
      'fonts/a.woff2',
      'video/intro.mp4',
      'data.json',
      'favicon.ico',
      'robots.txt',
      '.well-known/security.txt',
      'src/legacy.js',
    ]),
    {
      'index.html': 'src/pages/index.astro',
      'about/index.html': 'src/pages/about/index.astro',
      'contact.html': 'src/pages/contact.astro',
      'Blog Post.HTML': 'src/pages/Blog Post.astro',
      'café/menu.html': 'src/pages/café/menu.astro',
      'css/site.css': 'public/css/site.css',
      'js/app.js': 'public/js/app.js',
      'img/logo.png': 'public/img/logo.png',
      'fonts/a.woff2': 'public/fonts/a.woff2',
      'video/intro.mp4': 'public/video/intro.mp4',
      'data.json': 'public/data.json',
      'favicon.ico': 'public/favicon.ico',
      'robots.txt': 'public/robots.txt',
      '.well-known/security.txt': 'public/.well-known/security.txt',
      'src/legacy.js': 'public/src/legacy.js',
    },
  );
});

// The address Astro serves a copied page at, built with format 'preserve' (and served alike by `astro dev`).
function servedAt(pageTarget: string): string {
  const relative = pageTarget.replace(/^src\/pages\//, '').replace(/\.astro$/, '.html');
  return `https://site.test/${relative.split('/').map(encodeURIComponent).join('/')}`;
}

test('a relative or root-relative link resolves to the same address before and after, and that address is the copied file', () => {
  const pages = ['index.html', 'about/index.html', 'about/team.html', 'blog/2024/post.html', 'docs/a b/page.html'];
  const assets = ['css/site.css', 'about/photo.jpg', 'blog/2024/chart.png', 'img/logo.svg', 'docs/a b/diagram.svg'];
  const plan = targets([...pages, ...assets]);
  const links = [
    'css/site.css',
    '../css/site.css',
    '../../css/site.css',
    'photo.jpg',
    './chart.png',
    '/img/logo.svg',
    'diagram.svg',
    '../index.html',
    'team.html',
  ];
  for (const page of pages) {
    const before = `https://site.test/${page.split('/').map(encodeURIComponent).join('/')}`;
    const target = plan[page];
    assert.ok(target !== undefined, page);
    const after = servedAt(target);
    assert.equal(after, before, `${page} keeps its address`);
    for (const link of links) {
      const resolved = new URL(link, after).pathname;
      assert.equal(resolved, new URL(link, before).pathname, `${link} from ${page}`);
      // When the old link named a file of the site, the new address names its copy.
      const named = decodeURIComponent(resolved).slice(1);
      if (assets.includes(named)) {
        assert.equal(plan[named], `public/${named}`, `${link} from ${page} still finds ${named}`);
      }
    }
  }
});

test('two pages Astro would serve at one route: the folder index wins, then .html over .htm, and the other stays a plain file', () => {
  const decisions = routePages([
    { relative: 'about.html' },
    { relative: 'about/index.html' },
    { relative: 'x.htm' },
    { relative: 'x.html' },
    { relative: 'index.htm' },
    { relative: 'index.html' },
  ]);
  assert.deepEqual(Object.fromEntries(decisions), {
    'about.html': 'kept',
    'about/index.html': 'page',
    'x.htm': 'kept',
    'x.html': 'page',
    'index.htm': 'kept',
    'index.html': 'page',
  });
  const plan = planAstroCopy(listing(['about.html', 'about/index.html']), 'shop-astro');
  assert.ok(plan.ok);
  assert.deepEqual(plan.value.keptAsFiles, ['about.html']);
  assert.deepEqual(
    plan.value.entries.filter((entry) => entry.kind !== 'generated').map((entry) => [entry.kind, entry.target]),
    [
      ['asset', 'public/about.html'],
      ['page', 'src/pages/about/index.astro'],
    ],
  );
});

test('a name or folder Astro skips or reads as a parameter stays a plain file at its old address', () => {
  const plan = planAstroCopy(listing(['index.html', '_partial.html', '_drafts/a.html', '[id].html', 'shop/[slug]/index.html', 'ok_name.html']), 'shop-astro');
  assert.ok(plan.ok);
  assert.deepEqual(plan.value.keptAsFiles, ['_partial.html', '_drafts/a.html', '[id].html', 'shop/[slug]/index.html']);
  assert.equal(plan.value.pageCount, 2);
  const kept = plan.value.entries.filter((entry) => entry.kind === 'asset').map((entry) => entry.target);
  assert.deepEqual(kept, ['public/_partial.html', 'public/_drafts/a.html', 'public/[id].html', 'public/shop/[slug]/index.html']);
});

test('a .htm page is served as .html, and a forwarding page holds its old address', () => {
  const plan = planAstroCopy(listing(['Old Page.HTM', 'news/index.htm']), 'shop-astro');
  assert.ok(plan.ok);
  const byTarget = Object.fromEntries(plan.value.entries.map((entry) => [entry.target, entry]));
  assert.equal(byTarget['src/pages/Old Page.astro']?.kind, 'page');
  assert.equal(byTarget['src/pages/news/index.astro']?.kind, 'page');
  const forward = byTarget['public/Old Page.HTM'];
  assert.ok(forward?.kind === 'generated');
  assert.equal(forward.text, forwardingPage('Old Page.HTM'));
  assert.match(forward.text, /url=Old%20Page\.html"/);
  assert.match(forward.text, /location\.replace\('Old%20Page\.html' \+ location\.search \+ location\.hash\)/);
  assert.match(byTarget['public/news/index.htm']?.kind === 'generated' ? byTarget['public/news/index.htm'].text : '', /url=index\.html"/);
  assert.throws(() => forwardingPage('a.html'), /Assertion failed/);
});

test("the original's project files are left out, and every left-out entry is counted", () => {
  const plan = planAstroCopy(listing(['index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'docs/package.json'], 3), 'shop-astro');
  assert.ok(plan.ok);
  assert.equal(plan.value.skippedCount, 6);
  const written = plan.value.entries.map((entry) => entry.target);
  assert.ok(written.includes('public/docs/package.json'), 'only the root ones describe the old project');
  assert.ok(!written.includes('public/package.json'));
});

test('the scaffold is an Astro project that builds every page under its old file name', () => {
  const plan = planAstroCopy(listing(['index.html']), 'My Shop-astro');
  assert.ok(plan.ok);
  const generated = Object.fromEntries(plan.value.entries.flatMap((entry) => (entry.kind === 'generated' ? [[entry.target, entry.text]] : [])));
  assert.deepEqual(Object.keys(generated).sort(), ['.gitignore', 'astro.config.mjs', 'package.json', 'tsconfig.json']);
  const manifest: unknown = JSON.parse(generated['package.json'] ?? '');
  assert.deepEqual(manifest, {
    name: 'my-shop-astro',
    type: 'module',
    version: '0.0.1',
    private: true,
    scripts: { dev: 'astro dev', build: 'astro build', preview: 'astro preview', astro: 'astro' },
    dependencies: { astro: ASTRO_COPY_ASTRO_RANGE },
  });
  assert.match(generated['astro.config.mjs'] ?? '', /build: \{ format: 'preserve', inlineStylesheets: 'always' \}/);
  assert.match(generated['astro.config.mjs'] ?? '', /trailingSlash: 'ignore'/);
  assert.match(generated['.gitignore'] ?? '', /^node_modules\/$/m);
  assert.deepEqual(JSON.parse(generated['tsconfig.json'] ?? ''), {
    extends: 'astro/tsconfigs/base',
    include: ['.astro/types.d.ts', '**/*'],
    exclude: ['dist'],
  });
});

test("the astro range is the one Stacki's Studio builds against", () => {
  const studio: unknown = JSON.parse(fs.readFileSync(path.resolve('studio/package.json'), 'utf8'));
  assert.ok(typeof studio === 'object' && studio !== null && 'devDependencies' in studio);
  const dependencies = studio.devDependencies;
  assert.ok(typeof dependencies === 'object' && dependencies !== null && 'astro' in dependencies);
  assert.equal(dependencies.astro, ASTRO_COPY_ASTRO_RANGE);
});

test('package names are what npm accepts', () => {
  assert.equal(packageNameFor('My Shop-astro'), 'my-shop-astro');
  assert.equal(packageNameFor('Café ☕ site'), 'caf-site');
  assert.equal(packageNameFor('.._weird'), 'weird');
  assert.equal(packageNameFor('☕'), 'site');
  assert.equal(packageNameFor('a'.repeat(300)).length, 214);
});

test('a folder with no page, or past a bound, is refused before anything is written', () => {
  assert.deepEqual(planAstroCopy(listing(['a.css', 'package.json']), 'x'), { ok: false, error: { code: 'not-plain-website' } });
  assert.deepEqual(planAstroCopy({ ...listing(['index.html']), truncated: true }, 'x'), {
    ok: false,
    error: { code: 'too-many-files', limit: ASTRO_COPY_FILE_LIMITS.filesMax },
  });
  const atLimit = Array.from({ length: ASTRO_COPY_FILE_LIMITS.filesMax }, (_, index) => `f${index}.txt`);
  atLimit[0] = 'index.html';
  assert.equal(planAstroCopy(listing(atLimit), 'x').ok, true);
  assert.deepEqual(planAstroCopy(listing([...atLimit, 'one-more.txt']), 'x'), {
    ok: false,
    error: { code: 'too-many-files', limit: ASTRO_COPY_FILE_LIMITS.filesMax },
  });
  const sized = (entries: readonly (readonly [string, number])[]) => ({
    files: entries.map(([relative, sizeBytes]) => file(relative, sizeBytes)),
    skipped: [],
    truncated: false,
  });
  assert.equal(planAstroCopy(sized([['index.html', ASTRO_COPY_FILE_LIMITS.pageBytesMax]]), 'x').ok, true);
  assert.deepEqual(planAstroCopy(sized([['index.html', ASTRO_COPY_FILE_LIMITS.pageBytesMax + 1]]), 'x'), {
    ok: false,
    error: { code: 'file-too-large', limit: ASTRO_COPY_FILE_LIMITS.pageBytesMax, file: 'index.html' },
  });
  assert.deepEqual(
    planAstroCopy(
      sized([
        ['index.html', 1],
        ['film.mov', ASTRO_COPY_FILE_LIMITS.fileBytesMax + 1],
      ]),
      'x',
    ),
    { ok: false, error: { code: 'file-too-large', limit: ASTRO_COPY_FILE_LIMITS.fileBytesMax, file: 'film.mov' } },
  );
  assert.deepEqual(
    planAstroCopy(
      sized([
        ['index.html', 1],
        ['a.mov', ASTRO_COPY_FILE_LIMITS.fileBytesMax],
        ['b.mov', ASTRO_COPY_FILE_LIMITS.fileBytesMax],
      ]),
      'x',
    ),
    { ok: false, error: { code: 'too-many-bytes', limit: ASTRO_COPY_FILE_LIMITS.totalBytesMax } },
  );
  assert.throws(() => planAstroCopy(listing(['index.html']), ''), /Assertion failed/);
});
