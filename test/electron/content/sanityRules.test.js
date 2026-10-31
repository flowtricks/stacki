// Goal: a field's validation is read from its schema source the way the Studio's rule builder
// spells it, without running it: literal limits, link schemes, warnings, and nothing invented
// from a limit computed by code or a custom check.
// Method: validation sources shaped like real ones are read and the rules compared.
const test = require('node:test');
const assert = require('node:assert/strict');
const { rulesOf } = require('#dist/electron/content/sanityRules.js');

test('a chain of plain checks becomes rules, in order', () => {
  assert.deepEqual(rulesOf('(r) => r.required().min(3).max(80)'), [
    { level: 'error', kind: 'required' },
    { level: 'error', kind: 'min', limit: 3 },
    { level: 'error', kind: 'max', limit: 80 },
  ]);
  assert.deepEqual(rulesOf('(Rule) => Rule.unique().email()'), [
    { level: 'error', kind: 'unique' },
    { level: 'error', kind: 'email' },
  ]);
});

test('links keep their schemes and whether relative ones are allowed', () => {
  const [rule] = rulesOf(
    '(r) => r.required().uri({ allowRelative: true, scheme: ["http", "https", "mailto"] })',
  ).slice(1);
  assert.deepEqual(rule, {
    level: 'error',
    kind: 'uri',
    schemes: ['http', 'https', 'mailto'],
    relative: true,
  });
  assert.deepEqual(rulesOf('(r) => r.uri()')[0]?.schemes, ['http', 'https'], 'the default');
});

test('a warning chain warns; computed limits and custom checks are not invented', () => {
  assert.deepEqual(rulesOf('(r) => r.max(60).warning("Long titles get cut")'), [
    { level: 'warning', kind: 'max', limit: 60 },
  ]);
  assert.deepEqual(rulesOf('(r) => r.max(LIMIT).custom((v) => true)'), []);
  assert.deepEqual(rulesOf(undefined), []);
});
