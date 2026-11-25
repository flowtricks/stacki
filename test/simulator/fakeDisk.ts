// Disk I/O behind an interface (plan §10). The document actor reads, locks and
// atomically replaces files only through DocumentDisk (shared/engine/documentActor.ts);
// the simulator hands it this in-memory fake, so no step touches the OS and
// every interleaving is the scheduler's choice. The fake stamps each write with
// a global generation, which is how invariant 7 (never commit an older snapshot
// over a newer one) is checked without trusting the actor's own bookkeeping.
//
// Locks are advisory, as on the real disk: the fake's outside writers ignore
// them (an editor, git), and a cooperating writer (another Stacki) is modelled
// by holding the next lock attempt. A crashed actor's lock is broken by the
// world, as the real disk breaks a lock whose owner process is gone.
import { assert } from '#dist/shared/core/assert.js';
import type { FilePath } from '#dist/shared/core/brand.js';
import type { DiskError, DiskLock, DiskRead, DocumentDisk, LockError, ReplaceError } from '#dist/shared/engine/documentActor.js';
import { err, ok, type Result } from '#dist/shared/core/result.js';
import { toByteString, type ByteString } from '#dist/shared/core/span.js';

export type { DiskRead, DocumentDisk };

/** Files one simulated project holds. */
export const FAKE_DISK_FILES_MAX = 64;

/** How the next actor replace of a file fails. */
export type ReplaceFailure = ReplaceError['code'];

export class FakeDisk implements DocumentDisk {
  private readonly files = new Map<FilePath, DiskRead>();
  private readonly failing = new Map<FilePath, ReplaceFailure>();
  private readonly locks = new Map<FilePath, string>();
  private readonly contended = new Set<FilePath>();
  private generation = 0;
  private lockCount = 0;

  read(path: FilePath): Result<DiskRead, DiskError> {
    const file = this.files.get(path);
    if (file === undefined) {
      return err({ code: 'missing', message: `${path} is missing` });
    }
    assert(file.generation <= this.generation, 'A file generation never runs ahead of the disk');
    return ok(file);
  }

  lock(path: FilePath): Result<DiskLock, LockError> {
    if (this.contended.delete(path)) {
      return err({ code: 'held', message: `${path} is locked by another writer` });
    }
    assert(!this.locks.has(path), 'One actor per file: its lock is never taken twice');
    this.lockCount += 1;
    const token = `lock-${this.lockCount}`;
    this.locks.set(path, token);
    return ok({ path, token });
  }

  unlock(lock: DiskLock): Result<void, DiskError> {
    assert(this.locks.get(lock.path) === lock.token, 'Only the holder releases a lock');
    this.locks.delete(lock.path);
    return ok(undefined);
  }

  replace(path: FilePath, bytes: ByteString): Result<void, ReplaceError> {
    assert(this.locks.has(path), 'The actor replaces a file only under its lock');
    const failure = this.failing.get(path);
    this.failing.delete(path);
    switch (failure) {
      case undefined:
        this.store(path, bytes);
        return ok(undefined);
      case 'failed':
        return err({ code: 'failed', message: `${path} could not be written` });
      case 'not-durable':
        // Replaced, but the directory flush failed: the bytes are there now,
        // and nothing promises they survive a power loss.
        this.store(path, bytes);
        return err({ code: 'not-durable', message: `${path} may not survive a power loss` });
      default: {
        const exhaustive: never = failure;
        return exhaustive;
      }
    }
  }

  /** A write by someone other than the actor: an editor, an AI tool, git. */
  writeExternally(path: FilePath, bytes: ByteString): number {
    return this.store(path, bytes);
  }

  /** The next actor replace of `path` fails this way (disk full, EIO on the
   * directory flush). */
  failNextReplace(path: FilePath, failure: ReplaceFailure): void {
    assert(this.files.has(path), 'Only an existing file can be made to fail');
    this.failing.set(path, failure);
  }

  /** A cooperating writer holds the lock at the next attempt. */
  contendNextLock(path: FilePath): void {
    assert(this.files.has(path), 'Only an existing file is locked');
    this.contended.add(path);
  }

  /** The lock's owner crashed; the next writer breaks it. */
  breakLock(path: FilePath): void {
    assert(this.locks.delete(path), 'Only a held lock is broken');
  }

  lockHeld(path: FilePath): boolean {
    return this.locks.has(path);
  }

  generationOf(path: FilePath): number {
    return this.files.get(path)?.generation ?? 0;
  }

  paths(): readonly FilePath[] {
    return [...this.files.keys()];
  }

  private store(path: FilePath, bytes: ByteString): number {
    if (this.files.has(path)) {
      assert(this.files.size <= FAKE_DISK_FILES_MAX, 'Disk file count stays bounded');
    } else {
      assert(this.files.size < FAKE_DISK_FILES_MAX, 'Disk file count stays bounded');
    }
    this.generation += 1;
    assert(Number.isSafeInteger(this.generation), 'Disk generation stays a safe integer');
    this.files.set(path, { bytes: toByteString(bytes), generation: this.generation });
    return this.generation;
  }
}
