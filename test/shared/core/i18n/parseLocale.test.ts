// Goal: the locale boundaries (shared/core/i18n/parseLocale.ts) turn untrusted text (storage, the
// browser's language list) into a shipped locale or refuse it, and never guess wrong silently.
// Method: every shipped locale round-trips; each known-bad shape (wrong type, wrong case, unknown
// language, oversize) is refused; matching tries an exact tag, then an alias (Chinese by script, old
// Hebrew and Indonesian codes), then the primary language, then falls back to English; "system" follows
// the first language Stacki ships. The direction of each locale comes from the locale list.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOCALE_INFO, LOCALE_PREFERENCES, LOCALE_TAG_ALIASES, LOCALES, localeDirection, localeNativeName } from '#dist/shared/core/i18n/locales.js';
import { matchLocale, parseLocale, parseLocalePreference, resolveLocale, systemLocale } from '#dist/shared/core/i18n/parseLocale.js';

test('every shipped locale parses to itself and has a native name', () => {
  for (const locale of LOCALES) {
    assert.deepEqual(parseLocale(locale), { ok: true, value: locale });
    assert.ok(localeNativeName(locale).length > 0);
    assert.equal(localeDirection(locale), LOCALE_INFO[locale].direction);
  }
  assert.equal(new Set(LOCALES.map(localeNativeName)).size, LOCALES.length, 'native names are distinct');
  assert.deepEqual(parseLocalePreference('system'), { ok: true, value: 'system' });
  assert.equal(LOCALE_PREFERENCES.length, LOCALES.length + 1);
});

test('the locale list holds every language Stacki ships, written in itself, and only Arabic and Hebrew are right to left', () => {
  assert.deepEqual(Object.keys(LOCALE_INFO).sort(), [...LOCALES].sort());
  assert.equal(LOCALES[0], 'en');
  assert.deepEqual(
    LOCALES.filter((locale) => localeDirection(locale) === 'rtl'),
    ['ar', 'he'],
  );
  const expected = {
    'zh-CN': '中文（简体）',
    'zh-TW': '中文（繁體）',
    ja: '日本語',
    ko: '한국어',
    ru: 'Русский',
    it: 'Italiano',
    nl: 'Nederlands',
    tr: 'Türkçe',
    pl: 'Polski',
    id: 'Bahasa Indonesia',
    hi: 'हिन्दी',
    ar: 'العربية',
    he: 'עברית',
  } as const;
  for (const [locale, name] of Object.entries(expected)) {
    const parsed = parseLocale(locale);
    assert.ok(parsed.ok, `${locale} ships`);
    assert.equal(localeNativeName(parsed.value), name);
  }
  for (const locale of LOCALES) {
    assert.match(LOCALE_INFO[locale].directory, /^[a-z][A-Za-z]*$/, `${locale} directory is an identifier`);
  }
  for (const target of Object.values(LOCALE_TAG_ALIASES)) {
    assert.ok(parseLocale(target).ok, `the alias target ${target} ships`);
  }
});

test('parseLocale refuses what is not exactly a shipped locale', () => {
  for (const bad of [undefined, 3, ['en'], '', 'EN', 'pt-br', 'pt', 'zh', 'zh-cn', 'sv', 'en-US', 'system', 'x'.repeat(200)]) {
    assert.equal(parseLocale(bad).ok, false, `expected ${String(bad)} to be refused`);
  }
  for (const bad of [undefined, 'pt-br', 'sv', 'zh', '']) {
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
  assert.equal(matchLocale('ja-JP'), 'ja');
  assert.equal(matchLocale('sv-SE'), undefined);
  assert.equal(matchLocale(''), undefined);
  assert.equal(matchLocale('e'.repeat(100)), undefined);
});

test('Chinese is matched by script and region, and old codes find their language', () => {
  assert.equal(matchLocale('zh'), 'zh-CN');
  assert.equal(matchLocale('zh-CN'), 'zh-CN');
  assert.equal(matchLocale('zh-Hans'), 'zh-CN');
  assert.equal(matchLocale('zh-Hans-CN'), 'zh-CN');
  assert.equal(matchLocale('zh-SG'), 'zh-CN');
  assert.equal(matchLocale('zh-TW'), 'zh-TW');
  assert.equal(matchLocale('zh_TW'), 'zh-TW');
  assert.equal(matchLocale('zh-Hant'), 'zh-TW');
  assert.equal(matchLocale('zh-Hant-TW'), 'zh-TW');
  assert.equal(matchLocale('zh-HK'), 'zh-TW');
  assert.equal(matchLocale('zh-MO'), 'zh-TW');
  assert.equal(matchLocale('iw-IL'), 'he');
  assert.equal(matchLocale('in'), 'id');
  assert.equal(matchLocale('ar-EG'), 'ar');
  assert.equal(matchLocale('hi-IN'), 'hi');
  assert.equal(matchLocale('ko-KR'), 'ko');
  // A prefix match is a whole subtag, never part of one: "zh-hkx" is not Hong Kong, and "ind" is not "in".
  assert.equal(matchLocale('zh-hkx'), 'zh-CN');
  assert.equal(matchLocale('ind'), undefined);
});

test('systemLocale takes the first language that ships, else English', () => {
  assert.equal(systemLocale(['sv', 'fr-CA', 'de']), 'fr');
  assert.equal(systemLocale(['sv', 'fi']), 'en');
  assert.equal(systemLocale(['sv', 'zh-HK', 'en']), 'zh-TW');
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
      Array.from({ length: 100 }, () => 'sv'),
    ),
    'en',
  );
});
