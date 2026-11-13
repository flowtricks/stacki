// Goal: translations cannot drift from English. Every locale catalog has exactly English's keys and,
// for each key, the same placeholders, so a translator can neither lose a {name} nor invent one, and a
// new English string without translations fails here instead of shipping half-English.
// Method: the catalogs are split into one file per namespace per locale (docs/i18n.md), so the test lists
// the namespace files of English and holds every other locale to them one by one: the same file set, the
// same keys, the same placeholders per key. A namespace file may only hold keys with its own prefix, and
// each locale's index (the module the lazy loader imports) must merge exactly the namespace files it has.
// Rich messages (`<tag>…</tag>` marks, docs/i18n-playbook.md) must keep exactly English's tags and parse. Each message is also
// non-empty text that differs from English except where the translation line carries the marker `// same` (a product term, a
// cognate such as "Menu"): the exception is written next to the text it excuses, so parallel agents never edit one shared list.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseCatalog, parseMessage, placeholderSet, templatesOf } from '#dist/shared/core/i18n/catalog.js';
import { parseRichTemplate } from '#dist/shared/core/i18n/richText.js';
import { LOCALES } from '#dist/shared/core/i18n/locales.js';

type Messages = Readonly<Record<string, unknown>>;

const DIRECTORY_OF = { en: 'en', es: 'es', fr: 'fr', de: 'de', 'pt-BR': 'ptBR' } as const satisfies Record<(typeof LOCALES)[number], string>;
const SOURCE_ROOT = path.resolve(process.cwd(), 'shared/properties/i18n/messages');
const NAMESPACE_PATTERN = /^[a-z][A-Za-z0-9]*$/;

function namespacesOf(directory: string): readonly string[] {
  return fs
    .readdirSync(path.join(SOURCE_ROOT, directory))
    .filter((name) => name.endsWith('.ts') && name !== 'index.ts')
    .map((name) => name.slice(0, -'.ts'.length))
    .sort();
}

async function loadNamespace(locale: (typeof LOCALES)[number], namespace: string): Promise<Messages> {
  const loaded: unknown = await import(`#dist/shared/properties/i18n/messages/${DIRECTORY_OF[locale]}/${namespace}.js`);
  assert.ok(typeof loaded === 'object' && loaded !== null && 'messages' in loaded, `${locale}/${namespace} exports messages`);
  const messages: unknown = loaded.messages;
  assert.ok(typeof messages === 'object' && messages !== null, `${locale}/${namespace} messages is an object`);
  return Object.fromEntries(Object.entries(messages));
}

async function loadIndex(locale: (typeof LOCALES)[number]): Promise<Messages> {
  const loaded: unknown = await import(`#dist/shared/properties/i18n/messages/${DIRECTORY_OF[locale]}/index.js`);
  assert.ok(typeof loaded === 'object' && loaded !== null && 'messages' in loaded, `${locale} index exports messages`);
  const messages: unknown = loaded.messages;
  assert.ok(typeof messages === 'object' && messages !== null, `${locale} index messages is an object`);
  return Object.fromEntries(Object.entries(messages));
}

function placeholdersOfKey(catalog: Messages, key: string): readonly string[] {
  const value = Object.entries(catalog).find(([name]) => name === key)?.[1];
  assert.ok(value !== undefined, `${key} exists`);
  const message = parseMessage(value);
  assert.ok(message.ok, `${key} parses`);
  const set = placeholderSet(message.value);
  assert.ok(set.ok, `${key} is well formed`);
  return set.value;
}

test('every shipped locale has a directory in this test', () => {
  assert.deepEqual(Object.keys(DIRECTORY_OF).sort(), [...LOCALES].sort());
});

test('namespace names are plain lowerCamel words, and English has at least one', () => {
  const namespaces = namespacesOf('en');
  assert.ok(namespaces.length > 0);
  for (const namespace of namespaces) {
    assert.match(namespace, NAMESPACE_PATTERN, `${namespace} is a valid namespace`);
  }
});

test('every locale has exactly English’s namespace files', () => {
  const expected = namespacesOf('en');
  for (const locale of LOCALES) {
    assert.deepEqual(namespacesOf(DIRECTORY_OF[locale]), expected, `${locale} namespace files`);
  }
});

test('a namespace file only holds keys with its own prefix', async () => {
  for (const locale of LOCALES) {
    for (const namespace of namespacesOf('en')) {
      const messages = await loadNamespace(locale, namespace);
      for (const key of Object.keys(messages)) {
        assert.ok(key.startsWith(`${namespace}.`), `${locale}/${namespace}.ts holds ${key}, which belongs to another namespace`);
      }
    }
  }
});

test('every namespace file passes the boundary parser', async () => {
  for (const locale of LOCALES) {
    for (const namespace of namespacesOf('en')) {
      const parsed = parseCatalog(await loadNamespace(locale, namespace));
      assert.ok(parsed.ok, `${locale}/${namespace}: ${parsed.ok ? '' : parsed.error.message}`);
    }
  }
});

test('every namespace file has exactly English’s keys', async () => {
  for (const namespace of namespacesOf('en')) {
    const expected = Object.keys(await loadNamespace('en', namespace)).sort();
    assert.ok(expected.length > 0, `en/${namespace}.ts is not empty`);
    for (const locale of LOCALES) {
      const keys = Object.keys(await loadNamespace(locale, namespace)).sort();
      assert.deepEqual(
        keys.filter((key) => !expected.includes(key)),
        [],
        `${locale}/${namespace} has keys English lacks`,
      );
      assert.deepEqual(
        expected.filter((key) => !keys.includes(key)),
        [],
        `${locale}/${namespace} lacks English keys`,
      );
    }
  }
});

test('each locale index merges exactly the keys of its namespace files, and passes the boundary parser', async () => {
  for (const locale of LOCALES) {
    const merged: string[] = [];
    for (const namespace of namespacesOf(DIRECTORY_OF[locale])) {
      merged.push(...Object.keys(await loadNamespace(locale, namespace)));
    }
    const index = await loadIndex(locale);
    assert.deepEqual(Object.keys(index).sort(), merged.sort(), `${locale} index is missing a namespace file or holds an extra key`);
    const parsed = parseCatalog(index);
    assert.ok(parsed.ok, `${locale}: ${parsed.ok ? '' : parsed.error.message}`);
  }
});

test('every translation uses exactly the placeholders of its English message', async () => {
  for (const namespace of namespacesOf('en')) {
    const english = await loadNamespace('en', namespace);
    for (const locale of LOCALES) {
      const translated = await loadNamespace(locale, namespace);
      for (const key of Object.keys(english)) {
        assert.deepEqual(placeholdersOfKey(translated, key), placeholdersOfKey(english, key), `${locale} ${key}`);
      }
    }
  }
});

const TAG_PATTERN = /<\/?[a-z][A-Za-z0-9]*>/g;

function tagsOfKey(catalog: Messages, key: string): readonly string[] {
  const value = Object.entries(catalog).find(([name]) => name === key)?.[1];
  const message = parseMessage(value);
  assert.ok(message.ok, `${key} parses`);
  const tags = new Set<string>();
  for (const template of templatesOf(message.value)) {
    for (const tag of template.match(TAG_PATTERN) ?? []) {
      tags.add(tag);
    }
  }
  return [...tags].sort();
}

test('rich messages keep exactly English’s tags in every language, and parse as rich text', async () => {
  for (const namespace of namespacesOf('en')) {
    const english = await loadNamespace('en', namespace);
    for (const locale of LOCALES) {
      const translated = await loadNamespace(locale, namespace);
      for (const key of Object.keys(english)) {
        const tags = tagsOfKey(english, key);
        assert.deepEqual(tagsOfKey(translated, key), tags, `${locale} ${key} tags`);
        if (tags.length > 0) {
          const message = parseMessage(Object.entries(translated).find(([name]) => name === key)?.[1]);
          assert.ok(message.ok);
          for (const template of templatesOf(message.value)) {
            assert.ok(parseRichTemplate(template).ok, `${locale} ${key} is well formed rich text`);
          }
        }
      }
    }
  }
});

/** True when the `key` entry in a locale's namespace file carries `// same`, the marker for text that stays English on purpose. */
function markedSame(locale: (typeof LOCALES)[number], key: string): boolean {
  const namespace = key.slice(0, key.indexOf('.'));
  const lines = fs.readFileSync(path.join(SOURCE_ROOT, DIRECTORY_OF[locale], `${namespace}.ts`), 'utf8').split('\n');
  const start = lines.findIndex((line) => line.startsWith(`  '${key}':`) || line.startsWith(`  "${key}":`));
  assert.ok(start >= 0, `${locale}/${namespace}.ts has ${key}`);
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (index > start && (line.startsWith("  '") || line.startsWith('  "') || line.startsWith('}'))) {
      return false;
    }
    if (line.includes('// same')) {
      return true;
    }
  }
  return false;
}

test('no message is empty, and a translation differs from English unless it is a product term', async () => {
  const sameAsEnglishAllowed = new Set([
    'settings.tab.studio',
    'settings.tab.audits',
    'settings.tab.roles',
    'settings.tab.instructions',
    'settings.editor.section.general',
    'settings.secrets.name',
    'settings.secrets.tab',
    'settings.secrets.title',
    // Product terms and universal words of the MCP tab.
    'settings.mcp.agent.claude',
    'settings.mcp.tab',
    'settings.mcp.view.json',
    'settings.mcp.edit.url',
  ]);
  const english = await loadIndex('en');
  for (const locale of LOCALES) {
    for (const [key, value] of Object.entries(await loadIndex(locale))) {
      // A plural message is an object of forms; the parser (above) already holds its forms to non-empty text.
      if (typeof value !== 'string') {
        assert.ok(parseMessage(value).ok, `${locale} ${key} is a message`);
        continue;
      }
      assert.ok(value.trim().length > 0, `${locale} ${key} is non-empty text`);
      const source = Object.entries(english).find(([name]) => name === key)?.[1];
      if (locale !== 'en' && value === source) {
        assert.ok(
          sameAsEnglishAllowed.has(key) || markedSame(locale, key),
          `${locale} ${key} is untranslated (add a trailing // same comment if it is a product term)`,
        );
      }
    }
  }
});
