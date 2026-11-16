// The cheap alignment diff.ts falls back to when an exact minimum edit script
// would cost too much: two files that differ by thousands of bytes, or content
// so repetitive that Myers' snakes run the whole file once per diagonal. Stacki
// has no size limit, so a diff that is too expensive degrades to this instead
// of refusing the file (owner requirement).
//
// What it returns is not an edit script but the byte blocks it can PROVE equal
// and aligned: block (sourceStart, targetStart, length) says
// `source[sourceStart + i] === target[targetStart + i]` for every i below
// length. Everything between blocks is unknown, which is exactly what makes the
// result safe for the span mapper: it resolves a span only when the whole span
// lies inside one block, and never guesses for a span that touches the gaps.
//
// How, in linear time and memory: the common prefix and suffix are blocks; in
// the middle, lines that occur exactly once on each side are anchors (the
// patience-diff idea: a line unique to both files is very likely the same
// line), the longest ascending chain of anchors is kept, and each anchor grows
// into the run of equal lines around it. Every claimed block is verified byte
// for byte, so a hash collision costs an anchor, never correctness.
//
// Bounds (AGENTS.md §10): every loop is bounded by the byte or line count of
// its own input, and the work is a constant number of passes over each file.
import { assert } from '../core/assert';

/** A run of bytes equal in both files and at the same relative place. */
export interface EqualBlock {
  readonly sourceStart: number;
  readonly targetStart: number;
  readonly length: number;
}

const NEWLINE = 10;
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
/** Slots per source line in the line table: load stays under three quarters. */
const TABLE_SLOTS_PER_LINE = 1.34;

/** The blocks both files share, ascending and disjoint in both, and touching
 * blocks merged. Empty when the files share nothing the pass can prove. */
export function alignedBlocks(source: Uint8Array, target: Uint8Array): readonly EqualBlock[] {
  const prefix = commonPrefixLength(source, target);
  const suffix = commonSuffixLength(source, target, prefix);
  const blocks: EqualBlock[] = [];
  if (prefix > 0) {
    blocks.push({ sourceStart: 0, targetStart: 0, length: prefix });
  }
  const sourceEnd = source.length - suffix;
  const targetEnd = target.length - suffix;
  if (prefix < sourceEnd) {
    if (prefix < targetEnd) {
      blocks.push(...lineBlocks(source, prefix, sourceEnd, target, prefix, targetEnd));
    }
  }
  if (suffix > 0) {
    blocks.push({ sourceStart: sourceEnd, targetStart: targetEnd, length: suffix });
  }
  const merged = mergeTouching(blocks);
  assertBlocks(source, target, merged);
  return merged;
}

// --- Internal ----------------------------------------------------------------

function commonPrefixLength(source: Uint8Array, target: Uint8Array): number {
  const shorter = Math.min(source.length, target.length);
  let prefix = 0;
  while (prefix < shorter && source[prefix] === target[prefix]) {
    prefix++;
  }
  return prefix;
}

// The suffix may not reach into the prefix, or one byte would be in two blocks.
function commonSuffixLength(source: Uint8Array, target: Uint8Array, prefix: number): number {
  const room = Math.min(source.length, target.length) - prefix;
  let suffix = 0;
  while (suffix < room && source[source.length - 1 - suffix] === target[target.length - 1 - suffix]) {
    suffix++;
  }
  return suffix;
}

interface Lines {
  /** Byte offset where each line starts, then the region end as a sentinel. */
  readonly starts: Int32Array;
  readonly count: number;
}

// A line ends after its newline; the last one ends at the region end.
function splitLines(bytes: Uint8Array, from: number, to: number): Lines {
  let newlines = 0;
  for (let offset = from; offset < to; offset++) {
    if (bytes[offset] === NEWLINE) {
      newlines++;
    }
  }
  const starts = new Int32Array(newlines + 2);
  let count = 0;
  starts[0] = from;
  for (let offset = from; offset < to; offset++) {
    if (bytes[offset] === NEWLINE) {
      if (offset + 1 < to) {
        count++;
        starts[count] = offset + 1;
      }
    }
  }
  count++;
  starts[count] = to;
  assert(count <= newlines + 1, 'A region has at most one more line than newlines');
  return { starts, count };
}

function hashLine(bytes: Uint8Array, from: number, to: number): number {
  let hash = FNV_OFFSET;
  for (let offset = from; offset < to; offset++) {
    hash = Math.imul(hash ^ (bytes[offset] ?? 0), FNV_PRIME);
  }
  return hash >>> 0;
}

function linesEqual(source: Uint8Array, sourceLines: Lines, sourceLine: number, target: Uint8Array, targetLines: Lines, targetLine: number): boolean {
  const sourceStart = sourceLines.starts[sourceLine] ?? 0;
  const targetStart = targetLines.starts[targetLine] ?? 0;
  const length = (sourceLines.starts[sourceLine + 1] ?? 0) - sourceStart;
  if (length !== (targetLines.starts[targetLine + 1] ?? 0) - targetStart) {
    return false;
  }
  for (let offset = 0; offset < length; offset++) {
    if (source[sourceStart + offset] !== target[targetStart + offset]) {
      return false;
    }
  }
  return true;
}

// Open-addressed table of the source's line hashes: a slot is empty while its
// source line is -1. `sourceRepeats` marks a hash seen twice on the source
// side; `targetSeen` counts target occurrences, capped at two.
interface LineTable {
  readonly mask: number;
  readonly keys: Uint32Array;
  readonly sourceLine: Int32Array;
  readonly sourceRepeats: Uint8Array;
  readonly targetSeen: Uint8Array;
  readonly targetLine: Int32Array;
}

function createLineTable(sourceLines: number): LineTable {
  let slots = 16;
  while (slots < sourceLines * TABLE_SLOTS_PER_LINE) {
    slots *= 2;
  }
  return {
    mask: slots - 1,
    keys: new Uint32Array(slots),
    sourceLine: new Int32Array(slots).fill(-1),
    sourceRepeats: new Uint8Array(slots),
    targetSeen: new Uint8Array(slots),
    targetLine: new Int32Array(slots).fill(-1),
  };
}

// The slot holding `hash`, or the empty slot where it would go. The table is
// never full (load under three quarters), so the probe ends.
function findSlot(table: LineTable, hash: number): number {
  let slot = hash & table.mask;
  for (let probe = 0; probe <= table.mask; probe++) {
    if (table.sourceLine[slot] === -1) {
      return slot;
    }
    if (table.keys[slot] === hash) {
      return slot;
    }
    slot = (slot + 1) & table.mask;
  }
  throw new Error('Assertion failed: the line table always has an empty slot');
}

function lineBlocks(source: Uint8Array, sourceFrom: number, sourceTo: number, target: Uint8Array, targetFrom: number, targetTo: number): readonly EqualBlock[] {
  const sourceLines = splitLines(source, sourceFrom, sourceTo);
  const targetLines = splitLines(target, targetFrom, targetTo);
  const table = createLineTable(sourceLines.count);
  for (let line = 0; line < sourceLines.count; line++) {
    const hash = hashLine(source, sourceLines.starts[line] ?? 0, sourceLines.starts[line + 1] ?? 0);
    const slot = findSlot(table, hash);
    if (table.sourceLine[slot] === -1) {
      table.keys[slot] = hash;
      table.sourceLine[slot] = line;
    } else {
      table.sourceRepeats[slot] = 1;
    }
  }
  const targetSlots = new Int32Array(targetLines.count).fill(-1);
  for (let line = 0; line < targetLines.count; line++) {
    const hash = hashLine(target, targetLines.starts[line] ?? 0, targetLines.starts[line + 1] ?? 0);
    const slot = findSlot(table, hash);
    if (table.sourceLine[slot] !== -1) {
      targetSlots[line] = slot;
      const seen = table.targetSeen[slot] ?? 0;
      if (seen === 0) {
        table.targetLine[slot] = line;
      }
      table.targetSeen[slot] = Math.min(2, seen + 1);
    }
  }
  const anchorSources: number[] = [];
  const anchorTargets: number[] = [];
  for (let line = 0; line < targetLines.count; line++) {
    const slot = targetSlots[line] ?? -1;
    if (slot >= 0 && table.targetSeen[slot] === 1 && table.sourceRepeats[slot] === 0) {
      const sourceLine = table.sourceLine[slot] ?? -1;
      if (linesEqual(source, sourceLines, sourceLine, target, targetLines, line)) {
        anchorSources.push(sourceLine);
        anchorTargets.push(line);
      }
    }
  }
  const chain = longestAscendingChain(anchorSources);
  return growAnchors(
    { source, sourceLines, target, targetLines },
    chain.map((index) => [anchorSources[index] ?? 0, anchorTargets[index] ?? 0] as const),
  );
}

// Indexes of a longest strictly ascending subsequence of `values` (patience
// sorting): tails[k] is the index of the smallest value that ends an ascending
// run of length k + 1, so each value binary-searches its run.
function longestAscendingChain(values: readonly number[]): readonly number[] {
  const tails = new Int32Array(values.length);
  const previous = new Int32Array(values.length).fill(-1);
  let length = 0;
  for (let index = 0; index < values.length; index++) {
    const value = values[index] ?? 0;
    let low = 0;
    let high = length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((values[tails[middle] ?? 0] ?? 0) < value) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    tails[low] = index;
    previous[index] = low > 0 ? (tails[low - 1] ?? -1) : -1;
    if (low === length) {
      length++;
    }
  }
  const chain: number[] = [];
  let cursor = length > 0 ? (tails[length - 1] ?? -1) : -1;
  for (let step = 0; step < length; step++) {
    assert(cursor >= 0, 'The chain walks back through its predecessors');
    chain.push(cursor);
    cursor = previous[cursor] ?? -1;
  }
  return chain.reverse();
}

interface LinePair {
  readonly source: Uint8Array;
  readonly sourceLines: Lines;
  readonly target: Uint8Array;
  readonly targetLines: Lines;
}

// Each anchor grows backward and forward over equal lines, never into what an
// earlier block already claimed; an anchor an earlier block swallowed is
// skipped.
function growAnchors(pair: LinePair, anchors: readonly (readonly [number, number])[]): readonly EqualBlock[] {
  const { source, sourceLines, target, targetLines } = pair;
  const blocks: EqualBlock[] = [];
  let sourceClaimed = 0;
  let targetClaimed = 0;
  for (const [sourceLine, targetLine] of anchors) {
    if (sourceLine < sourceClaimed || targetLine < targetClaimed) {
      continue;
    }
    let back = 0;
    while (sourceLine - back - 1 >= sourceClaimed && targetLine - back - 1 >= targetClaimed) {
      if (!linesEqual(source, sourceLines, sourceLine - back - 1, target, targetLines, targetLine - back - 1)) {
        break;
      }
      back++;
    }
    let forward = 1;
    while (sourceLine + forward < sourceLines.count && targetLine + forward < targetLines.count) {
      if (!linesEqual(source, sourceLines, sourceLine + forward, target, targetLines, targetLine + forward)) {
        break;
      }
      forward++;
    }
    const firstSource = sourceLine - back;
    const firstTarget = targetLine - back;
    const lines = back + forward;
    const sourceStart = sourceLines.starts[firstSource] ?? 0;
    const targetStart = targetLines.starts[firstTarget] ?? 0;
    const length = (sourceLines.starts[firstSource + lines] ?? 0) - sourceStart;
    assert(length === (targetLines.starts[firstTarget + lines] ?? 0) - targetStart, 'Equal lines are equal in length');
    blocks.push({ sourceStart, targetStart, length });
    sourceClaimed = firstSource + lines;
    targetClaimed = firstTarget + lines;
  }
  return blocks;
}

function mergeTouching(blocks: readonly EqualBlock[]): readonly EqualBlock[] {
  const merged: EqualBlock[] = [];
  for (const block of blocks) {
    if (block.length === 0) {
      continue;
    }
    const last = merged[merged.length - 1];
    if (last !== undefined) {
      if (last.sourceStart + last.length === block.sourceStart && last.targetStart + last.length === block.targetStart) {
        merged[merged.length - 1] = { sourceStart: last.sourceStart, targetStart: last.targetStart, length: last.length + block.length };
        continue;
      }
    }
    merged.push(block);
  }
  return merged;
}

// The contract of the result, checked where it is produced: ascending and
// disjoint in both files, inside both, and equal at their ends. A full
// byte-for-byte check would be a third pass over the file; every block was
// grown from verified lines or from the prefix and suffix scans.
function assertBlocks(source: Uint8Array, target: Uint8Array, blocks: readonly EqualBlock[]): void {
  let sourceEnd = 0;
  let targetEnd = 0;
  for (const block of blocks) {
    assert(block.length > 0, 'A block is not empty');
    assert(block.sourceStart >= sourceEnd, 'Blocks ascend without overlapping in the source');
    assert(block.targetStart >= targetEnd, 'Blocks ascend without overlapping in the target');
    sourceEnd = block.sourceStart + block.length;
    targetEnd = block.targetStart + block.length;
    assert(sourceEnd <= source.length, 'A block lies inside the source');
    assert(targetEnd <= target.length, 'A block lies inside the target');
    assert(source[block.sourceStart] === target[block.targetStart], 'A block starts on equal bytes');
    assert(source[sourceEnd - 1] === target[targetEnd - 1], 'A block ends on equal bytes');
  }
}
