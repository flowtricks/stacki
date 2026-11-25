// The typing caret among a chip field's chips: pure gap arithmetic.
//
// A chip field reads like a tag input: chips in a wrapping row, and a caret that
// sits in a gap between them. The caret is a gap index, 0..chipCount — before the
// first chip, between two, after the last.
//
// Two fields use it, deliberately differently. The Settings panel's class field
// (src/features/props/ClassInput.tsx) lets a click or ← → put the caret in any
// gap, because the classes are an ordered list the person edits. The Style
// panel's selector field (src/features/style/embed/SelectorPicker.tsx) keeps its
// caret after the last chip: its chips are the selectors that style the element,
// not a list to type into the middle of. It lives here, below both features,
// because features import each other only along the edges the lint config lists.
//
// Tested without a browser (test/renderer/style/selectorCaret.test.js).

import { assert } from '../../shared/core/assert';

/** A chip's box on screen, in the same coordinates as the click. */
export interface ChipBox {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

// A field holds far fewer chips than this; a bigger count is a bug upstream.
const CHIPS_MAX = 512;

/**
 * The gap a click lands in. The row is the one nearest the click vertically
 * (rows wrap, and a click in the space between two rows belongs to the nearer);
 * within it, the click is before the first chip whose middle is right of it.
 * Below every row is the end.
 */
export function caretAtPoint(boxes: readonly ChipBox[], point: Point): number {
  assert(boxes.length <= CHIPS_MAX, 'caretAtPoint: a bounded chip count');
  if (boxes.length === 0) {
    return 0;
  }
  const bottomMax = Math.max(...boxes.map((box) => box.bottom));
  if (point.y > bottomMax) {
    return boxes.length;
  }
  const distances = boxes.map((box) => verticalDistance(box, point.y));
  const distanceMin = Math.min(...distances);
  let lastInRow = -1;
  for (let index = 0; index < boxes.length; index++) {
    const box = boxes[index];
    const distance = distances[index];
    if (box === undefined || distance === undefined) {
      continue;
    }
    if (distance - distanceMin < 0.5) {
      if (point.x < (box.left + box.right) / 2) {
        return index;
      }
      lastInRow = index;
    }
  }
  assert(lastInRow >= 0, 'caretAtPoint: the nearest row holds a chip');
  return lastInRow + 1;
}

/** One step left (-1) or right (+1), held inside 0..chipCount. */
export function caretStep(caret: number, chipCount: number, step: -1 | 1): number {
  assert(Number.isSafeInteger(caret), 'caretStep: the caret is an integer gap');
  assert(chipCount >= 0, 'caretStep: a chip count is not negative');
  return Math.min(Math.max(clampCaret(caret, chipCount) + step, 0), chipCount);
}

/** A caret held inside 0..chipCount — chips come and go under it. */
export function clampCaret(caret: number, chipCount: number): number {
  assert(chipCount >= 0, 'clampCaret: a chip count is not negative');
  assert(Number.isSafeInteger(caret), 'clampCaret: the caret is an integer gap');
  return Math.min(Math.max(caret, 0), chipCount);
}

function verticalDistance(box: ChipBox, y: number): number {
  if (y < box.top) {
    return box.top - y;
  }
  if (y > box.bottom) {
    return y - box.bottom;
  }
  return 0;
}
