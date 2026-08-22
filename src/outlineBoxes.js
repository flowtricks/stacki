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

/**
 * Whether a hover is on the thing already outlined as selected — in which case
 * there is no second outline to draw.
 *
 * The same PATH is not the same thing. A loop renders one path once per item,
 * so with one card selected, its siblings share its path and comparing paths
 * alone made every other card in the loop unhoverable. It takes the same copy
 * of it too.
 *
 * A hover with no occurrence came from the navigator, which points at the node
 * rather than at one copy of it — that one is about the selection whichever
 * copy is selected.
 */
export function hoverIsSelection(hover, selection) {
  if (!hover?.path || !selection?.path) return false;
  if (hover.path !== selection.path) return false;
  return hover.occ == null || hover.occ === (selection.occ ?? 0);
}

/**
 * Whether a new selection is near enough to the old one to still mean the same
 * COPY of it.
 *
 * A loop renders one path many times, and which copy you are looking at is
 * carried beside the path as an occurrence — the path itself is identical for
 * every copy. A selection made from the canvas says which copy it means; any
 * other route means "the node", and falls back to the first.
 *
 * That is right for a jump across the tree and wrong for a step within it.
 * Pressing ↑ from the second link in a list selects its parent — and the parent
 * of the SECOND one, which is the copy the reader is looking at. Stepping down
 * into a child, or across to a sibling, is the same move. So a step to an
 * ancestor, a descendant or a sibling keeps the copy; anything further away
 * starts again at the first.
 *
 * Paths are index trails, so all three are answered by comparing them. A path
 * carrying a file namespace (`src/Card.astro|0.1`) belongs to that file: a step
 * into another file's markup is not a step within a copy.
 */
export function sameCopy(from, to) {
  if (!from || !to || from === to) return false;
  const split = (p) => {
    const text = String(p);
    const bar = text.lastIndexOf('|');
    return {
      file: bar === -1 ? '' : text.slice(0, bar),
      trail: text.slice(bar + 1).split('.'),
    };
  };
  const a = split(from);
  const b = split(to);
  if (a.file !== b.file) return false;
  const shorter = Math.min(a.trail.length, b.trail.length);
  // A sibling differs only in its last step; an ancestor or descendant agrees
  // the whole way down the shorter of the two.
  const common = a.trail.length === b.trail.length ? shorter - 1 : shorter;
  for (let i = 0; i < common; i++) if (a.trail[i] !== b.trail[i]) return false;
  return true;
}

export default onePerPlace;
