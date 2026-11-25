import { readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assert } from '../../shared/core/assert';
import { ok, type Result } from '../../shared/core/result';
import { MAIN_LIMITS } from '../lib/mainLimits';
import { publishFilesystemFailure } from './publishGitCommand';

// A publish works in a private directory under the system temp folder. Removing it is housekeeping:
// by then the push or deployment has already succeeded or failed on its own terms, so a removal
// that fails must never change that outcome. On Windows the removal does fail for a while, with
// EBUSY or EPERM, when git, antivirus or the indexer still holds index.lock. The directory is
// retried with a bounded back-off, then logged and left for the next publish to sweep.

export const PUBLISH_TEMPORARY_PREFIX = 'stacki-publish-';

// The system call `mkdtemp` appends exactly six random characters; anything else with the prefix is not ours to delete.
const PUBLISH_TEMPORARY_NAME = /^stacki-publish-[A-Za-z0-9]{6}$/;

// A hold that ends by itself reports one of these; any other code is a real failure and stops the retries.
const TRANSIENT_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES']);

export interface PublishTemporarySeams {
  readonly remove: (directory: string) => Promise<void>;
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly log: (message: string) => void;
  readonly temporaryRoot: () => string;
  readonly list: (directory: string) => Promise<readonly string[]>;
  /** The modification time in milliseconds, or undefined when the entry is gone or is not a directory. */
  readonly modified: (entry: string) => Promise<number | undefined>;
  readonly now: () => number;
}

export const PUBLISH_TEMPORARY_SEAMS: PublishTemporarySeams = {
  // Retries are ours, so the platform's own are switched off explicitly rather than left to its defaults.
  remove: (directory) => rm(directory, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 }),
  wait: (milliseconds) => delay(milliseconds),
  log: (message) => console.error(message),
  temporaryRoot: () => tmpdir(),
  list: (directory) => readdir(directory),
  modified: async (entry) => {
    const info = await stat(entry).catch(() => undefined);
    return info?.isDirectory() === true ? info.mtimeMs : undefined;
  },
  now: () => Date.now(),
};

/** Removes a publish directory, retrying transient holds up to `attemptsMax` times. */
export async function removePublishTemporary(
  directory: string,
  seams: PublishTemporarySeams = PUBLISH_TEMPORARY_SEAMS,
  attemptsMax: number = MAIN_LIMITS.publishCleanupAttemptsMax,
): Promise<Result<void>> {
  assert(Number.isSafeInteger(attemptsMax), 'Attempt count is an integer');
  assert(attemptsMax > 0, 'At least one removal attempt is made');
  let failure: unknown;
  for (let attempt = 1; attempt <= attemptsMax; attempt++) {
    try {
      await seams.remove(directory);
      return ok(undefined);
    } catch (error: unknown) {
      failure = error;
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : '';
      if (!TRANSIENT_CODES.has(code)) {
        break;
      }
      if (attempt < attemptsMax) {
        await seams.wait(MAIN_LIMITS.publishCleanupRetryDelayMs * attempt);
      }
    }
  }
  return publishFilesystemFailure(failure);
}

/**
 * Removes a publish directory after the work is over. It never fails: a directory that cannot be
 * removed is logged and left for sweepPublishTemporaries, because the caller's result is already decided.
 */
export async function releasePublishTemporary(directory: string, seams: PublishTemporarySeams = PUBLISH_TEMPORARY_SEAMS): Promise<void> {
  const removed = await removePublishTemporary(directory, seams);
  if (!removed.ok) {
    seams.log(`[publish] could not remove ${directory}; the next publish will sweep it: ${removed.error.message}`);
  }
}

/** Removes leftover publish directories older than the stale age. One pass, bounded, never throws. */
export async function sweepPublishTemporaries(seams: PublishTemporarySeams = PUBLISH_TEMPORARY_SEAMS): Promise<number> {
  const root = seams.temporaryRoot();
  const listed = await seams.list(root).then(ok, publishFilesystemFailure);
  // An unreadable temp folder has nothing to sweep; the next publish tries again.
  const names = listed.ok ? listed.value : [];
  const candidates = names.filter((name) => PUBLISH_TEMPORARY_NAME.test(name)).slice(0, MAIN_LIMITS.publishSweepEntriesMax);
  assert(candidates.length <= MAIN_LIMITS.publishSweepEntriesMax, 'A sweep inspects a bounded number of entries');
  let removedCount = 0;
  for (const name of candidates) {
    const directory = path.join(root, name);
    const modified = await seams.modified(directory);
    if (modified === undefined) {
      continue;
    }
    if (seams.now() - modified < MAIN_LIMITS.publishSweepStaleAgeMs) {
      continue;
    }
    // One attempt: a hold that persists is retried by the next sweep, so a crowded folder cannot stall a publish.
    const removed = await removePublishTemporary(directory, seams, 1);
    if (removed.ok) {
      removedCount++;
    } else {
      seams.log(`[publish] could not sweep ${directory}: ${removed.error.message}`);
    }
  }
  return removedCount;
}
