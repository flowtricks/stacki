// One file's entry in the document host: its actor's state, when it was last
// used, the snapshots it retains, and the commits it remembers; and the
// rewrite that turns a program's text into an intent (documentActors.ts).

import { assert } from '../../shared/core/assert';
import { type Digest } from '../../shared/core/brand';
import { type ActorEffect, type ActorState } from '../../shared/engine/documentActor';
import { type Outcome, type RejectionReason, type SourceEdit } from '../../shared/engine/intent';
import { type CommitRecord } from '../../shared/engine/rebase';
import type { Snapshot } from '../../shared/page/snapshot';
import { LIMITS } from '../../shared/core/limits';
import { err, ok, type Result } from '../../shared/core/result';
import { decodeUtf8, toByteSpan, type ByteString } from '../../shared/core/span';
import { diffCodePatch } from '../../shared/engine/codePatch';
import { type CanonicalDocument } from './documentDisk';
import { type EditBase } from './documentReports';

// One actor and what the host keeps beside it. Its fields change only through the methods
// below, so every write to an actor's record is in one place and checks its bound there.
export class Entry {
  readonly document: CanonicalDocument;
  #state: ActorState;
  #used: number;
  #retained: readonly Snapshot[] = [];
  #log: readonly CommitRecord[] = [];
  #written: Digest | undefined = undefined;

  constructor(document: CanonicalDocument, state: ActorState, used: number) {
    this.document = document;
    this.#state = state;
    this.#used = used;
  }

  get state(): ActorState {
    return this.#state;
  }

  /** The host clock when the actor was last used, for least-recently-used eviction. */
  get used(): number {
    return this.#used;
  }

  /** Snapshots the actor held before its current one, newest last, bounded by
   * LIMITS.authoredSnapshotsMax: the bytes an edit may have been authored
   * against when an outside write replaced them since (step 6). */
  get retained(): readonly Snapshot[] {
    return this.#retained;
  }

  /** The actor's recent commits, oldest first, bounded by
   * LIMITS.commitLogEntriesMax: an edit authored before them rebases exactly. */
  get log(): readonly CommitRecord[] {
    return this.#log;
  }

  /** The checksum of the bytes this actor last wrote, created or committed;
   * undefined until it writes. A watcher tick asks it (plan §11.9). */
  get written(): Digest | undefined {
    return this.#written;
  }

  setState(next: ActorState): void {
    this.#state = next;
  }

  touch(clock: number): void {
    assert(clock >= this.#used, 'The host clock only moves forward');
    this.#used = clock;
  }

  setRetained(retained: readonly Snapshot[]): void {
    assert(retained.length <= LIMITS.authoredSnapshotsMax, 'Retained snapshots are bounded');
    this.#retained = retained;
  }

  recordCreate(checksum: Digest): void {
    this.#written = checksum;
  }

  recordCommit(record: CommitRecord): void {
    this.#log = [...this.#log, record].slice(-LIMITS.commitLogEntriesMax);
    this.#written = record.to;
    assert(this.#log.length <= LIMITS.commitLogEntriesMax, 'The commit log is bounded');
  }
}

/** An outcome with what the host learned beside it. */
export interface Settled {
  readonly outcome: Outcome;
  readonly message: string;
  /** The applied intent's splices, from its commit. */
  readonly committed: Extract<ActorEffect, { tag: 'committed' }> | undefined;
}

/** Steps one intent can take: idle → planned → written → idle. */
export const STEPS_PER_INTENT = 3;

/** What a program's rewrite writes: the text the file should read, and the
 * checksum of the bytes it was computed from. */
export interface Rewrite {
  readonly text: string;
  readonly baseChecksum: Digest;
}

// A rewrite that changes nothing: one empty hunk at the top, so the intent
// names a site (every rewrite does) and the file is written unchanged.
export const UNCHANGED: readonly SourceEdit[] = [{ span: toByteSpan(0, 0), text: '' }];

// The hunks from `bytes` to `text`: the code patch between them (its bounds
// and its coarsening past the diff budget are shared/engine/codePatch.ts's). The
// bytes' own text is the bytes themselves: UNCHANGED.
export function rewriteHunks(bytes: ByteString, text: string): Result<readonly SourceEdit[], RejectionReason> {
  const decoded = decodeUtf8(bytes);
  if (!decoded.ok) {
    return err('write-failed'); // Not text: a writer's text cannot be diffed with it.
  }
  const patch = diffCodePatch(decoded.value, text);
  if (!patch.ok) {
    return err(patch.error);
  }
  if (patch.value.length === 0) {
    return ok(UNCHANGED);
  }
  return ok(patch.value.map((hunk) => ({ span: hunk.span, text: hunk.text })));
}

// What lies between an edit's authored bytes and the bytes on disk now.
export function editHistory(authored: Snapshot, current: Snapshot, chain: readonly CommitRecord[] | undefined): EditBase['history'] {
  if (authored === current) {
    return 'unchanged';
  }
  return chain === undefined ? 'outside' : 'own-commits';
}

// Every byte an actor's entry keeps: its snapshot and the retained ones.
export function entryBytes(entry: Entry): number {
  const current = entry.state.snapshot?.bytes.length ?? 0;
  return entry.retained.reduce((total, snapshot) => total + snapshot.bytes.length, current);
}

// Canonical keys compare by UTF-16 code unit: a total order that does not
// depend on the locale, so every process takes a batch's actors in one order.
export function compareKeys(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left === right ? 0 : 1;
}
