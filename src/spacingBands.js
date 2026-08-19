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

const SIDES = ['top', 'right', 'bottom', 'left'];

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
export function spacingBands(box, spacing, kind, sides) {
  // Gap is not four numbers on this element — it is the space between its
  // children, and where those children are is a question only the laid-out
  // page can answer. The canvas measures it (see gapBandsFor in preload.js)
  // and sends the rectangles, so there is nothing to work out here beyond
  // which axis was asked for.
  if (kind === 'gap') {
    const want = new Set(sides || ['row', 'column']);
    return (spacing?.gaps || [])
      .filter((b) => want.has(b.axis) && b.w > 0 && b.h > 0)
      .map((b) => ({ side: b.axis, x: b.x, y: b.y, w: b.w, h: b.h }));
  }
  if (!box || !spacing?.[kind]) return [];
  const size = spacing[kind];
  const want = new Set(sides || []);
  const at = (side) => Math.max(0, Number(size[side]) || 0);
  const top = at('top');
  const bottom = at('bottom');
  const left = at('left');
  const right = at('right');

  // Margin lies outside the border box, padding inside it — the same four
  // strips either way, around a box that is either the element or the element
  // plus its margins.
  const outer =
    kind === 'margin'
      ? { x: box.x - left, y: box.y - top, w: box.w + left + right, h: box.h + top + bottom }
      : box;

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
    right: { x: kind === 'margin' ? box.x + box.w : box.x + box.w - right, y: outer.y, w: right, h: outer.h },
  };

  return SIDES.filter((side) => want.has(side) && bands[side].w > 0 && bands[side].h > 0).map((side) => ({
    side,
    ...bands[side],
  }));
}

export default spacingBands;
