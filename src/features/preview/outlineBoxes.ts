import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** The copy paints nothing (a hidden tab panel's, stacked where another's shows): never outlined. */
  readonly hidden?: boolean;
}
interface Occurrence {
  readonly path?: string | undefined;
  readonly occ?: number | undefined;
}

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

const covers = (outer: Box, inner: Box): boolean =>
  inner.x >= outer.x - SLACK && inner.y >= outer.y - SLACK && inner.x + inner.w <= outer.x + outer.w + SLACK && inner.y + inner.h <= outer.y + outer.h + SLACK;

/**
 * The boxes worth drawing, in the order they were reported — which is document
 * order, so "the second copy" still means the second one down the page.
 */
export function onePerPlace<T extends Box>(boxes: readonly T[] | undefined): readonly T[] {
  assert((boxes?.length ?? 0) <= LIMITS.treeNodesMax, 'Outline box count exceeds limit');
  const present = (boxes || []).filter((box) => box && box.hidden !== true);
  // A collapsed node reports a point (collapseKind says how it is drawn); it is kept only
  // when nothing beside it has a size, so a hollow copy never draws.
  const sized = present.filter((box) => box.w > 0 && box.h > 0);
  const list = sized.length > 0 ? sized : present;
  // Largest first, so a box is measured against the ones that could contain
  // it rather than the other way round.
  const order = [...list].sort((left, right) => right.w * right.h - left.w * left.h);
  const index = createKeeperIndex(list);
  const kept = new Set<T>();
  for (const box of order) {
    if (!index.candidates(box).some((keeper) => covers(keeper, box))) {
      kept.add(box);
      index.add(box);
    }
  }
  const drawn = list.filter((box) => kept.has(box));
  assert(drawn.length <= list.length, 'onePerPlace: never draws more boxes than were reported');
  return drawn;
}

/** A kept box spanning more grid cells than this is checked against every box instead of filed per cell. */
const KEEPER_CELLS_MAX = 16;

/**
 * A grid over the kept boxes, so "does a kept box cover this one?" looks at the few kept boxes
 * near it rather than all of them. Why: a loop's items are all kept (none contains another), and
 * checking each against every one before it was quadratic: 8,000 copies of a card took 180 ms
 * per overlay render. A covering box must contain the covered box's top-left corner, so a lookup
 * reads the one cell holding that corner, plus the few kept boxes too large to file per cell.
 * Cells are as big as a typical box, so a loop's item sits in about one cell.
 */
function createKeeperIndex<T extends Box>(boxes: readonly T[]): { readonly add: (box: T) => void; readonly candidates: (box: T) => readonly T[] } {
  const sizes = boxes.map((box) => Math.max(box.w, box.h)).sort((left, right) => left - right);
  const cellPx = Math.max(sizes[Math.floor(sizes.length / 2)] ?? 1, 1);
  assert(Number.isFinite(cellPx), 'onePerPlace: a grid cell has a finite size');
  const cells = new Map<string, T[]>();
  const wide: T[] = [];
  const cellOf = (value: number): number => Math.floor(value / cellPx);
  return {
    add(box) {
      const left = cellOf(box.x - SLACK);
      const right = cellOf(box.x + box.w + SLACK);
      const top = cellOf(box.y - SLACK);
      const bottom = cellOf(box.y + box.h + SLACK);
      if ((right - left + 1) * (bottom - top + 1) > KEEPER_CELLS_MAX) {
        wide.push(box);
        return;
      }
      for (let column = left; column <= right; column++) {
        for (let row = top; row <= bottom; row++) {
          const key = `${column}:${row}`;
          const cell = cells.get(key);
          if (cell === undefined) {
            cells.set(key, [box]);
          } else {
            cell.push(box);
          }
        }
      }
    },
    candidates(box) {
      const near = cells.get(`${cellOf(box.x)}:${cellOf(box.y)}`) ?? [];
      return wide.length === 0 ? near : [...near, ...wide];
    },
  };
}

/** A side under this many frame px has no size worth drawing: it is 0px as far as the page is concerned. */
const COLLAPSED_PX = 1;

export type CollapseKind = 'none' | 'flat' | 'point';

/**
 * How a node's real box is empty, so the overlay can say so rather than invent
 * a size. `point` has no width and no height (an empty block in a flex column):
 * there is nothing to outline, so it is drawn as a crosshair at its position,
 * wide enough to find and plainly not a box. `flat` has one side only (an empty
 * block of full width, an empty inline element): its real box is drawn, a line.
 */
export function collapseKind(box: Box): CollapseKind {
  assert(Number.isFinite(box.w), 'collapseKind: a box has a finite width');
  assert(Number.isFinite(box.h), 'collapseKind: a box has a finite height');
  const flatWide = box.w < COLLAPSED_PX;
  const flatTall = box.h < COLLAPSED_PX;
  if (flatWide) {
    return flatTall ? 'point' : 'flat';
  }
  return flatTall ? 'flat' : 'none';
}

/**
 * The boxes to draw for a node's reported copies.
 *
 * No occurrence means the node, so one box per place. A number means that copy:
 * the one clicked on the canvas, or the one whose component the user opened. A
 * number past the end (the loop shrank since) is the first copy rather than
 * nothing and rather than every copy, which drew a selected outline on each
 * item of a loop.
 */
export function copiesToDraw<T extends Box>(all: readonly T[], occurrence: number | undefined): readonly T[] {
  assert(all.length <= LIMITS.treeNodesMax, 'copiesToDraw: box count exceeds limit');
  if (occurrence === undefined) {
    return onePerPlace(all);
  }
  assert(Number.isSafeInteger(occurrence), 'copiesToDraw: an occurrence is a whole number');
  assert(occurrence >= 0, 'copiesToDraw: an occurrence is not negative');
  // A hidden copy draws nothing: another copy's box in its place would name the wrong instance.
  const selected = all[occurrence] ?? all[0];
  return selected === undefined || selected.hidden === true ? [] : [selected];
}

/** A map has no box of its own: it is on the page only as the copies of what
 * it renders. Its outline sits on its first child's boxes, so hovering a loop
 * outlines the same item its child would, drawn in the loop's colour. Borrowing
 * the containing node's box instead drew nothing for a loop at the top of a
 * page, where there is no containing node. */
export function outlineBoxPath(path: string, nodeKind: string | undefined): string {
  assert(path.length > 0, 'outlineBoxPath: path must not be empty');
  if (nodeKind !== 'map') {
    return path;
  }
  const childPath = `${path}.0`;
  assert(childPath.startsWith(path), 'outlineBoxPath: child path must extend its map');
  return childPath;
}

/** The paths a loop's outline is measured from: each of its children. */
export function loopChildPaths(path: string, childCount: number): readonly string[] {
  assert(path.length > 0, 'loopChildPaths: path must not be empty');
  assert(Number.isSafeInteger(childCount), 'loopChildPaths: a child count is a whole number');
  assert(childCount >= 0, 'loopChildPaths: a child count is not negative');
  // Bounded by the tree: a node never has more children than the page has nodes.
  assert(childCount <= LIMITS.treeNodesMax, 'loopChildPaths: child count exceeds limit');
  return Array.from({ length: Math.max(childCount, 1) }, (_, index) => `${path}.${index}`);
}

/**
 * One box around every copy a loop renders. A loop is the whole run of its
 * items, so its outline wraps them all, as a builder's collection list does,
 * rather than the first item alone (which reads as that item selected).
 */
export function unionBox(boxes: readonly Box[]): Box | undefined {
  assert(boxes.length <= LIMITS.treeNodesMax, 'unionBox: box count exceeds limit');
  const sized = boxes.filter((box) => box.w > 0 && box.h > 0 && box.hidden !== true);
  const [first] = sized;
  if (first === undefined) {
    return undefined;
  }
  let left = first.x;
  let top = first.y;
  let right = first.x + first.w;
  let bottom = first.y + first.h;
  for (const box of sized) {
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.w);
    bottom = Math.max(bottom, box.y + box.h);
  }
  assert(right >= left, 'unionBox: a union has width');
  assert(bottom >= top, 'unionBox: a union has height');
  return { x: left, y: top, w: right - left, h: bottom - top };
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
 * No occurrence on either side means the node rather than one copy of it.
 * Navigator hover and selection supply occurrence zero; this fallback still
 * handles a selection before a particular occurrence is known.
 */
export function hoverIsSelection(hover: Occurrence | undefined, selection: Occurrence | undefined): boolean {
  if (!hover?.path || !selection?.path) {
    return false;
  }
  if (hover.path !== selection.path) {
    return false;
  }
  if (hover.occ === undefined) {
    return true;
  }
  if (selection.occ === undefined) {
    return true;
  }
  return hover.occ === selection.occ;
}

/**
 * Whether a new selection is near enough to the old one to still mean the same
 * COPY of it.
 *
 * A loop renders one path many times, and which copy you are looking at is
 * carried beside the path as an occurrence — the path itself is identical for
 * every copy. A selection made from the canvas says which copy it means.
 * Navigator selection explicitly resets to the first copy.
 *
 * A nearby selection from another surface (for example, the code panel) keeps
 * the clicked copy across an ancestor, descendant, or sibling. A farther jump
 * starts again at the first. Navigator actions override this proximity rule.
 *
 * Paths are index trails, so all three are answered by comparing them. A path
 * carrying a file namespace (`src/Card.astro|0.1`) belongs to that file: a step
 * into another file's markup is not a step within a copy.
 */
export function sameCopy(from: string | undefined, to: string | undefined): boolean {
  if (!from || !to || from === to) {
    return false;
  }
  const split = (path: string) => {
    const text = String(path);
    const bar = text.lastIndexOf('|');
    return {
      file: bar === -1 ? '' : text.slice(0, bar),
      trail: text.slice(bar + 1).split('.'),
    };
  };
  const source = split(from);
  const target = split(to);
  if (source.file !== target.file) {
    return false;
  }
  const shorter = Math.min(source.trail.length, target.trail.length);
  // A sibling differs only in its last step; an ancestor or descendant agrees
  // the whole way down the shorter of the two.
  const common = source.trail.length === target.trail.length ? shorter - 1 : shorter;
  for (let i = 0; i < common; i++) {
    if (source.trail[i] !== target.trail[i]) {
      return false;
    }
  }
  return true;
}

export default onePerPlace;
