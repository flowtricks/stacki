// Where a drag over the canvas lands: one pure model that both the canvas and the Navigator draw from.
//
// Why one model: a drop indicator that says one thing and a drop that does another is worse than no
// indicator. The canvas line, the Navigator's gap or row, and the edit the drop writes all come from the
// decision made here, so they cannot disagree. The frame measures the page (electron/preload/frameDrag.ts);
// the editor turns the paths it names into node ids and asks this module what the pointer means.
//
// Input: the page tree, indexed once when the drag starts (`indexDropTree`), the pointer and the levels the
// frame measured under it, deepest first: the node under the pointer, its parent, and so on up to the file's
// root list. Each level carries its own box, its content box, the flow its children are laid out in, and,
// for the two deepest levels, the boxes of its rendered children. Output: the parent and index the node
// goes to, whether that is before or after a sibling or into the container, and the geometry of the line
// or placeholder that shows it, in the frame's own CSS pixels.
//
// Work per pointer move is O(depth + siblings): the tree index answers parent and child questions in O(1),
// and only the measured levels are read. The O(nodes) index is built once per drag.

import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import type { TreeView } from './treeView';

/** A box in the frame's CSS pixels. */
export interface DropRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface DropPoint {
  readonly x: number;
  readonly y: number;
}

/** How a container lays out its children, as the frame read it from the computed style. */
export const DROP_FLOWS = ['block', 'column', 'column-reverse', 'row', 'row-reverse', 'grid', 'wrap'] as const;
export type DropFlow = (typeof DROP_FLOWS)[number];

/** A rendered child of a measured level: its index among the parent's children in the tree, and its box. */
export interface DropChild {
  readonly id: string;
  readonly index: number;
  readonly box: DropRect;
}

/** One measured level under the pointer. `id` is undefined for the file's root list. */
export interface DropLevel {
  readonly id: string | undefined;
  readonly box: DropRect;
  readonly content: DropRect;
  readonly flow: DropFlow;
  /** The rendered children; undefined when the frame did not measure them (levels above the second). */
  readonly children: readonly DropChild[] | undefined;
}

/** What a node may take inside it, by structure: children, nothing (a void or text-only tag: drops go beside it), or nothing for a reason worth saying. */
export type DropHosting = 'children' | 'beside' | 'no-slot';

export interface DropTreeNode {
  readonly id: string;
  readonly parentId: string | undefined;
  readonly index: number;
  readonly childCount: number;
  readonly hosting: DropHosting;
  /** A loop's template: whatever lands inside repeats once per item. */
  readonly loop: boolean;
}

/** The page tree as the drop model reads it: O(1) per question. */
export interface DropTree {
  readonly node: (id: string) => DropTreeNode | undefined;
  readonly rootCount: number;
}

export type DropMode = 'before' | 'after' | 'into';

/** The line or placeholder that shows the place, in frame pixels. */
export type DropGuide =
  | { readonly kind: 'line'; readonly orientation: 'horizontal' | 'vertical'; readonly x: number; readonly y: number; readonly length: number }
  | { readonly kind: 'empty'; readonly box: DropRect };

export type DropDecision =
  /** Nothing under the pointer the drop could name (outside the frame, or a page with nothing measured). */
  | { readonly kind: 'none' }
  /** The pointer is over the dragged node itself: dropping there leaves it where it is. */
  | { readonly kind: 'self'; readonly box: DropRect }
  /** Into a node that cannot take children for a reason the person should hear. */
  | { readonly kind: 'refused'; readonly reason: 'no-slot'; readonly targetId: string; readonly box: DropRect }
  | {
      readonly kind: 'place';
      readonly parentId: string | undefined;
      readonly index: number;
      readonly mode: DropMode;
      /** The sibling the line stands beside; undefined for a drop into an empty container. */
      readonly anchorId: string | undefined;
      /** The node dropped into the place it already holds: nothing to write. */
      readonly noop: boolean;
      /** The target parent sits in (or is) a loop's template. */
      readonly loop: boolean;
      readonly guide: DropGuide;
      /** The parent's box: outlined and named while the drop lands inside it. */
      readonly parentBox: DropRect;
    };

export interface DropQuery {
  readonly tree: DropTree;
  /** The node being moved; undefined for a new node (a component dragged from the palette). */
  readonly draggedId: string | undefined;
  readonly point: DropPoint;
  readonly levels: readonly DropLevel[];
  /** Containers to treat as taking nothing inside, so their middle drops beside them: the ones the view found cannot take this node. */
  readonly beside?: ReadonlySet<string> | undefined;
}

/** The edge band of a container, in which a drop goes beside it rather than into it. */
export const DROP_EDGE = { fraction: 0.25, pxMin: 4, pxMax: 16 } as const satisfies Record<string, number>;

/** Indexes `nodes` for the drag. `hosting` says what each node takes inside it (the caller knows the component definitions). */
export function indexDropTree(nodes: readonly TreeView[], hosting: (node: TreeView) => DropHosting): DropTree {
  const byId = new Map<string, DropTreeNode>();
  const stack: { readonly node: TreeView; readonly parentId: string | undefined; readonly index: number; readonly depth: number; readonly loop: boolean }[] =
    nodes.map((node, index) => ({ node, parentId: undefined, index, depth: 0, loop: false }));
  for (let visited = 0; visited < stack.length; visited++) {
    assert(visited < LIMITS.treeNodesMax, 'indexDropTree: the tree stays inside the node bound');
    const entry = stack[visited];
    assert(entry !== undefined, 'indexDropTree: the visit index lies inside the stack');
    assert(entry.depth <= LIMITS.treeDepthMax, 'indexDropTree: the tree stays inside the depth bound');
    const children = entry.node.children ?? [];
    const loop = entry.loop || entry.node.kind === 'map';
    if (!byId.has(entry.node.id)) {
      byId.set(entry.node.id, {
        id: entry.node.id,
        parentId: entry.parentId,
        index: entry.index,
        childCount: children.length,
        hosting: hosting(entry.node),
        loop,
      });
    }
    for (const [index, child] of children.entries()) {
      stack.push({ node: child, parentId: entry.node.id, index, depth: entry.depth + 1, loop });
    }
  }
  return { node: (id) => byId.get(id), rootCount: nodes.length };
}

/** Whether `id` is `ancestorId` or lies inside it. O(depth). */
export function dropWithin(tree: DropTree, id: string | undefined, ancestorId: string): boolean {
  let current = id;
  for (let depth = 0; depth <= LIMITS.treeDepthMax && current !== undefined; depth++) {
    if (current === ancestorId) {
      return true;
    }
    current = tree.node(current)?.parentId;
  }
  return false;
}

/** The decision for a pointer over the canvas. Total: every query has one. */
export function decideCanvasDrop(query: DropQuery): DropDecision {
  const { tree, draggedId, point, levels } = query;
  assert(levels.length <= LIMITS.treeDepthMax + 1, 'decideCanvasDrop: the levels stay inside the depth bound');
  assert(Number.isFinite(point.x), 'decideCanvasDrop: the pointer has a finite x');
  assert(Number.isFinite(point.y), 'decideCanvasDrop: the pointer has a finite y');
  // The levels inside the dragged node are the node itself: dropping a node inside itself is no place.
  let first = 0;
  let selfBox: DropRect | undefined = undefined;
  if (draggedId !== undefined) {
    while (first < levels.length) {
      const level = levels[first];
      assert(level !== undefined, 'decideCanvasDrop: the level index lies inside the levels');
      if (level.id === undefined || !dropWithin(tree, level.id, draggedId)) {
        break;
      }
      // The outermost level inside it is the box drawn: the node's own when it was measured.
      selfBox = level.box;
      first += 1;
    }
  }
  if (selfBox !== undefined) {
    return { kind: 'self', box: selfBox };
  }
  const hit = levels[first];
  if (hit === undefined) {
    return { kind: 'none' };
  }
  const parent = levels[first + 1];
  if (hit.id === undefined) {
    return intoLevel(tree, draggedId, hit, point);
  }
  const node = tree.node(hit.id);
  if (node === undefined) {
    return { kind: 'none' };
  }
  const band = parent === undefined ? 0 : edgeBand(hit.box, parent.flow);
  const inMiddle = parent === undefined || withinMiddle(hit.box, point, parent.flow, band);
  const hosting = query.beside?.has(node.id) === true || holdsOnlyText(hit, node) ? 'beside' : node.hosting;
  if (inMiddle) {
    switch (hosting) {
      case 'children':
        return intoLevel(tree, draggedId, hit, point);
      case 'no-slot':
        return { kind: 'refused', reason: 'no-slot', targetId: node.id, box: hit.box };
      case 'beside':
        break;
      default: {
        const exhaustive: never = hosting;
        return exhaustive;
      }
    }
  }
  if (parent === undefined) {
    return { kind: 'none' };
  }
  return besideLevel(tree, draggedId, { id: node.id, index: node.index, box: hit.box }, parent, point);
}

/** The guide for a place the placement rule moved the drop to, when the levels measured hold it; undefined otherwise. */
export function guideForPlace(levels: readonly DropLevel[], place: { readonly parentId: string | undefined; readonly index: number }): DropGuide | undefined {
  const level = levels.find((candidate) => candidate.id === place.parentId && candidate.children !== undefined);
  if (level === undefined) {
    return undefined;
  }
  const children = level.children ?? [];
  if (children.length === 0) {
    return { kind: 'empty', box: level.content };
  }
  const after = [...children].reverse().find((child) => child.index < place.index);
  const before = children.find((child) => child.index >= place.index);
  if (before !== undefined) {
    return lineFor(level, before, 'before', children);
  }
  assert(after !== undefined, 'guideForPlace: a level with children has one before or after any index');
  return lineFor(level, after, 'after', children);
}

// A container whose children the frame could not box (a heading's or a paragraph's words): its middle is the
// words themselves, and a drop there goes beside it, as on a void element. Drawing an empty container's
// placeholder over a heading said "empty, drop here" about something full.
function holdsOnlyText(level: DropLevel, node: DropTreeNode): boolean {
  if (node.childCount === 0) {
    return false;
  }
  return level.children !== undefined && level.children.length === 0;
}

// A drop into a measured container: before the nearest child along its flow, or after the last; into an
// empty container, the placeholder fills its content box.
function intoLevel(tree: DropTree, draggedId: string | undefined, level: DropLevel, point: DropPoint): DropDecision {
  const children = (level.children ?? []).filter((child) => draggedId === undefined || child.id !== draggedId);
  const childCount = level.id === undefined ? tree.rootCount : (tree.node(level.id)?.childCount ?? 0);
  const loop = level.id !== undefined && (tree.node(level.id)?.loop ?? false);
  if (children.length === 0) {
    // Nothing rendered inside (or only the dragged node): the drop appends.
    const index = childCount;
    return {
      kind: 'place',
      parentId: level.id,
      index,
      mode: 'into',
      anchorId: undefined,
      noop: isNoop(tree, draggedId, level.id, index),
      loop,
      guide: { kind: 'empty', box: level.content },
      parentBox: level.box,
    };
  }
  const nearest = nearestGap(children, point, level.flow);
  const index = nearest.mode === 'before' ? nearest.child.index : nearest.child.index + 1;
  assert(index <= childCount, 'intoLevel: a measured child index lies inside its parent');
  return {
    kind: 'place',
    parentId: level.id,
    index,
    mode: 'into',
    anchorId: nearest.child.id,
    noop: isNoop(tree, draggedId, level.id, index),
    loop,
    guide: lineFor(level, nearest.child, nearest.mode, children),
    parentBox: level.box,
  };
}

// A drop beside the node under the pointer, in its parent: before it when the pointer is in its leading half
// along the parent's flow, after it otherwise.
function besideLevel(tree: DropTree, draggedId: string | undefined, hit: DropChild, parent: DropLevel, point: DropPoint): DropDecision {
  const mode = leadingHalf(hit.box, point, parent.flow) ? 'before' : 'after';
  const index = mode === 'before' ? hit.index : hit.index + 1;
  const siblings = (parent.children ?? [hit]).filter((child) => draggedId === undefined || child.id !== draggedId);
  const loop = parent.id !== undefined && (tree.node(parent.id)?.loop ?? false);
  return {
    kind: 'place',
    parentId: parent.id,
    index,
    mode,
    anchorId: hit.id,
    noop: isNoop(tree, draggedId, parent.id, index),
    loop,
    guide: lineFor(parent, hit, mode, siblings.some((sibling) => sibling.id === hit.id) ? siblings : [...siblings, hit]),
    parentBox: parent.box,
  };
}

// The place a node already holds: the gap just before it and the gap just after it (indexes count the list as it was).
function isNoop(tree: DropTree, draggedId: string | undefined, parentId: string | undefined, index: number): boolean {
  if (draggedId === undefined) {
    return false;
  }
  const dragged = tree.node(draggedId);
  if (dragged === undefined) {
    return false;
  }
  if (dragged.parentId !== parentId) {
    return false;
  }
  return index === dragged.index || index === dragged.index + 1;
}

function stacksVertically(flow: DropFlow): boolean {
  return flow === 'block' || flow === 'column' || flow === 'column-reverse';
}

function reversed(flow: DropFlow): boolean {
  return flow === 'column-reverse' || flow === 'row-reverse';
}

/** The band at a container's leading and trailing edges along its parent's flow. */
export function edgeBand(box: DropRect, flow: DropFlow): number {
  const size = stacksVertically(flow) ? box.h : box.w;
  return Math.min(DROP_EDGE.pxMax, Math.max(DROP_EDGE.pxMin, size * DROP_EDGE.fraction));
}

function withinMiddle(box: DropRect, point: DropPoint, flow: DropFlow, band: number): boolean {
  if (stacksVertically(flow)) {
    return point.y > box.y + band && point.y < box.y + box.h - band;
  }
  return point.x > box.x + band && point.x < box.x + box.w - band;
}

// Whether the pointer is in the half of `box` that comes first in the flow's order.
function leadingHalf(box: DropRect, point: DropPoint, flow: DropFlow): boolean {
  let leading: boolean;
  if (stacksVertically(flow)) {
    leading = point.y < box.y + box.h / 2;
  } else if (flow === 'grid' || flow === 'wrap') {
    // A grid or a wrapping row reads line by line: above the box's row is before it, below is after it.
    if (point.y < box.y) {
      leading = true;
    } else if (point.y > box.y + box.h) {
      leading = false;
    } else {
      leading = point.x < box.x + box.w / 2;
    }
  } else {
    leading = point.x < box.x + box.w / 2;
  }
  return reversed(flow) ? !leading : leading;
}

// The child the pointer is nearest to, and which side of it. Along a single axis that is the first child whose
// middle lies past the pointer; in a grid or a wrapping row it is the nearest box.
function nearestGap(children: readonly DropChild[], point: DropPoint, flow: DropFlow): { readonly child: DropChild; readonly mode: 'before' | 'after' } {
  assert(children.length > 0, 'nearestGap: there is a child to stand beside');
  if (flow === 'grid' || flow === 'wrap') {
    let best = children[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const child of children) {
      const distance = distanceTo(child.box, point);
      if (distance < bestDistance) {
        best = child;
        bestDistance = distance;
      }
    }
    assert(best !== undefined, 'nearestGap: a nearest child was found');
    return { child: best, mode: leadingHalf(best.box, point, flow) ? 'before' : 'after' };
  }
  const ordered = [...children].sort((left, right) => left.index - right.index);
  for (const child of ordered) {
    if (leadingHalf(child.box, point, flow)) {
      return { child, mode: 'before' };
    }
  }
  const last = ordered.at(-1);
  assert(last !== undefined, 'nearestGap: a list with children has a last one');
  return { child: last, mode: 'after' };
}

function distanceTo(box: DropRect, point: DropPoint): number {
  const dx = Math.max(box.x - point.x, 0, point.x - (box.x + box.w));
  const dy = Math.max(box.y - point.y, 0, point.y - (box.y + box.h));
  return Math.hypot(dx, dy);
}

/**
 * The insertion line beside `anchor` in `level`: across the parent's content box, perpendicular to its flow, in
 * the middle of the gap to the neighbour on that side when there is one (so the line sits between the two, not
 * on one of them). A grid or a wrapping row draws it along the anchor's own row.
 */
export function lineFor(level: DropLevel, anchor: DropChild, mode: 'before' | 'after', siblings: readonly DropChild[]): DropGuide {
  const ordered = [...siblings].sort((left, right) => left.index - right.index);
  const at = ordered.findIndex((sibling) => sibling.id === anchor.id);
  assert(at >= 0, 'lineFor: the anchor is among its siblings');
  const neighbour = mode === 'before' ? ordered[at - 1] : ordered[at + 1];
  const box = anchor.box;
  const content = level.content.w > 0 && level.content.h > 0 ? level.content : level.box;
  // In reading order, "before" is the leading edge; a reversed flow lays the leading child out last.
  const leadingEdge = (mode === 'before') !== reversed(level.flow);
  if (stacksVertically(level.flow)) {
    const edge = leadingEdge ? box.y : box.y + box.h;
    const other = neighbour === undefined ? undefined : leadingEdge ? neighbour.box.y + neighbour.box.h : neighbour.box.y;
    const y = other !== undefined && sameSide(edge, other, leadingEdge ? 'leading' : 'trailing') ? (edge + other) / 2 : edge;
    return { kind: 'line', orientation: 'horizontal', x: content.x, y, length: content.w };
  }
  const edge = leadingEdge ? box.x : box.x + box.w;
  const sameRow = neighbour !== undefined && overlapsVertically(neighbour.box, box);
  const other = neighbour === undefined || !sameRow ? undefined : leadingEdge ? neighbour.box.x + neighbour.box.w : neighbour.box.x;
  const x = other !== undefined && sameSide(edge, other, leadingEdge ? 'leading' : 'trailing') ? (edge + other) / 2 : edge;
  if (level.flow === 'grid' || level.flow === 'wrap') {
    return { kind: 'line', orientation: 'vertical', x, y: box.y, length: box.h };
  }
  return { kind: 'line', orientation: 'vertical', x, y: content.y, length: content.h };
}

// A neighbour's facing edge counts only when it lies on the expected side of the anchor's (not overlapping it).
function sameSide(edge: number, other: number, side: 'leading' | 'trailing'): boolean {
  return side === 'leading' ? other <= edge : other >= edge;
}

function overlapsVertically(left: DropRect, right: DropRect): boolean {
  return left.y < right.y + right.h && right.y < left.y + left.h;
}
