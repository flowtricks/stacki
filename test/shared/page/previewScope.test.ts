// Goal: the dev server's answer about a page's last-rendered values is checked before the
// binding picker trusts it: sampled data under identifier names passes; a non-record, a name
// that is not an identifier, an empty binding and anything past the name bound is dropped;
// and data the IPC boundary refuses (a non-finite number) still fails loudly.
// Method: parseScopeSamples is fed one known-good answer, then each known-bad shape.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseScopeSamples, PREVIEW_SCOPE_LIMITS, SCOPE_STORE_KEY } from '#dist/shared/page/previewScope.js';

// JSON's null, as the route writes it.
const jsonNull: unknown = JSON.parse('null');

test('sampled values under identifier names pass as they are', () => {
  const answer = {
    stats: [
      { id: 'untitled', data: { Number: '61.4%' } },
      { __stacki: 'more', count: 3 },
    ],
    $count: 2,
  };
  assert.deepEqual(parseScopeSamples(answer), answer);
  assert.equal(SCOPE_STORE_KEY, 'stacki.scope');
});

test('anything that is not an answer is no answer', () => {
  assert.deepEqual(parseScopeSamples(undefined), {});
  assert.deepEqual(parseScopeSamples(jsonNull), {});
  assert.deepEqual(parseScopeSamples('stats'), {});
  assert.deepEqual(parseScopeSamples([1, 2]), {});
  assert.deepEqual(parseScopeSamples({ 'not-a-name': 1, '0': 2, stats: jsonNull, kept: 'yes' }), { kept: 'yes' });
});

test('an answer is bounded by name count, and refused data still fails', () => {
  const many = Object.fromEntries(Array.from({ length: PREVIEW_SCOPE_LIMITS.namesMax + 10 }, (_, i) => [`value${i}`, i]));
  assert.equal(Object.keys(parseScopeSamples(many)).length, PREVIEW_SCOPE_LIMITS.namesMax);
  assert.throws(() => parseScopeSamples({ stats: Number.NaN }), /finite number/);
});
