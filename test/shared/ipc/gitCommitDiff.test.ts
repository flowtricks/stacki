// Goal: only bounded, unambiguous commit/file requests cross IPC.
// Methodology: parse valid SHA-1/SHA-256 requests and reject malformed identities,
// path escapes, wrong response shapes, and oversized patches at the boundary.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMIT_DIFF_LIMITS, parseCommitDiffRequest, parseCommitDiffResult } from '#dist/shared/ipc/gitCommitDiff.js';

const request = { projectPath: '/project', commit: 'a'.repeat(40), path: 'src/page.astro' };

test('commit diff requests validate commit identity and literal relative paths', () => {
  assert.deepEqual(parseCommitDiffRequest(request), { ...request, from: undefined });
  assert.equal(parseCommitDiffRequest({ ...request, commit: 'b'.repeat(64), from: 'old.astro' }).from, 'old.astro');
  assert.equal(parseCommitDiffRequest({ ...request, path: '[draft]*.astro' }).path, '[draft]*.astro');
  for (const commit of ['HEAD', '-p', 'abc123', 'G'.repeat(40), 5]) {
    assert.throws(() => parseCommitDiffRequest({ ...request, commit }));
  }
  for (const path of ['', '/etc/passwd', '../file', 'src/../../file', 'C:\\file', 'C:file', '\\server\\share', 'a\0b', 4]) {
    assert.throws(() => parseCommitDiffRequest({ ...request, path }));
    assert.throws(() => parseCommitDiffRequest({ ...request, from: path }));
  }
  assert.throws(() => parseCommitDiffRequest({ ...request, projectPath: '' }));
});

test('diff replies are bounded successes or explicit errors', () => {
  assert.deepEqual(parseCommitDiffResult({ ok: true, value: '' }), { ok: true, value: '' });
  assert.deepEqual(parseCommitDiffResult({ ok: false, error: 'Missing commit' }), {
    ok: false,
    error: 'Missing commit',
  });
  for (const value of [{ ok: true }, { ok: false }, { ok: 'yes', value: '' }]) {
    assert.throws(() => parseCommitDiffResult(value));
  }
  assert.throws(() => parseCommitDiffResult({ ok: true, value: 'a'.repeat(COMMIT_DIFF_LIMITS.charactersMax + 1) }), /character limit/);
  assert.throws(() => parseCommitDiffResult({ ok: true, value: '\n'.repeat(COMMIT_DIFF_LIMITS.linesMax) }), /line limit/);
});
