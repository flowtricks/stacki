// Goal: the locale boundaries (shared/core/i18n/parseLocale.ts) turn untrusted text (storage, the
// browser's language list) into a shipped locale or refuse it, and never guess wrong silently.
// Method: every shipped locale round-trips; each known-bad shape (wrong type, wrong case, unknown
// language, oversize) is refused; matching tries an exact tag, then the primary language, then
// falls back to English; "system" follows the first language Stacki ships.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOCALE_NATIVE_NAMES, LOCALE_PREFERENCES, LOCALES, localeDirection } from '#dist/shared/core/i18n/locales.js';
import { matchLocale, parseLocale, parseLocalePreference, resolveLocale, systemLocale } from '#dist/shared/core/i18n/parseLocale.js';

test('every shipped locale parses to itself and has a native name', () => {
  for (const locale of LOCALES) {
    assert.deepEqual(parseLocale(locale), { ok: true, value: locale });
    assert.ok(LOCALE_NATIVE_NAMES[locale].length > 0);
    assert.equal(localeDirection(locale), 'ltr');
  }
  assert.deepEqual(parseLocalePreference('system'), { ok: true, value: 'system' });
  assert.equal(LOCALE_PREFERENCES.length, LOCALES.length + 1);
});

test('parseLocale refuses what is not exactly a shipped locale', () => {
  for (const bad of [undefined, 3, ['en'], '', 'EN', 'pt-br', 'pt', 'ja', 'en-US', 'system', 'x'.repeat(200)]) {
    assert.equal(parseLocale(bad).ok, false, `expected ${String(bad)} to be refused`);
  }
  for (const bad of [undefined, 'pt-br', 'ja', '']) {
    assert.equal(parseLocalePreference(bad).ok, false);
  }
});

test('matchLocale matches exactly, then by primary language, case-insensitively', () => {
  assert.equal(matchLocale('es'), 'es');
  assert.equal(matchLocale('es-MX'), 'es');
  assert.equal(matchLocale('fr-CA'), 'fr');
  assert.equal(matchLocale('pt'), 'pt-BR');
  assert.equal(matchLocale('pt-PT'), 'pt-BR');
  assert.equal(matchLocale('PT-br'), 'pt-BR');
  assert.equal(matchLocale('de_AT'), 'de');
  assert.equal(matchLocale('ja-JP'), undefined);
  assert.equal(matchLocale(''), undefined);
  assert.equal(matchLocale('e'.repeat(100)), undefined);
});

test('systemLocale takes the first language that ships, else English', () => {
  assert.equal(systemLocale(['ja', 'fr-CA', 'de']), 'fr');
  assert.equal(systemLocale(['ja', 'zh']), 'en');
  assert.equal(systemLocale([]), 'en');
  assert.throws(() => systemLocale(Array.from({ length: 33 }, () => 'en')), /Assertion failed: systemLocale: at most LANGUAGE_TAGS_MAX tags/);
});

test('resolveLocale: an explicit choice wins over the system, "system" defers to it', () => {
  assert.equal(resolveLocale('de', ['fr']), 'de');
  assert.equal(resolveLocale('system', ['fr']), 'fr');
  assert.equal(resolveLocale('system', []), 'en');
  // A long system list is cut to the bound rather than crashing the renderer.
  assert.equal(
    resolveLocale(
      'system',
      Array.from({ length: 100 }, () => 'ja'),
    ),
    'en',
  );
});
