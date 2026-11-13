// The document actor's real disk (plan §5.2), and the only module that writes
// a page, chunk or stylesheet: it implements shared/engine/documentActor.ts's
// DocumentDisk over node:fs, through the primitives in atomicWrite.ts.
//
// - Reads are bounded by LIMITS.sourceBytesMax before and after the read.
// - The advisory lock (§5.2 step 7) is a lock file in the target's stable hidden
//   save directory, created exclusively and naming its owner (process, host, token).
//   It excludes only cooperating writers — another Stacki window or process. A lock whose owner
//   process is gone (a crash) is broken by the next writer; any lock is broken
//   once it is older than LOCK_STALE_MS. Node has
//   no portable flock, so a lock file is the "where available" of the plan.
// - Canonical paths: one actor per file, whatever spelling reaches it. The key
//   is the directory's identity (device and inode — directories are never
//   replaced by a save, so it is stable) plus the name, case-folded where the
//   directory is case-insensitive. Only a real probe decides that: `stat` the
//   name with its case swapped and compare identities. Without one (a missing
//   file, a name without letters) the platform default holds until a probe in
//   the same directory decides.
// - Installed code: a file inside node_modules is never locked, replaced or
//   created (electron/lib/installedPackages.ts). The check is on where the
//   write would land, folder links and file links resolved, so no spelling of
//   the path slips past it — pnpm's hard-linked `file:` dependencies live under
//   the project's own node_modules, and a write there reached the package's
//   source.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import { toFilePath, type FilePath } from '../../shared/core/brand';
import type { DiskError, DiskLock, DiskRead, DocumentDisk, LockError, Projector, ReplaceError } from '../../shared/engine/documentActor';
import { parsePageResult } from '../../shared/page/pageNode';
import { parseMarkdownPage } from '../parse/markdownParser';
import type { Plan } from '../../shared/engine/planner';
import { projectValueSplice } from '../../shared/engine/projectionPatch';
import { toRecord } from '../../shared/core/record';
import { err, ok, type Result } from '../../shared/core/result';
import { createLazySnapshot, createSnapshot, type Snapshot } from '../../shared/page/snapshot';
import { projectOpaqueDocument, projectPage, type Projection } from '../../shared/page/sourceProjection';
import { decodeUtf8, toByteString, type ByteString } from '../../shared/core/span';
import { parsePage } from '../parse/astroParser';
import {
  createFileExclusive,
  digestOf,
  errorCode,
  errorMessage,
  LOCK_PREFIX,
  LOCK_SUFFIX,
  replaceFileAtomic,
  writeTargetOf,
  type AtomicWriteError,
} from './atomicWrite';
import { readSourceBytes } from '../lib/mainLimits';
import { isInstalledFile, packageOf } from '../lib/installedPackages';
import { atomicDirectoryOf, prepareAtomicDirectory } from './atomicDirectory';
import { translateMain } from '../lib/mainLocale';

/** A lock older than this whose owner cannot be asked is abandoned: no save
 * holds its lock for more than one read, one write and one read-back. */
export const LOCK_STALE_MS = 10_000;
/** Directories whose case sensitivity a probe has settled, kept per process. */
const CASE_PROBES_MAX = 4_096;

export interface CanonicalDocument {
  /** The path the actor reads and writes. */
  readonly path: FilePath;
  /** One key per file, whatever spelling reached it. */
  readonly key: string;
}

export interface CreateError {
  readonly code: 'exists' | 'failed';
  readonly message: string;
}

export class NodeDocumentDisk implements DocumentDisk {
  readonly #held = new Set<string>();
  readonly #caseInsensitive = new Map<string, boolean>();
  #reads = 0;

  read(file: FilePath): Result<DiskRead, DiskError> {
    let bytes: Buffer;
    try {
      bytes = readSourceBytes(file);
    } catch (error: unknown) {
      const code = errorCode(error) === 'ENOENT' ? 'missing' : 'failed';
      return err({ code, message: translateMain('error.documents.readFailed', { file, reason: errorMessage(error) }) });
    }
    this.#reads += 1;
    assert(Number.isSafeInteger(this.#reads), 'The read stamp stays a safe integer');
    return ok({ bytes: toByteString(bytes), generation: this.#reads });
  }

  lock(file: FilePath): Result<DiskLock, LockError> {
    const target = writeTargetOf(file);
    if (!target.ok) {
      return err({ code: 'failed', message: target.error.message });
    }
    const installed = refuseInstalled(target.value);
    if (!installed.ok) {
      return installed;
    }
    const directory = prepareAtomicDirectory(target.value);
    if (!directory.ok) {
      return err({ code: 'failed', message: directory.error.message });
    }
    const location = lockFileOf(target.value);
    if (!location.ok) {
      return location;
    }
    const lockFile = location.value;
    const first = this.#tryLock(file, lockFile);
    if (first.ok || first.error.code === 'failed') {
      return first;
    }
    // Held. Break it only if its owner is provably gone, then try once more.
    if (!this.#breakIfStale(lockFile)) {
      return first;
    }
    return this.#tryLock(file, lockFile);
  }

  unlock(lock: DiskLock): Result<void, DiskError> {
    assert(this.#held.has(lock.token), 'Only a lock this disk holds is released');
    this.#held.delete(lock.token);
    const target = writeTargetOf(lock.path);
    if (!target.ok) {
      return err({ code: 'failed', message: target.error.message });
    }
    const location = lockFileOf(target.value);
    if (!location.ok) {
      return location;
    }
    const lockFile = location.value;
    const owner = readLockOwner(lockFile);
    if (owner?.token !== lock.token) {
      return err({ code: 'failed', message: translateMain('error.documents.lockTakenOver', { file: lock.path }) });
    }
    try {
      fs.rmSync(lockFile);
    } catch (error: unknown) {
      return err({ code: 'failed', message: errorMessage(error) });
    }
    return ok(undefined);
  }

  replace(file: FilePath, bytes: ByteString): Result<void, ReplaceError> {
    // Checked again under the lock: a folder can become a link in between.
    const installed = refuseInstalled(file);
    if (!installed.ok) {
      return installed;
    }
    const replaced = replaceFileAtomic(file, bytes);
    if (replaced.ok) {
      return replaced;
    }
    return err(replaceError(replaced.error));
  }

  /** Create a new document; never overwrites (atomicWrite.ts). Creation is not
   * an intent — there are no authored bytes to witness — so the host calls it
   * directly and the actor adopts the file on its next read. */
  create(file: FilePath, bytes: ByteString): Result<void, CreateError> {
    const installed = refuseInstalled(file);
    if (!installed.ok) {
      return installed;
    }
    const created = createFileExclusive(file, bytes);
    if (created.ok) {
      return created;
    }
    const code = created.error.code === 'exists' ? 'exists' : 'failed';
    return err({ code, message: created.error.message });
  }

  /** The actor's path and identity key for `file` (see header). */
  canonical(file: string): Result<CanonicalDocument, string> {
    // Check the authored path before canonicalization loses a workspace package link.
    const installed = refuseInstalled(file);
    if (!installed.ok) {
      return err(installed.error.message);
    }
    const target = writeTargetOf(file);
    if (!target.ok) {
      return err(target.error.message);
    }
    const name = path.basename(target.value);
    let directory: string;
    let identity: fs.Stats;
    try {
      directory = fs.realpathSync.native(path.dirname(target.value));
      identity = fs.statSync(directory);
    } catch (error: unknown) {
      return err(`The folder of ${file} is not available: ${errorMessage(error)}`);
    }
    const directoryKey = `${identity.dev}:${identity.ino}`;
    const folded = this.#caseInsensitiveAt(directoryKey, path.join(directory, name));
    const key = `${directoryKey}/${folded ? foldCase(name) : name}`;
    return ok({ path: toFilePath(path.join(directory, name)), key });
  }

  #tryLock(file: FilePath, lockFile: string): Result<DiskLock, LockError> {
    const token = randomUUID();
    const owner = JSON.stringify({ pid: process.pid, host: os.hostname(), token });
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(lockFile, 'wx', 0o644);
      fs.writeFileSync(descriptor, owner);
    } catch (error: unknown) {
      if (errorCode(error) === 'EEXIST') {
        return err({ code: 'held', message: translateMain('error.documents.lockHeld', { file }) });
      }
      return err({ code: 'failed', message: translateMain('error.documents.lockFailed', { file, reason: errorMessage(error) }) });
    } finally {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
      }
    }
    this.#held.add(token);
    return ok({ path: file, token });
  }

  // Move a stale lock aside under a unique name, and delete it only if it is
  // still the stale one: another process may have broken it and locked since,
  // and that fresh lock goes back where it was.
  #breakIfStale(lockFile: string): boolean {
    const owner = readLockOwner(lockFile);
    if (!this.#stale(lockFile, owner)) {
      return false;
    }
    const aside = path.join(path.dirname(lockFile), `${LOCK_PREFIX}broken-${randomUUID()}${LOCK_SUFFIX}`);
    try {
      fs.renameSync(lockFile, aside);
    } catch (error: unknown) {
      return errorCode(error) === 'ENOENT'; // Somebody else broke it first.
    }
    const moved = readLockOwner(aside);
    if (moved?.token !== owner?.token) {
      try {
        fs.linkSync(aside, lockFile); // Put the live lock back, unless one exists.
      } catch {
        /* A newer lock is in place, or links are unsupported: theirs stands. */
      }
      fs.rmSync(aside, { force: true });
      return false;
    }
    fs.rmSync(aside, { force: true });
    return true;
  }

  // Stale: leaked by this process, owned by a process that is gone, or older
  // than any save takes — which also covers another host, an unreadable lock
  // and a crashed owner whose process id was reused.
  #stale(lockFile: string, owner: LockOwner | undefined): boolean {
    if (owner !== undefined) {
      if (owner.host === os.hostname()) {
        if (owner.pid === process.pid) {
          return !this.#held.has(owner.token);
        }
        if (!processAlive(owner.pid)) {
          return true;
        }
      }
    }
    try {
      return Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS;
    } catch {
      // A failed observation is not proof of abandonment. The previous lock
      // can disappear and a fresh writer can acquire the same pathname before
      // recovery renames it, opening a gap where a second writer could enter.
      return false;
    }
  }

  #caseInsensitiveAt(directoryKey: string, file: string): boolean {
    const probed = probeCaseInsensitive(file);
    if (probed !== undefined) {
      if (this.#caseInsensitive.size < CASE_PROBES_MAX) {
        this.#caseInsensitive.set(directoryKey, probed);
      }
      return probed;
    }
    return this.#caseInsensitive.get(directoryKey) ?? platformCaseInsensitive();
  }
}

// --- Projection ------------------------------------------------------------------

/** Bytes → projection, through the real parser (plan §2 layer 1). `.astro`
 * pages get a page projection, and so — since step 10 — do Markdown and MDX
 * pages, through the Markdown parser; every other document — a chunk, a
 * stylesheet — is opaque (plan §6). Invalid UTF-8 is a parse-error
 * projection, never a lossy decode (plan §3.2). */
export function projectDocument(file: FilePath, bytes: ByteString): Projection {
  const decoded = decodeUtf8(bytes);
  if (!decoded.ok) {
    const diagnostic = { message: decoded.error.message, near: undefined };
    return { tag: 'parse-error', byteLength: bytes.length, diagnostics: [diagnostic] };
  }
  const text = decoded.value;
  const projection = projectText(file, text);
  assert(projection.byteLength === bytes.length, 'The projection measures the bytes it read');
  return projection;
}

function projectText(file: FilePath, text: string): Projection {
  if (/\.astro$/i.test(file)) {
    return projectPage(text, parsePageResult(parsePage(text, { locs: true })));
  }
  if (/\.mdx?$/i.test(file)) {
    const mdx = /\.mdx$/i.test(file);
    return projectPage(text, parsePageResult(parseMarkdownPage(text, { mdx })));
  }
  return projectOpaqueDocument(text);
}

const hashBytes = (bytes: ByteString) => digestOf(bytes);

/** The actor's projector in the app. Snapshots derive their projection when
 * first read (shared/page/snapshot.ts, createLazySnapshot), so a save that only
 * replaces the whole file parses nothing it does not use. A single value
 * splice derives its candidate from the base projection
 * (shared/engine/projectionPatch.ts); the simulator holds that patch to a full
 * reparse on every candidate (plan §10). */
export const NODE_PROJECTOR: Projector = {
  hash: hashBytes,
  snapshot: (file, bytes) => createLazySnapshot({ path: file, bytes }, (own) => projectDocument(file, own), hashBytes),
  candidate: (file: FilePath, base: Snapshot, plan: Plan, bytes: ByteString) => {
    const [splice, ...others] = plan.splices;
    if (splice !== undefined && others.length === 0) {
      if (plan.candidate === 'must-parse') {
        const patched = projectValueSplice(base.projection, base.bytes, splice);
        if (patched !== undefined) {
          return createSnapshot({ path: file, bytes, projection: patched }, hashBytes);
        }
      }
    }
    return createLazySnapshot({ path: file, bytes }, (own) => projectDocument(file, own), hashBytes);
  },
};

// --- Helpers -----------------------------------------------------------------------

export interface LockOwner {
  readonly pid: number;
  readonly host: string;
  readonly token: string;
}

/** Directory identity and a folded filename distinguish equal basenames while
 * making aliases of the same target contend for one lock in shared staging. */
function lockFileOf(target: string): Result<string, { readonly code: 'failed'; readonly message: string }> {
  try {
    const directory = fs.statSync(path.dirname(target));
    const identity = `${directory.dev}:${directory.ino}/${foldCase(path.basename(target))}`;
    const name = digestOf(identity);
    return ok(path.join(atomicDirectoryOf(target), `${LOCK_PREFIX}${name}${LOCK_SUFFIX}`));
  } catch (error: unknown) {
    return err({ code: 'failed', message: translateMain('error.documents.lockLocate', { reason: errorMessage(error) }) });
  }
}

// A lock file is written by another process: parse it, never trust it. Its
// size is checked before the read, so a huge foreign file is never loaded, and
// its text after, since the file can grow in between.
export function readLockOwner(lockFile: string): LockOwner | undefined {
  let raw: string;
  try {
    if (fs.statSync(lockFile).size > LOCK_OWNER_CHARS_MAX) {
      return undefined;
    }
    raw = fs.readFileSync(lockFile, 'utf8');
  } catch {
    return undefined;
  }
  if (raw.length > LOCK_OWNER_CHARS_MAX) {
    return undefined;
  }
  let input: unknown;
  try {
    const parsed: unknown = JSON.parse(raw);
    input = parsed;
  } catch {
    return undefined;
  }
  const record = toRecord(input);
  if (record === undefined) {
    return undefined;
  }
  const pid = record['pid'];
  const host = record['host'];
  const token = record['token'];
  if (typeof pid === 'number' && Number.isSafeInteger(pid)) {
    if (typeof host === 'string' && typeof token === 'string') {
      return { pid, host, token };
    }
  }
  return undefined;
}

export const LOCK_OWNER_CHARS_MAX = 1_024;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return errorCode(error) === 'EPERM'; // It exists; it belongs to another user.
  }
}

/** Whether the directory holding `file` ignores case, when `file` can tell. */
function probeCaseInsensitive(file: string): boolean | undefined {
  const name = path.basename(file);
  const swapped = swapCase(name);
  if (swapped === name) {
    return undefined; // No letters: the name has no other spelling.
  }
  let original: fs.Stats;
  try {
    original = fs.statSync(file);
  } catch {
    return undefined; // Missing: nothing to compare with.
  }
  try {
    const other = fs.statSync(path.join(path.dirname(file), swapped));
    if (other.dev === original.dev) {
      return other.ino === original.ino;
    }
    return false;
  } catch {
    return false;
  }
}

// macOS and Windows format case-insensitive by default; everything else here
// is case-sensitive unless a probe in the directory says otherwise.
function platformCaseInsensitive(): boolean {
  if (process.platform === 'darwin') {
    return true;
  }
  return process.platform === 'win32';
}

function foldCase(name: string): string {
  return name.toLocaleLowerCase('en-US');
}

function swapCase(name: string): string {
  return [...name]
    .map((character) => {
      const lower = character.toLocaleLowerCase('en-US');
      return lower === character ? character.toLocaleUpperCase('en-US') : lower;
    })
    .join('');
}

/** Refuse a write that would land inside node_modules (see header). */
function refuseInstalled(file: string): Result<void, { readonly code: 'failed'; readonly message: string }> {
  const landing = landingOf(file);
  assert(path.isAbsolute(landing), 'A landing path is absolute');
  if (isInstalledFile(file) || isInstalledFile(landing)) {
    const owner = packageOf(landing);
    const what = owner === undefined ? 'is inside node_modules' : `belongs to the installed package ${owner}`;
    return err({
      code: 'failed',
      message:
        `${path.basename(landing)} ${what}, so Stacki will not save it: the next install ` +
        `would replace the change, and the package may be shared with other projects. ` +
        `Edit the package's own source instead.`,
    });
  }
  return ok(undefined);
}

// Where a write to `file` lands: its link followed (atomicWrite.ts), then its
// folder's links. A dangling link or a missing folder keeps the path as
// given; the write itself reports those.
function landingOf(file: string): string {
  const target = writeTargetOf(file);
  const resolved = target.ok ? target.value : path.resolve(file);
  try {
    return path.join(fs.realpathSync.native(path.dirname(resolved)), path.basename(resolved));
  } catch {
    return resolved;
  }
}

function replaceError(error: AtomicWriteError): ReplaceError {
  switch (error.code) {
    case 'filesystem':
    case 'exists':
      return { code: 'failed', message: error.message };
    case 'not-durable':
      return { code: 'not-durable', message: error.message };
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
}
