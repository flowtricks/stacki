// One box per place.
//
// The page reports a node's boxes as a list — a node inside a loop is on the
// page once per item, and each copy is meant to be outlined separately. But
// the same *place* can come back several times over: a component whose markup
// is split across several marked runs, an element the page's own scripts
// cloned, a piece that measures to the same rect as the whole. Drawing those
// is not just redundant, it is wrong: the overlays are translucent, so two of
// them over the same pixels is twice the tint and fourteen is a wash. A
// section hovered from the navigator turned solid green that way — 14% painted
// fourteen times is 88%, which is a page you can no longer read.
//
// So a box is dropped when a box already kept covers it. Separate instances
// never contain one another, so they all survive.

// A pixel of slack: rects come from getBoundingClientRect and a box that is
// "the same" as another is rarely the same to six decimal places.
const SLACK = 1;

const covers = (a, b) =>
  b.x >= a.x - SLACK &&
  b.y >= a.y - SLACK &&
  b.x + b.w <= a.x + a.w + SLACK &&
  b.y + b.h <= a.y + a.h + SLACK;

/**
 * The boxes worth drawing, in the order they were reported — which is document
 * order, so "the second copy" still means the second one down the page.
 */
export function onePerPlace(boxes) {
  const list = (boxes || []).filter((b) => b && b.w > 0 && b.h > 0);
  // Largest first, so a box is measured against the ones that could contain
  // it rather than the other way round.
  const order = [...list].sort((a, b) => b.w * b.h - a.w * a.h);
  const kept = [];
  for (const box of order) {
    if (!kept.some((k) => covers(k, box))) kept.push(box);
  }
  return list.filter((b) => kept.includes(b));
}

export default onePerPlace;
