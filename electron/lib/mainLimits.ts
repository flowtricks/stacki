// Disk work has no product size limit: a project of any size opens (owner
// requirement). What remains is structural, or the platform's own ceiling
// (PLATFORM_LIMITS in shared/core/limits.ts). Work proportional to a project's
// size is sliced where it runs on the UI path, so size shows up as time, never
// as a refusal.
import * as fs from 'fs';
import * as path from 'path';
import { assert } from '../../shared/core/assert';
import { LIMITS, PLATFORM_LIMITS } from '../../shared/core/limits';

// The source-file bound lives in shared/core/limits.ts (plan §8), because the actor,
// the renderer and these readers must all refuse the same file: only a file the
// platform cannot hold as a string.
export const MAIN_LIMITS = {
  /**
   * Directory levels a walker descends. Not a size bound: a path is at most
   * ipcPathCharsMax units and each level costs at least a name unit and a
   * separator, so no real tree is deeper. The walkers do not follow symlinks,
   * so the depth also stops a cycle made of bind mounts or junctions.
   */
  directoryDepthMax: Math.floor(LIMITS.ipcPathCharsMax / 2),
  portAttemptsMax: 100,
  previewServersMax: 16,
  logChunkCharsMax: 64000,
  /** One JSON line from the content-config runner. Sized as one IPC field: a
   * reply longer than that could never reach the renderer, so the runner is
   * stopped instead of buffering toward it. */
  runnerLineCharsMax: LIMITS.ipcFieldCharsMax,
  /** Source files one content config bundle may draw on: the config, its loaders and their
   * imports. Each is statted on every read to tell whether the bundle is stale, so a graph far
   * past any real config is a runaway import, refused rather than statted. */
  runnerInputsMax: 10_000,
  /** The runner's stderr tail kept for an error message. */
  runnerStderrCharsMax: 4000,
  /** Output one command (git, the package manager, astro) may print before it
   * is killed. Node's own default, stated so no call relies on it. */
  commandOutputBytesMax: 1024 * 1024,
  /** Output one git command may print: a status or file listing of a very large project is far longer than a build's output. */
  gitOutputBytesMax: 64 * 1024 * 1024,
  /** The part of a failed git command's output shown to the person; hooks print their verdict last, so the tail is kept. */
  gitMessageCharsMax: 4000,
  /** Characters of one commit message: far past any real one, and well inside the argument limit of every platform. */
  commitMessageCharsMax: 50_000,
  /** Paths one commit or restore may name; past this the listing no longer fits a process argument and a file carries it. */
  pathspecArgumentsMax: 200,
  /** Files the commit picker lists. A project with more has a missing ignore rule, which is said instead of hiding files. */
  statusFilesMax: 20_000,
  /** Commits in one history page: a screenful and a scroll, never the whole history. */
  logPageMax: 500,
  /** The wait for a commit: hooks (lint-staged, tests) and signing programs may legitimately run for minutes. */
  commitTimeoutMs: 5 * 60 * 1000,
  /**
   * Removal attempts for one publish temporary directory. Windows reports EBUSY
   * or EPERM while git, antivirus or the search indexer still holds a file such
   * as index.lock; the hold ends within moments, so a few spaced attempts clear it.
   */
  publishCleanupAttemptsMax: 6,
  /** The pause before the second attempt; each later pause grows by this much (linear back-off). */
  publishCleanupRetryDelayMs: 200,
  /** Leftover publish directories one sweep inspects, so a crowded temp folder cannot stall a publish. */
  publishSweepEntriesMax: 64,
  /** A leftover this old belongs to no running publish (a job lasts minutes), so the sweep may remove it. */
  publishSweepStaleAgeMs: 24 * 60 * 60 * 1000,
} as const;

export function readSource(file: string): string {
  return readSourceBytes(file).toString('utf8');
}

/** The exact bytes of a source file, bounded before and after the read. A
 * checksum must be taken over these bytes, never over decoded text. */
export function readSourceBytes(file: string): Buffer {
  const size = fs.statSync(file).size;
  if (size > LIMITS.sourceBytesMax) {
    throw new Error(`Source file exceeds the ${LIMITS.sourceBytesMax} byte platform string limit`);
  }
  const bytes = fs.readFileSync(file);
  // A writer may grow the file between stat and read, so check both sides.
  if (bytes.length > LIMITS.sourceBytesMax) {
    throw new Error(`Source file exceeds the ${LIMITS.sourceBytesMax} byte platform string limit`);
  }
  return bytes;
}

/** Counts a walk for progress and depth. There is no entry total: a walk of
 * any size completes, and its bound is the tree's own size. `visited` still
 * counts so a test can prove every entry was seen. */
export function directoryBudget(root: string): (directory: string, entries: number) => void {
  // This closure owns the total; nested directory readers cannot reset it.
  let visited = 0;
  return (directory, entries) => {
    assert(Number.isSafeInteger(entries), 'Directory entry count must be an integer');
    assert(entries >= 0, 'Directory entry count must be nonnegative');
    const depth = path.relative(root, directory).split(path.sep).length;
    if (depth > MAIN_LIMITS.directoryDepthMax) {
      throw new Error('Directory depth exceeds limit');
    }
    visited += entries + 1;
    assert(visited <= PLATFORM_LIMITS.safeIntegerMax, 'The visited count stays an exact integer');
  };
}
