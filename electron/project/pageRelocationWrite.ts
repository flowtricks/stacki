// Writing one Page settings step — a rename, a homepage swap, a duplicate or a deletion — all or nothing, and taking
// it back. A step is texts changed in place plus files that move, appear or go. Every byte is checked against what
// the plan read before anything is written; the edited texts are written first (through the document actors, leased
// together), then the files move in two synchronous passes so the dev server never sees a page with stale imports:
//
//   1. Each arriving file's final bytes are staged in the project's .stacki/io (ignored by the watcher).
//   2. Every leaving file is renamed into .stacki/io; then every staged file is renamed to its destination.
//
// A swap's two pages therefore never collide (A → staging, B → staging, then both arrive), a case-only rename on a
// case-insensitive disk works, and each page arrives already holding its rewritten imports. A failure anywhere puts
// back every byte this call changed. The inverse of a step swaps its directions, so Undo and Redo are the same code.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assert } from '../../shared/core/assert';
import { err, ok, type AppError, type Result } from '../../shared/core/result';
import { described } from '../../shared/properties/i18n/messageRef';
import { PAGE_SETTINGS_LIMITS } from '../../shared/properties/pageSettings';
import { createFileExclusive } from '../documents/atomicWrite';
import { prepareAtomicDirectory } from '../documents/atomicDirectory';
import type { RenameText } from './pageRenamePlan';
import type { RenameWriter } from './pageRenameWrite';

/** A file that leaves `from` (holding `before`) and/or arrives at `to` (holding `after`). Paths are project-relative. */
export type FileChange =
  | { readonly kind: 'move'; readonly from: string; readonly to: string; readonly before: string; readonly after: string }
  | { readonly kind: 'create'; readonly to: string; readonly after: string }
  | { readonly kind: 'delete'; readonly from: string; readonly before: string };

export interface RelocationStep {
  readonly root: string;
  /** Files edited in place, at paths no change moves. */
  readonly texts: readonly RenameText[];
  readonly files: readonly FileChange[];
}

/** The step run backwards: every text swaps before and after, every file goes back where it came from. */
export function inverseStep(step: RelocationStep): RelocationStep {
  return {
    root: step.root,
    texts: step.texts.map((entry) => ({ file: entry.file, before: entry.after, after: entry.before })),
    files: step.files.map((change): FileChange => {
      switch (change.kind) {
        case 'move':
          return { kind: 'move', from: change.to, to: change.from, before: change.after, after: change.before };
        case 'create':
          return { kind: 'delete', from: change.to, before: change.after };
        case 'delete':
          return { kind: 'create', to: change.from, after: change.before };
        default: {
          const exhaustive: never = change;
          return exhaustive;
        }
      }
    }),
  };
}

export function applyRelocationStep(step: RelocationStep, writer: RenameWriter): Result<void> {
  assert(path.isAbsolute(step.root), 'A page settings step writes under an absolute project root');
  assert(step.files.length + step.texts.length > 0, 'A page settings step changes something');
  assert(step.files.length <= PAGE_SETTINGS_LIMITS.movesMax, 'A page settings step moves at most two files');
  const checked = checkBefore(step, writer);
  if (!checked.ok) {
    return checked;
  }
  const texts = step.texts.map((entry) => ({ ...entry, file: absolute(step.root, entry.file) }));
  return writer.lease(texts, () => writeLeased(step, texts, writer));
}

// Every byte as the plan read it, and every destination free (or about to be freed by this same step).
function checkBefore(step: RelocationStep, writer: RenameWriter): Result<void> {
  for (const entry of step.texts) {
    const current = writer.current(absolute(step.root, entry.file));
    if (!current.ok || current.value !== entry.before) {
      return err({ code: 'conflict', ...described('pages.rename.error.fileChanged', { file: entry.file }) });
    }
  }
  const leaving = step.files.flatMap((change) => (change.kind === 'create' ? [] : [change.from.toLowerCase()]));
  for (const change of step.files) {
    if (change.kind !== 'create') {
      const current = writer.current(absolute(step.root, change.from));
      if (!current.ok || current.value !== change.before) {
        return err({ code: 'conflict', ...described('pages.rename.error.fileChanged', { file: change.from }) });
      }
    }
    if (change.kind !== 'delete') {
      // On a case-insensitive disk `About.astro` is `about.astro`: a destination that is a leaving file is free.
      const freed = leaving.includes(change.to.toLowerCase());
      if (!freed && fs.existsSync(absolute(step.root, change.to))) {
        return err({ code: 'conflict', ...described('pages.rename.error.exists') });
      }
    }
  }
  return ok(undefined);
}

interface Staged {
  readonly change: FileChange;
  /** Where the arriving bytes wait; undefined for a deletion. */
  readonly arriving: string | undefined;
  /** Where the leaving file waits once moved out; undefined for a creation. */
  readonly parked: string | undefined;
}

function writeLeased(step: RelocationStep, texts: readonly RenameText[], writer: RenameWriter): Result<void> {
  const staged = stageArrivals(step);
  if (!staged.ok) {
    return staged;
  }
  const written: RenameText[] = [];
  for (const entry of texts) {
    const saved = writer.write(entry);
    if (!saved.ok) {
      discardStaged(staged.value);
      // The failed write is included: a filesystem error can come after the replacement.
      return putBack([...written, entry], saved.error, writer);
    }
    written.push(entry);
  }
  const moved = moveFiles(step.root, staged.value);
  if (!moved.ok) {
    discardStaged(staged.value);
    return putBack(written, moved.error, writer);
  }
  discardStaged(staged.value);
  for (const change of step.files) {
    if (change.kind !== 'delete') {
      assert(fs.existsSync(absolute(step.root, change.to)), 'Every arriving file is at its destination');
    }
  }
  return ok(undefined);
}

function stageArrivals(step: RelocationStep): Result<readonly Staged[]> {
  const directory = prepareAtomicDirectory(absolute(step.root, 'package.json'));
  if (!directory.ok) {
    return err({ code: 'filesystem', message: directory.error.message });
  }
  const id = randomUUID();
  const staged: Staged[] = [];
  for (const [index, change] of step.files.entries()) {
    const parked = change.kind === 'create' ? undefined : path.join(directory.value, `page-settings-${id}-${index}.leaving`);
    if (change.kind === 'delete') {
      staged.push({ change, arriving: undefined, parked });
      continue;
    }
    const arriving = path.join(directory.value, `page-settings-${id}-${index}.arriving`);
    const created = createFileExclusive(arriving, Buffer.from(change.after, 'utf8'));
    if (!created.ok) {
      discardStaged(staged);
      return err({ code: 'filesystem', message: created.error.message });
    }
    assert(fs.readFileSync(arriving).equals(Buffer.from(change.after, 'utf8')), 'The staged file holds the planned bytes');
    staged.push({ change, arriving, parked });
  }
  return ok(staged);
}

// Out first, then in: between the two passes the leaving files are parked, so no arrival overwrites one.
function moveFiles(root: string, staged: readonly Staged[]): Result<void> {
  const parkedDone: Staged[] = [];
  const arrivedDone: Staged[] = [];
  try {
    for (const entry of staged) {
      if (entry.change.kind !== 'create' && entry.parked !== undefined) {
        fs.renameSync(absolute(root, entry.change.from), entry.parked);
        parkedDone.push(entry);
      }
    }
    for (const entry of staged) {
      if (entry.change.kind !== 'delete' && entry.arriving !== undefined) {
        const target = absolute(root, entry.change.to);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(entry.arriving, target);
        arrivedDone.push(entry);
      }
    }
    return ok(undefined);
  } catch (error: unknown) {
    const undone = undoMoves(root, parkedDone, arrivedDone);
    const detail = error instanceof Error ? error.message : String(error);
    return err(undone ? { code: 'filesystem', message: detail } : { code: 'rollback', message: detail });
  }
}

// Arrivals go back to staging, parked files go home. Answers whether everything was put back.
function undoMoves(root: string, parked: readonly Staged[], arrived: readonly Staged[]): boolean {
  let restored = true;
  for (const entry of [...arrived].reverse()) {
    if (entry.change.kind !== 'delete' && entry.arriving !== undefined) {
      try {
        fs.renameSync(absolute(root, entry.change.to), entry.arriving);
      } catch {
        restored = false;
      }
    }
  }
  for (const entry of [...parked].reverse()) {
    if (entry.change.kind !== 'create' && entry.parked !== undefined) {
      try {
        fs.renameSync(entry.parked, absolute(root, entry.change.from));
      } catch {
        restored = false;
      }
    }
  }
  return restored;
}

function discardStaged(staged: readonly Staged[]): void {
  for (const entry of staged) {
    for (const file of [entry.arriving, entry.parked]) {
      if (file !== undefined) {
        fs.rmSync(file, { force: true });
      }
    }
  }
}

function putBack(written: readonly RenameText[], cause: AppError, writer: RenameWriter): Result<never> {
  const failed: string[] = [];
  for (const entry of [...written].reverse()) {
    const current = writer.current(entry.file);
    if (current.ok && current.value === entry.before) {
      continue;
    }
    if (!writer.write({ ...entry, before: entry.after, after: entry.before }).ok) {
      failed.push(entry.file);
    }
  }
  return err(
    failed.length > 0
      ? { code: 'rollback', ...described('pages.rename.error.restoreFailed', { detail: cause.message, files: failed.join(', ') }) }
      : { code: 'filesystem', ...described('pages.rename.error.restored', { detail: cause.message }) },
  );
}

function absolute(root: string, file: string): string {
  return path.join(root, ...file.split('/'));
}

/** Steps main can still take back, oldest forgotten first (PAGE_SETTINGS_LIMITS.undoEntriesMax). */
export class RelocationStore {
  readonly #entries = new Map<string, RelocationStep>();
  #next = 0;

  record(step: RelocationStep): string {
    this.#next += 1;
    const token = `page-settings-${this.#next}`;
    this.#entries.set(token, step);
    while (this.#entries.size > PAGE_SETTINGS_LIMITS.undoEntriesMax) {
      const oldest = this.#entries.keys().next();
      assert(oldest.done !== true, 'A store over its bound has an oldest entry');
      this.#entries.delete(oldest.value);
    }
    assert(this.#entries.size <= PAGE_SETTINGS_LIMITS.undoEntriesMax, 'The store stays within its bound');
    return token;
  }

  get(token: string): RelocationStep | undefined {
    return this.#entries.get(token);
  }
}
