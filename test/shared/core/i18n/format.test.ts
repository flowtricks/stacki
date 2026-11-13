// Goal: the locale-aware formatters (shared/core/i18n/format.ts) follow the chosen language, never the machine's, and refuse
// values that are not numbers or dates.
// Method: the same value formatted in each shipped locale and compared with known CLDR output for stable cases (grouping and
// decimal marks, list grammar, relative phrases, byte units), the relative-unit ladder checked at its edges, and the
// assertions pinned with their messages.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFormatters, formattersFor, relativeStep } from '#dist/shared/core/i18n/format.js';
import { LOCALES } from '#dist/shared/core/i18n/locales.js';

test("numbers follow the locale's grouping and decimal marks", () => {
  assert.equal(createFormatters('en').formatNumber(1234.5), '1,234.5');
  assert.equal(createFormatters('de').formatNumber(1234.5), '1.234,5');
  assert.equal(createFormatters('pt-BR').formatNumber(1234.5), '1.234,5');
  assert.equal(createFormatters('en').formatNumber(0.256, { style: 'percent' }), '26%');
  assert.throws(() => createFormatters('en').formatNumber(Number.NaN), /the value is finite/);
});

test('dates use the locale and the options the caller named', () => {
  const date = new Date(Date.UTC(2026, 10, 13, 12, 0, 0));
  assert.equal(createFormatters('en').formatDate(date, { dateStyle: 'long', timeZone: 'UTC' }), 'November 13, 2026');
  assert.equal(createFormatters('de').formatDate(date, { dateStyle: 'long', timeZone: 'UTC' }), '13. November 2026');
  assert.equal(createFormatters('fr').formatDate(date, { dateStyle: 'long', timeZone: 'UTC' }), '13 novembre 2026');
  assert.throws(() => createFormatters('en').formatDate(Number.NaN, { dateStyle: 'long' }), /the date is valid/);
});

test('relative time picks the largest unit that fits and speaks the language', () => {
  const now = Date.UTC(2026, 10, 13, 12, 0, 0);
  assert.equal(createFormatters('en').formatRelativeTime(now - 5 * 60_000, now), '5 minutes ago');
  assert.equal(createFormatters('en').formatRelativeTime(now - 86_400_000, now), 'yesterday');
  assert.equal(createFormatters('en').formatRelativeTime(now + 3 * 3_600_000, now), 'in 3 hours');
  assert.equal(createFormatters('es').formatRelativeTime(now - 2 * 3_600_000, now), 'hace 2 horas');
  assert.deepEqual(relativeStep(59_000), { amount: 59, unit: 'second' });
  assert.deepEqual(relativeStep(-60_000), { amount: -1, unit: 'minute' });
  assert.deepEqual(relativeStep(3_600_000), { amount: 1, unit: 'hour' });
  assert.deepEqual(relativeStep(-86_400_000 * 40), { amount: -1, unit: 'month' });
  assert.deepEqual(relativeStep(86_400_000 * 400), { amount: 1, unit: 'year' });
});

test('lists and byte sizes follow the language', () => {
  assert.equal(createFormatters('en').formatList(['a', 'b', 'c'], 'and'), 'a, b, and c');
  assert.equal(createFormatters('en').formatList(['a', 'b'], 'or'), 'a or b');
  assert.equal(createFormatters('de').formatList(['a', 'b', 'c'], 'and'), 'a, b und c');
  assert.equal(createFormatters('en').formatBytes(512), '512 byte');
  assert.match(createFormatters('en').formatBytes(1536), /^1\.5 ?kB$/);
  assert.match(createFormatters('de').formatBytes(1536), /^1,5 ?kB$/);
  assert.match(createFormatters('en').formatBytes(5_000_000), /^5 ?MB$/);
  assert.throws(() => createFormatters('en').formatBytes(-1), /not negative/);
});

test('every shipped locale has formatters, built once', () => {
  for (const locale of LOCALES) {
    assert.equal(formattersFor(locale), formattersFor(locale));
    assert.equal(formattersFor(locale).locale, locale);
    assert.equal(typeof formattersFor(locale).formatNumber(1), 'string');
  }
});
