// Goal: merging each language's catalogs into one file (scripts/catalogBundle.ts) changes the
// number of release files and nothing a person reads. Method: for every language, load the
// assembled index (what Studio and a release carry) and the Stacki source index, and hold their
// messages equal key for key; then check that only the standalone namespaces stay files of their
// own, that quotes, backslashes and line breaks survive, and that a broken inventory stops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CATALOG_ROOT, planCatalogs, STANDALONE_NAMESPACES } from '../scripts/catalogBundle';
import { record } from '../src/shared/primitiveValidation';

const studio = fileURLToPath(new URL('../', import.meta.url));
const root = path.dirname(studio);

async function messagesOf(file: string): Promise<Record<string, unknown>> {
  const loaded = record(await import(pathToFileURL(file).href));
  return record(loaded['messages'] ?? record(loaded['default'])['messages']);
}

test('every assembled language holds exactly the messages its Stacki source does', async () => {
  const locales = (await readdir(path.join(root, CATALOG_ROOT), { withFileTypes: true })).filter((entry) => entry.isDirectory());
  assert.ok(locales.length >= 18, 'Every interface language is read');
  for (const { name } of locales) {
    const assembled = path.join(studio, 'vendor/stacki', CATALOG_ROOT, name);
    assert.deepEqual((await readdir(assembled)).sort(), ['index.ts', ...STANDALONE_NAMESPACES.map((namespace) => `${namespace}.ts`)].sort(), name);
    assert.deepEqual(await messagesOf(path.join(assembled, 'index.ts')), await messagesOf(path.join(root, CATALOG_ROOT, name, 'index.ts')), name);
    const text = await readFile(path.join(assembled, 'index.ts'), 'utf8');
    assert.match(text, name === 'en' ? /satisfies CatalogOf<string>;\n\nexport type MessageKey/ : /satisfies CatalogOf<MessageKey>;\n$/, name);
  }
});

test('awkward characters survive the merge, and other files are copied as they are', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'stacki-catalog-'));
  try {
    const messages = {
      'a.quote': 'It\'s "quoted"',
      'a.slash': 'a\\b \\" \\\\\' c',
      'a.lines': 'one\ntwo three',
      'a.plural': { one: "{count} file's", other: '{count} files' },
    };
    const english = path.join(folder, CATALOG_ROOT, 'en');
    await mkdir(english, { recursive: true });
    await writeFile(path.join(english, 'index.mjs'), '');
    await writeFile(path.join(english, 'index.ts'), `export const messages = ${JSON.stringify({ ...messages, 'studio.title': 'Studio' })};\n`);
    await writeFile(path.join(english, 'studio.ts'), "export const messages = { 'studio.title': 'Studio' };\n");
    await writeFile(path.join(english, 'ui.ts'), 'export const messages = {};\n');
    const plan = await planCatalogs(folder, [`${CATALOG_ROOT}en/index.ts`, `${CATALOG_ROOT}en/studio.ts`, `${CATALOG_ROOT}en/ui.ts`, 'shared/core/assert.ts']);
    assert.deepEqual(plan.files, [`${CATALOG_ROOT}en/studio.ts`, 'shared/core/assert.ts']);
    const bundle = plan.bundles.get(`${CATALOG_ROOT}en/index.ts`);
    assert.ok(bundle);
    assert.match(bundle, / {2}\.\.\.studio,\n\} as const/);
    await writeFile(path.join(english, 'merged.ts'), bundle.replace(/^import .*\n/gm, '').replace('...studio,', "'studio.title': 'Studio',"));
    assert.deepEqual(await messagesOf(path.join(english, 'merged.ts')), { ...messages, 'studio.title': 'Studio' });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('a language listed without its index stops the assemble', async () => {
  await assert.rejects(planCatalogs(root, [`${CATALOG_ROOT}de/ai.ts`]), /Assertion failed: .*de catalogs without their index/);
});
