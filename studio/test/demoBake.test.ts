// Goal: a baked build keeps every promise the demo depends on: markers on every node,
// one replaceable section per authored stylesheet, and a snapshot the browser accepts,
// while the project's own files and ordinary builds stay untouched.
// Method: unit-test the pure transforms with known-good and each known-bad input, then
// run a real `astro build` over a disposable project and read what it produced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { styleSectionId } from '../src/features/bake/bakeIntegration';
import { bakePage } from '../src/features/bake/bakeHtml';
import { BAKE_PROTOCOL, BAKE_RUNTIME_DIRECTORY, BAKE_SNAPSHOT_FILE, sectionFences, splitStyleSections } from '../src/features/bake/bakeProtocol';
import { BAKE_LIMITS, parseBakeSnapshot } from '../src/features/bake/bakeSnapshot';
import { bakeSite, planComponentProbes } from '../src/features/bake/bakeSite';
import { renderBaselineScript } from '../src/features/preview/renderBaseline';
import { withRenderBaseline } from '../src/features/preview/previewMiddleware';
import { flatten, nodesOf } from '../src/features/source/source';
import { pathFor } from '../src/features/project/previewSelection';
import { scopeStyles } from '../demo/scopeStyles';
import { styleBlock } from '../demo/styleSections';
import { bakeFixture, FIXTURE_FILES, makeProject } from './demoFixture';

const GOOD_SNAPSHOT = {
  protocol: BAKE_PROTOCOL,
  id: 'a'.repeat(32),
  studioVersion: '1.0.0',
  base: '/demo/site/',
  project: { name: 'Site' },
  assets: {},
  variables: {},
  sources: { 'src/pages/index.astro': '<h1>Hi</h1>' },
  pages: [{ file: 'src/pages/index.astro', route: '/', document: 'index.html' }],
  sections: [{ id: 'src/pages/index.astro#0', file: 'src/pages/index.astro', scope: 'abc123', urls: { 'a.png': '/b.png' } }],
};

function snapshotWith(change: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ ...GOOD_SNAPSHOT, ...change });
}

test('a snapshot parses and keeps what it was given', () => {
  const snapshot = parseBakeSnapshot(JSON.stringify(GOOD_SNAPSHOT));
  assert.equal(snapshot.id, GOOD_SNAPSHOT.id);
  assert.equal(snapshot.pages[0]?.route, '/');
  assert.equal(snapshot.sections[0]?.scope, 'abc123');
});

test("a template's entries parse as pages sharing its file", () => {
  const entry = { file: 'src/pages/docs/[...slug].astro', route: '/docs/intro', document: 'docs/intro/index.html', entry: 'intro' };
  const snapshot = parseBakeSnapshot(snapshotWith({ pages: [...GOOD_SNAPSHOT.pages, entry] }));
  assert.deepEqual(snapshot.pages.at(-1), entry);
  assert.equal(snapshot.pages[0]?.entry, undefined, 'A fixed page carries no entry');
});

test('every known-bad snapshot shape is refused with its reason', () => {
  const cases: readonly (readonly [string, Readonly<Record<string, unknown>>, RegExp])[] = [
    ['another protocol', { protocol: BAKE_PROTOCOL + 1 }, /another bake protocol/],
    ['an id that is no digest', { id: 'nope' }, /not a digest/],
    ['a base outside the site', { base: '//evil.example/' }, /not a site path/],
    ['a base climbing out', { base: '/demo/../' }, /not a site path/],
    ['no pages', { pages: [] }, /no pages/],
    ['pages that are not a list', { pages: {} }, /list is missing/],
    ['too many pages', { pages: Array.from({ length: BAKE_LIMITS.pagesMax + 1 }, () => GOOD_SNAPSHOT.pages[0]) }, /exceeds its limit/],
    ['a page route without a slash', { pages: [{ ...GOOD_SNAPSHOT.pages[0], route: 'home' }] }, /not a path/],
    ['a document outside the site', { pages: [{ ...GOOD_SNAPSHOT.pages[0], document: '../secret.html' }] }, /outside the site/],
    ['an entry of a page that is no template', { pages: [{ ...GOOD_SNAPSHOT.pages[0], entry: 'intro' }] }, /not a template entry/],
    [
      'an entry whose route is a pattern',
      { pages: [{ file: 'src/pages/docs/[...slug].astro', route: '/docs/[...slug]', document: 'docs/a/index.html', entry: 'a' }] },
      /not a template entry/,
    ],
    ['a source outside the project', { sources: { '../etc/passwd.css': 'x' } }, /Invalid project path/],
    ['a scope that is not a scope', { sections: [{ ...GOOD_SNAPSHOT.sections[0], scope: 'a b' }] }, /not an Astro scope/],
    [
      'too many section URLs',
      { sections: [{ ...GOOD_SNAPSHOT.sections[0], urls: Object.fromEntries(Array.from({ length: 201 }, (_v, i) => [`${i}`, 'x'])) }] },
      /too many URLs/,
    ],
  ];
  for (const [name, change, message] of cases) {
    assert.throws(() => parseBakeSnapshot(snapshotWith(change)), message, name);
  }
});

test('a snapshot past its size limit is refused before parsing', () => {
  assert.throws(() => parseBakeSnapshot(' '.repeat(BAKE_LIMITS.snapshotBytesMax + 1)), /exceeds its size limit/);
});

test('style sections split at their fences, in order, around unfenced CSS', () => {
  const first = sectionFences('src/a.css');
  const second = sectionFences('src/b.astro#0');
  const css = `@font-face{}\n${first.start}\n.a{}\n${first.end}\n${second.start}\n.b{}\n${second.end}\n.tail{}`;
  const pieces = splitStyleSections(css);
  assert.deepEqual(
    pieces.map((piece) => piece.section),
    [undefined, 'src/a.css', 'src/b.astro#0', undefined],
  );
  assert.match(pieces[1]?.css ?? '', /\.a\{\}/);
});

test('a broken fence is an error, because it would reorder the cascade', () => {
  const fences = sectionFences('src/a.css');
  const other = sectionFences('src/b.css');
  assert.throws(() => splitStyleSections(`${fences.start}.a{}`), /never ends/);
  assert.throws(() => splitStyleSections(`.a{}${fences.end}`), /without its start/);
  assert.throws(() => splitStyleSections(`${fences.start}${other.start}`), /starts inside/);
});

test('only authored stylesheets get a section', () => {
  const root = '/project';
  assert.equal(styleSectionId('/project/src/styles/site.css', root), 'src/styles/site.css');
  assert.equal(styleSectionId('/project/src/pages/index.astro?astro&type=style&index=2&lang.css', root), 'src/pages/index.astro#2');
  assert.equal(styleSectionId('/project/node_modules/astro/components/viewtransitions.css', root), undefined);
  assert.equal(styleSectionId('/project/src/pages/index.astro', root), undefined);
  assert.equal(styleSectionId('/project/src/styles/site.css?url', root), undefined);
});

test('a page gets its stylesheets inline, a noindex mark and its baseline', () => {
  const { start, end } = sectionFences('src/a.css');
  const css = `${start}.a{color:red}${end}`;
  const html =
    '<html><head data-x="1"><link rel="stylesheet" href="/x.css"><link rel="stylesheet" href="https://other.example/y.css"></head><body></body></html>';
  const baked = bakePage(html, (href) => (href === '/x.css' ? css : undefined));
  assert.deepEqual(baked.sections, ['src/a.css']);
  assert.match(baked.html, /<style data-vite-dev-id="src\/a\.css">\.a\{color:red\}<\/style>/);
  assert.match(baked.html, /href="https:\/\/other\.example\/y\.css"/, 'An external stylesheet stays a link');
  assert.match(baked.html, /<meta name="robots" content="noindex">/);
  assert.match(baked.html, /id="studio-render-baseline"/);
});

test('the shared baseline is byte-for-byte what the dev middleware always sent', async () => {
  const html = '<html><body><script>"</script></body></html>';
  const response = await withRenderBaseline(new Response(html, { headers: { 'content-type': 'text/html' } }));
  assert.equal(
    await response.text(),
    `${html}<script id="studio-render-baseline" type="application/json">${JSON.stringify(html).replaceAll('<', '\\u003c')}</script>`,
  );
  assert.equal(renderBaselineScript('<').includes('<"'), false, 'Page content cannot close the inert script');
});

test('a real build is baked with markers, sections and a valid snapshot', async () => {
  const project = await makeProject();
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'stacki-bake-test-'));
  const out = path.join(scratch, 'out');
  const runtime = path.join(scratch, 'runtime');
  await mkdir(runtime);
  await writeFile(path.join(runtime, 'morph.js'), '// morph');
  await writeFile(path.join(runtime, 'preview-static.js'), '// preview');
  try {
    await bakeFixture(project.root, out, runtime);
    const html = await readFile(path.join(out, 'index.html'), 'utf8');
    const snapshot = parseBakeSnapshot(await readFile(path.join(out, BAKE_RUNTIME_DIRECTORY, BAKE_SNAPSHOT_FILE), 'utf8'));
    const tokens = new Set([...html.matchAll(/data-avb-p="([^"]+)"/g)].flatMap((match) => (match[1] ?? '').split(' ')));
    const nodes = flatten(nodesOf(FIXTURE_FILES['src/pages/index.astro'] ?? '')).filter((node) => node.kind === 'element' || node.kind === 'component');
    assert.ok(nodes.length > 5);
    for (const node of nodes) {
      assert.ok(tokens.has(pathFor(node.id ?? '')), `${node.name ?? node.kind} can be selected on the page`);
    }
    assert.match(html, /<!--avb-s:/, 'Comment markers survive');
    assert.match(html, /stacki-runtime\/preview\.js/);
    assert.doesNotMatch(html, /@vite\/client/);
    assert.doesNotMatch(html, /stacki-s-/, 'No fence reaches a page');
    assert.deepEqual(await readdir(path.join(out, BAKE_RUNTIME_DIRECTORY)).then((files) => files.sort()), [
      'asset-urls.json',
      'morph.js',
      'preview.js',
      'snapshot.json',
    ]);
    assert.deepEqual(
      snapshot.pages.map((page) => page.route),
      ['/about', '/'],
    );
    assert.equal((await readdir(path.join(out, '_astro')).catch(() => [])).filter((name) => name.endsWith('.css')).length, 0, 'Every stylesheet went inline');
    assert.equal(await readFile(path.join(project.root, 'src/pages/index.astro'), 'utf8'), FIXTURE_FILES['src/pages/index.astro'], 'The project is untouched');
    await checkScopeParity(html, snapshot.sections, snapshot.sources);
  } finally {
    await project.stop();
    await rm(scratch, { recursive: true, force: true });
  }
});

async function checkScopeParity(
  html: string,
  sections: ReturnType<typeof parseBakeSnapshot>['sections'],
  sources: Readonly<Record<string, string>>,
): Promise<void> {
  const compact = (css: string) => css.replace(/\s+/g, '').replace(/;}/g, '}');
  const scoped = sections.filter((section) => section.scope !== undefined && section.file === 'src/pages/index.astro');
  assert.equal(scoped.length, 1);
  for (const section of scoped) {
    const authored = styleBlock(sources[section.file] ?? '', 0);
    assert.ok(authored !== undefined);
    const built = new RegExp(`data-vite-dev-id="${section.id}">([^<]*)<`).exec(html)?.[1] ?? '';
    assert.equal(compact(scopeStyles(authored, section.scope ?? '')), compact(built), 'The browser scopes a block as Astro did');
  }
}

test('a bake refuses to clear a folder that is not an earlier bake', async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), 'stacki-bake-keep-'));
  await writeFile(path.join(out, 'precious.txt'), 'keep me');
  try {
    const result = await bakeSite({ root: '/nowhere', out, base: '/demo/site/', runtime: '/nowhere', studioVersion: '0' });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.error.code, 'output-not-empty');
    assert.equal(await readFile(path.join(out, 'precious.txt'), 'utf8'), 'keep me');
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('a bake reports a bad base and a missing Astro as values', async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), 'stacki-bake-empty-'));
  try {
    const base = await bakeSite({ root: '/nowhere', out, base: 'demo', runtime: '/nowhere', studioVersion: '0' });
    assert.equal(base.ok ? '' : base.error.code, 'invalid-base');
    const astro = await bakeSite({ root: '/nowhere', out, base: '/demo/', runtime: '/nowhere', studioVersion: '0' });
    assert.equal(astro.ok ? '' : astro.error.code, 'astro-missing');
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('a probe plan that throws is reported, never taken for a site with no components', async () => {
  const quiet = console.error;
  console.error = () => undefined;
  try {
    const failed = await planComponentProbes('/project', () => Promise.reject(new ReferenceError('assert is not defined')));
    assert.equal(failed.planned, undefined);
    assert.match(failed.failure ?? '', /planning component probes failed: ReferenceError: assert is not defined/);
  } finally {
    console.error = quiet;
  }
  const planned = await planComponentProbes('/project', (root) => Promise.resolve(root.length));
  assert.deepEqual(planned, { planned: 8, failure: undefined });
});
