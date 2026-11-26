// Design mode (experimental, removable: docs/design-mode/REMOVE.md): how a tall page's picture is cut: pure.

/** A slice is at most this many times as tall as it is wide: a model shrinks a taller picture past reading. */
const SLICE_RATIO_MAX = 2;
/** The most pictures one page becomes. A page past this many full slices has taller ones. */
export const SLICES_MAX = 6;

/** The heights, top to bottom, that a page of `widthPx` by `heightPx` is pictured in; they add up to its height. */
export function sliceHeights(widthPx: number, heightPx: number): readonly number[] {
  if (!(widthPx > 0) || !(heightPx > 0)) {
    throw new Error('Assertion failed: sliceHeights: a page has a size');
  }
  const count = Math.min(SLICES_MAX, Math.max(1, Math.ceil(heightPx / (widthPx * SLICE_RATIO_MAX))));
  const each = Math.floor(heightPx / count);
  return Array.from({ length: count }, (_, index) => (index === count - 1 ? heightPx - each * (count - 1) : each));
}
