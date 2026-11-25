// Goal: the pure message functions behind every translated string (shared/core/i18n/catalog.ts)
// accept exactly the messages they should and refuse the rest, and the translator never shows a
// raw key: a missing or broken translation falls back to English and says so.
// Method: known-good templates first, then each known-bad shape (stray and unclosed braces, empty
// and invalid names, a missing parameter, an oversize message), plural categories checked against
// Intl for real languages, and the translator driven with a catalog that lacks a key, holds a broken
// message, and a call site that is itself wrong (which must crash, not fall back).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CATALOG_LIMITS,
  createTranslator,
  formatMessage,
  formatTemplate,
  isMessageKey,
  parseCatalog,
  parseMessage,
  placeholderSet,
  placeholdersOf,
  pluralCategory,
  type CatalogIssue,
} from '#dist/shared/core/i18n/catalog.js';

test('placeholdersOf lists names once, in order, and honors brace escapes', () => {
  assert.deepEqual(placeholdersOf('plain'), { ok: true, value: [] });
  assert.deepEqual(placeholdersOf('{a} and {b} and {a}'), { ok: true, value: ['a', 'b'] });
  assert.deepEqual(placeholdersOf('{{literal}} {x}'), { ok: true, value: ['x'] });
});

test('placeholdersOf refuses malformed templates', () => {
  for (const bad of ['{', 'a {name', '}', 'a } b', '{}', '{ name }', '{1a}', '{a-b}', '{a{b}}']) {
    const result = placeholdersOf(bad);
    assert.equal(result.ok, false, `expected "${bad}" to be refused`);
  }
  assert.equal(placeholdersOf('x'.repeat(CATALOG_LIMITS.messageCharsMax + 1)).ok, false);
  const many = Array.from({ length: CATALOG_LIMITS.placeholdersMax + 1 }, (_, index) => `{p${index}}`).join('');
  assert.equal(placeholdersOf(many).ok, false);
});

test('formatTemplate fills placeholders, ignores extra parameters, and reports a missing one', () => {
  assert.deepEqual(formatTemplate('Hello {name}, {name}!', { name: 'Ada' }), { ok: true, value: 'Hello Ada, Ada!' });
  assert.deepEqual(formatTemplate('{{x}} = {n}', { n: 3 }), { ok: true, value: '{x} = 3' });
  assert.deepEqual(formatTemplate('static', { unused: 'y' }), { ok: true, value: 'static' });
  const missing = formatTemplate('Hi {name}', {});
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.error.code, 'missing-param');
  }
  assert.equal(formatTemplate('{bad', { bad: 1 }).ok, false);
});

test('a parameter value that looks like a placeholder is inserted as text, never expanded', () => {
  assert.deepEqual(formatTemplate('{a}', { a: '{b}', b: 'no' }), { ok: true, value: '{b}' });
});

test('pluralCategory follows Intl for the shipped languages', () => {
  assert.equal(pluralCategory('en', 1), 'one');
  assert.equal(pluralCategory('en', 0), 'other');
  assert.equal(pluralCategory('en', 2), 'other');
  assert.equal(pluralCategory('fr', 0), 'one');
  assert.equal(pluralCategory('fr', 1.5), 'one');
  assert.equal(pluralCategory('pt-BR', 0), 'one');
  assert.equal(pluralCategory('es', 1_000_000), 'many');
  assert.throws(() => pluralCategory('en', Number.NaN), /Assertion failed: pluralCategory: count is a finite number/);
});

test('formatMessage picks the plural form, falls back to other, and needs a numeric count', () => {
  const files = { one: '{count} file', other: '{count} files' };
  assert.deepEqual(formatMessage('en', files, { count: 1 }), { ok: true, value: '1 file' });
  assert.deepEqual(formatMessage('en', files, { count: 5 }), { ok: true, value: '5 files' });
  // Spanish says "many" for a million; the catalog has no such form, so other is used.
  assert.deepEqual(formatMessage('es', files, { count: 1_000_000 }), { ok: true, value: '1000000 files' });
  assert.equal(formatMessage('en', files, {}).ok, false);
  assert.equal(formatMessage('en', files, { count: '2' }).ok, false);
  assert.equal(formatMessage('en', files, { count: Number.POSITIVE_INFINITY }).ok, false);
});

test('placeholderSet is the sorted union over plural forms', () => {
  assert.deepEqual(placeholderSet({ one: '{count} of {total}', other: '{count}' }), { ok: true, value: ['count', 'total'] });
  assert.equal(placeholderSet('{').ok, false);
});

test('parseMessage and parseCatalog accept good shapes and refuse bad ones', () => {
  assert.equal(parseMessage('ok').ok, true);
  assert.equal(parseMessage({ one: 'a {count}', other: 'b {count}' }).ok, true);
  for (const bad of [1, undefined, ['x'], { one: 'only one' }, { other: 1 }, { other: 'x', several: 'y' }, { other: '{' }, 'x'.repeat(2001)]) {
    assert.equal(parseMessage(bad).ok, false);
  }
  assert.equal(parseCatalog({ 'a.b': 'x', 'c.d': { other: 'y' } }).ok, true);
  for (const bad of [undefined, 'text', ['a.b'], { nodots: 'x' }, { 'A.b': 'x' }, { 'a.b': 5 }, { 'a.b': '{' }]) {
    assert.equal(parseCatalog(bad).ok, false);
  }
  assert.equal(isMessageKey('ai.composer.placeholder.send'), true);
  assert.equal(isMessageKey('single'), false);
  assert.equal(isMessageKey(''), false);
});

test('the translator falls back to English for a missing or broken translation and reports each', () => {
  const english = { 'a.one': 'One', 'a.two': 'Two {name}', 'a.three': 'Three' } as const;
  const issues: CatalogIssue[] = [];
  const translate = createTranslator({
    locale: 'es',
    catalog: { 'a.one': 'Uno', 'a.two': 'Dos {nombre}' },
    fallback: english,
    onIssue: (issue) => issues.push(issue),
  });
  assert.equal(translate('a.one'), 'Uno');
  assert.equal(translate('a.two', { name: 'Ada' }), 'Two Ada');
  assert.equal(translate('a.three'), 'Three');
  assert.deepEqual(
    issues.map((issue) => issue.kind),
    ['bad-message', 'missing-key'],
  );
});

test('English never reports an issue, and a wrong call site crashes instead of falling back', () => {
  const english = { 'a.one': 'One', 'a.two': 'Two {name}' } as const;
  const translate = createTranslator({
    locale: 'en',
    catalog: english,
    fallback: english,
    onIssue: () => assert.fail('English reported an issue'),
  });
  assert.equal(translate('a.one'), 'One');
  assert.throws(() => translate('a.two'), /Assertion failed: t: English "a.two" formats/);
  // @ts-expect-error The test passes a key English does not have, as a stale call site would.
  assert.throws(() => translate('a.nine'), /Assertion failed: t: "a.nine" is not an English message/);
});
