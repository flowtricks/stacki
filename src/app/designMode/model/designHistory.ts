// Design mode's undo history: whole states, never inverse operations. A frame step keeps the frame's body as
// it was before and after the gesture; a frames step keeps the list of frames (and the documents of any it
// removed). Bounded by entries and by characters, dropping the oldest first.
import { DESIGN_LIMITS, type DesignElementId, type DesignFrameRecord, type FrameId } from './designTypes';

/** A frame's body as text: its attributes and its inner HTML. The head never changes in history (added styles stay). */
export interface BodyState {
  readonly attributes: readonly (readonly [string, string])[];
  readonly inner: string;
}

export interface SelectionState {
  readonly frame: FrameId;
  readonly ids: readonly DesignElementId[];
}

export type HistoryEntry =
  | {
      readonly kind: 'frame';
      readonly frame: FrameId;
      readonly before: BodyState;
      readonly after: BodyState;
      readonly selectionBefore: SelectionState | undefined;
      readonly selectionAfter: SelectionState | undefined;
    }
  | {
      readonly kind: 'frames';
      readonly before: readonly DesignFrameRecord[];
      readonly after: readonly DesignFrameRecord[];
      /** The full documents of frames this step removed or added, so undo and redo can bring them back. */
      readonly documents: ReadonlyMap<FrameId, string>;
    };

function sizeOf(entry: HistoryEntry): number {
  if (entry.kind === 'frame') {
    return entry.before.inner.length + entry.after.inner.length;
  }
  let chars = 0;
  for (const html of entry.documents.values()) {
    chars += html.length;
  }
  return chars;
}

export class DesignHistory {
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  private chars = 0;

  push(entry: HistoryEntry): void {
    if (entry.kind === 'frame' && entry.before.inner === entry.after.inner && sameAttributes(entry.before, entry.after)) {
      return; // A gesture that changed nothing is not a step.
    }
    this.past.push(entry);
    this.chars += sizeOf(entry);
    for (const dropped of this.future) {
      this.chars -= sizeOf(dropped);
    }
    this.future = [];
    while (this.past.length > DESIGN_LIMITS.historyEntriesMax || (this.chars > DESIGN_LIMITS.historyCharsMax && this.past.length > 1)) {
      const oldest = this.past.shift();
      if (oldest === undefined) {
        break;
      }
      this.chars -= sizeOf(oldest);
    }
    if (this.chars < 0) {
      throw new Error('Assertion failed: DesignHistory: the character count is never negative');
    }
  }

  /** The step to undo, moved to the redo side. */
  undo(): HistoryEntry | undefined {
    const entry = this.past.pop();
    if (entry !== undefined) {
      this.future.push(entry);
    }
    return entry;
  }

  /** The step to redo, moved back to the undo side. */
  redo(): HistoryEntry | undefined {
    const entry = this.future.pop();
    if (entry !== undefined) {
      this.past.push(entry);
    }
    return entry;
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }

  clear(): void {
    this.past = [];
    this.future = [];
    this.chars = 0;
  }
}

function sameAttributes(first: BodyState, second: BodyState): boolean {
  if (first.attributes.length !== second.attributes.length) {
    return false;
  }
  return first.attributes.every(([name, value], index) => second.attributes[index]?.[0] === name && second.attributes[index]?.[1] === value);
}

export function bodyStateOf(document: Document): BodyState {
  const body = document.body;
  if (body === null) {
    throw new Error('Assertion failed: bodyStateOf: a frame document has a body');
  }
  return { attributes: body.getAttributeNames().map((name) => [name, body.getAttribute(name) ?? ''] as const), inner: body.innerHTML };
}

export function restoreBodyState(document: Document, state: BodyState): void {
  const body = document.body;
  if (body === null) {
    throw new Error('Assertion failed: restoreBodyState: a frame document has a body');
  }
  for (const name of body.getAttributeNames()) {
    body.removeAttribute(name);
  }
  for (const [name, value] of state.attributes) {
    body.setAttribute(name, value);
  }
  body.innerHTML = state.inner;
}
