// The document actors of one Electron main process (plan §2 layer 2, §5.2): one
// actor per canonical file, driven by this host. From step 5 every write of
// project text is an intent submitted here, so the actor is the only writer,
// and every `applied` outcome hands the new checksum back for the persistence
// layer to adopt as its next baseline (plan §5.2). Since step 10 every write is
// splices: a page's edits are planned intents, and a program's change to a
// file's text (a stylesheet, a CMS entry, a property batch) is its diff from
// the bytes it read, a `rewrite-text` — no intent replaces a whole file.
//
// Scheduling. Main's IPC handlers run one at a time to completion on one
// thread, and so does this host: a submission is stepped to its terminal
// outcome before the call returns, the actor's steps back to back. That keeps
// the check-to-use window as narrow as the protocol allows and the write order
// the legacy order. The actor's queue is still the bound — a re-entrant or
// deferred submission queues behind the running one, and a full queue answers
// `backpressured` (tests drive the deferred mode to prove it). The actor never
// sees a timer: the only one here is the watcher-tick refresh, injected.
//
// Batches (component:editProperties, plan §3.3): the involved actors are leased
// in sorted canonical order, each file witnessed by its `before` checksum. With
// one thread two batches cannot interleave today; the sorted order is what
// keeps them from deadlocking once acquisition can wait.
import { assert } from '../../shared/core/assert';
import { toIntentId, type Digest } from '../../shared/core/brand';
import {
  actorQuiescent,
  createActor,
  markDirty,
  reconcileUncertain,
  refreshActor,
  stepActor,
  submitIntent,
  type ActorDependencies,
  type ActorEffect,
  type ActorState,
} from '../../shared/engine/documentActor';
import { describeRejection, intentPayloadBytes, toIntent, type Intent, type RejectionReason } from '../../shared/engine/intent';
import { commitChain, minimalSplices, rebaseIntent, type CommitRecord } from '../../shared/engine/rebase';
import type { Snapshot } from '../../shared/page/snapshot';
import { inverseEdits } from '../../shared/engine/splice';
import { LIMITS } from '../../shared/core/limits';
import { err, ok, type Result } from '../../shared/core/result';
import { encodeUtf8, toByteSpan } from '../../shared/core/span';
import { planIntent } from '../../shared/engine/planner';
import { NODE_PROJECTOR, NodeDocumentDisk, type CreateError } from './documentDisk';
import { createDocumentTelemetry } from './documentTelemetry';
import {
  type WriteReport,
  type EditReport,
  type EditBase,
  type EditStatement,
  type BuiltEdit,
  type DocumentActorsOptions,
  type DiskState,
  type CurrentError,
} from './documentReports';
import { translateMain } from '../lib/mainLocale';
import { Entry, type Settled, STEPS_PER_INTENT, type Rewrite, UNCHANGED, rewriteHunks, editHistory, entryBytes, compareKeys } from './documentEntry';

export {
  type WriteReport,
  type EditReport,
  type IntentDraft,
  type EditBase,
  type EditStatement,
  type BuiltEdit,
  type HostDisk,
  type DocumentActorsOptions,
  type DiskState,
  type CurrentError,
} from './documentReports';

/** The app's host: the real disk, the shipping planner, the real parser, and
 * one structured telemetry line per outcome on `log`. */
export function createNodeDocumentActors(input: { readonly log: (line: string) => void; readonly schedule: (task: () => void) => void }): DocumentActors {
  return new DocumentActors({
    disk: new NodeDocumentDisk(),
    projector: NODE_PROJECTOR,
    planner: planIntent,
    telemetry: createDocumentTelemetry(input.log),
    drain: 'immediate',
    schedule: input.schedule,
  });
}

export class DocumentActors {
  readonly #options: DocumentActorsOptions;
  readonly #dependencies: ActorDependencies;
  readonly #entries = new Map<string, Entry>();
  readonly #leased = new Set<string>();
  readonly #dirty = new Set<string>();
  #intents = 0;
  #clock = 0;
  #refreshScheduled = false;

  constructor(options: DocumentActorsOptions) {
    this.#options = options;
    this.#dependencies = {
      disk: options.disk,
      planner: options.planner,
      projector: options.projector,
    };
  }

  /** A program's change to a file's text (plan §3.4; step 10): `text` is what
   * the file should read, computed from the bytes of `baseChecksum`. Written
   * as the hunks where the two differ — a `rewrite-text`, never a whole-file
   * replacement — and only while the file holds exactly those bytes; anything
   * else is refused, never merged. Text that equals the file's is written
   * again unchanged. */
  writeText(file: string, text: string, baseChecksum: Digest): WriteReport {
    const entry = this.#entry(file);
    if (!entry.ok) {
      return {
        tag: 'rejected',
        reason: 'write-failed',
        message: entry.error,
        diskChecksum: undefined,
      };
    }
    return this.#submitRewrite(entry.value, { text, baseChecksum });
  }

  /** A visual edit (step 6): `build` states it as an intent against the
   * snapshot the renderer authored it against — the current one, or one the
   * host retained. An edit authored before the actor's own recent commits is
   * rebased through them exactly; one authored before an outside write is
   * submitted with its authored snapshot and mapped through the diff by the
   * planner. Without the authored bytes, it is refused: never guessed. */
  submitEdit(file: string, stated: EditStatement, build: (base: EditBase) => Result<BuiltEdit, RejectionReason>): EditReport {
    assert(this.#options.drain === 'immediate', 'A deferred host takes submitDeferred');
    const entry = this.#entry(file);
    if (!entry.ok) {
      return {
        tag: 'rejected',
        reason: 'write-failed',
        message: entry.error,
        diskChecksum: undefined,
      };
    }
    const current = this.#current(entry.value);
    if (!current.ok) {
      return {
        tag: 'rejected',
        reason: 'write-failed',
        message: current.error.message,
        diskChecksum: undefined,
      };
    }
    const submission = this.#editSubmission(entry.value, stated, build);
    if (!submission.ok) {
      const reason = submission.error;
      return {
        tag: 'rejected',
        reason,
        message: describeRejection(reason),
        diskChecksum: current.value,
      };
    }
    const intent = submission.value.intent;
    if (this.#enqueue(entry.value, intent, submission.value.authored) === 'backpressured') {
      return { tag: 'backpressured' };
    }
    const settled = this.#settle(entry.value).get(intent.id);
    assert(settled !== undefined, 'A settled actor reported the intent it accepted');
    if (settled.outcome.tag === 'applied') {
      const commit = settled.committed;
      assert(commit !== undefined, 'An applied intent was committed');
      return {
        tag: 'applied',
        checksum: settled.outcome.checksum,
        bytes: commit.candidate.bytes,
        inverse: inverseEdits(commit.plan.splices),
      };
    }
    const report = this.#report(entry.value, intent, settled);
    assert(report.tag !== 'applied', 'Only an applied outcome is reported as applied');
    return report;
  }

  /** The bytes on disk now and their checksum, through the file's actor
   * (§5.2 step 1). The bytes are the actor's snapshot: read-only. */
  current(file: string): Result<DiskState, CurrentError> {
    const entry = this.#entry(file);
    if (!entry.ok) {
      return err({ code: 'failed', message: entry.error });
    }
    const current = this.#current(entry.value);
    if (!current.ok) {
      return current;
    }
    const snapshot = entry.value.state.snapshot;
    assert(snapshot?.checksum === current.value, 'The answer is the refreshed snapshot');
    return ok({ checksum: snapshot.checksum, bytes: snapshot.bytes });
  }

  /** Writers that never named a base (the style panel's stylesheet save, a
   * code window, a CMS or asset edit into a page): the base is the file as it
   * is now, so the diff is of those bytes and the actor still refuses to write
   * over bytes that change under it; a missing file is created, never
   * overwritten. */
  writeCurrent(file: string, text: string): WriteReport {
    const entry = this.#entry(file);
    if (!entry.ok) {
      return {
        tag: 'rejected',
        reason: 'write-failed',
        message: entry.error,
        diskChecksum: undefined,
      };
    }
    const current = this.#current(entry.value);
    if (current.ok) {
      return this.#submitRewrite(entry.value, { text, baseChecksum: current.value });
    }
    if (current.error.code === 'missing') {
      return this.#create(entry.value, text);
    }
    return {
      tag: 'rejected',
      reason: 'write-failed',
      message: current.error.message,
      diskChecksum: undefined,
    };
  }

  /** A new document: never overwrites anything (documentDisk.ts). */
  create(file: string, text: string): Result<Digest, CreateError> {
    const entry = this.#entry(file);
    if (!entry.ok) {
      return err({ code: 'failed', message: entry.error });
    }
    const created = this.#create(entry.value, text);
    switch (created.tag) {
      case 'applied':
        return ok(created.checksum);
      case 'rejected':
        return err({
          code: created.reason === 'region-externally-modified' ? 'exists' : 'failed',
          message: created.message,
        });
      case 'uncertain':
      case 'backpressured':
        return err({ code: 'failed', message: translateMain('error.documents.createFailed', { file }) });
      default: {
        const exhaustive: never = created;
        return exhaustive;
      }
    }
  }

  /** Lease the actors of `items`' files in sorted canonical order and run
   * `run` with the items in that order; every write inside goes through those
   * actors, and no other intent reaches them until `run` returns. */
  withLeases<Item extends { readonly file: string }, T>(items: readonly Item[], run: (ordered: readonly Item[]) => T): Result<T, string> {
    assert(items.length <= LIMITS.documentActorsMax, 'A batch fits in the actor bound');
    const named: { readonly item: Item; readonly key: string }[] = [];
    for (const item of items) {
      const document = this.#options.disk.canonical(item.file);
      if (!document.ok) {
        return err(document.error);
      }
      named.push({ item, key: document.value.key });
    }
    const ordered = named.sort((left, right) => compareKeys(left.key, right.key));
    const keys = ordered.map((lease) => lease.key);
    assert(new Set(keys).size === keys.length, 'A batch names each file once');
    // Each actor is leased as it is taken, so taking the next one can never
    // evict one already held (eviction skips leased actors).
    for (const { item, key } of ordered) {
      const entry = this.#entry(item.file);
      if (!entry.ok) {
        for (const held of keys) {
          this.#leased.delete(held);
        }
        return err(entry.error);
      }
      assert(entry.value.document.key === key, 'The actor taken is the one named');
      assert(!this.#leased.has(key), 'An actor is leased by one batch at a time');
      assert(actorQuiescent(entry.value.state), 'A leased actor holds no other intent');
      this.#leased.add(key);
      this.#options.onLease?.(entry.value.document.path);
    }
    try {
      return ok(run(ordered.map((lease) => lease.item)));
    } finally {
      for (const key of keys) {
        this.#leased.delete(key);
      }
    }
  }

  /** Whether a watcher tick for `file` is this host hearing its own write
   * (plan §11.9): the file holds exactly the bytes its actor last wrote. One
   * read per tick, no clock — an outside write a millisecond later holds other
   * bytes, and a file gone since holds none. A file whose actor was dropped
   * (LIMITS.documentActorsMax) is answered `false`: the tick is then treated
   * as an outside change, whose one read finds the bytes the app already has. */
  echoes(file: string): boolean {
    const document = this.#options.disk.canonical(file);
    if (!document.ok) {
      return false; // Its folder is gone: whatever happened, it was not a write of ours.
    }
    const written = this.#entries.get(document.value.key)?.written;
    if (written === undefined) {
      return false;
    }
    const read = this.#options.disk.read(document.value.path);
    if (!read.ok) {
      return false;
    }
    return this.#options.projector.hash(read.value.bytes) === written;
  }

  /** The watcher saw an outside change (plan §7): a hint, not an authority.
   * The actor re-reads on the next tick, off the next intent's path. */
  noteExternalChange(file: string): void {
    const document = this.#options.disk.canonical(file);
    if (!document.ok) {
      return; // Gone with its folder: the next intent reports it.
    }
    const entry = this.#entries.get(document.value.key);
    if (entry === undefined) {
      return; // No actor, no snapshot to refresh.
    }
    entry.setState(markDirty(entry.state));
    if (this.#dirty.size < LIMITS.watcherFilesPerTickMax) {
      this.#dirty.add(document.value.key);
    }
    if (!this.#refreshScheduled) {
      this.#refreshScheduled = true;
      this.#options.schedule(() => this.#refreshDirty());
    }
  }

  /** Step every queued intent to its outcome (the deferred mode's drain). */
  drain(): void {
    for (const entry of this.#entries.values()) {
      this.#settle(entry);
    }
  }

  /** Whether no actor holds an intent: nothing queued, nothing in flight. */
  quiescent(): boolean {
    return [...this.#entries.values()].every((entry) => actorQuiescent(entry.state));
  }

  /** Forget every actor (the project closed). Only snapshots are dropped. */
  clear(): void {
    assert(this.quiescent(), 'A project closes with no intent in flight');
    assert(this.#leased.size === 0, 'A project closes with no batch running');
    this.#entries.clear();
    this.#dirty.clear();
  }

  actorCount(): number {
    return this.#entries.size;
  }

  /** Submit an intent without stepping it: the deferred mode's entry point. */
  submitDeferred(file: string, text: string, baseChecksum: Digest): 'accepted' | 'backpressured' {
    assert(this.#options.drain === 'deferred', 'Only a deferred host queues without stepping');
    const entry = this.#entry(file);
    assert(entry.ok, 'A deferred submission names an available file');
    const intent = this.#rewriteIntent(entry.value, { text, baseChecksum });
    assert(intent.ok, 'A deferred submission names text the host can diff');
    return this.#enqueue(entry.value, intent.value);
  }

  // --- Internal -----------------------------------------------------------------

  #submitRewrite(entry: Entry, rewrite: Rewrite): WriteReport {
    assert(this.#options.drain === 'immediate', 'A deferred host takes submitDeferred');
    const built = this.#rewriteIntent(entry, rewrite);
    if (!built.ok) {
      const current = entry.state.snapshot?.checksum;
      const reason = built.error;
      return { tag: 'rejected', reason, message: describeRejection(reason), diskChecksum: current };
    }
    const intent = built.value;
    const submitted = this.#enqueue(entry, intent);
    if (submitted === 'backpressured') {
      return { tag: 'backpressured' };
    }
    const outcomes = this.#settle(entry);
    const outcome = outcomes.get(intent.id);
    assert(outcome !== undefined, 'A settled actor reported the intent it accepted');
    return this.#report(entry, intent, outcome);
  }

  // The intent an edit becomes against the bytes on disk now, and the
  // snapshot to map it from when it is stale.
  #editSubmission(
    entry: Entry,
    stated: EditStatement,
    build: (base: EditBase) => Result<BuiltEdit, RejectionReason>,
  ): Result<{ readonly intent: Intent; readonly authored: Snapshot | undefined }, RejectionReason> {
    const { authoredChecksum } = stated;
    const current = entry.state.snapshot;
    assert(current !== undefined, 'A refreshed actor holds a snapshot');
    const authored = current.checksum === authoredChecksum ? current : entry.retained.find((snapshot) => snapshot.checksum === authoredChecksum);
    if (authored === undefined) {
      return err(stated.gone); // The authored bytes are gone: re-read, never guess.
    }
    const chain = authored === current ? [] : commitChain(entry.log, authoredChecksum, current.checksum);
    const history = editHistory(authored, current, chain);
    const built = build({ authored, current, history });
    if (!built.ok) {
      return built;
    }
    this.#intents += 1;
    assert(Number.isSafeInteger(this.#intents), 'Intent ids stay safe integers');
    // The payload bound (plan §8) is an expected failure here, not a throw:
    // a code patch as large as a file is the user's input, never truncated.
    const payloadBytes = intentPayloadBytes(built.value.draft.operation);
    if (payloadBytes > LIMITS.intentPayloadBytesMax) {
      return err('resource-limit');
    }
    const basis = built.value.basis === 'current' ? current : authored;
    const intent = toIntent({
      id: toIntentId(`main-${this.#intents}`),
      file: entry.document.path,
      authoredChecksum: basis.checksum,
      ...built.value.draft,
    });
    if (basis === current) {
      return ok({ intent, authored: undefined });
    }
    if (chain === undefined) {
      return ok({ intent, authored }); // An outside write between: the planner maps.
    }
    assert(chain.length > 0, 'Own commits between the snapshots form a chain');
    const rebased = rebaseIntent(intent, chain, current);
    return rebased.ok ? ok({ intent: rebased.value, authored: undefined }) : rebased;
  }

  #enqueue(entry: Entry, intent: Intent, authored: Snapshot | undefined = undefined): 'accepted' | 'backpressured' {
    const submitted = submitIntent(entry.state, { intent, authored });
    entry.setState(submitted.state);
    if (submitted.result.tag === 'backpressured') {
      this.#options.telemetry.record(entry.document.path, { tag: 'backpressured' });
      return 'backpressured';
    }
    assert(submitted.result.intentId === intent.id, 'The actor accepted this intent');
    return 'accepted';
  }

  // The rewrite as an intent against the base: the hunks from its bytes to the
  // text. When the disk no longer holds the base, there are no bytes to diff:
  // the intent names the UNCHANGED hunk and a whole-file span of no length, and
  // the planner refuses it as stale before it reads either (planRewriteText
  // checks the checksum first). A base that is not UTF-8 is not text a writer may
  // diff (write-failed); a diff past the payload bound is a resource limit.
  #rewriteIntent(entry: Entry, rewrite: Rewrite): Result<Intent, RejectionReason> {
    const { text, baseChecksum } = rewrite;
    if (entry.state.snapshot?.checksum !== baseChecksum) {
      if (actorQuiescent(entry.state)) {
        // Learn the base if the disk still holds it; a failed read is the
        // actor's to report, on its own read.
        this.#current(entry);
      }
    }
    const snapshot = entry.state.snapshot;
    const base = snapshot?.checksum === baseChecksum ? snapshot : undefined;
    const hunks = base === undefined ? ok(UNCHANGED) : rewriteHunks(base.bytes, text);
    if (!hunks.ok) {
      return hunks;
    }
    this.#intents += 1;
    assert(Number.isSafeInteger(this.#intents), 'Intent ids stay safe integers');
    const length = base === undefined ? 0 : base.bytes.length;
    return ok(
      toIntent({
        id: toIntentId(`main-${this.#intents}`),
        file: entry.document.path,
        authoredChecksum: baseChecksum,
        anchor: { span: toByteSpan(0, length), path: [], expectedKind: 'document' },
        operation: { tag: 'rewrite-text', hunks: hunks.value },
      }),
    );
  }

  // Step until the actor holds nothing, and collect every outcome. The bound is
  // the queue bound times the steps one intent takes, plus one refresh.
  #settle(entry: Entry): Map<string, Settled> {
    const outcomes = new Map<string, Settled>();
    const messages = new Map<string, string>();
    const commits = new Map<string, Extract<ActorEffect, { tag: 'committed' }>>();
    const stepsMax = (LIMITS.intentsPendingMax + 1) * STEPS_PER_INTENT + 1;
    for (let step = 0; step < stepsMax; step++) {
      if (actorQuiescent(entry.state)) {
        return outcomes;
      }
      const result = stepActor(entry.state, this.#dependencies);
      assert(result.parses <= LIMITS.parseTasksInFlightMax, 'A step parses within its bound');
      this.#adopt(entry, result.state);
      for (const effect of result.effects) {
        this.#absorb(entry, effect, { outcomes, messages, commits });
      }
    }
    throw new Error(`Assertion failed: the actor settles within ${stepsMax} steps`);
  }

  #absorb(
    entry: Entry,
    effect: ActorEffect,
    seen: {
      readonly outcomes: Map<string, Settled>;
      readonly messages: Map<string, string>;
      readonly commits: Map<string, Extract<ActorEffect, { tag: 'committed' }>>;
    },
  ): void {
    switch (effect.tag) {
      case 'outcome': {
        const id = effect.outcome.intentId;
        this.#options.telemetry.record(entry.document.path, effect);
        seen.outcomes.set(id, {
          outcome: effect.outcome,
          message: seen.messages.get(id) ?? '',
          committed: seen.commits.get(id),
        });
        return;
      }
      case 'disk-error':
        seen.messages.set(effect.intentId, effect.message);
        return;
      case 'lock-leaked':
        this.#options.telemetry.record(entry.document.path, { tag: 'lock-leaked' });
        return;
      case 'committed':
        seen.commits.set(effect.intent.id, effect);
        this.#logCommit(entry, effect);
        return;
      case 'refreshed':
        return;
      default: {
        const exhaustive: never = effect;
        throw new Error(`Unknown actor effect ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  #report(entry: Entry, intent: Intent, settled: Settled): WriteReport {
    const { outcome, message } = settled;
    switch (outcome.tag) {
      case 'applied': {
        assert(entry.state.snapshot?.checksum === outcome.checksum, 'The commit is the snapshot');
        const commit = settled.committed;
        assert(commit !== undefined, 'An applied intent was committed');
        // A replacement of bytes with the same bytes changes nothing: no hunk.
        const changed = minimalSplices(commit.plan.splices).filter((splice) => splice.range.start < splice.range.end || splice.replacementBytes.length > 0);
        return { tag: 'applied', checksum: outcome.checksum, inverse: inverseEdits(changed) };
      }
      case 'rejected': {
        const disk = this.#current(entry);
        const diskChecksum = disk.ok ? disk.value : undefined;
        return { tag: 'rejected', reason: outcome.reason, message, diskChecksum };
      }
      case 'uncertain': {
        const disk = this.#current(entry);
        const reconciliation = disk.ok
          ? reconcileUncertain({
              baseChecksum: intent.authoredChecksum,
              candidateChecksum: outcome.candidateChecksum,
              currentChecksum: disk.value,
            })
          : undefined;
        const candidateChecksum = outcome.candidateChecksum;
        return { tag: 'uncertain', message, candidateChecksum, reconciliation };
      }
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  }

  // What the disk holds now, through the idle actor (§5.2 step 1).
  #current(entry: Entry): Result<Digest, CurrentError> {
    assert(actorQuiescent(entry.state), 'Only an idle actor answers what the disk holds');
    const refreshed = refreshActor(entry.state, this.#dependencies);
    if (!refreshed.ok) {
      return err(refreshed.error);
    }
    this.#adopt(entry, refreshed.value.state);
    const snapshot = entry.state.snapshot;
    assert(snapshot !== undefined, 'A refresh after a good read holds a snapshot');
    return ok(snapshot.checksum);
  }

  #create(entry: Entry, text: string): WriteReport {
    const bytes = encodeUtf8(text);
    const created = this.#options.disk.create(entry.document.path, bytes);
    if (!created.ok) {
      const reason = created.error.code === 'exists' ? 'region-externally-modified' : 'write-failed';
      return { tag: 'rejected', reason, message: created.error.message, diskChecksum: undefined };
    }
    const current = this.#current(entry);
    if (!current.ok) {
      return {
        tag: 'rejected',
        reason: 'write-race',
        message: current.error.message,
        diskChecksum: undefined,
      };
    }
    const checksum = this.#options.projector.hash(bytes);
    if (current.value !== checksum) {
      return {
        tag: 'rejected',
        reason: 'write-race',
        message: translateMain('error.documents.createRaced', { file: entry.document.path }),
        diskChecksum: current.value,
      };
    }
    entry.recordCreate(checksum);
    return { tag: 'applied', checksum, inverse: [] };
  }

  #entry(file: string): Result<Entry, string> {
    const document = this.#options.disk.canonical(file);
    if (!document.ok) {
      return document;
    }
    this.#clock += 1;
    const existing = this.#entries.get(document.value.key);
    if (existing !== undefined) {
      if (existing.document.path === document.value.path) {
        existing.touch(this.#clock);
        return ok(existing);
      }
      // One key, another path: a case variant of the name on a case-insensitive
      // disk, or a deleted directory whose inode number was reused. The idle
      // actor holds only a cached snapshot, so it is replaced, never trusted.
      assert(actorQuiescent(existing.state), 'An actor is replaced only when idle');
      assert(!this.#leased.has(document.value.key), 'A leased actor keeps its path');
      this.#entries.delete(document.value.key);
    }
    this.#evict();
    const entry = new Entry(document.value, createActor(document.value.path), this.#clock);
    this.#entries.set(document.value.key, entry);
    assert(this.#entries.size <= LIMITS.documentActorsMax, 'The actor count stays inside its bound');
    return ok(entry);
  }

  // Drop the least recently used idle actors until one more fits both bounds.
  // An actor holds nothing but its snapshot between intents, so dropping one
  // loses no state: it re-reads the disk on its next intent.
  #evict(): void {
    const idle = [...this.#entries.entries()]
      .filter(([key, entry]) => actorQuiescent(entry.state) && !this.#leased.has(key))
      .sort(([, left], [, right]) => left.used - right.used);
    let retained = this.#retainedBytes();
    for (const [key, entry] of idle) {
      const underCount = this.#entries.size < LIMITS.documentActorsMax;
      if (underCount && retained <= LIMITS.documentBytesRetainedMax) {
        return;
      }
      retained -= entryBytes(entry);
      this.#entries.delete(key);
      this.#dirty.delete(key);
    }
    assert(this.#entries.size < LIMITS.documentActorsMax, 'Eviction makes room for one actor');
  }

  #retainedBytes(): number {
    let total = 0;
    for (const entry of this.#entries.values()) {
      total += entryBytes(entry);
    }
    return total;
  }

  // Take the actor's next state; the snapshot it replaces is retained, so an
  // edit authored against it can still be mapped (LIMITS.authoredSnapshotsMax).
  #adopt(entry: Entry, next: ActorState): void {
    const previous = entry.state.snapshot;
    entry.setState(next);
    if (previous === undefined) {
      return;
    }
    if (previous.checksum === next.snapshot?.checksum) {
      return;
    }
    const retained = [...entry.retained.filter((snapshot) => snapshot.checksum !== previous.checksum), previous].slice(-LIMITS.authoredSnapshotsMax);
    // Oldest first out, until the bytes fit too; the loop ends because each
    // pass drops one snapshot.
    let bytes = retained.reduce((total, snapshot) => total + snapshot.bytes.length, 0);
    while (bytes > LIMITS.authoredBytesRetainedMax) {
      const oldest = retained.shift();
      assert(oldest !== undefined, 'Bytes over the bound come from some snapshot');
      bytes -= oldest.bytes.length;
    }
    entry.setRetained(retained);
    assert(entry.retained === retained, 'The entry keeps the snapshots it was given');
  }

  #logCommit(entry: Entry, commit: Extract<ActorEffect, { tag: 'committed' }>): void {
    const record: CommitRecord = {
      from: commit.base.checksum,
      to: commit.candidate.checksum,
      splices: minimalSplices(commit.plan.splices),
      relocation: commit.plan.relocation,
    };
    entry.recordCommit(record);
    assert(entry.written === record.to, 'The commit is what the actor last wrote');
    assert(entry.state.snapshot?.checksum === record.to, 'The commit is the actor snapshot');
  }

  #refreshDirty(): void {
    this.#refreshScheduled = false;
    assert(this.#dirty.size <= LIMITS.watcherFilesPerTickMax, 'Watcher work per tick is bounded');
    for (const key of this.#dirty) {
      const entry = this.#entries.get(key);
      if (entry !== undefined) {
        if (actorQuiescent(entry.state)) {
          // A failed read leaves the snapshot; the next intent reports it.
          const refreshed = refreshActor(entry.state, this.#dependencies);
          if (refreshed.ok) {
            this.#adopt(entry, refreshed.value.state);
          }
        }
      }
    }
    this.#dirty.clear();
  }
}
