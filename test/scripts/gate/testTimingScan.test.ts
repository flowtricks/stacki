// Goal: the test-timing scan (scripts/gate/testTimingScan.ts) finds the two patterns behind the
// suites that failed only on loaded runners, fixed pauses used as synchronisation and absolute
// millisecond bounds, and leaves the cures alone: waits on state, task boundaries, bounds scaled by
// a calibration, counted operations. Its allowlist holds every existing site with a reason and an
// expiry, so new test code cannot add one silently.
// Methodology: scanTestTiming is pure; each pattern is pinned with lines that must count and the
// near misses that must not. judgeTestTiming is pure; one valid entry is built, then each rule of
// the allowlist is broken alone and its problem pinned. Last, the repository's own test files are
// scanned and judged against the committed allowlist, so a new pause fails this suite as well as
// the gate's static phase.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { judgeTestTiming, measureTestTiming, scanTestTiming, TEST_TIMING_ALLOWLIST, TEST_TIMING_LIMITS } from '#dist/scripts/gate/testTimingScan.js';
import type { TestTimingFinding } from '#dist/scripts/gate/testTimingScan.js';
import { repositoryRoot } from '#dist/scripts/lib/repoRoot.js';

const rules = (text: string): readonly string[] => scanTestTiming(text).map((finding) => finding.rule);

test('fixed pauses count: awaited sleeps by number or by a millisecond name, and promise sleeps', () => {
  assert.deepEqual(rules('  await wait(1500);'), ['fixed-pause']);
  assert.deepEqual(rules('await sleep(OBSERVE_MS);'), ['fixed-pause']);
  assert.deepEqual(rules('await page.waitForTimeout(500);'), ['fixed-pause']);
  assert.deepEqual(rules('await settle(80);'), ['fixed-pause']);
  assert.deepEqual(rules('await delay(settleMs, signal);'), ['fixed-pause']);
  assert.deepEqual(rules('const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));'), ['fixed-pause']);
  assert.deepEqual(rules('await new Promise((r) => setTimeout(r, 50));'), ['fixed-pause']);
  assert.deepEqual(rules('await wait(10); await wait(20);'), ['fixed-pause', 'fixed-pause'], 'each site on a line counts');
});

test('the cures and the near misses do not count', () => {
  assert.deepEqual(rules("await waitFor({ what: 'the menu open', read, until });"), []);
  assert.deepEqual(rules("await settled('the panel quiet');"), [], 'a wait for quiet, not a duration');
  assert.deepEqual(rules('await settle();'), [], 'a helper called without a duration is counted where it is defined');
  assert.deepEqual(rules('const nextTask = () => new Promise((resolve) => setImmediate(resolve));'), []);
  assert.deepEqual(rules('const flush = () => new Promise((resolve) => setTimeout(resolve, 0));'), [], 'a zero delay is a task boundary');
  assert.deepEqual(rules('global.requestAnimationFrame = (callback) => setTimeout(callback, 0);'), [], 'a frame shim');
  assert.deepEqual(rules('  // await wait(900) is what this replaced.'), [], 'comments are skipped');
  assert.deepEqual(rules('await waitForSteady({ what, read, until, steadyPollCount: 6 });'), []);
});

test('absolute millisecond bounds count on asserting lines; relative ones and counted work do not', () => {
  assert.deepEqual(rules('  assert.ok(largeMs < 16, `in ${largeMs} ms`);'), ['absolute-ms']);
  assert.deepEqual(rules('assert.ok(elapsed < 500, "paints promptly");'), ['absolute-ms']);
  assert.deepEqual(rules("assert.ok(performance.now() - started < 1200, 'bypasses the grace period');"), ['absolute-ms']);
  assert.deepEqual(rules("assert.ok(Date.now() - started < 1000, 'no wait');"), ['absolute-ms']);
  assert.deepEqual(rules('expect(16 > frameMs).toBe(true);'), ['absolute-ms']);
  assert.deepEqual(rules('assert.ok(largeMs < frameMs, "within one frame here");'), [], 'a bound scaled in the same run');
  assert.deepEqual(rules('assert.ok(lagMsMax < lagMsBound());'), []);
  assert.deepEqual(rules('assert.ok(growth < 2.1, "linear in reads");'), [], 'counted operations');
  assert.deepEqual(rules('assert.ok(items.length < 4);'), [], 'a name that merely ends in ms');
  assert.deepEqual(rules('const frameMs = 16 * measureSpeedFactor();'), [], 'not an assertion');
});

const ENTRY = {
  file: 'test/renderer/style/example.test.js',
  rule: 'fixed-pause',
  count: 2,
  reason: 'Waits out a product timer under test.',
  added: '2026-11-19',
  expires: '2027-01-19',
};
const sites = (count: number, rule: TestTimingFinding['rule'] = 'fixed-pause'): readonly TestTimingFinding[] =>
  Array.from({ length: count }, (_, index) => ({ rule, line: index + 1, text: 'await wait(50);' }));
const judge = (found: ReadonlyMap<string, readonly TestTimingFinding[]>, entries: readonly unknown[], today = '2026-11-20') =>
  judgeTestTiming(found, JSON.stringify({ entries }), today);

test('a file within its entry passes; above it, or with none, it fails naming every site and the cure', () => {
  const file = ENTRY.file;
  assert.deepEqual(judge(new Map([[file, sites(2)]]), [ENTRY]), { problems: [], lowerable: [] });
  const above = judge(new Map([[file, sites(3)]]), [ENTRY]).problems.join('\n');
  assert.match(above, /3 fixed-pause site\(s\), 2 allowed/);
  assert.match(above, /example\.test\.js:3 {2}await wait\(50\);/);
  assert.match(above, /test\/helpers\/waitFor\.js/);
  const unlisted = judge(new Map([['test/renderer/new.test.js', sites(1, 'absolute-ms')]]), []).problems.join('\n');
  assert.match(unlisted, /new\.test\.js: 1 absolute-ms site\(s\), 0 allowed\. Count operations/);
  assert.match(unlisted, /measureSpeedFactor/);
});

test('fewer sites than allowed, or a file that is gone, asks for the entry to be lowered without failing', () => {
  const fewer = judge(new Map([[ENTRY.file, sites(1)]]), [ENTRY]);
  assert.deepEqual(fewer.problems, []);
  assert.match(fewer.lowerable.join(), /1 site\(s\) now, the allowlist says 2; lower it/);
  const gone = judge(new Map(), [ENTRY]);
  assert.deepEqual(gone.problems, []);
  assert.match(gone.lowerable.join(), /no such test file any more/);
});

test('each broken allowlist rule fails with its own problem', () => {
  const found = new Map([[ENTRY.file, sites(2)]]);
  const problem = (entry: unknown, today = '2026-11-20'): string => judge(found, [entry], today).problems.join('\n');
  assert.match(problem({ ...ENTRY, reason: '' }), /names a file, a reason/);
  assert.match(problem({ ...ENTRY, rule: 'sleep' }), /rule is one of fixed-pause, absolute-ms/);
  assert.match(problem({ ...ENTRY, count: 0 }), /count is a whole number/);
  assert.match(problem({ ...ENTRY, count: 1.5 }), /count is a whole number/);
  assert.match(problem({ ...ENTRY, expires: '19 Jan 2027' }), /YYYY-MM-DD/);
  assert.match(problem({ ...ENTRY, added: '2026-12-01' }), /a day still to come/);
  assert.match(problem({ ...ENTRY, expires: '2027-06-30' }), new RegExp(`at most ${TEST_TIMING_LIMITS.daysMax} days`));
  assert.match(problem(ENTRY, '2027-01-20'), /expired on 2027-01-19/);
  assert.deepEqual(judge(found, [ENTRY], '2027-01-19').problems, [], 'the last day is still valid');
  assert.match(judge(found, [ENTRY, ENTRY]).problems.join(), /listed twice/);
  assert.match(judgeTestTiming(found, '{', '2026-11-20').problems.join(), /not JSON/);
  assert.match(judgeTestTiming(found, '[]', '2026-11-20').problems.join(), /"entries"/);
  assert.throws(() => judgeTestTiming(found, '{"entries":[]}', 'today'), /YYYY-MM-DD day/);
});

test("the repository's test files hold no fixed pause or absolute bound beyond the committed allowlist", () => {
  const root = repositoryRoot();
  const verdict = judgeTestTiming(measureTestTiming(root), readFileSync(join(root, TEST_TIMING_ALLOWLIST), 'utf8'), new Date().toISOString().slice(0, 10));
  assert.deepEqual(verdict.problems, []);
});
