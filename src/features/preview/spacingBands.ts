import type { Box } from './outlineBoxes';
type Side = 'top' | 'right' | 'bottom' | 'left';
interface SpacingSides {
  readonly top?: number;
  readonly right?: number;
  readonly bottom?: number;
  readonly left?: number;
}
/** What a margin's edge meets: the previous or next in-flow sibling, or the parent's own margin when a first or last child's margin passes through it. */
export type CollapsePartner = 'previous' | 'next' | 'parent';

/** A margin that is adjoining another margin: the two collapse into the larger (CSS 2.1 §8.3.1), and `margin` is the partner's in px. */
export interface MarginCollapse {
  readonly partner: CollapsePartner;
  readonly margin: number;
}

export interface Spacing {
  readonly padding?: SpacingSides;
  readonly margin?: SpacingSides;
  /** Per vertical margin side, the margin it collapses with. Absent where the side is not adjoining one (flex and grid items never are). */
  readonly collapse?: { readonly top?: MarginCollapse; readonly bottom?: MarginCollapse };
  readonly gaps?: readonly (Box & { readonly axis: 'row' | 'column' })[];
  /** What one `em`, `rem`, `vw` and `vh` is worth in px for this element. */
  readonly units?: Readonly<Record<string, number>>;
}
export interface Band extends Box {
  readonly side: string;
  /** Set on a margin that adds nothing because it collapses into a larger one: the band is a thin marker line at the box edge, not the strip. */
  readonly collapsedInto?: CollapsePartner;
}

/** How thick the marker line of a collapsed margin is, in frame px. */
export const COLLAPSE_MARKER_PX = 2;

/**
 * What a margin adds to the layout, in px: the part of `own` the margin it is adjoining does not already
 * supply. Two adjoining positive margins collapse into the larger, so the smaller adds nothing; every
 * other combination (a negative margin, nothing adjoining) adds what it says. The band is the whole strip
 * when this is more than 0, because then the margin IS the larger one and the strip is exactly the gap.
 */
export function marginContribution(own: number, adjoining: number | undefined): number {
  if (adjoining === undefined) {
    return own;
  }
  if (own > 0 && adjoining > 0) {
    return Math.max(0, own - adjoining);
  }
  return own;
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

  const drawn = SIDES.filter((side) => want.has(side) && bands[side].w > 0 && bands[side].h > 0).map((side): Band => ({ side, ...bands[side] }));
  return kind === 'margin' ? drawn.map((band) => collapsedMarker(band, box, spacing.collapse)) : drawn;
}

// A top or bottom margin that adds nothing (it is the smaller of two adjoining margins) has a strip that
// is inside its partner's, so drawing the strip would say the margin holds that space open. A thin line at
// the box edge says where it is and, with its label, why it shows no space.
function collapsedMarker(band: Band, box: Box, collapse: Spacing['collapse']): Band {
  if (band.side !== 'top' && band.side !== 'bottom') {
    return band;
  }
  const partner = collapse?.[band.side];
  if (!partner) {
    return band;
  }
  if (marginContribution(band.h, partner.margin) > 0) {
    return band;
  }
  const y = band.side === 'top' ? box.y - COLLAPSE_MARKER_PX : box.y + box.h;
  return { ...band, y, h: COLLAPSE_MARKER_PX, collapsedInto: partner.partner };
}

/**
 * `band` cut to the frame (`viewport`, in the frame's own px) so the label stays centred on what can be
 * seen: a margin hanging above the top of the page is mostly out of the frame, and a label centred on all
 * of it would be out of the frame too. Undefined when none of the band is inside. A band the frame does
 * not size is returned whole.
 */
export function clipBand(band: Band, viewport: { readonly w: number; readonly h: number } | undefined): Band | undefined {
  if (!viewport) {
    return band;
  }
  const left = Math.max(0, band.x);
  const top = Math.max(0, band.y);
  const right = Math.min(viewport.w, band.x + band.w);
  const bottom = Math.min(viewport.h, band.y + band.h);
  if (right <= left || bottom <= top) {
    return undefined;
  }
  return { ...band, x: left, y: top, w: right - left, h: bottom - top };
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
