// Goal: the two helpers the field-latency measurement stands on say what they mean. stageLatency.js
// turns marks into p50/p95 stage rows and bounds a measurement only relative to a baseline from
// the same run; fieldLatencyFixture.js builds the big project the measurement runs on, and that
// project grows linearly with its rule count and holds its target rules exactly once.
//
// Method: hand-made marks with known answers (nearest-rank percentiles, runs missing a mark), every
// refused input, and the fixture's text checked by counting, at two sizes. Pure functions only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { percentile, stageTable, markdownTable, withinBaseline } = require('../../helpers/e2e/stageLatency.js');
const { latencyStylesheet, latencyPage, TARGET } = require('../../helpers/e2e/fieldLatencyFixture.js');

test('percentiles are nearest-rank, so every value reported was measured', () => {
  const values = [5, 1, 4, 2, 3, 10, 6, 9, 7, 8];
  assert.equal(percentile(values, 50), 5);
  assert.equal(percentile(values, 95), 10);
  assert.equal(percentile(values, 0), 1);
  assert.equal(percentile([], 50), undefined);
  assert.deepEqual(values, [5, 1, 4, 2, 3, 10, 6, 9, 7, 8], 'the samples are not reordered in place');
  assert.throws(() => percentile(values, 101), /percentile: rank is within 0..100/);
  assert.throws(() => percentile(values, -1), /percentile: rank is within 0..100/);
  assert.throws(() => percentile(values, Number.NaN), /percentile: rank is a number/);
});

test('a stage counts only the runs that have both of its marks', () => {
  const runs = [
    { enter: 100, requestSent: 108, fieldShown: 101 },
    { enter: 200, requestSent: 212 },
    { enter: 300, fieldShown: 316 },
  ];
  const stages = [
    { name: 'write sent', from: 'enter', to: 'requestSent' },
    { name: 'field shows it', from: 'enter', to: 'fieldShown' },
    { name: 'never', from: 'enter', to: 'missing' },
  ];
  const rows = stageTable(runs, stages);
  assert.deepEqual(rows, [
    { stage: 'write sent', runs: 2, p50: 8, p95: 12 },
    { stage: 'field shows it', runs: 2, p50: 1, p95: 16 },
    { stage: 'never', runs: 0, p50: undefined, p95: undefined },
  ]);
  assert.match(markdownTable(rows), /\| never \| 0 \| n\/a \| n\/a \|/);
});

test('a bound is a ratio to the baseline of the same run, never milliseconds', () => {
  assert.deepEqual(withinBaseline({ measured: 30, baseline: 10, factorMax: 4, floor: 1 }), { ok: true, ratio: 3 });
  assert.equal(withinBaseline({ measured: 50, baseline: 10, factorMax: 4, floor: 1 }).ok, false);
  assert.equal(withinBaseline({ measured: 3, baseline: 0, factorMax: 4, floor: 1 }).ok, true, 'a baseline too quick to time is lifted to the floor');
  assert.throws(() => withinBaseline({ measured: 1, baseline: 1, factorMax: 0, floor: 1 }), /withinBaseline: factorMax is positive/);
  assert.throws(() => withinBaseline({ measured: 1, baseline: 1, factorMax: 2, floor: 0 }), /withinBaseline: floor is positive/);
});

test('the fixture stylesheet grows linearly and holds its target rules once', () => {
  const small = latencyStylesheet(3000);
  const large = latencyStylesheet(6000);
  const ratio = large.length / small.length;
  assert.ok(ratio > 1.9, `twice the rules is about twice the text (${ratio.toFixed(2)})`);
  assert.ok(ratio < 2.2, `twice the rules is about twice the text (${ratio.toFixed(2)})`);
  const count = (text, pattern) => (text.match(pattern) ?? []).length;
  assert.equal(count(small, /\.lat-rule-\d+[\s:{]/g), 3000, 'one filler rule per count');
  assert.equal(count(small, /h2\.heading\.text-style-h3 \{/g), 1);
  assert.equal(count(small, /\.heading \{\n {2}color: var\(--text\);/g), 1);
  assert.throws(() => latencyStylesheet(0), /latencyStylesheet: count is within/);
  assert.throws(() => latencyStylesheet(1.5), /latencyStylesheet: count is a safe integer/);
});

test('the fixture page gains the target heading after the second heading, and refuses another page', () => {
  const page = '<a/>\n      <Heading tag="h2" id="soak-heading-two" maxWidth={24}>x</Heading>';
  const changed = latencyPage(page);
  assert.ok(changed.indexOf(`id="${TARGET.elementId}"`) < changed.indexOf('soak-heading-two'));
  assert.equal(changed.split(TARGET.elementId).length, 2, 'added once');
  assert.throws(() => latencyPage('<p>no heading</p>'), /latencyPage: the soak page has its second heading/);
});
