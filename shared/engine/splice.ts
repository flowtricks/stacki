// Applying splices, the only write primitive (plan §3.4). The expected bytes are
// the witness: a splice applies only where its range still holds exactly the
// bytes the plan saw. Promoted from the simulator at step 5, so the document
// actor and the simulator apply splices through one implementation.
//
// Pure: bytes in, bytes out. Nothing here touches a disk or a clock.
import { assert } from '../core/assert';
import { LIMITS } from '../core/limits';
import type { SourceEdit } from './intent';
import type { Splice } from './planner';
import { byteStringsEqual, decodeUtf8, toByteSpan, toByteString, type ByteSpan, type ByteString } from '../core/span';

/** Whether every splice's range holds its expected bytes (plan §5.2 step 4). */
export function witnessesHold(bytes: ByteString, splices: readonly Splice[]): boolean {
  return splices.every((splice) => {
    if (splice.range.end <= bytes.length) {
      const found = toByteString(bytes.subarray(splice.range.start, splice.range.end));
      return byteStringsEqual(found, splice.expectedBytes);
    }
    return false;
  });
}

/** Splices sorted by start, checked disjoint. Overlapping splices would make the
 * result depend on application order — a planner bug, so it asserts. */
export function orderedSplices(splices: readonly Splice[]): readonly Splice[] {
  const ordered = [...splices].sort((left, right) => left.range.start - right.range.start);
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    assert(previous !== undefined, 'Previous splice exists');
    assert(current !== undefined, 'Current splice exists');
    assert(previous.range.end <= current.range.start, 'Splices do not overlap');
  }
  return ordered;
}

/** Apply splices in memory (plan §5.2 step 5). Witnesses were verified by the
 * caller; they are asserted again here, the pair on the other side.
 *
 * The plan says "descending offset": applied in place, a later splice must land
 * first so earlier offsets do not shift. This builds a new buffer instead, by
 * copying the untouched gaps between ascending, disjoint ranges of the original
 * — no offset ever shifts, so the result is the descending in-place result. */
export function applySplices(bytes: ByteString, splices: readonly Splice[]): ByteString {
  assert(witnessesHold(bytes, splices), 'Every witness holds at apply time');
  const ordered = orderedSplices(splices);
  const size = bytes.length + sizeDelta(ordered);
  assert(size >= 0, 'A result has a nonnegative size');
  const result = new Uint8Array(size);
  let cursorSource = 0;
  let cursorTarget = 0;
  for (const splice of ordered) {
    const gap = bytes.subarray(cursorSource, splice.range.start);
    result.set(gap, cursorTarget);
    cursorTarget += gap.length;
    result.set(splice.replacementBytes, cursorTarget);
    cursorTarget += splice.replacementBytes.length;
    cursorSource = splice.range.end;
  }
  result.set(bytes.subarray(cursorSource), cursorTarget);
  assert(cursorTarget + bytes.length - cursorSource === size, 'The result is exactly filled');
  return toByteString(result);
}

/** Where each splice's replacement landed in the result, ascending. */
export function changedRanges(splices: readonly Splice[]): readonly ByteSpan[] {
  let delta = 0;
  return orderedSplices(splices).map((splice) => {
    const start = splice.range.start + delta;
    delta += splice.replacementBytes.length - splice.expectedBytes.length;
    return toByteSpan(start, start + splice.replacementBytes.length);
  });
}

/** The inverse of applied splices (plan §11 step 6, Undo on the engine): in
 * the bytes they produced, each changed range goes back to the bytes it
 * replaced. Same ranges, expected and replacement swapped — submitted as a
 * `revert-splices` intent authored against the post-apply checksum, whose
 * planner reads the witness (the replacement bytes) off that snapshot. */
export function inverseEdits(splices: readonly Splice[]): readonly SourceEdit[] {
  const ordered = orderedSplices(splices);
  const ranges = changedRanges(ordered);
  return ordered.map((splice, index) => {
    const span = ranges[index];
    assert(span !== undefined, 'Every splice has a changed range');
    const text = decodeUtf8(splice.expectedBytes);
    // Splices cut at code-point boundaries (spans come from the parser), so
    // the bytes they replaced are text.
    assert(text.ok, 'Replaced bytes decode');
    return { span, text: text.value };
  });
}

/** Several commits' splices as one set against `original`, the bytes the first
 * was planned on: `steps[n]` is stated in the bytes the steps before it left.
 * The result leaves what the steps leave, and names only bytes a step wrote.
 * Why: a batch is written once, and a diff of the two files can place an
 * insertion inside a neighbour that looks like it (`<Accordion />` before a new
 * `<AccordionItem>`), so the neighbour loses its identity to the new node. */
export function composedSplices(original: ByteString, steps: readonly (readonly Splice[])[]): readonly Splice[] {
  assert(steps.length <= LIMITS.intentsPendingMax, 'Composed steps stay inside the queue bound');
  let pieces: readonly Piece[] = original.length === 0 ? [] : [{ tag: 'kept', from: 0, to: original.length }];
  for (const splices of steps) {
    // Last first, so the earlier ranges still index the pieces.
    for (const splice of [...orderedSplices(splices)].reverse()) {
      const [head, rest] = piecesAt(pieces, splice.range.start);
      const [, tail] = piecesAt(rest, splice.range.end - splice.range.start);
      const written: readonly Piece[] = splice.replacementBytes.length === 0 ? [] : [{ tag: 'written', bytes: splice.replacementBytes }];
      pieces = [...head, ...written, ...tail];
    }
  }
  return splicesOfPieces(original, pieces);
}

/** A stretch of a composed result: bytes of the original, or bytes a step wrote. */
type Piece = { readonly tag: 'kept'; readonly from: number; readonly to: number } | { readonly tag: 'written'; readonly bytes: ByteString };

function pieceLength(piece: Piece): number {
  return piece.tag === 'kept' ? piece.to - piece.from : piece.bytes.length;
}

// The pieces cut `offset` bytes in: what lies before, and what follows.
function piecesAt(pieces: readonly Piece[], offset: number): readonly [readonly Piece[], readonly Piece[]] {
  let left = offset;
  for (const [index, piece] of pieces.entries()) {
    if (left === 0) {
      return [pieces.slice(0, index), pieces.slice(index)];
    }
    const length = pieceLength(piece);
    if (left < length) {
      const [first, second]: readonly [Piece, Piece] =
        piece.tag === 'kept'
          ? [
              { tag: 'kept', from: piece.from, to: piece.from + left },
              { tag: 'kept', from: piece.from + left, to: piece.to },
            ]
          : [
              { tag: 'written', bytes: toByteString(piece.bytes.subarray(0, left)) },
              { tag: 'written', bytes: toByteString(piece.bytes.subarray(left)) },
            ];
      return [
        [...pieces.slice(0, index), first],
        [second, ...pieces.slice(index + 1)],
      ];
    }
    left -= length;
  }
  assert(left === 0, 'A splice lies inside the bytes it was planned on');
  return [pieces, []];
}

// Between two kept stretches, one splice: the original bytes dropped there and
// the written bytes standing in their place.
function splicesOfPieces(original: ByteString, pieces: readonly Piece[]): readonly Splice[] {
  const splices: Splice[] = [];
  let cursor = 0;
  let written: ByteString[] = [];
  const close = (until: number): void => {
    assert(cursor <= until, 'Kept bytes stay in their original order');
    const expectedBytes = toByteString(original.subarray(cursor, until));
    const replacementBytes = joined(written);
    if (!byteStringsEqual(expectedBytes, replacementBytes)) {
      splices.push({ range: toByteSpan(cursor, until), expectedBytes, replacementBytes });
    }
    written = [];
  };
  for (const piece of pieces) {
    if (piece.tag === 'written') {
      written.push(piece.bytes);
    } else {
      close(piece.from);
      cursor = piece.to;
    }
  }
  close(original.length);
  return splices;
}

function joined(parts: readonly ByteString[]): ByteString {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  return toByteString(result);
}

function sizeDelta(splices: readonly Splice[]): number {
  return splices.reduce((total, splice) => total + splice.replacementBytes.length - splice.expectedBytes.length, 0);
}
