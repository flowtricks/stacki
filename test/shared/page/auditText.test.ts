// Goal: every audit sentence that reaches a person can be translated, and the English kept in `shared/page` (which may import
// only `core`, so it cannot read the catalog) never drifts from the English catalog the translations are checked against.
// Method: hold `AUDIT_TEXT` equal to the `audits.detail.*`, `audits.fix.*` and `audits.measure.*` keys of the English catalog,
// key for key; hold every check's title and reason (`AUDIT_CHECKS`) to the English catalog through its reference; and assert
// that a sentence built with the wrong parameters crashes, since that is a programmer error, not a result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMessage, type MessageValue } from '#dist/shared/core/i18n/catalog.js';
import { AUDIT_CHECKS, AUDIT_CHECK_IDS, detailText, labelText, measureText } from '#dist/shared/page/auditFindings.js';
import { AUDIT_TEXT, auditSentence } from '#dist/shared/page/auditText.js';
import { messages as english } from '#dist/shared/properties/i18n/messages/en/index.js';

const SENTENCE_PREFIXES = ['audits.detail.', 'audits.fix.', 'audits.measure.'] as const;

test('AUDIT_TEXT is exactly the English detail, fix and measure messages', () => {
  const catalog: Readonly<Record<string, MessageValue>> = english;
  const wanted = Object.keys(catalog).filter((key) => SENTENCE_PREFIXES.some((prefix) => key.startsWith(prefix)));
  assert.deepEqual(Object.keys(AUDIT_TEXT).sort(), wanted.sort());
  for (const key of wanted) {
    assert.deepEqual(catalog[key], Reflect.get(AUDIT_TEXT, key), key);
  }
});

test('every check title and reason has a reference whose English is the text the table holds', () => {
  const catalog: Readonly<Record<string, MessageValue>> = english;
  for (const id of AUDIT_CHECK_IDS) {
    const check = AUDIT_CHECKS[id];
    for (const [text, ref] of [
      [check.title, check.titleRef],
      [check.why, check.whyRef],
    ] as const) {
      const message = catalog[ref.key];
      assert.notEqual(message, undefined, `${id}: ${ref.key} is in the English catalog`);
      const filled = formatMessage('en', message ?? '', ref.params ?? {});
      assert.ok(filled.ok, ref.key);
      assert.equal(filled.value, text, ref.key);
    }
  }
});

test('a sentence carries its English text and a reference with the parameters', () => {
  assert.deepEqual(detailText('audits.detail.alsoOn', { value: 'Home', routes: '/a, /b' }), {
    detail: '"Home" is also on /a, /b',
    detailRef: { key: 'audits.detail.alsoOn', params: { value: 'Home', routes: '/a, /b' } },
  });
  assert.equal(labelText('audits.fix.renameTo', { name: 'x-2' }).label, 'Rename to "x-2"');
  assert.equal(measureText('audits.measure.characters', { count: 1 }).measure, '1 character');
  assert.equal(measureText('audits.measure.characters', { count: 12 }).measure, '12 characters');
});

test('a sentence built without its parameters crashes loudly', () => {
  assert.throws(() => auditSentence('audits.detail.alsoOn', { value: 'Home' }), /formats with the parameters passed/);
});
