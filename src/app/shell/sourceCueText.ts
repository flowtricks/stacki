// The words and the place of the source cue, as pure functions: the path a bound text writes to, cut
// at its START when long. The file's name and the binding sit at a path's end, and
// the start is the part every project shares (`src/lib/...`), so it is what gives way.
// The cue sits under the element being typed in (sourceCuePlace).

import { assert } from '../../../shared/core/assert';

/** Characters of `file › expression` shown before the start is cut. */
export const SOURCE_CUE_CHARS_MAX = 56;

/** `text` itself when it fits, else an ellipsis and its last characters, `max` in all. */
export function truncateStart(text: string, max: number): string {
  assert(Number.isSafeInteger(max), 'truncateStart: max is a safe integer');
  assert(max >= 2, 'truncateStart: room for an ellipsis and a character');
  if (text.length <= max) {
    return text;
  }
  const out = `…${text.slice(text.length - (max - 1))}`;
  assert(out.length === max, 'truncateStart: the cut text is exactly max long');
  return out;
}

/** The code the cue shows: `file › expression`, or the expression alone for the page's own data. */
export function sourceCuePath(file: string, expression: string): string {
  return truncateStart(file === '' ? expression : `${file} › ${expression}`, SOURCE_CUE_CHARS_MAX);
}

/** Window pixels between the edited element and the cue. */
export const SOURCE_CUE_GAP_PX = 6;
/** Window pixels the cue keeps from the window's edges. */
export const SOURCE_CUE_MARGIN_PX = 8;
/**
 * The band above an element its selection label (`.node-outline-tag`, 10.5px type and 7px padding) takes,
 * rounded up. A cue that must go above the element goes above this band, so it never covers the label.
 */
export const SOURCE_CUE_LABEL_BAND_PX = 20;

interface SourceCueRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface SourceCueSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Where the cue goes, in window pixels: under the element's bottom edge, left-aligned with it. Above it, clear of
 * the selection label, only when there is no room below; pinned to the window's bottom when there is room for neither.
 * Why below: the selection label already holds the band above the element, and the cue names what is being typed in,
 * so it reads beside the words without covering the name of the selection.
 */
export function sourceCuePlace(box: SourceCueRect, cue: SourceCueSize, view: SourceCueSize): { readonly left: number; readonly top: number } {
  assert(cue.width >= 0, 'sourceCuePlace: the cue has a width');
  assert(cue.height >= 0, 'sourceCuePlace: the cue has a height');
  assert(view.height >= 0, 'sourceCuePlace: the window has a height');
  const leftMax = Math.max(SOURCE_CUE_MARGIN_PX, view.width - cue.width - SOURCE_CUE_MARGIN_PX);
  const left = Math.min(Math.max(SOURCE_CUE_MARGIN_PX, box.x), leftMax);
  const below = box.y + box.h + SOURCE_CUE_GAP_PX;
  const bottomMax = view.height - SOURCE_CUE_MARGIN_PX;
  if (below + cue.height <= bottomMax) {
    return { left, top: below };
  }
  const above = box.y - SOURCE_CUE_LABEL_BAND_PX - SOURCE_CUE_GAP_PX - cue.height;
  if (above >= SOURCE_CUE_MARGIN_PX) {
    return { left, top: above };
  }
  const pinned = Math.max(SOURCE_CUE_MARGIN_PX, bottomMax - cue.height);
  assert(pinned >= SOURCE_CUE_MARGIN_PX, 'sourceCuePlace: the pinned cue starts inside the window');
  return { left, top: pinned };
}
