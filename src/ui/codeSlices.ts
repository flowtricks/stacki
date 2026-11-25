// Slicing for work that is proportional to the size of the text: syntax
// colouring of a page of any length. Stacki has no size limit, so a colouring
// pass must never run as one synchronous block over the whole text. It cuts the
// text into slices of whole lines, does a bounded amount of work per slice, and
// lets the event loop run between slices, so the first window is coloured at
// once and the rest follows without a frame being lost.

import { assert } from '../../shared/core/assert';

/** A run of whole lines. `text.slice(start, end)` is those lines without the line break after the last one. */
export interface LineSlice {
  readonly start: number;
  readonly end: number;
  /** The slice that reaches the end of the text. */
  readonly last: boolean;
}

/**
 * The slice of whole lines that begins at `start` and holds at most `charsMax`
 * characters, or the one line that is longer than that on its own: a line is
 * the unit a grammar's state is carried across, so it is never cut. `start`
 * is the first character of a line.
 */
export function nextLineSlice(text: string, start: number, charsMax: number): LineSlice {
  assert(Number.isSafeInteger(charsMax), 'nextLineSlice: the slice size is a safe integer');
  assert(charsMax > 0, 'nextLineSlice: a slice holds at least one character');
  assert(start >= 0, 'nextLineSlice: a slice starts inside the text');
  assert(start <= text.length, 'nextLineSlice: a slice does not start past the text');
  const limit = start + charsMax;
  if (limit >= text.length) {
    return { start, end: text.length, last: true };
  }
  const lastBreak = text.lastIndexOf('\n', limit);
  const lineEnd = lastBreak >= start ? lastBreak : text.indexOf('\n', start);
  if (lineEnd < 0) {
    return { start, end: text.length, last: true };
  }
  assert(lineEnd >= start, 'nextLineSlice: a slice ends at or after its start');
  return { start, end: lineEnd, last: false };
}

/** What a slice needs of a document that is not one string, such as a CodeMirror `Text`. */
export interface LineIndex {
  readonly length: number;
  lineAt(position: number): { readonly from: number; readonly to: number };
}

/**
 * `nextLineSlice` for a document held as a line tree: it finds the slice's end
 * by line lookups, so a page of any length is never joined into one string.
 */
export function nextDocumentLineSlice(document: LineIndex, start: number, charsMax: number): LineSlice {
  assert(charsMax > 0, 'nextDocumentLineSlice: a slice holds at least one character');
  assert(start >= 0, 'nextDocumentLineSlice: a slice starts inside the document');
  assert(start <= document.length, 'nextDocumentLineSlice: a slice does not start past the document');
  const limit = start + charsMax;
  if (limit >= document.length) {
    return { start, end: document.length, last: true };
  }
  const line = document.lineAt(limit);
  // The limit falls inside `line`: the slice ends with the line before it, or,
  // when that would leave the slice empty, with `line` itself.
  const end = line.from > start ? line.from - 1 : line.to;
  assert(end >= start, 'nextDocumentLineSlice: a slice ends at or after its start');
  return { start, end, last: end >= document.length };
}

/** The slices that cover `text`, one at a time, from `start` (the first character of a line). */
export function* lineSlices(text: string, start: number, charsMax: number): Generator<LineSlice> {
  let cursor = start;
  // Every slice but the last ends on a line break, and the next one starts after
  // it, so the cursor advances by at least one character per slice and the
  // text's own length bounds the loop.
  for (let steps = 0; steps <= text.length + 1; steps++) {
    const slice = nextLineSlice(text, cursor, charsMax);
    yield slice;
    if (slice.last) {
      return;
    }
    assert(slice.end + 1 > cursor, 'lineSlices: every slice advances');
    cursor = slice.end + 1;
  }
  assert(false, 'lineSlices: the text ran out before the slices did');
}

/**
 * Lets the event loop run: input, painting and timers go ahead of the next
 * slice. A timer rather than a message channel, because an open channel keeps
 * a Node process alive and the same module runs under the test runner.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}
