// Which item of each enclosing loop the canvas selection is in.
//
// A node inside `cards.map((card) => …)` is rendered once per card, and the
// canvas names the copy a click landed on by its occurrence: the order of the
// copies on the page. The data picker reads a loop item's values from one
// element of the list, so it should read the element the selected copy was
// made from, not the first one forever.
//
// Copies are numbered like the digits of a number whose places are the
// enclosing loops, outermost first (the outer loop's items are the slowest to
// change). That holds while every loop has as many items in each pass as its
// first one, which is the usual page. When the numbers cannot be reconciled
// with what the canvas rendered — a filtered list, an item hidden by a
// condition, a loop whose size is unknown — this answers nothing, and the
// picker keeps showing the first item as it always did. A wrong item would be
// worse than the first one: it would look deliberate.

import { assert } from '../../shared/core/assert';

/** The copy of the selected node the canvas named, and how many copies it counted. */
export interface LoopCopy {
  /** The copy's place among the node's copies on the page, 0-based. */
  readonly occurrence: number;
  /** How many copies the canvas drew, when it said; used to prove the loops' sizes add up. */
  readonly copies: number | undefined;
}

const COPIES_MAX = 20_000;

/**
 * The item index in each enclosing loop (outermost first) the copy sits in, or
 * undefined when `counts` do not account for the copy. `counts` holds how many
 * items each loop's list has, or undefined where the list is not known.
 */
export function loopIndexesOfCopy(copy: LoopCopy, counts: readonly (number | undefined)[]): readonly number[] | undefined {
  assert(counts.length <= 64, 'loopIndexesOfCopy: loop nesting is bounded');
  if (!Number.isSafeInteger(copy.occurrence) || copy.occurrence < 0) {
    return undefined;
  }
  let total = 1;
  const sizes: number[] = [];
  for (const count of counts) {
    if (count === undefined || !Number.isSafeInteger(count) || count < 1) {
      return undefined;
    }
    sizes.push(count);
    total *= count;
    if (total > COPIES_MAX) {
      return undefined;
    }
  }
  if (copy.copies !== undefined && copy.copies !== total) {
    return undefined;
  }
  if (copy.occurrence >= total) {
    return undefined;
  }
  const indexes: number[] = [];
  let stride = total;
  for (const size of sizes) {
    stride = Math.floor(stride / size);
    indexes.push(Math.floor(copy.occurrence / stride) % size);
  }
  assert(indexes.length === sizes.length, 'loopIndexesOfCopy: one index per loop');
  assert(
    indexes.every((index, place) => index < (sizes[place] ?? 0)),
    'loopIndexesOfCopy: each index is inside its loop',
  );
  return indexes;
}

/** Which item the pager steps to from `index`, wrapping at both ends as the data picker's arrows do. */
export function steppedLoopIndex(index: number, step: -1 | 1, count: number): number {
  assert(count >= 1, 'steppedLoopIndex: a loop has an item');
  assert(Number.isSafeInteger(index), 'steppedLoopIndex: the index is an integer');
  const at = Math.min(Math.max(index, 0), count - 1);
  return (((at + step) % count) + count) % count;
}
