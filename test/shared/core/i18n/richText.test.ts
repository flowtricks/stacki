// Goal: rich messages (a sentence with inline code, links or emphasis) parse into a bounded tree of text, slot and tag
// parts, refuse every malformed shape as a value, and translate with the same fallback rules as plain messages
// (shared/core/i18n/richText.ts).
// Method: known-good templates first (slots, tags, nesting, brace escapes, a stray `<` as text), then each known-bad shape
// (unclosed, mismatched and over-deep tags, bad slot names, bounds), then the translator driven with a catalog that lacks a
// key, uses a mark the call site did not offer, and a plural that picks its form by language.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CatalogIssue } from '#dist/shared/core/i18n/catalog.js';
import { RICH_LIMITS, createRichTranslator, parseRichTemplate, richNamesOf, richNamesOfTemplate } from '#dist/shared/core/i18n/richText.js';

test('a template parses into text, slots and tags in order', () => {
  assert.deepEqual(parseRichTemplate('Saved in {file} for <link>the docs</link>.'), {
    ok: true,
    value: [
      { kind: 'text', text: 'Saved in ' },
      { kind: 'slot', name: 'file' },
      { kind: 'text', text: ' for ' },
      { kind: 'tag', name: 'link', children: [{ kind: 'text', text: 'the docs' }] },
      { kind: 'text', text: '.' },
    ],
  });
  assert.deepEqual(parseRichTemplate(''), { ok: true, value: [] });
});

test('tags nest, brace escapes are literal, and a stray angle bracket is text', () => {
  const nested = parseRichTemplate('<a>x <b>y</b></a>');
  assert.equal(nested.ok, true);
  assert.deepEqual(richNamesOfTemplate('<a>x <b>{n}</b></a>'), { ok: true, value: { slots: ['n'], tags: ['a', 'b'] } });
  assert.deepEqual(parseRichTemplate('{{x}} 1 < 2 and 3 > 2 <3'), { ok: true, value: [{ kind: 'text', text: '{x} 1 < 2 and 3 > 2 <3' }] });
});

test('malformed rich templates are error values, each with a stable code', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['<a>open', 'bad-tag'],
    ['close</a>', 'bad-tag'],
    ['<a>x</b>', 'bad-tag'],
    ['<a><b>x</a></b>', 'bad-tag'],
    ['{', 'bad-placeholder'],
    ['}', 'bad-placeholder'],
    ['{}', 'bad-placeholder'],
    ['{a b}', 'bad-placeholder'],
    ['{code:file}', 'bad-placeholder'],
  ];
  for (const [template, code] of cases) {
    const result = parseRichTemplate(template);
    assert.equal(result.ok, false, `expected "${template}" to be refused`);
    if (!result.ok) {
      assert.equal(result.error.code, code, template);
    }
  }
});

test('the bounds on depth, tags and slots hold', () => {
  const deep = '<a>'.repeat(RICH_LIMITS.tagDepthMax + 2) + 'x' + '</a>'.repeat(RICH_LIMITS.tagDepthMax + 2);
  const tooDeep = parseRichTemplate(deep);
  assert.equal(tooDeep.ok, false);
  const fine = '<a>'.repeat(RICH_LIMITS.tagDepthMax) + 'x' + '</a>'.repeat(RICH_LIMITS.tagDepthMax);
  assert.equal(parseRichTemplate(fine).ok, true);
  const manyTags = '<a>x</a>'.repeat(RICH_LIMITS.tagsMax + 1);
  assert.equal(parseRichTemplate(manyTags).ok, false);
  const manySlots = Array.from({ length: RICH_LIMITS.slotsMax + 1 }, (_, index) => `{s${index}}`).join(' ');
  assert.equal(parseRichTemplate(manySlots).ok, false);
});

test('richNamesOf lists each slot and tag once, sorted', () => {
  const parsed = parseRichTemplate('{b} <x>{a}</x> {b} <x>y</x>');
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(richNamesOf(parsed.value), { slots: ['a', 'b'], tags: ['x'] });
  }
});

const english = {
  'x.saved': 'Saved in {file} for <link>the docs</link>.',
  'x.files': { one: '{count} file in <b>{folder}</b>', other: '{count} files in <b>{folder}</b>' },
  'x.plain': 'Nothing special',
} as const;
const spanish = {
  'x.saved': 'Guardado en {file}; consulta <link>la documentación</link>.',
  'x.files': { one: '{count} archivo en <b>{folder}</b>', many: '{count} de archivos en <b>{folder}</b>', other: '{count} archivos en <b>{folder}</b>' },
  'x.plain': 'Nada especial <unknown>x</unknown>',
};

function translator(locale: 'en' | 'es', catalog: Record<string, never> | typeof spanish, issues: CatalogIssue[]) {
  return createRichTranslator({ locale, catalog, fallback: english, onIssue: (issue) => void issues.push(issue) });
}

test('the translator picks the language, and the plural form by count', () => {
  const issues: CatalogIssue[] = [];
  const spanishTranslator = translator('es', spanish, issues);
  const request = { slots: ['file'], tags: ['link'] };
  assert.equal(spanishTranslator('x.saved', request)[0]?.kind, 'text');
  assert.deepEqual(spanishTranslator('x.saved', request)[0], { kind: 'text', text: 'Guardado en ' });
  const one = spanishTranslator('x.files', { slots: ['count', 'folder'], tags: ['b'], count: 1 });
  assert.deepEqual(one[0], { kind: 'slot', name: 'count' });
  assert.deepEqual(one[1], { kind: 'text', text: ' archivo en ' });
  const other = spanishTranslator('x.files', { slots: ['count', 'folder'], tags: ['b'], count: 5 });
  assert.deepEqual(other[1], { kind: 'text', text: ' archivos en ' });
  assert.deepEqual(issues, []);
});

test('a translation that uses a mark the call site did not offer falls back to English and reports it', () => {
  const issues: CatalogIssue[] = [];
  const parts = translator('es', spanish, issues)('x.plain', { slots: [], tags: [] });
  assert.deepEqual(parts, [{ kind: 'text', text: 'Nothing special' }]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.kind, 'bad-message');
});

test('a key the language lacks falls back to English and reports it; English itself must fit the call site', () => {
  const issues: CatalogIssue[] = [];
  const parts = translator('es', {}, issues)('x.plain', { slots: [], tags: [] });
  assert.deepEqual(parts, [{ kind: 'text', text: 'Nothing special' }]);
  assert.deepEqual(issues, [{ kind: 'missing-key', locale: 'es', key: 'x.plain' }]);
  assert.throws(() => translator('en', {}, issues)('x.saved', { slots: [], tags: ['link'] }), /fits the slots and tags/);
  assert.throws(() => translator('en', {}, issues)('x.saved', { slots: ['file'], tags: [] }), /fits the slots and tags/);
});
