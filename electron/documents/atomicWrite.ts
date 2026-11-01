// The OS-facing write primitives under the document actor's disk
// (electron/documents/documentDisk.ts, plan §5.2 steps 7–8). Nothing else may import the
// writing functions here: the actor is the only writer of a page, chunk or
// stylesheet (plan §3.3), and eslint.config.mjs fences the names.
//
// Why atomic: a plain writeFileSync truncates the target first, so a crash, a
// full disk or a concurrent reader can observe a half-written page. Here the
// bytes go to a temporary file in a project’s .stacki/io directory (same filesystem,
// so the rename is atomic), are flushed, and replace the target in one rename.
// The target holds the old bytes or the new ones, never a mixture.
//
// The OS-facing contract, pinned by the platform suite (test/electron/documents/):
// - Flush: `fsync` on the temporary file before the rename, then `fsync` on the
//   source and target directories after it, so the rename survives a power loss. On Windows
//   Node cannot open a directory for flushing; NTFS journals the rename, and
//   that is the platform's whole promise. Where a filesystem refuses to flush a
//   directory (EINVAL and friends), the same applies. On macOS `fsync` reaches
//   the drive but not its cache (F_FULLFSYNC is not exposed by Node) — the
//   honest limit of the platform, not of this module.
// - A directory flush that fails with a real I/O error leaves the file replaced
//   but not promised durable: `not-durable`, which the actor reports as
//   `uncertain` (plan §3.5), never as success.
// - Mode: the permission bits of the target survive (the umask cannot narrow
//   them). Ownership: the replacement is created by this process; where the
//   target belongs to another owner or group, the temporary file is given
//   theirs, and when the OS refuses, the write is refused — silently handing a
//   user's file to another owner is a change nobody asked for.
// - Symlinks: a link to a file is written through to the file it names, so the
//   link survives; a dangling link is refused, because creating its target
//   would be a guess about where the user meant the file to live.
// - Hard links: a target with more than one link is refused. The rename gives
//   the path a new file, so the other links would keep the old bytes — the
//   save would split one file into two without a word, which is as much a
//   change nobody asked for as a new owner.
// - Windows replacement: the rename is MoveFileEx with REPLACE_EXISTING. A
//   target held open without delete sharing (an antivirus scan, an indexer)
//   fails the rename with EPERM, EBUSY or EACCES; the target is untouched, the
//   temporary file is removed, and the actor reports `write-failed`. It never
//   retries (plan §3.5).
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import { toDigest, type Digest } from '../../shared/core/brand';
import { LIMITS } from '../../shared/core/limits';
import { err, ok, type Result } from '../../shared/core/result';
import { prepareAtomicDirectory } from './atomicDirectory';

/** Why a write did not happen, or did without a durability promise. */
export type AtomicWriteError =
  | { readonly code: 'filesystem'; readonly message: string }
  | { readonly code: 'exists'; readonly message: string }
  | { readonly code: 'not-durable'; readonly message: string };

const TEMPORARY_PREFIX = '.stacki-write-';
const TEMPORARY_SUFFIX = '.tmp';
export const LOCK_PREFIX = '.stacki-lock-';
export const LOCK_SUFFIX = '.lock';
/** Permission bits a replacement keeps; file-type bits are not settable. */
const MODE_BITS = 0o7777;
/** Directory-flush errors that mean "this filesystem does not flush
 * directories", not "the flush failed". */
const FLUSH_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR', 'EPERM', 'EBADF']);

/** SHA-256 of the exact bytes, the only constructor of a Digest outside the
 * wire parser. A string is hashed as its UTF-8 encoding. */
export function digestOf(bytes: Uint8Array | string): Digest {
  return toDigest(createHash('sha256').update(bytes).digest('hex'));
}

/** True for the temporary and lock files the write protocol creates, so the
 * project watcher can ignore them instead of reporting an outside edit. */
export function isAtomicTemporary(name: string): boolean {
  if (/(?:^|[\\/])\.stacki[\\/]io(?:[\\/]|$)/.test(name)) {
    return true;
  }
  // Recognize older staging folders until projects have removed them.
  if (name.split(/[\\/]/).includes('.stacki-io')) {
    return true;
  }
  const base = path.basename(name);
  if (base.startsWith(TEMPORARY_PREFIX)) {
    return base.endsWith(TEMPORARY_SUFFIX);
  }
  if (base.startsWith(LOCK_PREFIX)) {
    return base.endsWith(LOCK_SUFFIX);
  }
  return false;
}

/** Where a write to `file` lands: the file a symlink names, or the path itself
 * for a regular or missing file. A dangling symlink is refused (see header). */
export function writeTargetOf(file: string): Result<string, AtomicWriteError> {
  const absolute = path.resolve(file);
  let link: fs.Stats;
  try {
    link = fs.lstatSync(absolute);
  } catch (error: unknown) {
    return isMissing(error) ? ok(absolute) : filesystemError(file, error);
  }
  if (!link.isSymbolicLink()) {
    return ok(absolute);
  }
  try {
    return ok(fs.realpathSync(absolute));
  } catch (error: unknown) {
    if (isMissing(error)) {
      return err({ code: 'filesystem', message: `${file} is a symlink to a missing file` });
    }
    return filesystemError(file, error);
  }
}

/** Replace the existing `file` with `bytes` atomically. The caller verifies
 * what the file holds afterwards; this reports only what it did. */
export function replaceFileAtomic(file: string, bytes: Uint8Array): Result<void, AtomicWriteError> {
  if (bytes.length > LIMITS.sourceBytesMax) {
    return err({ code: 'filesystem', message: `${file} would exceed the 10 MB source limit` });
  }
  const target = writeTargetOf(file);
  if (!target.ok) {
    return target;
  }
  let stats: fs.Stats;
  try {
    stats = fs.statSync(target.value);
  } catch (error: unknown) {
    return filesystemError(file, error);
  }
  if (stats.nlink > 1) {
    return err({
      code: 'filesystem',
      message:
        `${path.basename(target.value)} is hard-linked to another file, so Stacki will not ` + `save it: saving would leave the other copy with the old text.`,
    });
  }
  const directory = prepareAtomicDirectory(target.value);
  if (!directory.ok) {
    return directory;
  }
  const temporary = path.join(directory.value, `${TEMPORARY_PREFIX}${randomUUID()}${TEMPORARY_SUFFIX}`);
  const staged = stageTemporary(temporary, bytes, stats);
  if (!staged.ok) {
    return discardTemporary(temporary, file, staged.error.message);
  }
  // Created exclusively above: nobody else can have written these bytes.
  assert(digestOf(fs.readFileSync(temporary)) === digestOf(bytes), 'The temporary holds the plan');
  try {
    fs.renameSync(temporary, target.value);
  } catch (error: unknown) {
    return discardTemporary(temporary, file, errorMessage(error));
  }
  // The rename changes two directories. Flush both, even if the first fails.
  const sourceFlush = flushDirectory(directory.value, file);
  const targetFlush = flushDirectory(path.dirname(target.value), file);
  return targetFlush.ok ? sourceFlush : targetFlush;
}

/** Create `file` with `bytes`, failing with `exists` if anything is there: a
 * creation can never overwrite. A crash mid-creation can leave a partial new
 * file; no existing bytes are ever at risk. */
export function createFileExclusive(file: string, bytes: Uint8Array): Result<void, AtomicWriteError> {
  if (bytes.length > LIMITS.sourceBytesMax) {
    return err({ code: 'filesystem', message: `${file} would exceed the 10 MB source limit` });
  }
  const target = path.resolve(file);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(target, 'wx', 0o666);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } catch (error: unknown) {
    if (errorCode(error) === 'EEXIST') {
      return err({ code: 'exists', message: `${file} already exists` });
    }
    return filesystemError(file, error);
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
  return flushDirectory(path.dirname(target), file);
}

function stageTemporary(temporary: string, bytes: Uint8Array, target: fs.Stats): Result<void, AtomicWriteError> {
  const mode = target.mode & MODE_BITS;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', mode);
    // The umask applied at open time must not narrow the file's permissions.
    fs.fchmodSync(descriptor, mode);
    keepOwner(descriptor, target);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } catch (error: unknown) {
    return err({ code: 'filesystem', message: errorMessage(error) });
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
  return ok(undefined);
}

// Give the replacement the target's owner and group. Throws (and so refuses the
// write) when the OS will not; Windows has no POSIX owner to keep.
function keepOwner(descriptor: number, target: fs.Stats): void {
  if (process.platform === 'win32') {
    return;
  }
  const staged = fs.fstatSync(descriptor);
  if (staged.uid === target.uid) {
    if (staged.gid === target.gid) {
      return;
    }
  }
  try {
    fs.fchownSync(descriptor, target.uid, target.gid);
  } catch (error: unknown) {
    throw new Error(`Saving would change the file's owner (${target.uid}:${target.gid}), ` + `and it cannot be kept: ${errorMessage(error)}`);
  }
}

function flushDirectory(directory: string, file: string): Result<void, AtomicWriteError> {
  if (process.platform === 'win32') {
    return ok(undefined); // See the header: NTFS journals the rename.
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code !== undefined) {
      if (FLUSH_UNSUPPORTED.has(code)) {
        return ok(undefined);
      }
    }
    return err({
      code: 'not-durable',
      message: `${file} was saved, but its folder could not be flushed: ${errorMessage(error)}`,
    });
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
  return ok(undefined);
}

function discardTemporary(temporary: string, file: string, reason: string): Result<never, AtomicWriteError> {
  try {
    fs.rmSync(temporary, { force: true });
  } catch (error: unknown) {
    return err({
      code: 'filesystem',
      message: `Could not save ${file} or remove temporary file ${temporary}: ` + `${reason}; ${errorMessage(error)}`,
    });
  }
  return err({ code: 'filesystem', message: `Could not save ${file}: ${reason}` });
}

function filesystemError(file: string, error: unknown): Result<never, AtomicWriteError> {
  return err({ code: 'filesystem', message: `Could not save ${file}: ${errorMessage(error)}` });
}

export function isMissing(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

export function errorCode(error: unknown): string | undefined {
  if (error instanceof Error) {
    if ('code' in error) {
      return typeof error.code === 'string' ? error.code : undefined;
    }
  }
  return undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
