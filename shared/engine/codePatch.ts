// Code patches (plan §3.3 `ApplyCodePatch`, §7; step 8). The code editor does
// not send its text: it sends the byte diff from its baseline — the bytes on
// disk its text descends from, named by checksum — to that text. The actor
// splices only the hunks, so an outside edit elsewhere in the file survives
// (a stale hunk is mapped through it), and one that overlaps a hunk is a
// `merge-conflict`, never an overwrite.
//
// A hunk carries its witness: the baseline text it replaces. Main checks it
// against the bytes the checksum names before it builds the intent, so a
// renderer whose text is not of those bytes is refused, not trusted.
//
// Bounds (AGENTS.md §10): the text is at most `sourceBytesMax` bytes, the diff
// spends at most the shared diff budget (past it the patch is the one region
// between the common prefix and suffix — coarser, never wrong), a patch has at
// most `splicesPerIntentMax` hunks, and its replacement bytes are at most
// `intentPayloadBytesMax`: past that it fails with `resource-limit`, never
// truncated.
import { assert } from '../core/assert';
import { DIFF_BUDGET, diffBytes, diffHunks, type Hunk } from './diff';
import { LIMITS } from '../core/limits';
import { err, ok, type Result } from '../core/result';
import { decodeUtf8, encodeUtf8, toByteSpan, toByteString, utf8ByteLength, type ByteSpan, type ByteString } from '../core/span';

/** Replace the baseline bytes at `span`, which hold `expected`, with `text`. */
export interface CodeHunk {
  readonly span: ByteSpan;
  readonly expected: string;
  readonly text: string;
}

/** Matched bytes between two hunks below which they become one. A word
 * rewritten in place diffs as letters around a shared vowel or two; islands
 * that small say nothing about where the edit is, and each one splits the
 * patch into hunks the mapper must place separately. */
const HUNK_GAP_BYTES_MIN = 8;

/** Continuation bytes after a UTF-8 lead byte: at most three. */
const CONTINUATION_BYTES_MAX = 3;

/** The patch from `baseline` to `next`, as ascending, disjoint hunks of the
 * baseline on code-point boundaries. Empty when the texts are equal. */
export function diffCodePatch(baseline: string, next: string): Result<readonly CodeHunk[], 'resource-limit'> {
  // Measured in UTF-16 units first: every unit is at least one byte, and the
  // text travels to main as one IPC field, bounded in units.
  if (next.length > LIMITS.ipcFieldCharsMax) {
    return err('resource-limit');
  }
  if (utf8ByteLength(next) > LIMITS.sourceBytesMax) {
    return err('resource-limit'); // Not a file this app writes, patched or whole.
  }
  const source = encodeUtf8(baseline);
  const target = encodeUtf8(next);
  const regions = changedRegions(source, target);
  const hunks = regions.map((region) => codeHunk(source, target, region));
  if (codePatchBytes(hunks) > LIMITS.intentPayloadBytesMax) {
    return err('resource-limit');
  }
  assert(hunks.length <= LIMITS.splicesPerIntentMax, 'A patch fits one intent');
  assert(applyCodePatch(baseline, hunks) === next, 'The patch turns the baseline into the text');
  return ok(hunks);
}

/** UTF-8 bytes a patch writes: the payload its intent carries. */
export function codePatchBytes(hunks: readonly CodeHunk[]): number {
  return hunks.reduce((total, hunk) => total + utf8ByteLength(hunk.text), 0);
}

/** The baseline with every hunk applied. Each hunk's witness must hold. */
export function applyCodePatch(baseline: string, hunks: readonly CodeHunk[]): string {
  const source = encodeUtf8(baseline);
  const pieces: Uint8Array[] = [];
  let at = 0;
  for (const hunk of hunks) {
    assert(at <= hunk.span.start, 'Hunks ascend without overlapping');
    assert(hunk.span.end <= source.length, 'A hunk lies inside the baseline');
    const held = decodeUtf8(toByteString(source.subarray(hunk.span.start, hunk.span.end)));
    assert(held.ok, 'A hunk starts and ends on code points');
    assert(held.value === hunk.expected, 'A hunk replaces the text it names');
    pieces.push(source.subarray(at, hunk.span.start), encodeUtf8(hunk.text));
    at = hunk.span.end;
  }
  pieces.push(source.subarray(at));
  const decoded = decodeUtf8(concatBytes(pieces));
  assert(decoded.ok, 'Whole code points in, whole code points out');
  return decoded.value;
}

/** Three-way merge of two texts that both descend from `base` (plan §7). The
 * code editor's text `ours` kept changing while a save was on its way; the
 * disk now holds `theirs` — the saved text plus what the host merged into it
 * (an outside edit mapped through, an earlier visual edit rebased). Changes
 * that touch or overlap cannot be ordered and are a `merge-conflict`: the
 * user decides, the app never picks a side. */
export function mergeTyping(base: string, ours: string, theirs: string): Result<string, 'merge-conflict' | 'resource-limit'> {
  if (ours === base || ours === theirs) {
    return ok(theirs);
  }
  if (theirs === base) {
    return ok(ours);
  }
  const mine = diffCodePatch(base, ours);
  if (!mine.ok) {
    return mine;
  }
  const other = diffCodePatch(base, theirs);
  if (!other.ok) {
    return other;
  }
  for (const left of mine.value) {
    for (const right of other.value) {
      if (spansTouch(left.span, right.span)) {
        return err('merge-conflict');
      }
    }
  }
  const both = [...mine.value, ...other.value].sort((left, right) => left.span.start - right.span.start);
  const merged = applyCodePatch(base, both);
  assert(merged !== base, 'Two changes merged are a change');
  return ok(merged);
}

// --- Internal ----------------------------------------------------------------

interface Region {
  readonly source: ByteSpan;
  readonly target: ByteSpan;
}

// The regions a minimum edit script changes, inside the part the common prefix
// and suffix leave, widened to whole code points and joined across small
// islands. Past the diff budget, or with more regions than one intent carries,
// the whole middle is one region.
function changedRegions(source: ByteString, target: ByteString): readonly Region[] {
  const middle = trimmedMiddle(source, target);
  if (middle === undefined) {
    return [];
  }
  const inner = diffBytes(
    toByteString(source.subarray(middle.source.start, middle.source.end)),
    toByteString(target.subarray(middle.target.start, middle.target.end)),
    DIFF_BUDGET,
  );
  if (inner.tag === 'too-costly') {
    return [middle];
  }
  const shifted = diffHunks(inner.diff).map((hunk) => shiftHunk(hunk, middle));
  const regions = joinRegions(shifted.map((hunk) => widenRegion(source, target, hunk)));
  if (regions.length > LIMITS.splicesPerIntentMax) {
    return [middle];
  }
  return regions;
}

function trimmedMiddle(source: ByteString, target: ByteString): Region | undefined {
  const shorter = Math.min(source.length, target.length);
  let prefix = 0;
  while (prefix < shorter && source[prefix] === target[prefix]) {
    prefix++;
  }
  if (prefix === source.length && prefix === target.length) {
    return undefined; // Equal.
  }
  let suffix = 0;
  while (suffix < shorter - prefix && source[source.length - 1 - suffix] === target[target.length - 1 - suffix]) {
    suffix++;
  }
  const region = {
    source: toByteSpan(prefix, source.length - suffix),
    target: toByteSpan(prefix, target.length - suffix),
  };
  return widenRegion(source, target, region);
}

function shiftHunk(hunk: Hunk, middle: Region): Region {
  return {
    source: toByteSpan(hunk.source.start + middle.source.start, hunk.source.end + middle.source.start),
    target: toByteSpan(hunk.target.start + middle.target.start, hunk.target.end + middle.target.start),
  };
}

// Out to code-point boundaries on both sides. The bytes just outside a region
// are matched — equal in source and target — so both sides move together and
// the region's two halves stay aligned.
function widenRegion(source: ByteString, target: ByteString, region: Region): Region {
  let sourceStart: number = region.source.start;
  let targetStart: number = region.target.start;
  for (let step = 0; step <= CONTINUATION_BYTES_MAX; step++) {
    if (!continues(source, sourceStart) && !continues(target, targetStart)) {
      break;
    }
    assert(step < CONTINUATION_BYTES_MAX, 'A code point has at most three continuation bytes');
    sourceStart--;
    targetStart--;
  }
  let sourceEnd: number = region.source.end;
  let targetEnd: number = region.target.end;
  for (let step = 0; step <= CONTINUATION_BYTES_MAX; step++) {
    if (!continues(source, sourceEnd) && !continues(target, targetEnd)) {
      break;
    }
    assert(step < CONTINUATION_BYTES_MAX, 'A code point has at most three continuation bytes');
    sourceEnd++;
    targetEnd++;
  }
  return {
    source: toByteSpan(sourceStart, sourceEnd),
    target: toByteSpan(targetStart, targetEnd),
  };
}

// Whether the byte at `offset` continues a code point begun before it.
function continues(bytes: ByteString, offset: number): boolean {
  const byte = bytes[offset];
  if (byte === undefined) {
    return false; // The end of the bytes is a boundary.
  }
  return byte >= 0x80 && byte < 0xc0;
}

// Regions that overlap after widening, or sit closer than the gap bound, are
// one region. What lies between two of them is matched, so joining keeps the
// halves aligned: the source gap and the target gap are equal.
function joinRegions(regions: readonly Region[]): readonly Region[] {
  const joined: Region[] = [];
  for (const region of regions) {
    const last = joined[joined.length - 1];
    if (last !== undefined && region.source.start < last.source.end + HUNK_GAP_BYTES_MIN) {
      const sourceGap = region.source.start - last.source.end;
      assert(sourceGap === region.target.start - last.target.end, 'Matched gaps have one length');
      joined[joined.length - 1] = {
        source: toByteSpan(last.source.start, Math.max(last.source.end, region.source.end)),
        target: toByteSpan(last.target.start, Math.max(last.target.end, region.target.end)),
      };
      continue;
    }
    joined.push(region);
  }
  return joined;
}

function codeHunk(source: ByteString, target: ByteString, region: Region): CodeHunk {
  const expected = decodeUtf8(toByteString(source.subarray(region.source.start, region.source.end)));
  const text = decodeUtf8(toByteString(target.subarray(region.target.start, region.target.end)));
  assert(expected.ok, 'A widened region holds whole code points of the baseline');
  assert(text.ok, 'A widened region holds whole code points of the text');
  return { span: region.source, expected: expected.value, text: text.value };
}

// Two changes of one base that touch cannot be ordered: an insertion at the
// edge of another change could go before or after it.
function spansTouch(left: ByteSpan, right: ByteSpan): boolean {
  if (left.start <= right.end) {
    return right.start <= left.end;
  }
  return false;
}

function concatBytes(pieces: readonly Uint8Array[]): ByteString {
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const piece of pieces) {
    joined.set(piece, at);
    at += piece.length;
  }
  assert(at === total, 'Every piece was copied');
  return toByteString(joined);
}
