// The deterministic simulation (plan §10). One World holds a fake disk, one
// actor per file, and the client's view of each file. Every step the seeded
// PRNG picks one event — a visual intent, a stale preview intent, a Markdown
// block intent (step 10: text typed, a block or item removed, inserted or
// moved) fresh or from a stale preview, an oracle gesture, a code-editor save
// (a patch, since step 8, often leaving the file invalid), a program's text
// rewrite (step 10's `rewrite-text`), an external manual edit, a pasted copy of
// a line, an attribute added in another editor, an AI-style rewrite, a
// git-style atomic replacement, a watcher tick, an actor step, a crash, a disk
// failure, a submission burst — applies it, and checks the invariants.
//
// Determinism is structural, not careful: the scheduler is the only source of
// order, the PRNG the only source of choice, the disk is in memory, and there
// is no timer, promise or clock anywhere under test/simulator/ (the lint gate
// enforces that). The trace of one seed is therefore a pure function of the
// seed and the fixtures, and its digest proves it (invariant 9).
//
// From step 3 the actor plans set-attribute with the shipping planner, mapped
// through the diff when the intent is stale (enginePlanner.ts). Every writer
// here also records where each byte came from (provenance.ts), and every stale
// set-attribute decision is judged against those origins (remapJudge.ts): a
// plan at any other element than the one the authored element became fails the
// run (`wrongSite: 'fail'`, the gate) or is counted (`'count'`, the spike
// report). The judgements are tallied per file.
import { createHash } from 'node:crypto';
import { assert } from '#dist/shared/core/assert.js';
import { toFilePath, toIntentId, type Digest, type FilePath } from '#dist/shared/core/brand.js';
import { toIntent, type Intent, type Operation, type Outcome, type RejectionReason, type SourceEdit } from '#dist/shared/engine/intent.js';
import { changedRanges, inverseEdits, orderedSplices } from '#dist/shared/engine/splice.js';
import { diffCodePatch } from '#dist/shared/engine/codePatch.js';
import { LIMITS } from '#dist/shared/core/limits.js';
import { toAnchorRef, toChildIndex } from '#dist/shared/page/ref.js';
import type { Snapshot } from '#dist/shared/page/snapshot.js';
import type { ProjectedNode } from '#dist/shared/page/sourceProjection.js';
import { type ByteString, decodeUtf8, encodeUtf8, toByteSpan, toByteString, utf8ByteLength } from '#dist/shared/core/span.js';
import {
  actorHasWork,
  crashActor,
  createActor,
  markDirty,
  reconcileUncertain,
  stepActor,
  submitIntent,
  type ActorDependencies,
  type ActorEffect,
  type ActorState,
  type ActorStep,
  type Submission,
} from '#dist/shared/engine/documentActor.js';
import { SIMULATOR_PROJECTOR } from './candidate.ts';
import { planEngine } from './enginePlanner.ts';
import { FakeDisk } from './fakeDisk.ts';
import { checkBounds, checkCommitted, checkGeneration, checkOutcome, checkQuiescent } from './invariants.ts';
import { oracleIntent, oracleSplices } from './oracleIntent.ts';
import { ORACLE_SCENARIOS, type OracleScenario } from './oracles.ts';
import { Prng } from './prng.ts';
import { sha256, snapshotOf } from './project.ts';
import { OriginSource, insertOrigins, lineEndingOrigins, moveOrigins, restoreOrigins, spliceOrigins, type Origins } from './provenance.ts';
import { checkMappingReference, judgeBlockRemap, judgeOracleRemap, judgeRemap, type RemapDecision, type RemapVerdict } from './remapJudge.ts';

export interface SimulationFile {
  /** Fixture name; the file lives at `/project/<name>` on the fake disk. */
  readonly name: string;
  readonly text: string;
}

export interface SimulationInput {
  readonly seed: number;
  readonly steps: number;
  /** A judged wrong-site plan fails the run at the event (`fail`, the gate), or
   * is counted and logged so a report can measure how often it happens. */
  readonly wrongSite: 'fail' | 'count';
  readonly files: readonly SimulationFile[];
  /** Whole-file versions git may swap in for a file (a checkout, a revert). */
  readonly alternates: ReadonlyMap<string, readonly string[]>;
}

export interface SimulationReport {
  readonly digest: string;
  readonly trace: readonly string[];
  readonly tally: Readonly<Record<string, number>>;
}

/** Steps one run may take; a nightly run raises the seed count, not this. */
export const SIMULATION_STEPS_MAX = 100_000;
/** Client-side snapshots kept per file, for authoring stale preview intents. */
const HISTORY_MAX = 8;
/** Disk versions whose byte origins a run keeps; older ones judge `unjudged`. */
const ORIGINS_RETAINED_MAX = 512;
/** Snapshots per file whose checksums the run remembers the actor holding. */
const HELD_MAX = 16;
/** Writes whose replaced origins wait for their commit (a crash never commits). */
const REPLACED_RETAINED_MAX = 64;
/** Applied edits the run can undo (step 6): the most recent ones. */
const UNDOABLE_MAX = 8;

/** An applied edit and what Undo needs: its inverse, the bytes it left, and
 * the origins of the bytes it wrote — the only bytes a revert may replace. */
interface Undoable {
  readonly file: FilePath;
  readonly view: View;
  readonly inverse: readonly SourceEdit[];
  readonly written: ReadonlySet<number>;
  /** The origins of the bytes the edit replaced, per splice in order: its
   * inverse writes exactly those bytes back, so they get their origins back —
   * a removed block restored, a moved one returned, is the same block. */
  readonly restores: readonly Origins[] | undefined;
}

/** A snapshot as the client saw it, with the disk generation it was read at. */
interface View {
  readonly snapshot: Snapshot;
  readonly generation: number;
}

const EVENTS = [
  ['actor-step', 30],
  ['visual-intent', 12],
  ['watcher-tick', 8],
  ['oracle-gesture', 6],
  ['external-edit', 6],
  ['preview-intent', 5],
  ['markdown-intent', 8],
  ['markdown-preview', 4],
  ['copy-paste', 3],
  ['attribute-append', 3],
  ['code-save', 4],
  ['program-write', 2],
  ['git-replace', 3],
  ['ai-rewrite', 2],
  ['crash', 1],
  ['write-failure', 1],
  ['lock-contended', 1],
  ['burst', 1],
  ['undo', 4],
] as const;

type EventKind = (typeof EVENTS)[number][0];
const EVENT_WEIGHT_TOTAL = EVENTS.reduce((total, [, weight]) => total + weight, 0);

const ATTRIBUTE_VALUES = ['New', 'café 🎉', 'two words', '', 'quote"breaks'] as const;

export function runSimulation(input: SimulationInput): SimulationReport {
  assert(input.steps <= SIMULATION_STEPS_MAX, 'Simulation steps are bounded');
  assert(input.files.length > 0, 'A simulation needs at least one file');
  const world = new World(input);
  for (let step = 0; step < input.steps; step++) {
    world.step(step);
  }
  world.drain();
  return world.report();
}

class World {
  private readonly prng: Prng;
  private readonly disk = new FakeDisk();
  // The shipped actor (shared/engine/documentActor.ts), on the fake disk.
  private readonly dependencies: ActorDependencies = {
    disk: this.disk,
    planner: planEngine,
    projector: SIMULATOR_PROJECTOR,
  };
  private readonly actors = new Map<FilePath, ActorState>();
  private readonly accepted = new Map<string, Intent>();
  private readonly terminal = new Map<string, Outcome>();
  private readonly history = new Map<FilePath, View[]>();
  private readonly gestures = new Map<string, { scenario: OracleScenario; next: number }>();
  private readonly inputs = new Map<string, Digest>();
  private readonly watched = new Set<FilePath>();
  private readonly trace: string[] = [];
  private readonly tally: Record<string, number> = {};
  private readonly input: SimulationInput;
  // Ground truth for remapped intents: byte origins per disk generation, the
  // generations at which git replaced a file whole, the generation each intent
  // was authored at, and the checksums each actor has held.
  private readonly origins = new Map<number, Origins>();
  private readonly originSource = new OriginSource();
  private readonly replacedWhole = new Map<FilePath, number[]>();
  // Step 8: generations a code patch wrote whose hunks could slide along equal
  // bytes (see slidable): which copy of a repeated run the user removed or
  // typed beside is not in the bytes, so origins after it are not ground truth.
  private readonly slidPatches = new Map<FilePath, number[]>();
  private readonly authoredAt = new Map<string, number>();
  private readonly held = new Map<FilePath, Digest[]>();
  // Step 6: applied edits Undo may revert, and the reverts in flight.
  private undoable: Undoable[] = [];
  private readonly undoing = new Map<string, Undoable>();
  // Step 8: code-editor saves in flight, judged by byte origin like undo.
  private readonly patching = new Set<string>();
  // Step 10: Markdown block intents in flight, judged by their node's survival.
  private readonly blocks = new Set<string>();
  // Step 10: undos in flight and the origins their write restores (see
  // Undoable.restores). Cleared at the write or the outcome.
  private readonly restorations = new Map<string, { readonly origins: readonly Origins[]; readonly generation: number }>();
  // The origins each tracked write replaced, per splice, by the generation it
  // wrote, for the undo entry its commit becomes — a later actor step, after
  // other files' writes, so keyed. Consumed at the commit; bounded.
  private readonly replacedBy = new Map<number, readonly Origins[]>();
  private intents = 0;

  constructor(input: SimulationInput) {
    this.input = input;
    this.prng = new Prng(input.seed);
    for (const file of input.files) {
      const path = toFilePath(`/project/${file.name}`);
      const bytes = encodeUtf8(file.text);
      const generation = this.disk.writeExternally(path, bytes);
      this.keepOrigins(generation, this.originSource.fresh(bytes.length));
      this.actors.set(path, createActor(path));
      this.inputs.set(file.name, sha256(bytes));
    }
  }

  step(index: number): void {
    const kind = this.pickEvent();
    this.count(kind);
    this.log(`#${index} ${kind}`);
    this.dispatch(kind);
    checkBounds(this.actors.values(), 0);
  }

  /** Run actors until every accepted intent is terminal (invariant 1). Each
   * pass either finishes a phase or empties a queue, so the bound is the total
   * work: every queued intent takes at most three steps, plus one refresh each. */
  drain(): void {
    const passesMax = (LIMITS.intentsPendingMax * 3 + 2) * this.actors.size * 4;
    for (let pass = 0; pass < passesMax; pass++) {
      const busy = [...this.actors.values()].filter(actorHasWork);
      const [actor] = busy;
      if (actor === undefined) {
        checkQuiescent(this.accepted, this.terminal);
        return;
      }
      this.runActor(actor);
    }
    throw new Error(`Assertion failed: drain did not settle in ${passesMax} passes`);
  }

  report(): SimulationReport {
    const digest = createHash('sha256').update(this.trace.join('\n')).digest('hex');
    return { digest, trace: this.trace, tally: { ...this.tally } };
  }

  private pickEvent(): EventKind {
    let roll = this.prng.below(EVENT_WEIGHT_TOTAL);
    for (const [kind, weight] of EVENTS) {
      if (roll < weight) {
        return kind;
      }
      roll -= weight;
    }
    throw new Error('Assertion failed: the event roll lies inside the weight total');
  }

  private dispatch(kind: EventKind): void {
    switch (kind) {
      case 'actor-step': {
        const busy = [...this.actors.values()].filter(actorHasWork);
        if (busy.length > 0) {
          this.runActor(this.prng.pick(busy));
        }
        return;
      }
      case 'visual-intent':
        return this.submitVisual(this.clientView(this.pickPath()));
      case 'preview-intent':
        return this.submitVisual(this.staleView(this.pickPath()));
      case 'markdown-intent':
        return this.submitMarkdown((path) => this.clientView(path));
      case 'markdown-preview':
        return this.submitMarkdown((path) => this.staleView(path));
      case 'oracle-gesture':
        return this.startGesture(this.prng.pick(ORACLE_SCENARIOS));
      case 'code-save':
        return this.submitCodePatch(this.pickPath());
      case 'program-write':
        return this.submitProgramWrite(this.pickPath());
      case 'external-edit':
        return this.editExternally(this.pickPath());
      case 'copy-paste':
        return this.pasteLineCopy(this.pickPath());
      case 'attribute-append':
        return this.appendAttributeExternally(this.pickPath());
      case 'ai-rewrite':
        return this.rewriteLineEndings(this.pickPath());
      case 'git-replace':
        return this.replaceLikeGit(this.pickPath());
      case 'watcher-tick':
        return this.tickWatcher();
      case 'crash':
        return this.crash();
      case 'write-failure': {
        const failure = this.prng.pick(['failed', 'not-durable'] as const);
        this.count(`replace:${failure}`);
        return this.disk.failNextReplace(this.pickPath(), failure);
      }
      case 'lock-contended':
        return this.disk.contendNextLock(this.pickPath());
      case 'burst':
        return this.burst(this.pickPath());
      case 'undo':
        return this.undo();
      default: {
        const exhaustive: never = kind;
        throw new Error(`Unknown event ${String(exhaustive)}`);
      }
    }
  }

  // --- Actors and outcomes ---------------------------------------------------

  private runActor(actor: ActorState): void {
    const head = actor.phase.tag === 'idle' ? actor.queue[0] : undefined;
    const generationBefore = this.disk.generationOf(actor.path);
    const result = stepActor(actor, this.dependencies);
    this.actors.set(actor.path, result.state);
    checkBounds(this.actors.values(), result.parses);
    this.trackActorWrite(actor, result.state, generationBefore);
    if (head !== undefined) {
      this.judgePlanning(head, result);
    }
    for (const effect of result.effects) {
      this.absorb(effect, actor.path);
    }
  }

  /** The actor's atomic replace (planned → written) keeps the origins of every
   * byte outside its splices; the disk held the base bytes just before it. */
  private trackActorWrite(before: ActorState, after: ActorState, generationBefore: number): void {
    const generation = this.disk.generationOf(before.path);
    if (generation === generationBefore) {
      return;
    }
    assert(before.phase.tag === 'planned', 'Only a planned actor writes the disk');
    // Written, or idle after a replace that landed but could not be flushed.
    assert(after.phase.tag !== 'planned', 'A write moves the actor on');
    const origins = this.origins.get(generationBefore);
    if (origins !== undefined) {
      const splices = before.phase.plan.splices;
      // A move relocates its node's bytes, and an undo writes back the bytes
      // its edit replaced: either way they keep their origins (step 10).
      const intent = before.phase.intent;
      // Only an undo planned on exactly the bytes its edit left restores: one
      // mapped through other writes (a whole-file replacement among them)
      // lands where the planner put it, among bytes of other histories.
      // And bytes a git-style replacement swapped back in are not the edit's.
      const fresh = before.phase.base.checksum === intent.authoredChecksum;
      const restoration = this.restorations.get(intent.id);
      this.restorations.delete(intent.id);
      const intact = restoration !== undefined && fresh && !this.rewrittenBetween(before.path, restoration.generation, generationBefore);
      const restored = intact ? restoration.origins : undefined;
      let next: Origins;
      if (intent.operation.tag === 'move-node') {
        next = moveOrigins(origins, splices, this.originSource);
      } else if (restored !== undefined) {
        next = restoreOrigins(origins, splices, restored, this.originSource);
      } else {
        next = spliceOrigins(origins, splices, this.originSource);
      }
      this.keepOrigins(generation, next);
      const replaced = orderedSplices(splices).map((splice) => origins.slice(splice.range.start, splice.range.end));
      this.replacedBy.set(generation, replaced);
      if (this.replacedBy.size > REPLACED_RETAINED_MAX) {
        const [oldest] = this.replacedBy.keys();
        assert(oldest !== undefined, 'A full store has an oldest entry');
        this.replacedBy.delete(oldest);
      }
    }
    const phase = before.phase;
    // An undo of a code patch removes or retypes the same slidable run
    // (seed 2181: the patch's `<`, not the file's, became the list's own).
    if (BYTE_HUNK_OPERATIONS.includes(phase.intent.operation.tag)) {
      if (phase.plan.splices.some((splice) => slidable(phase.base.bytes, splice))) {
        this.count('code:slidable');
        this.slidPatches.set(before.path, [...(this.slidPatches.get(before.path) ?? []), generation]);
      }
    }
  }

  /** Whether origins between two generations of a file are ground truth: no
   * git-style replacement re-originated it, and no code patch was placed on
   * one copy of a repeated run it could as well have been placed on. */
  private rewrittenBetween(path: FilePath, after: number, through: number): boolean {
    const inside = (generation: number) => generation > after && generation <= through;
    const whole = (this.replacedWhole.get(path) ?? []).some(inside);
    return whole || (this.slidPatches.get(path) ?? []).some(inside);
  }

  // Every stale set-attribute decision is judged against the origins; fresh
  // ones are the identity mapping and only counted.
  private judgePlanning(submission: Submission, result: ActorStep): void {
    const intent = submission.intent;
    const undone = this.undoing.get(intent.id);
    if (undone !== undefined) {
      return this.judgeUndo(undone, intent, result);
    }
    if (this.patching.delete(intent.id)) {
      return this.judgeCodePatch(submission, result);
    }
    if (this.blocks.delete(intent.id)) {
      return this.judgeBlock(submission, result);
    }
    const gesture = this.gestures.get(intent.id);
    const survival = judgedBySurvival(intent.operation.tag);
    if (!survival) {
      if (gesture === undefined) {
        return; // No survival rule, and no oracle step names its expected bytes.
      }
    }
    // The simulated client always sends the snapshot it authored against.
    assert(submission.authored !== undefined, 'Simulated intents carry their authored bytes');
    const head = { intent, authored: submission.authored };
    const decision = decisionFor(intent, result);
    const current = result.state.snapshot;
    if (decision === undefined || current === undefined) {
      return; // The read failed: nothing was planned against anything.
    }
    if (head.authored.checksum === current.checksum) {
      this.count('mapping:identity');
      return;
    }
    const authoredGeneration = this.authoredAt.get(intent.id);
    assert(authoredGeneration !== undefined, 'Every submitted intent has an authored generation');
    const baseGeneration = result.state.generation;
    const input = {
      intent,
      authored: head.authored,
      current,
      authoredOrigins: this.origins.get(authoredGeneration),
      currentOrigins: this.origins.get(baseGeneration),
      replacedWhole: this.rewrittenBetween(intent.file, authoredGeneration, baseGeneration),
      decision,
    };
    this.countAge(intent.file, head.authored.checksum, current.checksum);
    if (!survival) {
      if (markdownBlockIntent(intent, head.authored)) {
        // Its splices include the syntax between blocks, which belongs to no
        // node: replaying them at their surviving bytes is no oracle once text
        // lands between a block and its old separator. Judged, like every
        // Markdown block intent, by where the plan sits against its node.
        this.count(`remap-markdown-oracle:${intent.operation.tag}`);
        this.countVerdict(intent.file, judgeBlockRemap(input));
        return;
      }
      const step = gesture?.scenario.steps[gesture.next - 1];
      assert(step !== undefined, 'A judged gesture intent is one of its scenario steps');
      this.countVerdict(intent.file, judgeOracleRemap(input, oracleSplices(step)));
      return;
    }
    if (intent.operation.tag === 'set-attribute') {
      this.count(checkMappingReference(input) ? 'reference:agreed' : 'reference:skipped');
    }
    this.countVerdict(intent.file, judgeRemap(input));
  }

  private countVerdict(path: FilePath, verdict: RemapVerdict): void {
    if (verdict.tag === 'wrong-site') {
      const where = `seed ${this.input.seed}: ${verdict.detail}`;
      assert(this.input.wrongSite === 'count', `Wrong site (step-4 gate: zero allowed): ${where}`);
      this.count(`remap-wrong-site:${where}`);
    }
    const detail = verdictDetail(verdict);
    const key = detail === '' ? verdict.tag : `${verdict.tag} ${detail}`;
    this.count(`remap:${key}`);
    this.count(`remap-file:${path.slice('/project/'.length)}|${key}`);
    this.log(`  remap ${key}`);
  }

  /** How many snapshots before the current one the authored one was, in the
   * actor's own history — an actor keeping k earlier snapshots would have had
   * the authored bytes for ages up to k (open question: lastKnownBytes).
   * `unseen`: the actor never held them (the client read the disk itself). */
  private countAge(path: FilePath, authored: Digest, current: Digest): void {
    const held = this.held.get(path) ?? [];
    const chain = held[held.length - 1] === current ? held : [...held, current];
    const index = chain.lastIndexOf(authored);
    const age = chain.length - 1 - index;
    if (index < 0) {
      this.count('authored-age:unseen');
    } else {
      assert(age > 0, 'A stale intent was authored before the current snapshot');
      this.count(`authored-age:${age < 3 ? String(age) : '3+'}`);
    }
  }

  private hold(path: FilePath, checksum: Digest): void {
    const held = [...(this.held.get(path) ?? []), checksum].slice(-HELD_MAX);
    assert(held.length <= HELD_MAX, 'Held checksums are bounded');
    this.held.set(path, held);
  }

  private keepOrigins(generation: number, origins: Origins): void {
    assert(!this.origins.has(generation), 'A disk generation is written once');
    this.origins.set(generation, origins);
    if (this.origins.size > ORIGINS_RETAINED_MAX) {
      const [oldest] = this.origins.keys();
      assert(oldest !== undefined, 'A full origin store has an oldest entry');
      this.origins.delete(oldest);
    }
    assert(this.origins.size <= ORIGINS_RETAINED_MAX, 'Origin retention is bounded');
  }

  private absorb(effect: ActorEffect, path: FilePath): void {
    switch (effect.tag) {
      case 'outcome':
        return this.record(effect.outcome);
      case 'committed':
        checkCommitted(effect);
        this.rememberUndoable(effect, path);
        this.hold(path, effect.candidate.checksum);
        this.remember({ snapshot: effect.candidate, generation: effect.generation });
        this.log(`  commit ${effect.intent.id} ${effect.plan.splices.length} splice(s)`);
        return;
      case 'refreshed':
        checkGeneration(effect.previousGeneration, effect.generation);
        this.holdCurrent(path);
        this.log(`  refresh ${path} gen ${effect.generation}`);
        return;
      case 'disk-error':
        this.log(`  disk error for ${effect.intentId}`);
        return;
      case 'lock-leaked':
        throw new Error('Assertion failed: the fake disk never fails to release a lock');
      default: {
        const exhaustive: never = effect;
        throw new Error(`Unknown effect ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  // --- Undo (step 6) ----------------------------------------------------------

  // Every applied edit but a program's rewrite or a revert can be undone: its
  // inverse, authored against the bytes it left (plan §11 step 6).
  private rememberUndoable(effect: Extract<ActorEffect, { tag: 'committed' }>, path: FilePath): void {
    const tag = effect.intent.operation.tag;
    if (NOT_UNDOABLE.includes(tag)) {
      return;
    }
    const origins = this.origins.get(effect.generation);
    if (origins === undefined) {
      return;
    }
    const written = new Set<number>();
    for (const range of changedRanges(effect.plan.splices)) {
      for (let at = range.start; at < range.end; at++) {
        const origin = origins[at];
        assert(origin !== undefined, 'A changed byte has an origin');
        written.add(origin);
      }
    }
    const view = { snapshot: effect.candidate, generation: effect.generation };
    const restores = this.replacedBy.get(effect.generation);
    this.replacedBy.delete(effect.generation);
    const inverse = inverseEdits(effect.plan.splices);
    const entry = { file: path, view, inverse, written, restores };
    this.undoable = [...this.undoable, entry].slice(-UNDOABLE_MAX);
  }

  // Undo one of them, whatever happened to its file since.
  private undo(): void {
    const entry = this.undoable.length === 0 ? undefined : this.prng.pick(this.undoable);
    if (entry === undefined) {
      this.log('  skip: nothing to undo');
      return;
    }
    this.undoable = this.undoable.filter((candidate) => candidate !== entry);
    if (entry.inverse.length === 0) {
      return;
    }
    const snapshot = entry.view.snapshot;
    const anchor = toAnchorRef({
      span: toByteSpan(0, snapshot.bytes.length),
      path: [],
      expectedKind: 'document',
    });
    const intent = toIntent({
      id: this.nextIntentId(),
      file: entry.file,
      authoredChecksum: snapshot.checksum,
      anchor,
      operation: { tag: 'revert-splices', hunks: entry.inverse },
    });
    if (this.submit(intent, entry.view)) {
      this.undoing.set(intent.id, entry);
      if (entry.restores !== undefined) {
        this.restorations.set(intent.id, {
          origins: entry.restores,
          generation: entry.view.generation,
        });
      }
    }
  }

  // A planned revert replaces bytes equal to what the undone edit wrote (its
  // witness), so what can go wrong is where: at a copy of them while the
  // edit's own bytes survive elsewhere — a wrong site — or over an outside
  // change. Judged by origin: a replaced byte of another origin fails the run
  // when the edit's own bytes are still in the file; when none of them is
  // (another writer rewrote that text, identical, under new origins), no byte
  // rule can tell the two apart (planner.test.ts, BYTES CANNOT TELL): counted
  // unjudged. A git-style replacement in between re-originates everything.
  private judgeUndo(entry: Undoable, intent: Intent, result: ActorStep): void {
    this.undoing.delete(intent.id);
    const decision = decisionFor(intent, result);
    if (decision === undefined) {
      return;
    }
    if (decision.tag === 'rejected') {
      this.count(`undo:rejected ${decision.reason}`);
      return;
    }
    const origins = this.origins.get(result.state.generation);
    const replaced = this.rewrittenBetween(entry.file, entry.view.generation, result.state.generation);
    if (origins === undefined || replaced) {
      this.count('undo:unjudged');
      return;
    }
    const inside = (at: number) => decision.plan.splices.some((splice) => splice.range.start <= at && at < splice.range.end);
    const foreign = origins.some((origin, at) => inside(at) && !entry.written.has(origin));
    if (foreign) {
      // The edit's own bytes surviving outside what the revert replaces means
      // it replaced a copy; surviving only inside it, the place is right.
      const elsewhere = origins.some((origin, at) => !inside(at) && entry.written.has(origin));
      assert(!elsewhere, `Undo reverts its own bytes, not a copy of them (seed ${this.input.seed})`);
      const own = origins.some((origin, at) => inside(at) && entry.written.has(origin));
      this.count(own ? 'undo:planned-over-rewrite' : 'undo:unjudged');
      return;
    }
    const stale = result.state.snapshot?.checksum !== entry.view.snapshot.checksum;
    this.count(stale ? 'undo:mapped' : 'undo:planned');
  }

  // A planned code patch replaces what each hunk held when it was typed —
  // equal bytes, by its witness — so, as for undo, what can go wrong is where:
  // at a copy of those bytes while the ones it was typed against survive
  // elsewhere. Judged by origin: each replaced range must hold the authored
  // range's own bytes (an insertion: its authored neighbours). A range of
  // other origins fails the run when the authored bytes survive outside the
  // plan; when they do not (rewritten identically under new origins), no byte
  // rule can tell the two apart and it is counted unjudged. An applied patch
  // whose candidate does not parse is a malformed intermediate (plan §3.6).
  private judgeCodePatch(submission: Submission, result: ActorStep): void {
    const intent = submission.intent;
    const decision = decisionFor(intent, result);
    if (decision === undefined) {
      return;
    }
    if (decision.tag === 'rejected') {
      this.count(`code:rejected ${decision.reason}`);
      return;
    }
    const phase = result.state.phase;
    assert(phase.tag === 'planned', 'A planned decision leaves the actor planned');
    if (phase.candidate.projection.tag === 'parse-error') {
      this.count('code:invalid');
    }
    const authored = submission.authored;
    assert(authored !== undefined, 'Simulated intents carry their authored bytes');
    if (authored.checksum === phase.base.checksum) {
      this.count('code:planned');
      return;
    }
    const authoredAt = this.authoredAt.get(intent.id);
    assert(authoredAt !== undefined, 'Every submitted intent has an authored generation');
    const before = this.origins.get(authoredAt);
    const now = this.origins.get(result.state.generation);
    const replaced = this.rewrittenBetween(intent.file, authoredAt, result.state.generation);
    if (before === undefined || now === undefined || replaced) {
      this.count('code:unjudged');
      return;
    }
    const operation = intent.operation;
    assert(operation.tag === 'apply-code-patch', 'Only code patches are judged here');
    const verdict = codePatchVerdict(operation.hunks, decision.plan.splices, {
      before,
      now,
      bytes: authored.bytes,
    });
    const where = `seed ${this.input.seed}`;
    assert(verdict !== 'wrong-site', `A code patch replaces its own bytes (${where})`);
    this.count(`code:${verdict}`);
  }

  private holdCurrent(path: FilePath): void {
    const snapshot = this.actors.get(path)?.snapshot;
    assert(snapshot !== undefined, 'A refreshed actor holds a snapshot');
    this.hold(path, snapshot.checksum);
  }

  private record(outcome: Outcome): void {
    checkOutcome(outcome, this.accepted, this.terminal);
    this.terminal.set(outcome.intentId, outcome);
    this.authoredAt.delete(outcome.intentId);
    this.restorations.delete(outcome.intentId);
    const detail = outcome.tag === 'rejected' ? ` ${outcome.reason}` : '';
    this.count(`outcome:${outcome.tag}${detail}`);
    this.log(`  outcome ${outcome.intentId} ${outcome.tag}${detail}`);
    const gesture = this.gestures.get(outcome.intentId);
    if (gesture !== undefined) {
      this.gestures.delete(outcome.intentId);
      this.continueGesture(gesture.scenario, gesture.next, outcome);
    }
  }

  private submit(intent: Intent, view: View): boolean {
    const actor = this.actors.get(intent.file);
    assert(actor !== undefined, 'Every intent names a simulated file');
    const submitted = submitIntent(actor, { intent, authored: view.snapshot });
    this.actors.set(intent.file, submitted.state);
    const name = intent.file.slice('/project/'.length);
    this.log(`  submit ${intent.id} ${intent.operation.tag} ${name} ${submitted.result.tag}`);
    this.count(`submit:${submitted.result.tag}`);
    if (submitted.result.tag === 'accepted') {
      this.accepted.set(intent.id, intent);
      this.authoredAt.set(intent.id, view.generation);
      return true;
    }
    return false;
  }

  private nextIntentId(): ReturnType<typeof toIntentId> {
    this.intents += 1;
    return toIntentId(`i${this.intents}`);
  }

  // --- Client views ------------------------------------------------------------

  private pickPath(): FilePath {
    return this.prng.pick([...this.actors.keys()]);
  }

  /** What the renderer shows: the actor's snapshot, or its own read of the disk
   * when the actor has not read the file yet (page:read). The actor's
   * generation names the latest disk version it confirmed holds those bytes. */
  private clientView(path: FilePath): View {
    const actor = this.actors.get(path);
    assert(actor !== undefined, 'Every path has an actor');
    if (actor.snapshot !== undefined) {
      return { snapshot: actor.snapshot, generation: actor.generation };
    }
    const read = this.disk.read(path);
    assert(read.ok, 'Simulated files are never deleted');
    const snapshot = snapshotOf(path, read.value.bytes);
    const view = { snapshot, generation: read.value.generation };
    this.remember(view);
    return view;
  }

  /** A preview rendered from an older version of the file. */
  private staleView(path: FilePath): View {
    const seen = this.history.get(path) ?? [];
    return seen.length > 0 ? this.prng.pick(seen) : this.clientView(path);
  }

  private remember(view: View): void {
    const seen = this.history.get(view.snapshot.path) ?? [];
    const next = [...seen, view].slice(-HISTORY_MAX);
    assert(next.length <= HISTORY_MAX, 'Client history is bounded');
    this.history.set(view.snapshot.path, next);
  }

  // --- Intents -----------------------------------------------------------------

  private submitVisual(view: View): void {
    const snapshot = view.snapshot;
    const projection = snapshot.projection;
    if (projection.tag === 'parse-error') {
      this.log('  skip: the view does not parse');
      return;
    }
    const targets = projection.nodes.flatMap((node) =>
      node.attributes.filter((attribute) => attribute.type === 'string').map((attribute) => ({ node, attribute })),
    );
    if (targets.length === 0) {
      this.log('  skip: no string attribute in view');
      return;
    }
    const { node, attribute } = this.prng.pick(targets);
    const anchor = toAnchorRef({
      span: node.span,
      path: node.path.map(toChildIndex),
      expectedKind: node.kind,
    });
    const intent = toIntent({
      id: this.nextIntentId(),
      file: snapshot.path,
      authoredChecksum: snapshot.checksum,
      anchor,
      operation: this.visualOperation(snapshot.bytes, node, attribute.name),
    });
    this.count(`visual:${intent.operation.tag}`);
    this.submit(intent, view);
  }

  // Mostly the step-3 set-attribute; from step 9 also the renames that took
  // over gestures the whole-model save carried: an attribute's name, and the
  // tag's own (a raw `<style>` or `<script>` is never renamed).
  private visualOperation(bytes: ByteString, node: ProjectedNode, name: string): Operation {
    const roll = this.prng.below(10);
    if (roll === 0) {
      return { tag: 'rename-attribute', from: name, to: `${name}-renamed` };
    }
    if (roll === 1) {
      const tag = tagNameText(bytes, node);
      if (tag !== '' && (node.kind === 'element' || node.kind === 'component')) {
        return { tag: 'rename-tag', from: tag, to: `${tag}x` };
      }
    }
    const target = this.prng.chance(1, 10) ? 'data-absent' : name;
    const value = { type: 'string' as const, value: this.prng.pick(ATTRIBUTE_VALUES) };
    return { tag: 'set-attribute', name: target, value };
  }

  // --- Markdown block intents (step 10) ---------------------------------------------

  /** A gesture on a Markdown page's own nodes, authored against the view
   * `viewOf` gives: typing into a block's text, or a block or item removed,
   * put beside another, or moved beside a sibling of its list. */
  private submitMarkdown(viewOf: (path: FilePath) => View): void {
    const pages = [...this.actors.keys()].filter((path) => /\.mdx?$/.test(path));
    if (pages.length === 0) {
      this.log('  skip: no Markdown page');
      return;
    }
    const view = viewOf(this.prng.pick(pages));
    const projection = view.snapshot.projection;
    if (projection.tag === 'parse-error') {
      this.log('  skip: the view does not parse');
      return;
    }
    const targets = projection.nodes.filter((node) => node.syntax === 'markdown');
    if (targets.length === 0) {
      this.log('  skip: no Markdown node in view');
      return;
    }
    const node = this.prng.pick(targets);
    const operation = this.markdownOperation(view.snapshot.bytes, projection.nodes, node);
    const anchor = toAnchorRef({
      span: node.span,
      path: node.path.map(toChildIndex),
      expectedKind: node.kind,
    });
    const intent = toIntent({
      id: this.nextIntentId(),
      file: view.snapshot.path,
      authoredChecksum: view.snapshot.checksum,
      anchor,
      operation,
    });
    this.count(`markdown:${operation.tag}`);
    if (this.submit(intent, view)) {
      this.blocks.add(intent.id);
    }
  }

  private markdownOperation(bytes: ByteString, nodes: readonly ProjectedNode[], node: ProjectedNode): Operation {
    if (node.list === 'inline') {
      // Typed at the end of the text: a word, or a new line of it.
      const typed = this.prng.pick([' typed', '\nand a line']);
      const end = toByteSpan(node.span.end, node.span.end);
      return { tag: 'rewrite-node', hunks: [{ span: end, text: typed }] };
    }
    const siblings = nodes.filter((other) => other !== node && other.list === node.list);
    const roll = this.prng.below(3);
    if (roll === 0) {
      return { tag: 'remove-node' };
    }
    if (roll === 1 && siblings.length > 0) {
      const other = this.prng.pick(siblings);
      const destination = toAnchorRef({
        span: other.span,
        path: other.path.map(toChildIndex),
        expectedKind: other.kind,
      });
      const placement = this.prng.pick(['before', 'after'] as const);
      return { tag: 'move-node', destination, placement };
    }
    const source = node.list === 'items' ? `${markerText(bytes, node)} new item` : 'New block.';
    return { tag: 'insert-node', placement: 'after', source };
  }

  /** A stale block intent's plan, judged by its node's survival (step 10). */
  private judgeBlock(submission: Submission, result: ActorStep): void {
    const intent = submission.intent;
    assert(submission.authored !== undefined, 'Simulated intents carry their authored bytes');
    const decision = decisionFor(intent, result);
    const current = result.state.snapshot;
    if (decision === undefined || current === undefined) {
      return;
    }
    if (submission.authored.checksum === current.checksum) {
      this.count('markdown-mapping:identity');
      return;
    }
    const authoredGeneration = this.authoredAt.get(intent.id);
    assert(authoredGeneration !== undefined, 'Every submitted intent has an authored generation');
    const baseGeneration = result.state.generation;
    const verdict = judgeBlockRemap({
      intent,
      authored: submission.authored,
      current,
      authoredOrigins: this.origins.get(authoredGeneration),
      currentOrigins: this.origins.get(baseGeneration),
      replacedWhole: this.rewrittenBetween(intent.file, authoredGeneration, baseGeneration),
      decision,
    });
    this.count(`remap-markdown:${verdict.tag}`);
    this.countVerdict(intent.file, verdict);
  }

  /** A program's text rewrite (`rewrite-text`, step 10): a stylesheet rule, a
   * CMS entry, a property batch — the hunks from the text it read to the text
   * it wants, witnessed by the checksum it was read at. An unchanged text is
   * the one empty hunk the host writes when the text equals the file's. */
  private submitProgramWrite(path: FilePath): void {
    const view = this.clientView(path);
    const decoded = decodeUtf8(view.snapshot.bytes);
    assert(decoded.ok, 'Simulated writers only write UTF-8');
    const suffix = this.prng.pick(['\n<!-- saved -->\n', '\n<div', '']);
    const patch = diffCodePatch(decoded.value, decoded.value + suffix);
    assert(patch.ok, 'A suffix stays inside the bounds');
    const touch: readonly SourceEdit[] = [{ span: toByteSpan(0, 0), text: '' }];
    const typed = patch.value.map((hunk) => ({ span: hunk.span, text: hunk.text }));
    const hunks = typed.length === 0 ? touch : typed;
    const anchor = toAnchorRef({
      span: toByteSpan(0, view.snapshot.bytes.length),
      path: [],
      expectedKind: 'document',
    });
    this.submit(
      toIntent({
        id: this.nextIntentId(),
        file: path,
        authoredChecksum: view.snapshot.checksum,
        anchor,
        operation: { tag: 'rewrite-text', hunks },
      }),
      view,
    );
  }

  /** The code editor's save (step 8): the byte diff from the text it shows to
   * what the user typed — often a malformed intermediate (plan §3.6). */
  private submitCodePatch(path: FilePath): void {
    const view = this.clientView(path);
    const decoded = decodeUtf8(view.snapshot.bytes);
    assert(decoded.ok, 'Simulated writers only write UTF-8');
    const typed = this.typeInto(decoded.value);
    const patch = diffCodePatch(decoded.value, typed);
    assert(patch.ok, 'Simulated typing stays inside the bounds');
    if (patch.value.length === 0) {
      this.count('code:unchanged');
      return;
    }
    const intent = toIntent({
      id: this.nextIntentId(),
      file: path,
      authoredChecksum: view.snapshot.checksum,
      anchor: toAnchorRef({
        span: toByteSpan(0, view.snapshot.bytes.length),
        path: [],
        expectedKind: 'document',
      }),
      operation: {
        tag: 'apply-code-patch',
        hunks: patch.value.map((hunk) => ({ span: hunk.span, text: hunk.text })),
      },
    });
    if (this.submit(intent, view)) {
      this.patching.add(intent.id);
    }
  }

  // One burst of typing at a line: an unfinished tag or expression (the file
  // stops parsing), a finished element, a line rewritten, or one deleted.
  private typeInto(text: string): string {
    const lines = text.split('\n');
    const at = this.prng.below(lines.length);
    const line = lines[at] ?? '';
    const typed = this.prng.pick(['<div', '{', '<p title="', '<p>typed</p>', 'rewrite', 'delete']);
    switch (typed) {
      case 'rewrite':
        lines[at] = `${line} edited`;
        break;
      case 'delete':
        lines.splice(at, 1);
        break;
      default:
        lines[at] = `${typed}${line}`;
    }
    return lines.join('\n');
  }

  /** More intents than the queue holds, at once: the tail must be backpressured. */
  private burst(path: FilePath): void {
    for (let index = 0; index < LIMITS.intentsPendingMax + 4; index++) {
      this.submitProgramWrite(path);
    }
  }

  private startGesture(scenario: OracleScenario): void {
    this.continueGesture(scenario, 0, undefined);
  }

  // A gesture's next step goes out only after the previous one is applied, and
  // only while its own file still holds the oracle's input bytes (plan §3.3).
  private continueGesture(scenario: OracleScenario, index: number, previous: Outcome | undefined): void {
    if (previous !== undefined) {
      if (previous.tag !== 'applied') {
        this.log(`  gesture cancelled after ${previous.tag}`);
        this.count('gesture:cancelled');
        return;
      }
    }
    const step = scenario.steps[index];
    if (step === undefined) {
      this.count('gesture:completed');
      return;
    }
    const path = toFilePath(`/project/${step.file}`);
    const view = this.clientView(path);
    if (view.snapshot.checksum !== this.inputs.get(step.file)) {
      this.log(`  gesture skipped: ${step.file} no longer holds the oracle input`);
      this.count('gesture:precondition');
      return;
    }
    const intent = oracleIntent(step, view.snapshot, this.nextIntentId());
    if (this.submit(intent, view)) {
      this.gestures.set(intent.id, { scenario, next: index + 1 });
    }
  }

  // --- Other writers -----------------------------------------------------------

  private writeOutside(path: FilePath, bytes: ReturnType<typeof encodeUtf8>, origins: Origins | undefined, what: string): void {
    const generation = this.disk.writeExternally(path, bytes);
    if (origins !== undefined) {
      assert(origins.length === bytes.length, 'Origins describe the written bytes');
      this.keepOrigins(generation, origins);
    }
    this.watched.add(path);
    assert(this.watched.size <= LIMITS.watcherFilesPerTickMax, 'Watcher work per tick is bounded');
    this.log(`  ${what} ${path} gen ${generation}`);
  }

  private diskText(path: FilePath): string {
    const read = this.disk.read(path);
    assert(read.ok, 'Simulated files are never deleted');
    const decoded = decodeUtf8(read.value.bytes);
    assert(decoded.ok, 'Simulated writers only write UTF-8');
    return decoded.value;
  }

  /** A manual edit: a comment at a node boundary, or (rarely) a broken tag, as
   * a new line before line `line`, or after the last one. */
  private editExternally(path: FilePath): void {
    const text = this.diskText(path);
    const lines = text.split('\n');
    const line = this.prng.below(lines.length + 1);
    const inserted = this.prng.chance(1, 8) ? '<' : '<!-- external -->';
    if (line === lines.length) {
      this.insertExternally(path, utf8ByteLength(text), `\n${inserted}`, 'external-edit');
    } else {
      const before = lines
        .slice(0, line)
        .map((kept) => `${kept}\n`)
        .join('');
      this.insertExternally(path, utf8ByteLength(before), `${inserted}\n`, 'external-edit');
    }
  }

  /** Copy and paste in another editor: a line duplicated right below itself.
   * The copy is new bytes and the original keeps its origins, so a remap onto
   * the copy is a wrong-site application; the mapper must call it ambiguous. */
  private pasteLineCopy(path: FilePath): void {
    const text = this.diskText(path);
    const lines = text.split('\n');
    const line = this.prng.below(lines.length);
    const copied = lines[line];
    assert(copied !== undefined, 'The copied line exists');
    const through = lines.slice(0, line + 1).join('\n');
    this.insertExternally(path, utf8ByteLength(through), `\n${copied}`, 'copy-paste');
  }

  /** Another editor adds an attribute after an element's last one — the edit
   * step 2 pinned as byte-level conservatism for the element itself. */
  private appendAttributeExternally(path: FilePath): void {
    const projection = snapshotOf(path, this.diskBytes(path)).projection;
    if (projection.tag === 'parse-error') {
      this.log('  skip: the file does not parse');
      return;
    }
    const hosts = projection.nodes.filter((node) => node.attributes.length > 0);
    if (hosts.length === 0) {
      this.log('  skip: no element with attributes');
      return;
    }
    const host = this.prng.pick(hosts);
    const end = Math.max(...host.attributes.map((attribute) => attribute.span.end));
    this.insertExternally(path, end, ' data-edited="1"', 'attribute-append');
  }

  /** An outside writer inserts `text` at byte `at` and keeps every other byte,
   * so every other byte keeps its origin. */
  private insertExternally(path: FilePath, at: number, text: string, what: string): void {
    const bytes = this.diskBytes(path);
    assert(at <= bytes.length, 'An insertion point lies inside the file');
    const inserted = encodeUtf8(text);
    const next = new Uint8Array(bytes.length + inserted.length);
    next.set(bytes.subarray(0, at), 0);
    next.set(inserted, at);
    next.set(bytes.subarray(at), at + inserted.length);
    const origins = this.origins.get(this.disk.generationOf(path));
    const nextOrigins = origins === undefined ? undefined : insertOrigins(origins, at, this.originSource.fresh(inserted.length));
    this.writeOutside(path, toByteString(next), nextOrigins, what);
  }

  /** A formatter or an AI tool rewriting the whole file: line endings flipped. */
  private rewriteLineEndings(path: FilePath): void {
    const text = this.diskText(path);
    const toLf = text.includes('\r\n');
    const rewritten = toLf ? text.replaceAll('\r\n', '\n') : text.replaceAll('\n', '\r\n');
    const origins = this.origins.get(this.disk.generationOf(path));
    const direction = toLf ? 'to-lf' : 'to-crlf';
    const next = origins === undefined ? undefined : lineEndingOrigins(this.diskBytes(path), origins, direction, this.originSource);
    this.writeOutside(path, encodeUtf8(rewritten), next, 'ai-rewrite');
  }

  /** A checkout: the whole file is new bytes, and no byte's origin is known. */
  private replaceLikeGit(path: FilePath): void {
    const name = path.slice('/project/'.length);
    const versions = this.input.alternates.get(name) ?? [];
    if (versions.length > 0) {
      const bytes = encodeUtf8(this.prng.pick(versions));
      this.writeOutside(path, bytes, this.originSource.fresh(bytes.length), 'git-replace');
      const replaced = [...(this.replacedWhole.get(path) ?? []), this.disk.generationOf(path)];
      assert(replaced.length <= SIMULATION_STEPS_MAX, 'One replacement per step at most');
      this.replacedWhole.set(path, replaced);
    }
  }

  private tickWatcher(): void {
    assert(this.watched.size <= LIMITS.watcherFilesPerTickMax, 'Watcher work per tick is bounded');
    for (const path of this.watched) {
      const actor = this.actors.get(path);
      assert(actor !== undefined, 'The watcher only reports simulated files');
      this.actors.set(path, markDirty(actor));
    }
    this.log(`  watcher marked ${this.watched.size} file(s)`);
    this.watched.clear();
  }

  private crash(): void {
    const busy = [...this.actors.values()].filter((actor) => actor.phase.tag !== 'idle');
    if (busy.length === 0) {
      return;
    }
    const actor = this.prng.pick(busy);
    const phase = actor.phase;
    assert(phase.tag !== 'idle', 'A crash is injected mid-intent');
    const result = crashActor(actor);
    this.actors.set(actor.path, result.state);
    if (phase.tag === 'written') {
      this.disk.breakLock(actor.path); // The real disk breaks a dead owner's lock.
    }
    for (const effect of result.effects) {
      this.absorb(effect, actor.path);
    }
    const verdict = reconcileUncertain({
      baseChecksum: phase.base.checksum,
      candidateChecksum: phase.candidate.checksum,
      currentChecksum: sha256(this.diskBytes(actor.path)),
    });
    this.count(`reconcile:${verdict}`);
    this.log(`  crash ${actor.path} in ${phase.tag}: reconciled ${verdict}`);
  }

  private diskBytes(path: FilePath): ReturnType<typeof encodeUtf8> {
    const read = this.disk.read(path);
    assert(read.ok, 'Simulated files are never deleted');
    return read.value.bytes;
  }

  // --- Trace -------------------------------------------------------------------

  private log(line: string): void {
    this.trace.push(line);
  }

  private count(key: string): void {
    this.tally[key] = (this.tally[key] ?? 0) + 1;
  }
}

/** What the planner decided for the head intent in one idle step: the plan now
 * in flight, or the rejection among the step's outcomes; undefined when the
 * step rejected before planning (a failed read). */
// Operations Undo never reverts: a program's rewrite is not the user's edit,
// and a revert is itself an undo.
const NOT_UNDOABLE: readonly Operation['tag'][] = ['rewrite-text', 'revert-splices'];

// Operations whose hunks a diff placed: a code patch, and the undo of one.
const BYTE_HUNK_OPERATIONS: readonly Operation['tag'][] = ['apply-code-patch', 'revert-splices'];

// Whether a splice could move one byte along the file and write the same bytes:
// deleting one of two equal lines, or typing a character beside its twin. A
// diff places such a change on one copy by convention (shared/engine/codePatch.ts
// trims the common prefix first, so it takes the last); the user may have
// meant the other, and no byte rule can tell (planner.test.ts, BYTES CANNOT
// TELL). Found by the step-8 long run: a deletion placed on the last of two
// identical <Card> lines made the judge call the survivor a wrong site.
function slidable(
  base: Uint8Array,
  splice: {
    readonly range: { readonly start: number; readonly end: number };
    readonly expectedBytes: Uint8Array;
    readonly replacementBytes: Uint8Array;
  },
): boolean {
  const { start, end } = splice.range;
  const removed = splice.expectedBytes;
  const typed = splice.replacementBytes;
  const before = base[start - 1];
  const after = base[end];
  // Left: the byte before could end both runs instead; right: the byte after
  // could start both.
  const left = before !== undefined && lastIs(removed, before) && lastIs(typed, before);
  const right = after !== undefined && firstIs(removed, after) && firstIs(typed, after);
  return left || right;
}

// An empty run takes any byte at its edge; a run ends (or starts) with it.
function lastIs(run: Uint8Array, byte: number): boolean {
  return run.length === 0 || run[run.length - 1] === byte;
}

function firstIs(run: Uint8Array, byte: number): boolean {
  return run.length === 0 || run[0] === byte;
}

// Whether a stale code patch's planned splices sit on the bytes its hunks were
// typed against, by origin (see judgeCodePatch).
function codePatchVerdict(
  hunks: readonly SourceEdit[],
  splices: readonly { readonly range: { readonly start: number; readonly end: number } }[],
  origins: {
    readonly before: Origins;
    readonly now: Origins;
    /** The authored bytes `before` describes. */
    readonly bytes: ByteString;
  },
): 'mapped' | 'unjudged' | 'wrong-site' {
  const { before, now } = origins;
  assert(hunks.length === splices.length, 'A code patch plans one splice per hunk');
  const inside = (at: number) => splices.some((splice) => splice.range.start <= at && at < splice.range.end);
  let unjudged = false;
  for (const [index, hunk] of hunks.entries()) {
    const splice = splices[index];
    assert(splice !== undefined, 'Every hunk has its splice');
    // A range, or an insertion's two neighbours, compared as origin sequences.
    const width = hunk.span.end - hunk.span.start;
    const from = width === 0 ? hunk.span.start - 1 : hunk.span.start;
    const to = width === 0 ? hunk.span.end + 1 : hunk.span.end;
    const shift = splice.range.start - hunk.span.start;
    const expected = before.slice(Math.max(0, from), to);
    const found = now.slice(Math.max(0, from + shift), to + shift);
    if (expected.every((origin, at) => found[at] === origin)) {
      continue;
    }
    // Only content survives as evidence: a line break or a space is kept by
    // whichever replacement happens to share it (spliceOrigins), so its
    // origin says nothing about where the user's text went (step 10: seeded
    // Markdown moves and undos move gaps around).
    const content = expected.filter((_origin, offset) => {
      const byte = origins.bytes[Math.max(0, from) + offset];
      return byte !== undefined && !isSeparatorByte(byte);
    });
    const survives = now.some((origin, at) => !inside(at) && content.includes(origin));
    if (width > 0 && survives) {
      return 'wrong-site';
    }
    unjudged = true;
  }
  return unjudged ? 'unjudged' : 'mapped';
}

function isSeparatorByte(byte: number): boolean {
  switch (byte) {
    case 0x20:
    case 0x09:
    case 0x0a:
    case 0x0d:
    case 0x3e:
      return true;
    default:
      return false;
  }
}

function decisionFor(intent: Intent, result: ActorStep): RemapDecision | undefined {
  const phase = result.state.phase;
  if (phase.tag === 'planned') {
    assert(phase.intent.id === intent.id, 'The planned intent is the head of the queue');
    return { tag: 'planned', plan: phase.plan };
  }
  const reason = rejectionOf(intent, result);
  assert(reason !== undefined, 'An idle step plans its head or rejects it');
  return reason === 'write-failed' ? undefined : { tag: 'rejected', reason };
}

function rejectionOf(intent: Intent, result: ActorStep): RejectionReason | undefined {
  for (const effect of result.effects) {
    if (effect.tag === 'outcome') {
      if (effect.outcome.intentId === intent.id) {
        assert(effect.outcome.tag === 'rejected', 'An idle step only rejects');
        return effect.outcome.reason;
      }
    }
  }
  return undefined;
}

function verdictDetail(verdict: RemapVerdict): string {
  switch (verdict.tag) {
    case 'applied-correct':
    case 'wrong-site':
      return '';
    case 'conservative':
    case 'rejected-conflict':
    case 'rejected-gone':
    case 'other':
      return verdict.reason;
    case 'unjudged':
      return verdict.decision;
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

// Tags whose planned stale intents are judged by whether their element survived
// (remapJudge.ts): every operation that edits one tag's name or attributes.
function judgedBySurvival(tag: Intent['operation']['tag']): boolean {
  return tag === 'set-attribute' || tag === 'rename-attribute' || tag === 'rename-tag';
}

// A tree operation or a rewrite on a Markdown node of the authored view.
function markdownBlockIntent(intent: Intent, authored: Snapshot): boolean {
  switch (intent.operation.tag) {
    case 'rewrite-node':
    case 'remove-node':
    case 'insert-node':
    case 'move-node':
      break;
    case 'set-attribute':
    case 'remove-attribute':
    case 'rename-binding':
    case 'set-inline-style':
    case 'apply-code-patch':
    case 'revert-splices':
    case 'edit-frontmatter-slot':
    case 'rewrite-text':
    case 'rename-tag':
    case 'rename-attribute':
    case 'wrap-nodes':
    case 'append-body':
    case 'insert-frontmatter':
      return false;
    default: {
      const exhaustive: never = intent.operation;
      return exhaustive;
    }
  }
  const projection = authored.projection;
  if (projection.tag !== 'valid') {
    return false;
  }
  const path = intent.anchor.path;
  const node = projection.nodes.find((candidate) => candidate.path.length === path.length && candidate.path.every((step, index) => step === path[index]));
  return node?.syntax === 'markdown';
}

// A list item's marker as written: its bullet, or its number and `.` or `)`.
function markerText(bytes: ByteString, item: ProjectedNode): string {
  const text = Buffer.from(bytes.subarray(item.span.start, item.span.end)).toString('utf8');
  return /^(?:[-*+]|\d{1,9}[.)])/.exec(text)?.[0] ?? '-';
}

// A tag's name as written, from its `<` to the first space, `/` or `>`.
function tagNameText(bytes: ByteString, node: ProjectedNode): string {
  const text = Buffer.from(bytes.subarray(node.span.start + 1, node.span.end)).toString('utf8');
  return /^[^\s/>]*/.exec(text)?.[0] ?? '';
}
