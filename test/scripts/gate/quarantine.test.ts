// Goal: the quarantine tolerates a flaky suite only within strict rules, and every way out of them
// fails the gate: an unknown suite, a protected (correctness, safety, data-write) suite, fewer than
// two red runs, more than seven days, a date in the future, an expired entry, a duplicate, a
// malformed file. An empty list is valid.
// Methodology: judgeQuarantine is pure; one valid entry is built, then each rule is broken alone
// and the problem it reports is pinned. The committed scripts/gate/quarantine.json is judged too, so a
// lapsed entry in the repository fails this suite as well as the gate.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { judgeQuarantine, PROTECTED_SUITE_PATTERN, QUARANTINE_LIMITS } from '#dist/scripts/gate/quarantine.js';

const SUITES = new Set(['renderer/apps/appUiKitElements', 'electron/documents/atomicWrite', 'renderer/style/popoverLifetime']);
const RED = 'https://github.com/flowtricks/stacki/actions/runs/';
const VALID = {
  suite: 'renderer/apps/appUiKitElements',
  owner: 'maintainer',
  reason: 'Escape not delivered on the Linux runner',
  added: '2026-11-17',
  expires: '2026-11-24',
  reds: [`${RED}1`, `${RED}2`],
};

function judge(entries: readonly unknown[], today = '2026-11-18'): readonly string[] {
  return judgeQuarantine(JSON.stringify({ entries }), SUITES, today).problems;
}

test('a valid entry is accepted, and an empty list is valid', () => {
  const verdict = judgeQuarantine(JSON.stringify({ entries: [VALID] }), SUITES, '2026-11-18');
  assert.deepEqual(verdict.problems, []);
  assert.equal(verdict.entries[0]?.suite, VALID.suite);
  assert.deepEqual(judge([]), []);
  assert.deepEqual(judge([VALID], '2026-11-24'), [], 'the last day is still valid');
});

test('each broken rule fails with its own problem', () => {
  assert.match(judge([{ ...VALID, suite: 'renderer/none' }]).join(), /names no suite the gate runs/);
  assert.match(judge([{ ...VALID, suite: 'electron/documents/atomicWrite' }]).join(), /never quarantined/);
  assert.match(judge([{ ...VALID, reds: [`${RED}1`] }]).join(), /at least 2 different red runs/);
  assert.match(judge([{ ...VALID, reds: [`${RED}1`, `${RED}1`] }]).join(), /at least 2 different red runs/);
  assert.match(judge([{ ...VALID, reds: ['https://example.test/1', `${RED}2`] }]).join(), /needs suite, owner/);
  assert.match(judge([{ ...VALID, expires: '2026-11-25' }]).join(), /lasts more than 7 days/);
  assert.match(judge([VALID], '2026-11-25').join(), /expired on 2026-11-24/);
  assert.match(judge([{ ...VALID, added: '2026-11-20', expires: '2026-11-21' }]).join(), /in the future/);
  assert.match(judge([VALID, VALID]).join(), /listed twice/);
  assert.match(judge([{ ...VALID, owner: ' ' }]).join(), /needs suite, owner/);
  assert.match(judgeQuarantine('not json', SUITES, '2026-11-18').problems.join(), /not JSON/);
  assert.match(judgeQuarantine('[]', SUITES, '2026-11-18').problems.join(), /expected an object/);
  assert.match(judge(Array.from({ length: QUARANTINE_LIMITS.entriesMax + 1 }, () => VALID)).join(), /fix suites instead/);
  assert.throws(() => judgeQuarantine('{"entries":[]}', SUITES, 'today'), /today is YYYY-MM-DD/);
});

test('the protected names cover the suites that must stay blocking', () => {
  for (const name of [
    'scripts/release/linuxPreflightChecks',
    'electron/documents/atomicWrite',
    'shared/page/parsePage',
    'corpus/roundtrip',
    'electron/content/envSecrets',
    'shared/core/boundary',
  ]) {
    assert.ok(PROTECTED_SUITE_PATTERN.test(name), name);
  }
  assert.ok(!PROTECTED_SUITE_PATTERN.test('renderer/apps/appUiKitElements'));
});

test('the committed quarantine is valid today', () => {
  const verdict = judgeQuarantine(readFileSync('scripts/gate/quarantine.json', 'utf8'), new Set(SUITES), new Date().toISOString().slice(0, 10));
  assert.deepEqual(
    verdict.problems.filter((problem) => !problem.includes('names no suite')),
    [],
  );
});
