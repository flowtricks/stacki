import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Writing studio/vendor/stacki without a window in which it is half there.
//
// The assemble used to delete the whole tree and copy it again. Every agent stop hook, gate and
// session runs it, often at the same moment, and a type check that read the tree mid-copy failed
// with TS6053 (file not found) or ENOTEMPTY floods. Now:
//   - one writer at a time: a lock folder, created atomically with mkdir; a lock older than its
//     stale bound belongs to a writer that died and is taken over;
//   - a file is written only when its bytes differ, through a temporary file and a rename, so a
//     reader sees the old file or the new one, never a missing or partial one;
//   - files no longer in the inventory are removed after everything else is in place.
// Concurrent assembles of the same sources therefore change nothing at all.

export const VENDOR_SYNC_LIMITS = {
  lockWaitMsMax: 120_000,
  lockPollMs: 100,
  lockStaleMs: 10 * 60_000,
  filesMax: 5_000,
  depthMax: 32,
} as const satisfies Record<string, number>;

export type Sleep = (delayMs: number) => Promise<void>;

const sleepReal: Sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}

/** Runs `work` while holding the lock folder; waits (bounded) for another holder. */
export async function withVendorLock<T>(lockPath: string, work: () => Promise<T>, sleep: Sleep = sleepReal): Promise<T> {
  const attemptsMax = Math.ceil(VENDOR_SYNC_LIMITS.lockWaitMsMax / VENDOR_SYNC_LIMITS.lockPollMs);
  await mkdir(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt <= attemptsMax; attempt += 1) {
    try {
      await mkdir(lockPath);
    } catch (error: unknown) {
      if (errorCode(error) !== 'EEXIST') {
        throw error;
      }
      const ageMs = await stat(lockPath).then(
        (info) => Date.now() - info.mtimeMs,
        () => 0,
      );
      if (ageMs > VENDOR_SYNC_LIMITS.lockStaleMs) {
        await rm(lockPath, { recursive: true, force: true });
      } else {
        await sleep(VENDOR_SYNC_LIMITS.lockPollMs);
      }
      continue;
    }
    try {
      return await work();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }
  throw new Error(`Another Studio assemble held ${lockPath} for over ${VENDOR_SYNC_LIMITS.lockWaitMsMax / 1000} s`);
}

async function listFiles(root: string): Promise<readonly string[]> {
  const found: string[] = [];
  const pending: { readonly folder: string; readonly depth: number }[] = [{ folder: root, depth: 0 }];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) {
      break;
    }
    if (next.depth > VENDOR_SYNC_LIMITS.depthMax) {
      throw new Error(`vendor tree deeper than ${VENDOR_SYNC_LIMITS.depthMax}`);
    }
    const entries = await readdir(next.folder, { withFileTypes: true }).catch((error: unknown) => {
      if (errorCode(error) === 'ENOENT') {
        return [];
      }
      throw error;
    });
    for (const entry of entries) {
      const full = path.join(next.folder, entry.name);
      if (entry.isDirectory()) {
        pending.push({ folder: full, depth: next.depth + 1 });
      } else {
        found.push(path.relative(root, full).split(path.sep).join('/'));
      }
      if (found.length > VENDOR_SYNC_LIMITS.filesMax) {
        throw new Error(`vendor tree holds more than ${VENDOR_SYNC_LIMITS.filesMax} files`);
      }
    }
  }
  return found;
}

/** Writes one file only if its bytes differ, through a temporary file and a rename. */
export async function writeIfChanged(target: string, content: string | Buffer): Promise<boolean> {
  const bytes = typeof content === 'string' ? Buffer.from(content) : content;
  const current = await readFile(target).catch(() => undefined);
  if (current !== undefined && current.equals(bytes)) {
    return false;
  }
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(temporary, bytes);
  await rename(temporary, target);
  return true;
}

export interface SyncReport {
  readonly written: number;
  readonly removed: number;
}

/** Makes `root` hold exactly `files` (relative paths with `/`), touching only what differs. */
export async function syncTree(root: string, files: ReadonlyMap<string, string | Buffer>): Promise<SyncReport> {
  if (files.size > VENDOR_SYNC_LIMITS.filesMax) {
    throw new Error(`more than ${VENDOR_SYNC_LIMITS.filesMax} vendor files`);
  }
  let written = 0;
  for (const [relative, content] of files) {
    if (relative.split('/').includes('..') || path.isAbsolute(relative)) {
      throw new Error(`vendor path ${relative} leaves the tree`);
    }
    if (await writeIfChanged(path.join(root, ...relative.split('/')), content)) {
      written += 1;
    }
  }
  let removed = 0;
  for (const relative of await listFiles(root)) {
    if (!files.has(relative)) {
      await rm(path.join(root, ...relative.split('/')), { force: true });
      removed += 1;
    }
  }
  return { written, removed };
}
