// One open instructions file, as a value: the text on disk the editor started
// from (`base`), the text the person has now (`draft`), and an outside change
// that met unsaved edits (`conflict`). The view owns the session in state and
// runs these transitions; they never touch the disk. The rules:
//
// - Opening and closing without an edit never writes: `dirty` is false while
//   the draft is the base, byte for byte.
// - A save is witnessed by `base`; main refuses it when the file moved on.
// - An outside change reloads the editor when nothing is unsaved, and is
//   ignored when it holds what the editor already has.
// - Otherwise it is a conflict, and the person chooses: keep theirs, keep
//   mine (saved over theirs), or merge both when the changes do not overlap
//   (`mergeTyping`, the code editor's three-way merge).
import { assert } from '../../../shared/core/assert';
import { mergeTyping } from '../../../shared/engine/codePatch';

export interface DocumentSession {
  readonly file: string;
  readonly base: string;
  readonly draft: string;
  readonly conflict: DocumentConflict | undefined;
}

export interface DocumentConflict {
  /** What the disk holds now. */
  readonly theirs: string;
  /** Both sides merged, when their changes do not touch; undefined when the person must pick one. */
  readonly merged: string | undefined;
}

export type ConflictChoice = 'theirs' | 'mine' | 'merge';

export function openSession(file: string, source: string): DocumentSession {
  return { file, base: source, draft: source, conflict: undefined };
}

export function isDirty(session: DocumentSession): boolean {
  return session.draft !== session.base;
}

/** The person typed: the draft moves, the base stays the text it was edited from. */
export function edited(session: DocumentSession, draft: string): DocumentSession {
  return { ...session, draft };
}

/** A save landed: the disk now holds `saved`. Typing that came after it stays a draft. */
export function saved(session: DocumentSession, written: string, saved: string): DocumentSession {
  assert(written === saved, 'A save reads back what it wrote');
  return { ...session, base: saved };
}

/** The disk holds `theirs`, written outside the editor (or found when a save was refused). */
export function changedOnDisk(session: DocumentSession, theirs: string): DocumentSession {
  if (theirs === session.base) {
    return session;
  }
  if (theirs === session.draft) {
    // The disk caught up with the editor (a save heard back, or the same edit made twice).
    return { ...session, base: theirs, conflict: undefined };
  }
  if (!isDirty(session)) {
    return { ...session, base: theirs, draft: theirs, conflict: undefined };
  }
  const merge = mergeTyping(session.base, session.draft, theirs);
  return { ...session, conflict: { theirs, merged: merge.ok ? merge.value : undefined } };
}

/** The person chose how to settle a conflict. `mine` and `merge` leave a draft to save over `theirs`. */
export function resolved(session: DocumentSession, choice: ConflictChoice): DocumentSession {
  const conflict = session.conflict;
  assert(conflict !== undefined, 'Only a conflict is resolved');
  switch (choice) {
    case 'theirs':
      return { ...session, base: conflict.theirs, draft: conflict.theirs, conflict: undefined };
    case 'mine':
      return { ...session, base: conflict.theirs, conflict: undefined };
    case 'merge': {
      assert(conflict.merged !== undefined, 'Merge is offered only when both sides merge');
      return { ...session, base: conflict.theirs, draft: conflict.merged, conflict: undefined };
    }
    default: {
      const exhaustive: never = choice;
      return exhaustive;
    }
  }
}

/** Whether a save may start now: unsaved edits and no conflict waiting on the person. */
export function shouldSave(session: DocumentSession): boolean {
  if (session.conflict !== undefined) {
    return false;
  }
  return isDirty(session);
}
