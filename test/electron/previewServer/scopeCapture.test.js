// A file's last-rendered frontmatter values reach the binding picker without
// running anything again.
//
//   node test/electron/previewServer/scopeCapture.test.js
//
// Goal: the marked copy of an .astro file ends its frontmatter with one
// statement that files the file's top-level value bindings — and only those —
// in the dev server's memory, and the value route reads them back as bounded
// samples: the first items of a list with their fields and values, clipped
// strings, no getters run, no promises awaited, one node budget across the
// answer, and a bounded wait for a render newer than an edit. A file that has
// not rendered answers "no sample" (an error and no value) instead of throwing.
//
// Method: frontmatterBindings and withScopeCapture are fed frontmatter with
// every kind of top-level statement. The capture statement is then run for
// real: a frontmatter (imports aside) becomes an async function body, so its
// getters close over real bindings exactly as Astro's compiled component does,
// and the value route's own source (SCOPE_SOURCE) is loaded as a module and
// asked for the file — the same code the dev server runs, with no dev server.
// markSourceFile is smoke-tested on a project file on disk.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { frontmatterBindings, scopeCaptureStatement, withScopeCapture, SCOPE_CAPTURE_LIMITS } = require('#dist/electron/previewServer/scopeCapture.js');
const { markSourceFile } = require('#dist/electron/previewServer/previewMarkers.js');
const { SCOPE_SOURCE, VALUE_ENDPOINT } = require('#dist/electron/preview/markerConfig.js');
const { SCOPE_STORE_KEY, PREVIEW_SCOPE_LIMITS } = require('#dist/shared/page/previewScope.js');

const AsyncFunction = (async () => {}).constructor;
// JSON's null, as the route writes it for "no value" and "no error".
const jsonNull = JSON.parse('null');
const store = () => globalThis[Symbol.for(SCOPE_STORE_KEY)];

// The value route's scope reader, loaded as the module the dev server compiles.
let routeModule;
async function route() {
  if (routeModule === undefined) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-scope-route-'));
    const file = path.join(directory, 'scope.mjs');
    fs.writeFileSync(file, `${SCOPE_SOURCE}\nexport { readScope, sampleScopeValue };\n`);
    routeModule = await import(pathToFileURL(file).href);
  }
  return routeModule;
}

// Runs `frontmatter` (no imports) with the capture appended, as a render would.
async function render(file, frontmatter) {
  const marked = withScopeCapture(`---\n${frontmatter}\n---\n<p>page</p>\n`, file);
  const body = marked.slice(4, marked.indexOf('\n---\n', 3));
  await new AsyncFunction(body)();
  return marked;
}

test('the bindings are the frontmatter’s top-level values, and only those', () => {
  const frontmatter = [
    "import type { CollectionEntry } from 'astro:content';",
    "import { type Post, posts, getPosts } from '../data/posts';",
    "import team from '../data/team.json';",
    "import * as site from '../data/site';",
    "import Layout from '../layouts/Layout.astro';",
    "import '../styles/site.css';",
    "import styles from '../styles/card.module.css';",
    'declare const injected: string;',
    'interface Props { title: string }',
    'type Item = { id: string };',
    'const response = await fetch("https://example.org/stats.json");',
    'const data = await response.json();',
    'const { items, meta: { total }, ...rest } = data;',
    'const [first, , third] = items;',
    'let count = 0, label = "Stats";',
    'export const prerender = true;',
    'function helper() { const inner = 1; return inner; }',
    'class Thing {}',
    'if (count) { var hoisted = 1; }',
  ].join('\n');
  assert.deepEqual(frontmatterBindings(frontmatter), [
    'posts',
    'getPosts',
    'team',
    'site',
    'response',
    'data',
    'items',
    'total',
    'rest',
    'first',
    'third',
    'count',
    'label',
    'prerender',
  ]);
  assert.deepEqual(frontmatterBindings(''), [], 'an empty frontmatter binds nothing');
  assert.deepEqual(frontmatterBindings('const = ;'), [], 'a broken declaration names nothing');
  assert.deepEqual(frontmatterBindings('x'.repeat(SCOPE_CAPTURE_LIMITS.frontmatterCharsMax + 1)), [], 'past the length bound nothing is parsed');
  const many = Array.from({ length: PREVIEW_SCOPE_LIMITS.namesMax + 10 }, (_, i) => `const value${i} = ${i};`).join('\n');
  assert.equal(frontmatterBindings(many).length, PREVIEW_SCOPE_LIMITS.namesMax, 'the names are bounded');
});

test('the capture statement refuses what it cannot safely write', () => {
  assert.throws(() => scopeCaptureStatement('src/pages/a.astro', []), /at least one binding/);
  assert.throws(() => scopeCaptureStatement('src/pages/a.astro', ['not-a-name']), /is an identifier/);
  assert.throws(() => scopeCaptureStatement('src/pages/a.astro', ['__stackiScope']), /capture’s own local/);
  const tooMany = Array.from({ length: PREVIEW_SCOPE_LIMITS.namesMax + 1 }, (_, i) => `value${i}`);
  assert.throws(() => scopeCaptureStatement('src/pages/a.astro', tooMany), /bounded number/);
  // The file path is written as a string literal, whatever it holds.
  assert.match(scopeCaptureStatement('src/pages/"quoted".astro', ['a']), /"src\/pages\/\\"quoted\\"\.astro"/);
});

test('the capture is the frontmatter’s last line, and a file binding nothing is left alone', () => {
  const marked = withScopeCapture('---\nconst stats = [1, 2]\n---\n<p>{stats}</p>\n', 'src/pages/a.astro');
  const lines = marked.split('\n');
  assert.equal(lines[0], '---');
  assert.equal(lines[1], 'const stats = [1, 2]');
  assert.match(lines[2], /^;\{const __stackiScope=/, 'the capture follows the last statement, opened with `;`');
  assert.equal(lines[3], '---');
  assert.equal(lines.slice(4).join('\n'), '<p>{stats}</p>\n', 'the template is untouched');
  const untouched = '---\nimport Layout from "../layouts/Layout.astro";\n---\n<Layout />\n';
  assert.equal(withScopeCapture(untouched, 'src/pages/a.astro'), untouched);
  assert.equal(withScopeCapture('<p>no frontmatter</p>\n', 'src/pages/a.astro'), '<p>no frontmatter</p>\n');
  assert.equal(withScopeCapture('---\nconst open = 1\n', 'src/pages/a.astro'), '---\nconst open = 1\n', 'an unclosed fence is left alone');
});

test('a fetched list samples to its first items’ fields and values', async () => {
  const { readScope } = await route();
  // `await fetch(url)` then `await res.json()`, with the response standing in.
  await render(
    'src/pages/stats.astro',
    [
      'const response = { ok: true, json: async () => ({ items: Array.from({ length: 20 }, (_, i) => ({ id: "stat-" + i, data: { Number: (60 + i) + "%", Header: "Uptime" } })) }) };',
      'const data = await response.json();',
      'const statsEntries = data.items;',
      'const literal = [{ title: "One" }, { title: "Two" }];',
    ].join('\n'),
  );
  const answer = await readScope('src/pages/stats.astro', 0, 0);
  assert.equal(answer.error, jsonNull);
  const { statsEntries, data, literal, response } = answer.value;
  assert.deepEqual(statsEntries[0], { id: 'stat-0', data: { Number: '60%', Header: 'Uptime' } });
  assert.equal(statsEntries.length, 9, 'eight items and a marker for the rest');
  assert.deepEqual(statsEntries[8], { __stacki: 'more', count: 12 });
  assert.equal(data.items[1].data.Number, '61%', 'a path inside a value samples with it');
  assert.deepEqual(literal, [{ title: 'One' }, { title: 'Two' }]);
  assert.deepEqual(response, { ok: true }, 'a response’s body is never read: its method is code, not data');
});

test('reading a sample runs no getter, awaits no promise and stops at every bound', async () => {
  const { readScope, sampleScopeValue } = await route();
  globalThis.getterRuns = 0;
  await render(
    'src/pages/bounds.astro',
    [
      'const lazy = { plain: 1, get computed() { globalThis.getterRuns += 1; return 2; } };',
      'const pending = new Promise(() => {});',
      'const long = "x".repeat(500);',
      'const odd = { nan: NaN, infinite: Infinity, when: new Date(0), link: new URL("https://example.org/a") };',
      'let deep = {}; for (let i = 0, at = deep; i < 20; i++) { at.next = {}; at = at.next; }',
      'const helper = () => 1;',
      'const nothing = null;',
    ].join('\n'),
  );
  const { value } = await readScope('src/pages/bounds.astro', 0, 0);
  assert.deepEqual(value.lazy, { plain: 1 }, 'an accessor is left out');
  assert.equal(globalThis.getterRuns, 0, 'and never run');
  assert.deepEqual(value.pending, undefined, 'a promise is not a sample');
  assert.equal(value.long.length, 161, 'a long string is clipped');
  assert.ok(value.long.endsWith('…'));
  assert.deepEqual(value.odd, {
    nan: jsonNull,
    infinite: jsonNull,
    when: { __stacki: 'date', value: '1970-01-01T00:00:00.000Z' },
    link: 'https://example.org/a',
  });
  let at = value.deep;
  let depth = 0;
  while (at.next !== undefined && depth < 20) {
    at = at.next;
    depth += 1;
  }
  assert.deepEqual(at, { __stacki: 'deep' }, 'nesting stops at its depth bound');
  assert.equal(depth, 6);
  assert.equal('helper' in value, false, 'a function is code, not data');
  assert.equal(value.nothing, jsonNull);
  // One node budget across the whole answer: wide data runs out and says so.
  const budget = { nodes: 3 };
  assert.deepEqual(sampleScopeValue({ a: 1, b: 2, c: 3 }, budget, 0), { a: 1, b: 2, c: { __stacki: 'deep' } });
  assert.equal(budget.nodes, 0);
});

test('a binding the render never reached is skipped, not thrown', async () => {
  const { readScope } = await route();
  // The getter for `later` throws, as one for a binding past an early return would.
  store().set('src/pages/early.astro', {
    at: Date.now(),
    values: {
      get reached() {
        return [1];
      },
      get later() {
        throw new ReferenceError('later is not defined');
      },
    },
  });
  const { value, error } = await readScope('src/pages/early.astro', 0, 0);
  assert.equal(error, jsonNull);
  assert.deepEqual(value, { reached: [1] });
});

test('an unrendered or unknown file answers no sample, and a fresh render is waited for', async () => {
  const { readScope } = await route();
  assert.deepEqual(await readScope('src/pages/never.astro', 0, 0), { value: jsonNull, error: 'The file has not rendered yet' });
  assert.deepEqual(await readScope('../outside.astro', 0, 0), { value: jsonNull, error: 'Not a project .astro file' });
  assert.deepEqual(await readScope('src/pages/script.js', 0, 0), { value: jsonNull, error: 'Not a project .astro file' });
  await render('src/pages/edited.astro', 'const version = "before";');
  // An edit asks for a render no older than itself: the old one is not it.
  const since = Date.now() + 1;
  const waiting = readScope('src/pages/edited.astro', since, 2000);
  setTimeout(() => {
    store().set('src/pages/edited.astro', { at: since + 1, values: { version: 'after' } });
  }, 150);
  assert.deepEqual((await waiting).value, { version: 'after' });
  // No newer render within the wait: the last one is the answer.
  const stale = await readScope('src/pages/edited.astro', Date.now() + 60_000, 200);
  assert.deepEqual(stale.value, { version: 'after' });
});

test('the record keeps a bounded number of files, dropping the oldest render', async () => {
  for (let i = 0; i < PREVIEW_SCOPE_LIMITS.filesMax + 5; i++) {
    await render(`src/pages/many-${i}.astro`, `const index = ${i};`);
  }
  assert.ok(store().size <= PREVIEW_SCOPE_LIMITS.filesMax);
  assert.equal(store().has('src/pages/many-0.astro'), false);
  assert.equal(store().has(`src/pages/many-${PREVIEW_SCOPE_LIMITS.filesMax + 4}.astro`), true);
});

test('the value route answers scope requests through its own reader', () => {
  assert.ok(VALUE_ENDPOINT.includes(SCOPE_SOURCE), 'the route embeds the reader tested here');
  assert.match(VALUE_ENDPOINT, /searchParams\.get\('p'\)/);
});

test('a marked project file carries the capture for its own path', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-scope-mark-'));
  const pages = path.join(directory, 'src', 'pages');
  fs.mkdirSync(pages, { recursive: true });
  const file = path.join(pages, 'stats.astro');
  fs.writeFileSync(
    file,
    [
      '---',
      "import type { CollectionEntry } from 'astro:content';",
      "import { getCollection } from 'astro:content';",
      "import Layout from '../layouts/Layout.astro';",
      "const statsEntries = await getCollection('stats', ({ data }) => !data.draft);",
      '---',
      '<Layout>',
      '  <ul>{statsEntries.map((item) => (<li>{item.data.Header}</li>))}</ul>',
      '</Layout>',
      '',
    ].join('\n'),
  );
  try {
    const marked = markSourceFile(file, [directory]);
    assert.ok(marked, 'the page is marked');
    const close = marked.code.indexOf('\n---\n', 3);
    const frontmatter = marked.code.slice(0, close);
    const capture = frontmatter.split('\n').at(-1);
    assert.match(capture, /\.set\("src\/pages\/stats\.astro",/);
    assert.match(capture, /get getCollection\(\)\{return getCollection\}/);
    assert.match(capture, /get statsEntries\(\)\{return statsEntries\}/);
    assert.doesNotMatch(capture, /CollectionEntry|Layout/, 'no type and no component is captured');
    assert.equal(marked.source.includes('__stackiScope'), false, 'the file on disk is not what carries it');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
