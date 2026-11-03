// The document actor (plan §2 layer 2, §5.2), as pure steps. One actor per
// canonical file. Each call does one unit of the write protocol and returns the
// next state plus what happened; whoever drives it — the simulator's seeded
// scheduler, or the Electron host (electron/documents/documentActors.ts) — decides what
// runs between two steps. Disk I/O, parsing and hashing are injected, so this
// module has no clock, no timer, no promise and no OS (plan §10), and the
// simulator exercises exactly the state machine that ships.
//
//   idle    → read, refresh the snapshot, plan, verify witnesses, apply in
//             memory, re-parse the candidate           (§5.2 steps 1–6)
//   planned → take the advisory lock, re-read, re-verify, atomic replace
//                                                      (§5.2 steps 7–8)
//   written → re-read, verify the checksum, release the lock, commit
//                                                      (§5.2 steps 9–10)
//
// Honest limit, a product contract (plan §5.2): a byte check cannot close the
// kernel's check-to-use race against an uncooperative writer, because no
// portable API offers compare-and-swap on a pathname. The lock excludes only
// cooperating writers (another Stacki). So this actor never knowingly applies an
// intent to stale bytes — it re-reads and re-verifies under the lock — never
// silently remaps an anchor — mapping is the planner's, and ambiguity rejects —
// and reports `write-race` where the OS cannot guarantee atomicity: when the
// bytes read back after the replace are not the candidate's.
//
// The actor never retries and never merges: every accepted intent reaches
// exactly one terminal outcome (plan §3.5), and a rejected one needs a
// deliberate resubmission by the persistence layer.
import { assert } from '../core/assert';
import type { Digest, FilePath } from '../core/brand';
import type { Intent, Outcome, RejectionReason, SubmissionResult } from './intent';
import { LIMITS } from '../core/limits';
import type { Plan, PlanningBase } from './planner';
import { err, ok, type Result } from '../core/result';
import type { Snapshot } from '../page/snapshot';
import type { ByteString } from '../core/span';
import { applySplices, changedRanges, witnessesHold } from './splice';

// --- Injected dependencies -----------------------------------------------------

/** Why a disk call failed. `message` is for the user's notice only: it may name
 * paths, so telemetry never logs it (plan §9a). */
export interface DiskError {
  readonly code: 'missing' | 'failed';
  readonly message: string;
}

export interface DiskRead {
  readonly bytes: ByteString;
  /** An observation stamp, monotonic per disk: a later read of a file never
   * carries a smaller one. The simulator's fake disk stamps each write; the
   * real disk counts its own reads. Invariant 7 is checked against it. */
  readonly generation: number;
}

/** A held advisory lock, returned only by `lock` and consumed by `unlock`. */
export interface DiskLock {
  readonly path: FilePath;
  readonly token: string;
}

export type LockError = { readonly code: 'held'; readonly message: string } | { readonly code: 'failed'; readonly message: string };

/** A replace either left the target untouched (`failed`) or replaced it and
 * cannot promise the replacement survives a power loss (`not-durable`: the
 * directory could not be flushed). The second is the crash window of plan
 * §3.5 made visible, so it reaches the caller as `uncertain`. */
export type ReplaceError = { readonly code: 'failed'; readonly message: string } | { readonly code: 'not-durable'; readonly message: string };

export interface DocumentDisk {
  read(path: FilePath): Result<DiskRead, DiskError>;
  /** Advisory, and only against cooperating writers (the honest limit above). */
  lock(path: FilePath): Result<DiskLock, LockError>;
  unlock(lock: DiskLock): Result<void, DiskError>;
  /** Atomic replace: readers see the old bytes or the new ones, never a mix. */
  replace(path: FilePath, bytes: ByteString): Result<void, ReplaceError>;
}

export type Planner = (base: PlanningBase, intent: Intent) => Result<Plan, RejectionReason>;

/** Bytes → snapshots, through the real parser. Injected because the parser
 * lives in electron/ and SHA-256 in `node:crypto`, neither of which shared/ may
 * import (the renderer loads shared/ too). */
export interface Projector {
  hash(bytes: ByteString): Digest;
  snapshot(path: FilePath, bytes: ByteString): Snapshot;
  /** The candidate after `plan` applied to `base` gives `bytes`. May derive the
   * projection from the base (shared/engine/projectionPatch.ts) instead of parsing. */
  candidate(path: FilePath, base: Snapshot, plan: Plan, bytes: ByteString): Snapshot;
}

export interface ActorDependencies {
  readonly disk: DocumentDisk;
  readonly planner: Planner;
  readonly projector: Projector;
}

// --- State -----------------------------------------------------------------------

/** A queued intent, and the snapshot it was authored against when the client
 * holds one. The renderer holds only a checksum; the simulator (and, from step
 * 6, visual gestures) may send the bytes so a stale intent can be mapped. When
 * absent, the actor's current snapshot serves if its checksum is the authored
 * one; otherwise the authored bytes are gone and the intent rejects (the
 * `lastKnownBytes` decision, tracker open questions). */
export interface Submission {
  readonly intent: Intent;
  readonly authored: Snapshot | undefined;
}

/** An intent between planning and commit, with everything the next step needs. */
export interface InFlight {
  readonly intent: Intent;
  readonly base: Snapshot;
  readonly plan: Plan;
  readonly candidate: Snapshot;
}

export type ActorPhase =
  { readonly tag: 'idle' } | ({ readonly tag: 'planned' } & InFlight) | ({ readonly tag: 'written'; readonly lock: DiskLock } & InFlight);

/** The watcher is a hint (plan §2): it only says "read again before trusting". */
export type WatcherHint = 'clean' | 'dirty';

export interface ActorState {
  readonly path: FilePath;
  readonly snapshot: Snapshot | undefined;
  /** Disk observation stamp the snapshot was read at. */
  readonly generation: number;
  readonly queue: readonly Submission[];
  readonly phase: ActorPhase;
  readonly hint: WatcherHint;
}

export type ActorEffect =
  | { readonly tag: 'outcome'; readonly outcome: Outcome }
  | ({
      readonly tag: 'committed';
      readonly previousGeneration: number;
      readonly generation: number;
    } & InFlight)
  | { readonly tag: 'refreshed'; readonly previousGeneration: number; readonly generation: number }
  /** Why a disk call failed, for the rejection notice; never logged. */
  | { readonly tag: 'disk-error'; readonly intentId: Intent['id']; readonly message: string }
  /** The lock could not be released. The real disk breaks a lock whose owner is
   * gone, so this costs cooperating writers a `write-race`, never a deadlock. */
  | { readonly tag: 'lock-leaked'; readonly path: FilePath };

export interface ActorStep {
  readonly state: ActorState;
  readonly effects: readonly ActorEffect[];
  /** Parses this step ran — bounded by LIMITS.parseTasksInFlightMax. */
  readonly parses: number;
}

export function createActor(path: FilePath): ActorState {
  return {
    path,
    snapshot: undefined,
    generation: 0,
    queue: [],
    phase: { tag: 'idle' },
    hint: 'dirty',
  };
}

// --- Public steps -----------------------------------------------------------------

/** Accept the intent or push back: a full queue is backpressure, not rejection,
 * and never a silent drop — the caller still holds the draft (plan §3.5). */
export function submitIntent(state: ActorState, submission: Submission): { readonly state: ActorState; readonly result: SubmissionResult } {
  const intent = submission.intent;
  assert(intent.file === state.path, 'An intent is submitted to its own file actor');
  if (submission.authored !== undefined) {
    assert(submission.authored.path === intent.file, 'The authored snapshot is of the file');
    assert(submission.authored.checksum === intent.authoredChecksum, 'The authored snapshot is the one the intent names');
  }
  assert(state.queue.length <= LIMITS.intentsPendingMax, 'The queue never exceeds its bound');
  if (state.queue.length < LIMITS.intentsPendingMax) {
    const next = { ...state, queue: [...state.queue, submission] };
    return { state: next, result: { tag: 'accepted', intentId: intent.id } };
  }
  return { state, result: { tag: 'backpressured' } };
}

/** Whether a step would do anything: in-flight work, queued work, or a hint. */
export function actorHasWork(state: ActorState): boolean {
  if (state.phase.tag === 'idle') {
    return state.queue.length > 0 ? true : state.hint === 'dirty';
  }
  return true;
}

/** Whether the actor holds no intent at all: nothing queued, nothing in flight. */
export function actorQuiescent(state: ActorState): boolean {
  if (state.phase.tag === 'idle') {
    return state.queue.length === 0;
  }
  return false;
}

export function markDirty(state: ActorState): ActorState {
  return { ...state, hint: 'dirty' };
}

export function stepActor(state: ActorState, dependencies: ActorDependencies): ActorStep {
  const phase = state.phase;
  switch (phase.tag) {
    case 'idle':
      return stepIdle(state, dependencies);
    case 'planned':
      return stepPlanned(state, phase, dependencies);
    case 'written':
      return stepWritten(state, phase, dependencies);
    default: {
      const exhaustive: never = phase;
      throw new Error(`Unknown actor phase ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Re-read the file now (§5.2 step 1, and the watcher tick of §7: one read and
 * at most one parse). Only an idle actor refreshes; a failed read changes
 * nothing and is returned, so the caller can tell a missing file apart. */
export function refreshActor(state: ActorState, dependencies: ActorDependencies): Result<ActorStep, DiskError> {
  assert(state.phase.tag === 'idle', 'Only an idle actor refreshes');
  const refreshed = refresh(state, dependencies);
  if ('code' in refreshed) {
    return err(refreshed);
  }
  assert(refreshed.step.parses <= 1, 'A refresh parses at most once');
  return ok(refreshed.step);
}

/** A crash (plan §3.5): the in-flight intent becomes `uncertain` with its
 * candidate checksum; queued intents were never planned and become `uncertain`
 * without one. The restarted actor knows nothing and re-reads from disk. A
 * lock held by the crashed actor is not released here — the disk recovers a
 * lock whose owner is gone. */
export function crashActor(state: ActorState): ActorStep {
  const effects: ActorEffect[] = [];
  const phase = state.phase;
  if (phase.tag !== 'idle') {
    const outcome: Outcome = {
      tag: 'uncertain',
      intentId: phase.intent.id,
      candidateChecksum: phase.candidate.checksum,
    };
    effects.push({ tag: 'outcome', outcome });
  }
  for (const { intent } of state.queue) {
    const outcome: Outcome = {
      tag: 'uncertain',
      intentId: intent.id,
      candidateChecksum: undefined,
    };
    effects.push({ tag: 'outcome', outcome });
  }
  assert(effects.length <= LIMITS.intentsPendingMax + 1, 'A crash reports at most the queue');
  return { state: createActor(state.path), effects, parses: 0 };
}

export type Reconciliation = 'applied' | 'not-applied' | 'changed-again';

/** Resolve an `uncertain` outcome by comparison, not by guess (plan §3.5): the
 * file now holds the candidate (applied), still holds the base the intent was
 * planned against — for an unmapped intent, its authored bytes — (not applied),
 * or holds something else, a missing file included, and a person must review
 * it. No intent journal is needed; the candidate checksum is the token that
 * names the crash window. */
export function reconcileUncertain(input: {
  readonly baseChecksum: Digest;
  readonly candidateChecksum: Digest | undefined;
  readonly currentChecksum: Digest | undefined;
}): Reconciliation {
  const current = input.currentChecksum;
  if (current === undefined) {
    return 'changed-again';
  }
  if (current === input.candidateChecksum) {
    return 'applied'; // Checked first: a no-op candidate equals the authored bytes.
  }
  if (current === input.baseChecksum) {
    return 'not-applied';
  }
  assert(current !== input.candidateChecksum, 'Neither the candidate nor the base is on disk');
  return 'changed-again';
}

// --- Steps ------------------------------------------------------------------------

type Refreshed = { readonly state: ActorState; readonly step: ActorStep };

// Read the disk and adopt its bytes as the snapshot when they changed (§5.2
// step 1). The parse is synchronous inside this step, so no newer version can
// arrive while it runs; the generation check is invariant 7 on the producer
// side — a read never goes back, so an older snapshot never replaces a newer.
function refresh(state: ActorState, dependencies: ActorDependencies): Refreshed | DiskError {
  const read = dependencies.disk.read(state.path);
  if (!read.ok) {
    return read.error;
  }
  const generation = read.value.generation;
  assert(generation >= state.generation, 'A disk read never returns an older generation');
  const checksum = dependencies.projector.hash(read.value.bytes);
  if (state.snapshot !== undefined) {
    if (state.snapshot.checksum === checksum) {
      const next: ActorState = { ...state, generation, hint: 'clean' };
      return { state: next, step: { state: next, effects: [], parses: 0 } };
    }
  }
  const snapshot = dependencies.projector.snapshot(state.path, read.value.bytes);
  assert(snapshot.checksum === checksum, 'The snapshot names the bytes just read');
  const next: ActorState = { ...state, snapshot, generation, hint: 'clean' };
  const effect: ActorEffect = {
    tag: 'refreshed',
    previousGeneration: state.generation,
    generation,
  };
  return { state: next, step: { state: next, effects: [effect], parses: 1 } };
}

// The control flow of §5.2 steps 1–6: every rejection is decided here; the
// helpers compute and do not branch on outcomes.
function stepIdle(state: ActorState, dependencies: ActorDependencies): ActorStep {
  const refreshed = refresh(state, dependencies);
  const [submission, ...rest] = state.queue;
  if (submission === undefined) {
    return 'code' in refreshed ? { state, effects: [], parses: 0 } : refreshed.step;
  }
  const intent = submission.intent;
  if ('code' in refreshed) {
    const cause = diskError(intent, refreshed.message);
    return reject({ ...state, queue: rest }, intent, 'write-failed', 0, [cause]);
  }
  const current: ActorState = { ...refreshed.state, queue: rest };
  const base = current.snapshot;
  assert(base !== undefined, 'A successful refresh leaves a snapshot');
  const earlier = refreshed.step.effects;
  const parses = refreshed.step.parses;
  const authored = authoredBase(submission, base);
  if (authored === undefined) {
    return reject(current, intent, staleWithoutBytes(intent), parses, earlier);
  }
  const planned = dependencies.planner({ authored, current: base }, intent);
  if (!planned.ok) {
    return reject(current, intent, planned.error, parses, earlier);
  }
  const plan = planned.value;
  const checked = candidateOf(state.path, base, plan, dependencies.projector);
  if (!checked.ok) {
    return reject(current, intent, checked.error.reason, parses + checked.error.parses, earlier);
  }
  const candidate = checked.value;
  const phase: ActorPhase = { tag: 'planned', intent, base, plan, candidate };
  return { state: { ...current, phase }, effects: earlier, parses: parses + 1 };
}

// The authored snapshot: the one the client sent, or the current one when it
// is the authored one. Undefined when the authored bytes are gone.
function authoredBase(submission: Submission, current: Snapshot): Snapshot | undefined {
  if (submission.authored !== undefined) {
    return submission.authored;
  }
  return current.checksum === submission.intent.authoredChecksum ? current : undefined;
}

// Without the authored bytes no span can be mapped, so a stale intent is
// refused with the reason its operation gives staleness.
function staleWithoutBytes(intent: Intent): RejectionReason {
  const operation = intent.operation;
  switch (operation.tag) {
    case 'rewrite-text':
    case 'revert-splices':
      return 'region-externally-modified';
    case 'apply-code-patch':
      return 'merge-conflict';
    case 'set-attribute':
    case 'remove-attribute':
    case 'insert-node':
    case 'remove-node':
    case 'move-node':
    case 'rename-binding':
    case 'set-inline-style':
    case 'edit-frontmatter-slot':
    case 'rename-tag':
    case 'rename-attribute':
    case 'rewrite-node':
    case 'wrap-nodes':
    case 'append-body':
    case 'insert-frontmatter':
      return 'anchor-moved';
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}

/** The bytes `plan` leaves on `base`, checked as a write would check them
 * (§5.2 steps 4–6): within the splice and size bounds, every witness still on
 * `base`, and, where the plan says so, a candidate that parses with its targets'
 * kinds intact. The actor's step and a batch planned in memory
 * (electron/documents/editPreview.ts) share it, so a batch is held to exactly
 * what each of its edits would be held to alone. `parses` counts the parse a
 * refusal cost. */
export function candidateOf(
  path: FilePath,
  base: Snapshot,
  plan: Plan,
  projector: Pick<ActorDependencies['projector'], 'candidate'>,
): Result<Snapshot, { readonly reason: RejectionReason; readonly parses: 0 | 1 }> {
  assert(base.path === path, 'A candidate is of the file its base is');
  if (plan.splices.length > LIMITS.splicesPerIntentMax) {
    return err({ reason: 'resource-limit', parses: 0 });
  }
  if (!witnessesHold(base.bytes, plan.splices)) {
    return err({ reason: 'region-externally-modified', parses: 0 });
  }
  const bytes = applySplices(base.bytes, plan.splices);
  if (bytes.length > LIMITS.sourceBytesMax) {
    return err({ reason: 'resource-limit', parses: 0 });
  }
  const candidate = projector.candidate(path, base, plan, bytes);
  assert(candidate.bytes === bytes, 'The candidate is the applied bytes');
  if (plan.candidate === 'must-parse') {
    if (candidate.projection.tag === 'parse-error') {
      return err({ reason: 'source-invalid', parses: 1 });
    }
    if (!postKindsHold(candidate, plan)) {
      return err({ reason: 'unsupported-operation', parses: 1 });
    }
  }
  assert(candidate.path === path, 'The candidate is the same file');
  return ok(candidate);
}

// The target is still there, with its expected kind (§5.2 step 6). Until step 8
// this asserted: a candidate without it meant a broken planner. The step-8 long
// run found bytes that reach it with a correct plan: outside edits had left
// comments inside two tags, which the parser reads leniently as attributes, and
// an attribute appended where the planner saw a tag end cut one of them open —
// the candidate still parsed, but the loop around the target now read as code.
// Outside bytes are input, not invariants, so reject a candidate that changes
// the target's syntax kind. The renderer can then try a bounded rewrite.
function postKindsHold(candidate: Snapshot, plan: Plan): boolean {
  const projection = candidate.projection;
  assert(projection.tag === 'valid', 'Post-kinds are checked on a parsing candidate');
  for (const expected of plan.postKinds) {
    const found = projection.nodes.find((node) => {
      if (node.path.length === expected.path.length) {
        return node.path.every((step, index) => step === expected.path[index]);
      }
      return false;
    });
    if (found === undefined) {
      return false;
    }
    if (found.kind !== expected.kind) {
      return false;
    }
  }
  return true;
}

// §5.2 steps 7–8. The lock is taken first, so the re-read and the replace see
// no cooperating writer between them; it stays held through the verifying read
// of the next step and is released there.
function stepPlanned(state: ActorState, phase: Extract<ActorPhase, { tag: 'planned' }>, dependencies: ActorDependencies): ActorStep {
  const disk = dependencies.disk;
  const idle: ActorState = { ...state, phase: { tag: 'idle' }, hint: 'dirty' };
  const intent = phase.intent;
  const locked = disk.lock(state.path);
  if (!locked.ok) {
    const cause = diskError(intent, locked.error.message);
    const reason = locked.error.code === 'held' ? 'write-race' : 'write-failed';
    return reject(idle, intent, reason, 0, [cause]);
  }
  const lock = locked.value;
  assert(lock.path === state.path, 'The lock is on the actor file');
  const read = disk.read(state.path);
  if (!read.ok) {
    const effects = release(disk, lock, [diskError(intent, read.error.message)]);
    return reject(idle, intent, 'write-failed', 0, effects);
  }
  // Re-read before writing (§5.2 step 7): the snapshot may be stale by now.
  // The actor does not re-plan against new bytes; a resubmission does.
  if (dependencies.projector.hash(read.value.bytes) !== phase.base.checksum) {
    return reject(idle, intent, 'region-externally-modified', 0, release(disk, lock, []));
  }
  assert(witnessesHold(read.value.bytes, phase.plan.splices), 'Witnesses hold on re-read bytes');
  const replaced = disk.replace(state.path, phase.candidate.bytes);
  if (!replaced.ok) {
    const effects = release(disk, lock, [diskError(intent, replaced.error.message)]);
    if (replaced.error.code === 'failed') {
      return reject(idle, intent, 'write-failed', 0, effects);
    }
    return uncertain(idle, phase, effects);
  }
  const written: ActorPhase = { ...phase, tag: 'written', lock };
  return { state: { ...state, phase: written }, effects: [], parses: 0 };
}

// §5.2 steps 9–10: verify, release, commit.
function stepWritten(state: ActorState, phase: Extract<ActorPhase, { tag: 'written' }>, dependencies: ActorDependencies): ActorStep {
  const disk = dependencies.disk;
  const idle: ActorState = { ...state, phase: { tag: 'idle' }, hint: 'dirty' };
  const intent = phase.intent;
  const read = disk.read(state.path);
  const released = release(disk, phase.lock, []);
  if (!read.ok) {
    const effects = [...released, diskError(intent, read.error.message)];
    if (read.error.code === 'missing') {
      return reject(idle, intent, 'write-race', 0, effects); // Deleted after our replace.
    }
    return uncertain(idle, phase, effects); // Replaced, and unreadable: nobody knows.
  }
  // Verify (§5.2 step 9): anything but the candidate means another writer won.
  if (dependencies.projector.hash(read.value.bytes) !== phase.candidate.checksum) {
    return reject(idle, intent, 'write-race', 0, released);
  }
  assert(read.value.generation >= state.generation, 'The commit never adopts an older generation');
  const committed: ActorState = {
    ...idle,
    hint: state.hint,
    snapshot: phase.candidate,
    generation: read.value.generation,
  };
  const outcome: Outcome = {
    tag: 'applied',
    intentId: intent.id,
    changedRanges: changedRanges(phase.plan.splices),
    checksum: phase.candidate.checksum,
  };
  const commit: ActorEffect = {
    tag: 'committed',
    previousGeneration: state.generation,
    generation: read.value.generation,
    intent,
    base: phase.base,
    plan: phase.plan,
    candidate: phase.candidate,
  };
  return {
    state: committed,
    effects: [...released, commit, { tag: 'outcome', outcome }],
    parses: 0,
  };
}

function release(disk: DocumentDisk, lock: DiskLock, effects: readonly ActorEffect[]): readonly ActorEffect[] {
  const released = disk.unlock(lock);
  return released.ok ? effects : [...effects, { tag: 'lock-leaked', path: lock.path }];
}

function diskError(intent: Intent, message: string): ActorEffect {
  return { tag: 'disk-error', intentId: intent.id, message };
}

function uncertain(state: ActorState, phase: InFlight, earlier: readonly ActorEffect[]): ActorStep {
  const outcome: Outcome = {
    tag: 'uncertain',
    intentId: phase.intent.id,
    candidateChecksum: phase.candidate.checksum,
  };
  return { state, effects: [...earlier, { tag: 'outcome', outcome }], parses: 0 };
}

function reject(state: ActorState, intent: Intent, reason: RejectionReason, parses: number, earlier: readonly ActorEffect[] = []): ActorStep {
  assert(parses <= LIMITS.parseTasksInFlightMax, 'A step runs at most the parse bound');
  const outcome: Outcome = { tag: 'rejected', intentId: intent.id, reason };
  return { state, effects: [...earlier, { tag: 'outcome', outcome }], parses };
}
