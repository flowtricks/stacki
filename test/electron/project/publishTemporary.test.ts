// Goal: a publish directory that Windows will not release yet (EBUSY on index.lock) never fails a publish.
// Method: drive removePublishTemporary, releasePublishTemporary and sweepPublishTemporaries through injected
// seams (remove, wait, log, clock, directory listing), so no test sleeps, touches a real lock or reads a wall clock.
// Retries are counted, never timed, so a slow CI machine changes nothing.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { git, setToolPathHome } from '#dist/electron/lib/nodeTools.js';
import { MAIN_LIMITS } from '#dist/electron/lib/mainLimits.js';
import {
  PUBLISH_TEMPORARY_SEAMS,
  releasePublishTemporary,
  removePublishTemporary,
  sweepPublishTemporaries,
  type PublishTemporarySeams,
} from '#dist/electron/project/publishTemporary.js';
import { createPublishSource, readPublishTree } from '#dist/electron/project/publishSnapshot.js';

setToolPathHome(homedir());

function failure(code: string): Error {
  return Object.assign(new Error(`${code}: resource busy or locked, unlink 'index.lock'`), { code });
}

interface Recorder {
  readonly seams: PublishTemporarySeams;
  readonly removed: string[];
  readonly waits: number[];
  readonly logs: string[];
}

function recorder(overrides: Partial<PublishTemporarySeams> & { readonly failures?: readonly Error[] } = {}): Recorder {
  const removed: string[] = [];
  const waits: number[] = [];
  const logs: string[] = [];
  const pending = [...(overrides.failures ?? [])];
  const seams: PublishTemporarySeams = {
    remove: async (directory) => {
      const next = pending.shift();
      if (next !== undefined) {
        throw next;
      }
      removed.push(directory);
    },
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
    log: (message) => {
      logs.push(message);
    },
    temporaryRoot: () => path.join(path.sep, 'tmp'),
    list: async () => [],
    modified: async () => undefined,
    now: () => 0,
    ...overrides,
  };
  return { seams, removed, waits, logs };
}

test('EBUSY that clears within the attempt limit is retried with a growing pause and then succeeds', async () => {
  const failures = [failure('EBUSY'), failure('EPERM'), failure('ENOTEMPTY')];
  const recording = recorder({ failures });
  const result = await removePublishTemporary('/tmp/stacki-publish-abc123', recording.seams);
  assert.deepEqual(result, { ok: true, value: undefined });
  assert.deepEqual(recording.removed, ['/tmp/stacki-publish-abc123']);
  const delay = MAIN_LIMITS.publishCleanupRetryDelayMs;
  assert.deepEqual(recording.waits, [delay, delay * 2, delay * 3]);
});

test('EBUSY that never clears stops at the attempt limit and returns a failure value', async () => {
  let attempts = 0;
  const recording = recorder({
    remove: async () => {
      attempts++;
      throw failure('EBUSY');
    },
  });
  const result = await removePublishTemporary('/tmp/stacki-publish-abc123', recording.seams);
  assert.equal(result.ok, false);
  assert.equal(attempts, MAIN_LIMITS.publishCleanupAttemptsMax);
  // No pause follows the last attempt.
  assert.equal(recording.waits.length, MAIN_LIMITS.publishCleanupAttemptsMax - 1);
});

test('a code that is not a transient hold fails at once without retrying', async () => {
  let attempts = 0;
  const recording = recorder({
    remove: async () => {
      attempts++;
      throw failure('EINVAL');
    },
  });
  const result = await removePublishTemporary('/tmp/stacki-publish-abc123', recording.seams);
  assert.equal(result.ok, false);
  assert.equal(attempts, 1);
  assert.deepEqual(recording.waits, []);
});

test('removal rejects a non-positive attempt count', async () => {
  await assert.rejects(removePublishTemporary('/tmp/stacki-publish-abc123', recorder().seams, 0), /At least one removal attempt/);
});

test('release logs a stuck directory and never throws or returns a failure', async () => {
  const recording = recorder({
    remove: async () => {
      throw failure('EBUSY');
    },
  });
  assert.equal(await releasePublishTemporary('/tmp/stacki-publish-abc123', recording.seams), undefined);
  assert.equal(recording.logs.length, 1);
  assert.match(recording.logs[0] ?? '', /stacki-publish-abc123/);
  assert.match(recording.logs[0] ?? '', /EBUSY/);
});

test('release is silent when removal succeeds after retries', async () => {
  const recording = recorder({ failures: [failure('EBUSY')] });
  await releasePublishTemporary('/tmp/stacki-publish-abc123', recording.seams);
  assert.deepEqual(recording.logs, []);
  assert.equal(recording.removed.length, 1);
});

test('sweep removes only stale directories that carry this feature’s exact name shape', async () => {
  const root = path.join(path.sep, 'tmp');
  const age = MAIN_LIMITS.publishSweepStaleAgeMs;
  const modifiedAt = new Map<string, number>([
    [path.join(root, 'stacki-publish-old111'), 0],
    [path.join(root, 'stacki-publish-new222'), 2 * age - 1],
    [path.join(root, 'stacki-publish-test-xyz'), 0],
    [path.join(root, 'other-old333'), 0],
  ]);
  const recording = recorder({
    temporaryRoot: () => root,
    list: async () => ['stacki-publish-old111', 'stacki-publish-new222', 'stacki-publish-test-xyz', 'other-old333', 'stacki-publish-gone44'],
    modified: async (entry) => modifiedAt.get(entry),
    now: () => 2 * age,
  });
  const count = await sweepPublishTemporaries(recording.seams);
  assert.equal(count, 1);
  assert.deepEqual(recording.removed, [path.join(root, 'stacki-publish-old111')]);
});

test('sweep logs a directory that is still held, makes one attempt, and carries on', async () => {
  const root = path.join(path.sep, 'tmp');
  let attempts = 0;
  const recording = recorder({
    temporaryRoot: () => root,
    list: async () => ['stacki-publish-held11', 'stacki-publish-free22'],
    modified: async () => 0,
    now: () => MAIN_LIMITS.publishSweepStaleAgeMs,
    remove: async (directory) => {
      attempts++;
      if (directory.endsWith('held11')) {
        throw failure('EBUSY');
      }
    },
  });
  assert.equal(await sweepPublishTemporaries(recording.seams), 1);
  assert.equal(attempts, 2);
  assert.equal(recording.logs.length, 1);
  assert.deepEqual(recording.waits, []);
});

test('sweep inspects at most the entry limit and survives an unreadable temp folder', async () => {
  const names = Array.from({ length: MAIN_LIMITS.publishSweepEntriesMax + 10 }, (_, index) => `stacki-publish-${String(index).padStart(6, 'a')}`);
  let inspected = 0;
  const bounded = recorder({
    list: async () => names,
    modified: async () => {
      inspected++;
      return undefined;
    },
  });
  assert.equal(await sweepPublishTemporaries(bounded.seams), 0);
  assert.equal(inspected, MAIN_LIMITS.publishSweepEntriesMax);
  const unreadable = recorder({
    list: async () => {
      throw failure('EACCES');
    },
  });
  assert.equal(await sweepPublishTemporaries(unreadable.seams), 0);
});

test('the real seams remove a real directory that holds a lock file', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'stacki-publish-seam-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'index.lock'), '');
  assert.deepEqual(await removePublishTemporary(directory, PUBLISH_TEMPORARY_SEAMS), { ok: true, value: undefined });
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('a snapshot capture failure is reported as itself, not replaced by a cleanup failure', async (context) => {
  // The root is not a Git repository, so capture fails; the real removal then runs and must not alter that answer.
  const root = await mkdtemp(path.join(tmpdir(), 'stacki-publish-nogit-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const captured = await createPublishSource(root, 'github');
  assert.equal(captured.ok, false);
  if (!captured.ok) {
    assert.notEqual(captured.error.code, 'filesystem');
  }
});

test('reading a tree succeeds even though the directory removal is left to the sweep', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'stacki-publish-tree-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'sub'));
  await git(root, ['init', '--initial-branch=main']);
  await writeFile(path.join(root, 'sub/page.txt'), 'content');
  const tree = await readPublishTree(root);
  assert.equal(tree.ok, true);
});
