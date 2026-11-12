// Goal: translations cannot drift from English. Every locale catalog has exactly English's keys and,
// for each key, the same placeholders, so a translator can neither lose a {name} nor invent one, and a
// new English string without translations fails here instead of shipping half-English.
// Method: load every shipped catalog (the same modules the lazy loader imports), compare key sets in
// both directions, compare placeholder sets per key, run each through the boundary parser, and check
// every message is non-empty text that differs from English except for the few product terms and cognates.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCatalog, parseMessage, placeholderSet } from '#dist/shared/core/i18n/catalog.js';
import { LOCALES } from '#dist/shared/core/i18n/locales.js';
import { messages as english } from '#dist/shared/properties/i18n/messages/en.js';
import { messages as de } from '#dist/shared/properties/i18n/messages/de.js';
import { messages as es } from '#dist/shared/properties/i18n/messages/es.js';
import { messages as fr } from '#dist/shared/properties/i18n/messages/fr.js';
import { messages as ptBR } from '#dist/shared/properties/i18n/messages/ptBR.js';

const catalogs = { en: english, es, fr, de, 'pt-BR': ptBR } as const satisfies Record<(typeof LOCALES)[number], Readonly<Record<string, unknown>>>;

function placeholdersOfKey(catalog: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  const value = Object.entries(catalog).find(([name]) => name === key)?.[1];
  assert.ok(value !== undefined, `${key} exists`);
  const message = parseMessage(value);
  assert.ok(message.ok, `${key} parses`);
  const set = placeholderSet(message.value);
  assert.ok(set.ok, `${key} is well formed`);
  return set.value;
}

test('every shipped locale has a catalog in this test', () => {
  assert.deepEqual(Object.keys(catalogs).sort(), [...LOCALES].sort());
});

test('every catalog passes the boundary parser', () => {
  for (const locale of LOCALES) {
    const parsed = parseCatalog(catalogs[locale]);
    assert.ok(parsed.ok, `${locale}: ${parsed.ok ? '' : parsed.error.message}`);
  }
});

test('every catalog has exactly English’s keys', () => {
  const expected = Object.keys(english).sort();
  assert.ok(expected.length > 0);
  for (const locale of LOCALES) {
    const keys = Object.keys(catalogs[locale]).sort();
    assert.deepEqual(
      keys.filter((key) => !expected.includes(key)),
      [],
      `${locale} has keys English lacks`,
    );
    assert.deepEqual(
      expected.filter((key) => !keys.includes(key)),
      [],
      `${locale} lacks English keys`,
    );
  }
});

test('every translation uses exactly the placeholders of its English message', () => {
  for (const locale of LOCALES) {
    for (const key of Object.keys(english)) {
      assert.deepEqual(placeholdersOfKey(catalogs[locale], key), placeholdersOfKey(english, key), `${locale} ${key}`);
    }
  }
});

test('no message is empty, and a translation differs from English unless it is a product term', () => {
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
  for (const locale of LOCALES) {
    for (const [key, value] of Object.entries(catalogs[locale])) {
      assert.ok(typeof value === 'string' && value.trim().length > 0, `${locale} ${key} is non-empty text`);
      const source = Object.entries(english).find(([name]) => name === key)?.[1];
      if (locale !== 'en' && value === source) {
        assert.ok(sameAsEnglishAllowed.has(key), `${locale} ${key} is untranslated`);
      }
    }
  }
});
