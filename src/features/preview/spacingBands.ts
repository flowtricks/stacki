import type { Box } from './outlineBoxes';
type Side = 'top' | 'right' | 'bottom' | 'left';
interface SpacingSides {
  readonly top?: number;
  readonly right?: number;
  readonly bottom?: number;
  readonly left?: number;
}
export interface Spacing {
  readonly padding?: SpacingSides;
  readonly margin?: SpacingSides;
  readonly gaps?: readonly (Box & { readonly axis: 'row' | 'column' })[];
  /** What one `em`, `rem`, `vw` and `vh` is worth in px for this element. */
  readonly units?: Readonly<Record<string, number>>;
}
interface Band extends Box {
  readonly side: string;
}

// Where a side's spacing is on the page.
//
// Hovering `padding-top` in the style panel says which property you are about
// to change; it does not say what that property is holding up. So the canvas
// draws it: the strip of the element that padding-top actually occupies, and
// the value written across it. Margin is the same idea outside the box instead
// of inside — which is why the two are different colours rather than one
// highlight that means "spacing".
//
// The side strips run the full height of the box, corner to corner, because
// that is the shape of what they hold open: `padding-left` is not a band
// hovering in the middle of the element, it is the whole left edge. Top and
// bottom then take what is left between them — but only when the sides are
// drawn too. Hovering the top alone draws the top edge corner to corner, since
// there is nothing there to leave room for. Bands never overlap: the fill is
// translucent, and two of them over the same pixels reads as a third colour.

const SIDES = ['top', 'right', 'bottom', 'left'] as const;

/**
 * The rectangles to draw over `box` (the element's border box, in canvas
 * coordinates) for `sides` of `kind` — 'padding' inside the box, 'margin'
 * around it, 'gap' between its children (where `sides` are axes, 'row' and
 * 'column', rather than edges).
 *
 * `spacing` is the element's computed spacing in px: `{ padding: {top,…},
 * margin: {…} }`. A side with nothing on it draws nothing: an empty strip is
 * not somewhere to look.
 */
export function spacingBands(
  box: Box | undefined,
  spacing: Spacing | undefined,
  kind: 'padding' | 'margin' | 'gap',
  sides?: readonly string[] | undefined,
): readonly Band[] {
  // Gap is not four numbers on this element — it is the space between its
  // children, and where those children are is a question only the laid-out
  // page can answer. The canvas measures it (see gapBandsFor in electron/preload/frameMeasure.ts)
  // and sends the rectangles, so there is nothing to work out here beyond
  // which axis was asked for.
  if (kind === 'gap') {
    const want = new Set(sides || ['row', 'column']);
    return (spacing?.gaps || [])
      .filter((band) => want.has(band.axis) && band.w > 0 && band.h > 0)
      .map((band) => ({ side: band.axis, x: band.x, y: band.y, w: band.w, h: band.h }));
  }
  if (!box || !spacing?.[kind]) {
    return [];
  }
  const size = spacing[kind];
  const want = new Set(sides || []);
  const at = (side: Side) => Math.max(0, Number(size[side]) || 0);
  const top = at('top');
  const bottom = at('bottom');
  const left = at('left');
  const right = at('right');

  // Margin lies outside the border box, padding inside it — the same four
  // strips either way, around a box that is either the element or the element
  // plus its margins.
  const outer = kind === 'margin' ? { x: box.x - left, y: box.y - top, w: box.w + left + right, h: box.h + top + bottom } : box;

  // A corner belongs to the side strip, so the top and bottom stop short of any
  // side being drawn beside them.
  const cutLeft = want.has('left') && left > 0 ? left : 0;
  const cutRight = want.has('right') && right > 0 ? right : 0;

  const bands = {
    top: { x: outer.x + cutLeft, y: outer.y, w: outer.w - cutLeft - cutRight, h: top },
    bottom: {
      x: outer.x + cutLeft,
      y: kind === 'margin' ? box.y + box.h : box.y + box.h - bottom,
      w: outer.w - cutLeft - cutRight,
      h: bottom,
    },
    left: { x: outer.x, y: outer.y, w: left, h: outer.h },
    right: {
      x: kind === 'margin' ? box.x + box.w : box.x + box.w - right,
      y: outer.y,
      w: right,
      h: outer.h,
    },
  };

  return SIDES.filter((side) => want.has(side) && bands[side].w > 0 && bands[side].h > 0).map((side) => ({
    side,
    ...bands[side],
  }));
}

const LENGTH = /^\s*(-?(?:\d+\.?\d*|\.\d+))\s*(px|rem|em|vw|vh)?\s*(?:!important)?\s*$/i;

/** A value the panel is dragging, in pixels, or undefined when only the laid-out
 *  page can say: a percentage, a variable, a calc(). Units come from the page
 *  with its measurements: em is the element's own font size, rem the root's. */
export function lengthToPx(value: string, units: Readonly<Record<string, number>> | undefined): number | undefined {
  const match = LENGTH.exec(value);
  if (!match) {
    return undefined;
  }
  const amount = parseFloat(match[1] ?? '');
  const unit = (match[2] ?? '').toLowerCase();
  if (unit === '') {
    // A bare number is a length only when it is 0.
    return amount === 0 ? 0 : undefined;
  }
  if (unit === 'px') {
    return amount;
  }
  const perUnit = units?.[unit];
  if (perUnit === undefined) {
    return undefined;
  }
  return perUnit > 0 ? amount * perUnit : undefined;
}

/**
 * `spacing` with the sides a drag is writing replaced by the dragged values, so
 * the band on the canvas is the number in the panel, on the same frame, rather
 * than the page as it was last measured. A value that cannot be turned into
 * pixels here keeps its measurement.
 */
export function withLiveSpacing(spacing: Spacing | undefined, kind: string, live: Readonly<Record<string, string>> | undefined): Spacing | undefined {
  if (!spacing || !live) {
    return spacing;
  }
  if (kind !== 'padding' && kind !== 'margin') {
    return spacing;
  }
  const sizes: { [Key in Side]?: number } = { ...spacing[kind] };
  let changed = false;
  for (const side of SIDES) {
    const value = live[side];
    const px = value === undefined ? undefined : lengthToPx(value, spacing.units);
    if (px !== undefined) {
      sizes[side] = px;
      changed = true;
    }
  }
  return changed ? { ...spacing, [kind]: sizes } : spacing;
}

export default spacingBands;
