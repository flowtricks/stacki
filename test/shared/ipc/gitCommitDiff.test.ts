// Goal: only bounded, unambiguous commit/file requests cross IPC.
// Methodology: parse valid SHA-1/SHA-256 requests and reject malformed identities,
// path escapes and wrong response shapes at the boundary; a patch of any length is accepted.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCommitDiffRequest, parseCommitDiffResult } from '#dist/shared/ipc/gitCommitDiff.js';

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
  const errorRef = { key: 'history.error.diffUnreadable' };
  assert.deepEqual(parseCommitDiffResult({ ok: false, error: 'Too large', errorRef }), { ok: false, error: 'Too large', errorRef });
  // A malformed reference is dropped; the English error still shows.
  assert.deepEqual(parseCommitDiffResult({ ok: false, error: 'Too large', errorRef: { key: 3 } }), { ok: false, error: 'Too large' });
  for (const value of [{ ok: true }, { ok: false }, { ok: 'yes', value: '' }]) {
    assert.throws(() => parseCommitDiffResult(value));
  }
  // A patch of any length is accepted: past the old 500,000 characters and 10,000 lines it still parses.
  const long = 'a'.repeat(600_000);
  assert.deepEqual(parseCommitDiffResult({ ok: true, value: long }), { ok: true, value: long });
  const tall = '\n'.repeat(20_000);
  assert.deepEqual(parseCommitDiffResult({ ok: true, value: tall }), { ok: true, value: tall });
});
