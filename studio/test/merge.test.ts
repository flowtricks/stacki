// Three-way reconciliation must preserve local drafts and reject overlapping remote
// edits without emitting conflict-marker text into an executable Astro file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSource } from '../src/features/github/merge';
test('external commit merges with disjoint draft edits', async () => {
  const base = 'one\ntwo\nthree\nfour\nfive\n';
  const result = await mergeSource(base, base.replace('one', 'local'), base.replace('five', 'remote'));
  assert.deepEqual(result, { kind: 'merged', source: 'local\ntwo\nthree\nfour\nremote\n' });
});
test('overlapping edits surface a conflict', async () => {
  assert.deepEqual(await mergeSource('<h1>base</h1>\n', '<h1>local</h1>\n', '<h1>remote</h1>\n'), {
    kind: 'conflict',
  });
});
