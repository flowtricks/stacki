// A draft cut at the caret and put back together: how dictation writes where the caret is (a comment pin's box). The
// editor's document holds each chip as one character, so a caret offset counts a chip as one.
import { assert } from '../../../../shared/core/assert';
import type { ComposerSegment, ComposerSegments } from '../../../../shared/properties/ai/mentions';
import { normalizeSegments } from '../mentions/mentionChips';

export interface CaretSplit {
  readonly before: ComposerSegments;
  readonly after: ComposerSegments;
}

/** The characters `segments` take in the editor's document. */
export function documentLengthOf(segments: ComposerSegments): number {
  return segments.reduce((total, segment) => total + (segment.kind === 'text' ? segment.text.length : 1), 0);
}

/** The draft on each side of document offset `caret`. A caret past the end is the end. */
export function splitAtCaret(segments: ComposerSegments, caret: number): CaretSplit {
  assert(Number.isSafeInteger(caret), 'splitAtCaret: the caret is a document offset');
  assert(caret >= 0, 'splitAtCaret: the caret is inside the document');
  const before: ComposerSegment[] = [];
  const after: ComposerSegment[] = [];
  let at = 0;
  for (const segment of segments) {
    const length = segment.kind === 'text' ? segment.text.length : 1;
    if (at + length <= caret) {
      before.push(segment);
    } else if (at >= caret) {
      after.push(segment);
    } else {
      assert(segment.kind === 'text', 'splitAtCaret: only text can be cut inside');
      before.push({ kind: 'text', text: segment.text.slice(0, caret - at) });
      after.push({ kind: 'text', text: segment.text.slice(caret - at) });
    }
    at += length;
  }
  return { before, after };
}

/**
 * The two sides joined again, and where the caret then is: at the end of `before`. Words just written that would run
 * into the word after them get a space, which the caret stays in front of.
 */
export function joinAtCaret(before: ComposerSegments, after: ComposerSegments): { readonly segments: ComposerSegments; readonly caret: number } {
  const last = before[before.length - 1];
  const next = after[0];
  const touching = last?.kind === 'text' && !/\s$/u.test(last.text) && next?.kind === 'text' && /^[\p{L}\p{N}]/u.test(next.text);
  const tail: ComposerSegments = touching ? [{ kind: 'text', text: ' ' }, ...after] : after;
  return { segments: normalizeSegments([...before, ...tail]), caret: documentLengthOf(before) };
}
