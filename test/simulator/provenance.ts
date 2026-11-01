// Byte provenance: the ground truth a remapped intent is judged against (step
// 3). Every byte a simulated writer puts on the fake disk carries an origin
// number, and a byte a writer keeps keeps its origin. The simulator knows what
// each writer did — it did it — so "where did the authored element go?" has an
// exact answer that owes nothing to the diff: follow the origins. The mapper
// never sees them; the judge (remapJudge.ts) compares its answer with theirs.
//
// Origins are unique within one version of a file: fresh ones come from one
// counter per run, and every writer below keeps an existing origin at most once.
import { assert } from '#dist/shared/core/assert.js';
import type { Splice } from '#dist/shared/engine/planner.js';
import { toByteSpan, toByteString, type ByteSpan, type ByteString } from '#dist/shared/core/span.js';
import { orderedSplices } from '#dist/shared/engine/splice.js';

/** One origin per byte of one version of a file. */
export type Origins = readonly number[];

const CARRIAGE_RETURN = 0x0d;
const LINE_FEED = 0x0a;

/** Hands out origins no byte has had before. */
export class OriginSource {
  private next = 0;

  fresh(count: number): Origins {
    assert(Number.isSafeInteger(count), 'Origin count is an integer');
    assert(count >= 0, 'Origin count is nonnegative');
    const first = this.next;
    this.next += count;
    assert(Number.isSafeInteger(this.next), 'Origins stay safe integers');
    return Array.from({ length: count }, (_, index) => first + index);
  }
}

/** A writer inserted `count` new bytes at `at` and kept everything else. */
export function insertOrigins(origins: Origins, at: number, inserted: Origins): Origins {
  assert(at <= origins.length, 'An insertion point lies inside the file');
  return [...origins.slice(0, at), ...inserted, ...origins.slice(at)];
}

/** The actor applied `splices`. Bytes outside them keep their origins; inside,
 * the bytes a replacement shares with its witness at either end keep theirs —
 * a code save that appends to the file keeps the file — and the rest are new. */
export function spliceOrigins(origins: Origins, splices: readonly Splice[], source: OriginSource): Origins {
  const result: number[] = [];
  let cursor = 0;
  for (const splice of orderedSplices(splices)) {
    result.push(...origins.slice(cursor, splice.range.start));
    const kept = origins.slice(splice.range.start, splice.range.end);
    const expected = splice.expectedBytes;
    const replacement = splice.replacementBytes;
    const prefix = commonPrefix(expected, replacement);
    const suffix = commonSuffix(expected, replacement, prefix);
    const middle = replacement.length - prefix - suffix;
    result.push(...kept.slice(0, prefix), ...source.fresh(middle));
    result.push(...kept.slice(kept.length - suffix));
    cursor = splice.range.end;
  }
  result.push(...origins.slice(cursor));
  return result;
}

/** The actor applied an undo: each of its splices writes back the bytes one
 * splice of the undone edit replaced, in order, so those bytes get the origins
 * they had before that edit (`restored`, per splice) — the core between their
 * leading and trailing separators, as a move carries (a mapped undo may put
 * them beside other blocks, and the blank lines around them are rewritten).
 * A splice whose bytes do not match in length falls back to new origins, as
 * every splice does when the counts differ. */
export function restoreOrigins(origins: Origins, splices: readonly Splice[], restored: readonly Origins[], source: OriginSource): Origins {
  const ordered = orderedSplices(splices);
  if (ordered.length !== restored.length) {
    return spliceOrigins(origins, splices, source);
  }
  const result: number[] = [];
  let cursor = 0;
  ordered.forEach((splice, index) => {
    result.push(...origins.slice(cursor, splice.range.start));
    const back = restored[index];
    assert(back !== undefined, 'Every splice has its restored origins');
    const bytes = splice.replacementBytes;
    if (back.length === bytes.length) {
      const core = coreOf(bytes);
      result.push(...source.fresh(core.start));
      result.push(...back.slice(core.start, core.end));
      result.push(...source.fresh(bytes.length - core.end));
    } else {
      result.push(...source.fresh(bytes.length));
    }
    cursor = splice.range.end;
  });
  result.push(...origins.slice(cursor));
  return result;
}

/** Cells the move alignment may fill: a move of a block of a few hundred
 * bytes. Past it the relocated bytes are counted new, which only makes the
 * judge call the moved node gone (unjudged, never a false pass). */
const ALIGN_CELLS_MAX = 4_000_000;

/** The actor applied a move (step 10 made moves common): its removal's bytes
 * reappear in its insertion, relocated and not new — re-prefixed for another
 * container, beside a new separator. The bytes the two share, aligned in
 * order (a longest common subsequence), keep their origins in their new
 * place; the rest of the insertion and whatever the removal writes are new.
 * Each origin still appears at most once: the removed bytes are gone. */
export function moveOrigins(origins: Origins, splices: readonly Splice[], source: OriginSource): Origins {
  const ordered = orderedSplices(splices);
  const [first, second] = ordered;
  assert(ordered.length === 2, 'A move is an insertion and a removal');
  assert(first !== undefined, 'The first splice exists');
  assert(second !== undefined, 'The second splice exists');
  const removal = first.expectedBytes.length >= second.expectedBytes.length ? first : second;
  const insertion = removal === first ? second : first;
  const removed = origins.slice(removal.range.start, removal.range.end);
  const relocated = alignedOrigins({ bytes: removal.expectedBytes, origins: removed }, insertion.replacementBytes, source);
  const result: number[] = [];
  let cursor = 0;
  for (const splice of ordered) {
    result.push(...origins.slice(cursor, splice.range.start));
    if (splice === insertion) {
      result.push(...relocated);
    } else {
      result.push(...source.fresh(splice.replacementBytes.length));
    }
    cursor = splice.range.end;
  }
  result.push(...origins.slice(cursor));
  return result;
}

// Origins for `target`: each byte aligned with a byte of `from` takes its
// origin, the others fresh ones. What a move carries is its node; the
// separators around it (the whitespace, line breaks and a quote's `>` at
// either end of each side) are rewritten, never carried, so only the two
// cores between them are aligned. The alignment is the heaviest common
// subsequence, content bytes weighing more than separator bytes, so
// "\r\n\r\nNew." moved to "New.\r\n\r\n" keeps the origins of "New.".
function alignedOrigins(from: { readonly bytes: ByteString; readonly origins: Origins }, target: ByteString, source: OriginSource): number[] {
  const fromCore = coreOf(from.bytes);
  const targetCore = coreOf(target);
  const inner = alignedCore(
    {
      bytes: toByteString(from.bytes.subarray(fromCore.start, fromCore.end)),
      origins: from.origins.slice(fromCore.start, fromCore.end),
    },
    toByteString(target.subarray(targetCore.start, targetCore.end)),
    source,
  );
  const lead = source.fresh(targetCore.start);
  const trail = source.fresh(target.length - targetCore.end);
  const out = [...lead, ...inner, ...trail];
  assert(out.length === target.length, 'Every target byte has an origin');
  return out;
}

// The bytes between the leading and the trailing separator bytes.
function coreOf(bytes: ByteString): ByteSpan {
  let start = 0;
  while (start < bytes.length && alignWeight(bytes[start] ?? 0) === 1) {
    start++;
  }
  let end = bytes.length;
  while (end > start && alignWeight(bytes[end - 1] ?? 0) === 1) {
    end--;
  }
  return toByteSpan(start, end);
}

function alignedCore(from: { readonly bytes: ByteString; readonly origins: Origins }, target: ByteString, source: OriginSource): number[] {
  const rows = from.bytes.length + 1;
  const columns = target.length + 1;
  if (rows * columns > ALIGN_CELLS_MAX) {
    return [...source.fresh(target.length)];
  }
  // best[i][j]: the heaviest alignment of the suffixes from i and j.
  const best = new Int32Array(rows * columns);
  const at = (row: number, column: number) => best[row * columns + column] ?? 0;
  for (let i = from.bytes.length - 1; i >= 0; i--) {
    for (let j = target.length - 1; j >= 0; j--) {
      const skip = Math.max(at(i + 1, j), at(i, j + 1));
      const byte = from.bytes[i];
      const take = byte !== undefined && byte === target[j] ? alignWeight(byte) + at(i + 1, j + 1) : -1;
      best[i * columns + j] = Math.max(skip, take);
    }
  }
  const matched = new Array<number | undefined>(target.length).fill(undefined);
  let i = 0;
  let j = 0;
  while (i < from.bytes.length && j < target.length) {
    const byte = from.bytes[i];
    if (byte !== undefined && byte === target[j]) {
      if (at(i, j) === alignWeight(byte) + at(i + 1, j + 1)) {
        matched[j] = from.origins[i];
        i++;
        j++;
        continue;
      }
    }
    if (at(i + 1, j) >= at(i, j + 1)) {
      i++;
    } else {
      j++;
    }
  }
  const out = matched.map((origin) => origin ?? source.fresh(1)[0] ?? -1);
  assert(out.length === target.length, 'Every target byte has an origin');
  return out;
}

// Separator bytes weigh 1, content bytes 4.
function alignWeight(byte: number): number {
  switch (byte) {
    case 0x20:
    case 0x09:
    case 0x0a:
    case 0x0d:
    case 0x3e:
      return 1;
    default:
      return 4;
  }
}

/** A formatter flipped every line ending: CRLF to LF drops each CR, LF to
 * CRLF adds a new CR before each LF. The LF bytes keep their origins. */
export function lineEndingOrigins(bytes: ByteString, origins: Origins, direction: 'to-lf' | 'to-crlf', source: OriginSource): Origins {
  assert(bytes.length === origins.length, 'Origins describe these bytes');
  const result: number[] = [];
  for (let index = 0; index < bytes.length; index++) {
    const origin = origins[index];
    assert(origin !== undefined, 'Every byte has an origin');
    const byte = bytes[index];
    if (direction === 'to-lf') {
      if (byte === CARRIAGE_RETURN) {
        if (bytes[index + 1] === LINE_FEED) {
          continue;
        }
      }
    } else if (byte === LINE_FEED) {
      result.push(...source.fresh(1));
    }
    result.push(origin);
  }
  return result;
}

/** Where `span` of the authored version sits in the current one, when every
 * one of its bytes survived, in order and contiguous; undefined otherwise. */
export function survivingSpan(authored: Origins, span: ByteSpan, current: Origins): ByteSpan | undefined {
  assert(span.start < span.end, 'Only non-empty spans are followed');
  assert(span.end <= authored.length, 'The span lies inside the authored version');
  const first = authored[span.start];
  assert(first !== undefined, 'The span has a first byte');
  const start = current.indexOf(first);
  if (start < 0) {
    return undefined;
  }
  const length = span.end - span.start;
  for (let offset = 1; offset < length; offset++) {
    if (current[start + offset] !== authored[span.start + offset]) {
      return undefined;
    }
  }
  return toByteSpan(start, start + length);
}

function commonPrefix(left: ByteString, right: ByteString): number {
  const bound = Math.min(left.length, right.length);
  let length = 0;
  while (length < bound) {
    if (left[length] !== right[length]) {
      break;
    }
    length += 1;
  }
  return length;
}

function commonSuffix(left: ByteString, right: ByteString, prefix: number): number {
  const bound = Math.min(left.length, right.length) - prefix;
  let length = 0;
  while (length < bound) {
    if (left[left.length - 1 - length] !== right[right.length - 1 - length]) {
      break;
    }
    length += 1;
  }
  return length;
}
