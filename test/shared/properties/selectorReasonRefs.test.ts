// Goal: the "can't tell" reasons and file notes of the selector report carry an optional message reference that crosses IPC
// (shared/properties/selectorUsage.ts), and the engine's rename refusals carry a code the editor words (shared/engine/variableRename.ts).
// Method: a good reference is kept next to the English text; each malformed one is dropped without failing the report; old
// reports without references still parse; every rename refusal code has a sentence, and two codes pin their English text.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSelectorReport } from '#dist/shared/properties/selectorUsage.js';
import { describeRenameProblem, variableNameProblem } from '#dist/shared/engine/variableRename.js';

const digest = 'a'.repeat(64);
const entry = (verdict: unknown) => ({ id: 'a.css|0|0|0', rel: 'a.css', line: 1, selector: '.a', scope: 'global', verdict });

test('an unknown verdict keeps a well-formed reasonRef and drops a malformed one', () => {
  const good = { key: 'selectors.reason.unreadable', params: { file: 'src/a.astro' } };
  const kept = parseSelectorReport({ entries: [entry({ kind: 'unknown', names: ['a'], reason: 'x', reasonRef: good })], notes: [], files: [] });
  assert.deepEqual(kept.entries[0]?.verdict, { kind: 'unknown', names: ['a'], reason: 'x', reasonRef: good });
  for (const bad of [42, { key: 'not a key' }, { key: 'selectors.reason.unreadable', params: { file: { nested: true } } }]) {
    const dropped = parseSelectorReport({ entries: [entry({ kind: 'unknown', names: ['a'], reason: 'x', reasonRef: bad })], notes: [], files: [] });
    assert.deepEqual(dropped.entries[0]?.verdict, { kind: 'unknown', names: ['a'], reason: 'x' });
  }
});

test('a note keeps a well-formed messageRef, drops a malformed one, and parses without one', () => {
  const good = { key: 'selectors.problem.nesting' };
  const report = parseSelectorReport({
    entries: [],
    notes: [
      { rel: 'a', message: 'one', messageRef: good },
      { rel: 'b', message: 'two', messageRef: 7 },
      { rel: 'c', message: 'three' },
    ],
    files: [{ rel: 'a.css', digest }],
  });
  assert.deepEqual(report.notes, [
    { rel: 'a', message: 'one', messageRef: good },
    { rel: 'b', message: 'two' },
    { rel: 'c', message: 'three' },
  ]);
});

test('a refused variable name carries its code and the English sentence', () => {
  const invalid = variableNameProblem('1abc');
  assert.deepEqual(invalid?.problem, { code: 'invalid-name', name: '1abc' });
  assert.equal(invalid?.message, '“1abc” isn’t a valid variable name. Use letters, numbers, _ or $, and don’t start with a number.');
  assert.equal(variableNameProblem('class')?.problem.code, 'reserved-word');
  assert.equal(variableNameProblem('item'), undefined);
  assert.equal(
    describeRenameProblem({ code: 'exists', name: 'x', choose: 'source-menu' }),
    '“x” already exists in this file. To loop over it, choose it in the Source menu.',
  );
});
