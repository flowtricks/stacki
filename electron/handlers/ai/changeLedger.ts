// What one chat's turns changed, so the person can keep or undo each file.
// Edits apply the moment the agent makes them (Timothy's decision: review
// after, not approve before); the ledger keeps each touched file's content as
// it was before the turn, and as the agent left it.
//
// Two sources, because neither adapter routes its writes through the client
// (spike, docs/contracts.md "AI panel"): the files a tool call names are read
// from disk the first time they are named — before the edit runs, since an
// edit is announced (and, in ask mode, approved) before it happens — and a git
// tree snapshot at each end of the turn (treeSnapshot.ts) catches what a shell
// command changed without naming. Outside git only the first source applies.
//
// Undo writes the "before" text back through the document actors, witnessed
// by the "after" text: when the file changed since the agent's edit, the write
// is not made and the three versions go to the merge editor instead (`drifted`).
// Text files only: a binary or oversized file is left out of the ledger.
import path from 'node:path';
import { assert } from '../../../shared/core/assert';
import { toArray, toRecord } from '../../../shared/core/record';
import type { ReviewOutcome } from '../../../shared/ipc/aiChat';
import { mergeConflictSnapshot, type MergePick, type MergeResolution } from '../../../shared/ipc/mergeResolution';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';
import { toTurnId, type ChatFileChange, type FileChangeKind, type ReviewState, type TurnId } from '../../../shared/properties/ai/chatModel';
import { mergeInline, renderResolved, threeWay, type ConflictPart } from '../../git/conflicts';
import type { TreeSnapshots } from './treeSnapshot';

export interface LedgerEntry {
  /** Project-relative, forward slashes. */
  readonly path: string;
  /** Undefined: the file did not exist before the turn. */
  readonly before: string | undefined;
  /** Undefined: the turn deleted the file. */
  readonly after: string | undefined;
  readonly review: ReviewState;
}

export interface LedgerTurn {
  readonly turn: TurnId;
  readonly entries: readonly LedgerEntry[];
}

/** The disk, as the ledger may touch it. Writes go through the document actors (aiHandlers.ts). */
export interface LedgerFiles {
  /** The file's text; undefined when it does not exist. Throws when it is not readable text. */
  readonly read: (file: string) => string | undefined;
  readonly write: (file: string, text: string, expected: string) => void;
  readonly create: (file: string, text: string) => void;
  readonly trash: (file: string) => Promise<void>;
}

/** A file the ledger could not read as text: left out, never guessed at. */
export class UnreadableFile extends Error {}

interface OpenTurn {
  readonly turn: TurnId;
  readonly tree: string | undefined;
  readonly captured: Map<string, string | undefined>;
}

export class ChangeLedger {
  private open: OpenTurn | undefined;
  private turns: LedgerTurn[];

  constructor(
    private readonly root: string,
    private readonly files: LedgerFiles,
    private readonly snapshots: TreeSnapshots,
    stored: readonly LedgerTurn[],
  ) {
    assert(path.isAbsolute(root), 'ChangeLedger: the project root is absolute');
    this.turns = stored.slice(-AI_LIMITS.ledgerTurnsMax);
  }

  async begin(turn: TurnId): Promise<void> {
    assert(this.open === undefined, 'ChangeLedger.begin: one turn at a time per chat');
    const tree = await this.snapshots.snapshot(this.root);
    this.open = { turn, tree, captured: new Map() };
    assert(this.open.captured.size === 0, 'ChangeLedger.begin: a turn starts with nothing captured');
  }

  /** A tool call named `file`: keep its content now, before the call changes it. Once per file per turn. */
  noteTouch(file: string): void {
    const open = this.open;
    if (open === undefined) {
      return;
    }
    const relative = this.relative(file);
    if (relative === undefined || open.captured.has(relative) || open.captured.size >= AI_LIMITS.ledgerFilesMax) {
      return;
    }
    try {
      open.captured.set(relative, this.files.read(this.absolute(relative)));
    } catch {
      // Not text: nothing to review.
    }
  }

  /** Ends the turn: every file whose content changed, with its before and after. */
  async finish(turn: TurnId): Promise<LedgerTurn> {
    const open = this.open;
    assert(open !== undefined, 'ChangeLedger.finish: a turn is open');
    assert(open.turn === turn, 'ChangeLedger.finish: the turn that began');
    this.open = undefined;
    const before = new Map(open.captured);
    if (open.tree !== undefined) {
      const after = await this.snapshots.snapshot(this.root);
      const changes = after === undefined ? [] : await this.snapshots.changes(this.root, open.tree, after);
      for (const change of changes) {
        // The tree from the turn's start is the truth for "before"; a capture can only be later.
        before.set(change.path, change.status === 'added' ? undefined : await this.snapshots.blob(this.root, open.tree, change.path));
      }
    }
    const entries: LedgerEntry[] = [];
    let bytes = 0;
    for (const [relative, original] of before) {
      if (entries.length >= AI_LIMITS.ledgerFilesMax) {
        break;
      }
      let current: string | undefined;
      try {
        current = this.files.read(this.absolute(relative));
      } catch {
        continue;
      }
      bytes += (original?.length ?? 0) + (current?.length ?? 0);
      if (current !== original && bytes <= AI_LIMITS.ledgerBytesMax) {
        entries.push({ path: relative, before: original, after: current, review: 'pending' });
      }
    }
    const result: LedgerTurn = { turn, entries };
    if (entries.length > 0) {
      this.turns = [...this.turns, result].slice(-AI_LIMITS.ledgerTurnsMax);
    }
    assert(this.turns.length <= AI_LIMITS.ledgerTurnsMax, 'ChangeLedger.finish: kept turns are bounded');
    return result;
  }

  async review(
    turn: TurnId,
    file: string,
    action: { readonly kind: 'keep' } | { readonly kind: 'undo' } | { readonly kind: 'resolve'; readonly resolution: MergeResolution },
  ): Promise<ReviewOutcome> {
    const relative = this.relative(file) ?? file;
    const entry = this.turns.find((candidate) => candidate.turn === turn)?.entries.find((candidate) => candidate.path === relative);
    if (entry === undefined) {
      return { tag: 'failed', message: 'This change is no longer kept for review.' };
    }
    if (entry.review !== 'pending') {
      return { tag: 'failed', message: `This change was already ${entry.review === 'kept' ? 'kept' : 'undone'}.` };
    }
    switch (action.kind) {
      case 'keep':
        this.settle(turn, relative, 'kept');
        return { tag: 'done', review: 'kept' };
      case 'undo':
        return this.undo(turn, entry);
      case 'resolve':
        return this.resolve(turn, entry, action.resolution);
      default: {
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  }

  /** Every kept turn, for the chat's reviews file. */
  stored(): readonly LedgerTurn[] {
    return this.turns;
  }

  /** The changes of one turn, as the transcript records them. */
  static changesOf(turn: LedgerTurn): readonly ChatFileChange[] {
    return turn.entries.map((entry) => ({ path: entry.path, change: changeKind(entry), review: entry.review }));
  }

  private async undo(turn: TurnId, entry: LedgerEntry): Promise<ReviewOutcome> {
    const file = this.absolute(entry.path);
    let current: string | undefined;
    try {
      current = this.files.read(file);
    } catch {
      return { tag: 'failed', message: `${entry.path} can no longer be read as text.` };
    }
    if (current !== entry.after) {
      if (current === undefined || entry.before === undefined || entry.after === undefined) {
        return { tag: 'failed', message: `${entry.path} changed after the agent's edit. Open it to put it right by hand.` };
      }
      return { tag: 'drifted', clash: { path: entry.path, ours: current, theirs: entry.before, parts: undoParts(entry.after, current, entry.before) } };
    }
    try {
      await this.restore(file, entry.before, current);
    } catch (error: unknown) {
      return { tag: 'failed', message: error instanceof Error ? error.message : String(error) };
    }
    this.settle(turn, entry.path, 'undone');
    return { tag: 'done', review: 'undone' };
  }

  private async resolve(turn: TurnId, entry: LedgerEntry, resolution: MergeResolution): Promise<ReviewOutcome> {
    const file = this.absolute(entry.path);
    const current = this.files.read(file);
    if (current === undefined || entry.before === undefined || entry.after === undefined) {
      return { tag: 'failed', message: `${entry.path} can no longer be merged.` };
    }
    const parts = undoParts(entry.after, current, entry.before);
    let text: string;
    if (resolution === 'ours') {
      this.settle(turn, entry.path, 'kept');
      return { tag: 'done', review: 'kept' };
    } else if (resolution === 'theirs') {
      text = entry.before;
    } else if (isPicks(resolution)) {
      text = renderResolved(parts, resolution);
    } else {
      if (resolution.expected !== mergeConflictSnapshot(parts)) {
        return { tag: 'failed', message: `${entry.path} changed again while you were merging. Undo it again to see the new version.` };
      }
      text = resolution.text;
    }
    try {
      this.files.write(file, text, current);
    } catch (error: unknown) {
      return { tag: 'failed', message: error instanceof Error ? error.message : String(error) };
    }
    this.settle(turn, entry.path, 'undone');
    return { tag: 'done', review: 'undone' };
  }

  private async restore(file: string, before: string | undefined, current: string | undefined): Promise<void> {
    if (before === undefined) {
      // The turn created the file: undoing moves it to the bin, where it can be got back from.
      await this.files.trash(file);
    } else if (current === undefined) {
      this.files.create(file, before);
    } else {
      this.files.write(file, before, current);
    }
  }

  private settle(turn: TurnId, relative: string, review: ReviewState): void {
    this.turns = this.turns.map((candidate) =>
      candidate.turn === turn
        ? { ...candidate, entries: candidate.entries.map((entry) => (entry.path === relative ? { ...entry, review } : entry)) }
        : candidate,
    );
    const settled = this.turns.find((candidate) => candidate.turn === turn)?.entries.find((entry) => entry.path === relative);
    assert(settled?.review === review, 'ChangeLedger.settle: the review is recorded');
  }

  private relative(file: string): string | undefined {
    const absolute = path.resolve(this.root, file);
    const relative = path.relative(this.root, absolute);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      return undefined; // Outside the project: not Stacki's to undo.
    }
    return relative.split(path.sep).join('/');
  }

  private absolute(relative: string): string {
    const absolute = path.join(this.root, ...relative.split('/'));
    assert(this.relative(absolute) === relative, 'ChangeLedger.absolute: stays inside the project');
    return absolute;
  }
}

/**
 * The merge an undo becomes when the file moved on: base is the agent's
 * version, "ours" the file as it is now, "theirs" the version before the turn.
 * Lines only one side touched combine; the rest are the person's to choose.
 */
export function undoParts(agentText: string, currentText: string, beforeText: string): readonly ConflictPart[] {
  const runs = threeWay(agentText.split('\n'), currentText.split('\n'), beforeText.split('\n'));
  const parts: ConflictPart[] = runs.map((run): ConflictPart => {
    if (!('ours' in run)) {
      return { kind: 'same', text: run.common.join('\n') };
    }
    const ours = run.ours.join('\n');
    const theirs = run.theirs.join('\n');
    const changedBy = run.changedBy ?? 'both';
    const merged = changedBy === 'both' && run.base !== undefined ? mergeInline(run.base.join('\n'), ours, theirs) : undefined;
    return merged === undefined ? { kind: 'clash', ours, theirs, changedBy } : { kind: 'clash', ours, theirs, changedBy, merged };
  });
  assert(parts.length === runs.length, 'undoParts: one part per run');
  return parts;
}

function isPicks(resolution: MergeResolution): resolution is readonly MergePick[] {
  return Array.isArray(resolution);
}

function changeKind(entry: LedgerEntry): FileChangeKind {
  if (entry.before === undefined) {
    return 'created';
  }
  return entry.after === undefined ? 'deleted' : 'modified';
}

/** The reviews file, parsed; anything malformed is dropped (the edits themselves are already on disk). */
export function parseLedgerTurns(input: unknown): readonly LedgerTurn[] {
  const turns = toArray(toRecord(input)?.['turns']) ?? [];
  const parsed: LedgerTurn[] = [];
  for (const value of turns.slice(-AI_LIMITS.ledgerTurnsMax)) {
    const turn = toRecord(value);
    const entries = toArray(turn?.['entries']);
    if (turn === undefined || entries === undefined || typeof turn['turn'] !== 'string') {
      continue;
    }
    try {
      parsed.push({ turn: toTurnId(turn['turn']), entries: entries.slice(0, AI_LIMITS.ledgerFilesMax).flatMap(parseEntry) });
    } catch {
      continue;
    }
  }
  return parsed;
}

function parseEntry(input: unknown): readonly LedgerEntry[] {
  const entry = toRecord(input);
  const review = entry?.['review'];
  if (entry === undefined || typeof entry['path'] !== 'string' || (review !== 'pending' && review !== 'kept' && review !== 'undone')) {
    return [];
  }
  const before = entry['before'];
  const after = entry['after'];
  if ((before !== undefined && typeof before !== 'string') || (after !== undefined && typeof after !== 'string')) {
    return [];
  }
  return [{ path: entry['path'], before, after, review }];
}

export function serializeLedger(turns: readonly LedgerTurn[]): string {
  // Settled entries keep no content: only pending ones can still be undone.
  const kept = turns.map((turn) => ({
    turn: turn.turn,
    entries: turn.entries.map((entry) => (entry.review === 'pending' ? entry : { path: entry.path, review: entry.review, before: '', after: '' })),
  }));
  return `${JSON.stringify({ version: 1, turns: kept })}\n`;
}
