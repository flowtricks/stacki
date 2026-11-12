// Goal: the lazy catalog loader (src/lib/i18n/loadCatalog.ts) imports a language once, shares one
// import between concurrent callers, never caches a failure, refuses a corrupt module as a value
// rather than a crash, and serves English without any import.
// Method: the real module is bundled for node and driven with fake importers that count calls, then
// once with the shipped importers to prove each shipped chunk loads and parses.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const { ROOT, repoPath } = require('../../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'load-catalog.bundle.cjs');
buildSync({
  stdin: { contents: `export * from './src/lib/i18n/loadCatalog.ts';`, resolveDir: ROOT },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const { createCatalogLoader, loadCatalog } = require(output);

const good = { 'a.b': 'x' };
function importers(overrides) {
  const calls = [];
  const make = (locale) => () => {
    calls.push(locale);
    return Promise.resolve({ messages: good });
  };
  const table = { en: make('en'), es: make('es'), fr: make('fr'), de: make('de'), 'pt-BR': make('pt-BR'), ...overrides };
  return { table, calls };
}

test('a locale is imported once and then served from memory', async () => {
  const { table, calls } = importers({});
  const load = createCatalogLoader(table);
  assert.deepEqual(await load('es'), { ok: true, value: good });
  assert.deepEqual(await load('es'), { ok: true, value: good });
  assert.deepEqual(calls, ['es']);
});

test('concurrent callers share one import', async () => {
  const { table, calls } = importers({});
  const load = createCatalogLoader(table);
  const [first, second] = await Promise.all([load('fr'), load('fr')]);
  assert.equal(first.ok && second.ok, true);
  assert.deepEqual(calls, ['fr']);
});

test('a failed import is a value and is retried next time', async () => {
  let attempts = 0;
  const { table } = importers({
    de: () => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error('offline')) : Promise.resolve({ messages: good });
    },
  });
  const load = createCatalogLoader(table);
  const first = await load('de');
  assert.equal(first.ok, false);
  assert.equal(first.error.code, 'catalog-import-failed');
  assert.match(first.error.message, /offline/);
  assert.equal((await load('de')).ok, true);
  assert.equal(attempts, 2);
});

test('a corrupt module is refused, not trusted', async () => {
  for (const bad of [undefined, 'text', { messages: { 'no-dots': 'x' } }, { messages: { 'a.b': 5 } }, { messages: { 'a.b': '{broken' } }]) {
    const { table } = importers({ es: () => Promise.resolve(bad) });
    const result = await createCatalogLoader(table)('es');
    assert.equal(result.ok, false, JSON.stringify(bad));
  }
});

test('every shipped language loads and parses; English is bundled', async () => {
  for (const locale of ['en', 'es', 'fr', 'de', 'pt-BR']) {
    const result = await loadCatalog(locale);
    assert.equal(result.ok, true, locale);
    assert.ok(Object.keys(result.value).length > 10);
  }
  assert.equal((await loadCatalog('es')).value['settings.title'], 'Ajustes');
});
