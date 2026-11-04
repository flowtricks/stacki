// The typing caret among the selector field's chips.
//
// The field reads like a tag input: chips in a wrapping row, and a caret that can
// sit in any gap between them — before the first, between two, after the last.
// The caret is a gap index, 0..chipCount. A class typed there is written next to
// the class chip beside the caret, so the element's class order (which the chips
// follow) is the order the person saw; Backspace and Delete with nothing typed
// take off the chip before or after the caret, the way they would a character.
//
// Everything here is pure arithmetic over chip boxes and chip parts, so it is
// tested without a browser (test/renderer/style/selectorCaret.test.js).

import { assert } from '../../../../shared/core/assert';
import { PLACEMENT_END, type ClassPlacement } from '../../../editor/classAttr';

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

/** What a chip stands for on the element, as far as Delete is concerned. */
export type ChipPart = { readonly kind: 'class'; readonly name: string } | { readonly kind: 'attribute'; readonly name: string } | { readonly kind: 'other' };

export type CaretKey = 'Backspace' | 'Delete';

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

/**
 * Where a class typed at the caret goes among the element's classes: before the
 * class chip right after the caret, else after the class chip right before it,
 * else beside the nearest class chip on either side, else at the end. Tag and
 * attribute chips are skipped — they hold no place in `class="…"`.
 */
export function placementAt(parts: readonly ChipPart[], caret: number): ClassPlacement {
  assert(parts.length <= CHIPS_MAX, 'placementAt: a bounded chip count');
  const gap = clampCaret(caret, parts.length);
  if (gap === parts.length) {
    return PLACEMENT_END;
  }
  const next = parts[gap];
  if (next?.kind === 'class') {
    return { kind: 'before', className: next.name };
  }
  for (let index = gap - 1; index >= 0; index--) {
    const part = parts[index];
    if (part?.kind === 'class') {
      return { kind: 'after', className: part.name };
    }
  }
  for (let index = gap + 1; index < parts.length; index++) {
    const part = parts[index];
    if (part?.kind === 'class') {
      return { kind: 'before', className: part.name };
    }
  }
  return PLACEMENT_END;
}

/** The chip Backspace (the one before the caret) or Delete (after) takes off, if any. */
export function chipAtCaret(caret: number, chipCount: number, key: CaretKey): number | undefined {
  const gap = clampCaret(caret, chipCount);
  const index = key === 'Backspace' ? gap - 1 : gap;
  if (index < 0) {
    return undefined;
  }
  if (index < chipCount) {
    return index;
  }
  return undefined;
}

/**
 * The part a chip stands for. `loneClass` is the chip's lone class, when it is
 * one (`.hero_title`); an attribute chip is a lone `[name]` or `[name="value"]`.
 * Anything else — a tag, `[class*="text-"]`, a combinator, a state — is part of
 * a selector, not something written on the element.
 */
export function chipPart(selectorText: string, loneClass: string | undefined): ChipPart {
  if (loneClass !== undefined) {
    assert(loneClass.length > 0, 'chipPart: a lone class has a name');
    return { kind: 'class', name: loneClass };
  }
  const name = attributeChipName(selectorText);
  return name === undefined ? { kind: 'other' } : { kind: 'attribute', name };
}

// `[data-state]` or `[data-state="open"]`, alone. Substring and prefix matches
// (`*=`, `^=`, `~=`, …) select a family of values, not an attribute to remove.
const ATTRIBUTE_CHIP = /^\[\s*([A-Za-z_][\w:.-]*)\s*(?:=\s*(?:"[^"]*"|'[^']*'|[^\]\s"']+)\s*(?:[is]\s*)?)?\]$/;

export function attributeChipName(selectorText: string): string | undefined {
  const match = ATTRIBUTE_CHIP.exec(selectorText.trim());
  return match?.[1];
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
