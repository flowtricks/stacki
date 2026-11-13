// Goal: a message reference that crossed a process boundary (shared/core/i18n/messageReference.ts) is accepted only when it is a
// well-formed key with a bounded bag of strings and finite numbers.
// Method: known-good references, then each known-bad shape (not an object, bad key, bad params, over the bounds).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CATALOG_LIMITS } from '#dist/shared/core/i18n/catalog.js';
import { parseMessageRef } from '#dist/shared/core/i18n/messageReference.js';

// Null as a boundary receives it, parsed from JSON: inputs may hold it; our values never do.
const jsonNull: unknown = JSON.parse('null');

test('a reference with a key, with or without params, is accepted', () => {
  assert.deepEqual(parseMessageRef({ key: 'audits.finding.rawValue' }), { ok: true, value: { key: 'audits.finding.rawValue' } });
  assert.deepEqual(parseMessageRef({ key: 'a.b', params: { name: 'x', count: 3 } }), { ok: true, value: { key: 'a.b', params: { name: 'x', count: 3 } } });
});

test('every malformed reference is refused', () => {
  const tooMany = Object.fromEntries(Array.from({ length: CATALOG_LIMITS.paramsMax + 1 }, (_, index) => [`p${index}`, 1]));
  const bad: readonly unknown[] = [
    undefined,
    jsonNull,
    'a.b',
    [],
    {},
    { key: 3 },
    { key: 'nodots' },
    { key: 'A.b' },
    { key: 'a.b', params: [] },
    { key: 'a.b', params: 'x' },
    { key: 'a.b', params: { n: jsonNull } },
    { key: 'a.b', params: { n: Number.NaN } },
    { key: 'a.b', params: { n: Number.POSITIVE_INFINITY } },
    { key: 'a.b', params: { n: {} } },
    { key: 'a.b', params: { n: 'x'.repeat(CATALOG_LIMITS.messageCharsMax + 1) } },
    { key: 'a.b', params: tooMany },
  ];
  for (const input of bad) {
    assert.equal(parseMessageRef(input).ok, false, JSON.stringify(input));
  }
});
