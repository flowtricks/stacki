// From a decision to the picture: what the drag controller (src/app/state/appCanvasDrag.ts) publishes for the
// canvas overlay and the Navigator to draw (src/editor/canvasDragSession.ts).
//
// Pure, so the whole chain (frame levels -> decision -> verdict -> canvas guide and Navigator mark) is tested
// without a window. The placement rule judges each place once per drag and the answer is kept: a pointer that
// stays over one gap asks nothing new, and the cache is bounded by the places one drag can name.

import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import {
  decideCanvasDrop,
  guideForPlace,
  indexDropTree,
  type DropDecision,
  type DropHosting,
  type DropLevel,
  type DropPoint,
  type DropRect,
  type DropTree,
} from './canvasDrop';
import type { CanvasDragSubject, CanvasDragView, CanvasDropVerdict, NavigatorDropMark } from './canvasDragSession';
import { VOID_TAGS } from './elementSchemas';
import { placementNodeOfItem, resolveTarget, type PlacementEnvironment, type PlacementSubject } from './placementCheck';
import type { TreeView } from './treeView';

/** What a component definition says about its slots, as the scan lists it. */
export interface DropInsertable {
  readonly name: string;
  readonly slots?: readonly string[];
  readonly renderTag?: { readonly tag?: string | undefined; readonly prop?: string | undefined } | undefined;
}

/** One drag's fixed facts: the tree as it was when the drag began, and what is moving. */
export interface DropSession {
  readonly nodes: readonly TreeView[];
  readonly tree: DropTree;
  readonly byId: ReadonlyMap<string, TreeView>;
  readonly subject: CanvasDragSubject;
  readonly placement: PlacementSubject | undefined;
  readonly environment: PlacementEnvironment;
  /** The placement rule's answer per place, kept for the drag. */
  readonly placements: Map<string, CanvasDropVerdict>;
}

/** The places one drag may judge before the cache starts over: far more than a person can point at in one drag. */
const PLACEMENTS_MAX = 4096;

/** What `node` takes inside it. A component whose definition is known and has no default slot renders nothing put inside it. */
export function hostingOf(node: TreeView, insertables: readonly DropInsertable[]): DropHosting {
  if (node.id === 'layout') {
    return 'children';
  }
  switch (node.kind) {
    case 'element':
      return VOID_TAGS.has(String(node.name ?? '').toLowerCase()) ? 'beside' : 'children';
    case 'component': {
      if (node.name === 'Fragment') {
        return 'children';
      }
      const definition = insertables.find((candidate) => candidate.name === node.name);
      if (definition === undefined) {
        return 'children'; // Unknown is allowed: a wrong refusal is worse than a wrong nesting (shared/page/placement.ts).
      }
      return (definition.slots ?? []).includes('default') ? 'children' : 'no-slot';
    }
    case 'map':
      // A loop whose callback is code returns each root from its own site: drops go inside its elements (navigatorDrop.ts).
      return node.bodyParts === undefined ? 'children' : 'beside';
    case 'chunk-group':
    case 'branch':
      return 'children';
    default:
      return 'beside';
  }
}

/** What the chip says is moving. */
export function subjectOf(node: TreeView, label: string): CanvasDragSubject {
  switch (node.kind) {
    case 'component':
      return { kind: node.name === 'Fragment' ? 'element' : 'component', id: node.id, label };
    case 'map':
      return { kind: 'loop', id: node.id, label };
    case 'text':
    case 'expr':
      return { kind: 'text', id: node.id, label };
    default:
      return { kind: 'element', id: node.id, label };
  }
}

/** The drag's fixed facts. O(nodes), once per drag. */
export function startDropSession(
  nodes: readonly TreeView[],
  subject: CanvasDragSubject,
  environment: PlacementEnvironment & { readonly insertables: readonly DropInsertable[] },
): DropSession {
  const byId = new Map<string, TreeView>();
  const tree = indexDropTree(nodes, (node) => {
    byId.set(node.id, node);
    return hostingOf(node, environment.insertables);
  });
  let placement: PlacementSubject | undefined;
  if (subject.kind === 'new') {
    const node = placementNodeOfItem({ type: 'component', name: subject.label }, environment);
    placement = node === undefined ? undefined : { kind: 'new', node };
  } else {
    assert(byId.has(subject.id), 'startDropSession: the dragged node is in the tree');
    placement = { kind: 'existing', id: subject.id };
  }
  return { nodes, tree, byId, subject, placement, environment, placements: new Map() };
}

/** The frame's levels as the model reads them: paths turned into ids. A level whose node the tree lacks is left out. */
export function levelsOfPaths(
  levels: readonly {
    readonly path: string;
    readonly box: DropRect;
    readonly content: DropRect;
    readonly flow: DropLevel['flow'];
    readonly children: readonly { readonly path: string; readonly box: DropRect }[] | undefined;
  }[],
  tree: DropTree,
  idOfPath: (path: string) => string | undefined,
): readonly DropLevel[] {
  const out: DropLevel[] = [];
  for (const level of levels) {
    const id = level.path === '' ? undefined : idOfPath(level.path);
    if (level.path !== '' && id === undefined) {
      continue;
    }
    const children =
      level.children === undefined
        ? undefined
        : level.children.flatMap((child) => {
            const childId = idOfPath(child.path);
            const node = childId === undefined ? undefined : tree.node(childId);
            return node === undefined ? [] : [{ id: node.id, index: node.index, box: child.box }];
          });
    out.push({ id, box: level.box, content: level.content, flow: level.flow, children });
  }
  return out;
}

/** The picture of the drag for a pointer at `pointer` over `levels`. */
export function dropView(
  session: DropSession,
  input: { readonly levels: readonly DropLevel[]; readonly pointer: DropPoint; readonly dragged: readonly DropRect[]; readonly outside: boolean },
  pathOf: (id: string) => string | undefined,
): CanvasDragView {
  const { decision, verdict } = decideAndJudge(session, input);
  const place = landing(decision, verdict);
  const guide = guideOf(decision, verdict, input.levels);
  const parentBox = place === undefined ? undefined : parentBoxOf(decision, place, input.levels);
  const navigator = place === undefined ? undefined : markOf(decision, place);
  return {
    subject: session.subject,
    decision,
    verdict,
    guide,
    parent:
      parentBox === undefined || place === undefined ? undefined : { box: parentBox, path: place.parentId === undefined ? undefined : pathOf(place.parentId) },
    navigator,
    expand: place === undefined ? new Set() : openedFor(session.tree, place.parentId),
    revealId: place === undefined ? undefined : decision.kind === 'place' && verdict.kind !== 'snap' ? (decision.anchorId ?? place.parentId) : place.parentId,
    dragged: input.dragged,
    pointer: input.pointer,
  };
}

/** How many containers one pointer position may turn away before the drop settles beside one: the tree's depth. */
const BESIDE_RETRIES_MAX = LIMITS.treeDepthMax;

// The decision, and the rule's verdict on it. A container the node cannot go into (a component without a slot, a
// heading or a paragraph that cannot hold the node) takes the drop beside it instead, before or after by halves, as
// a void element does: in its middle the person meant "here", and a red refusal or a drop moved somewhere else
// read as the canvas flickering between two answers while crossing it.
function decideAndJudge(
  session: DropSession,
  input: { readonly levels: readonly DropLevel[]; readonly pointer: DropPoint; readonly outside: boolean },
): { readonly decision: DropDecision; readonly verdict: CanvasDropVerdict } {
  if (input.outside) {
    return { decision: { kind: 'none' }, verdict: { kind: 'none' } };
  }
  const draggedId = session.subject.kind === 'new' ? undefined : session.subject.id;
  const beside = new Set<string>();
  for (let attempt = 0; attempt <= BESIDE_RETRIES_MAX; attempt++) {
    const decision = decideCanvasDrop({ tree: session.tree, draggedId, point: input.pointer, levels: input.levels, beside });
    const verdict = verdictOf(session, decision);
    const turnedAway = intoRefused(decision, verdict);
    if (turnedAway === undefined || beside.has(turnedAway)) {
      return { decision, verdict };
    }
    beside.add(turnedAway);
  }
  assert(false, 'decideAndJudge: a pointer settles within the tree depth');
}

// The container a drop into was turned away from, when it was.
function intoRefused(decision: DropDecision, verdict: CanvasDropVerdict): string | undefined {
  if (decision.kind === 'refused') {
    return decision.targetId;
  }
  if (decision.kind !== 'place' || decision.mode !== 'into' || decision.parentId === undefined) {
    return undefined;
  }
  return verdict.kind === 'snap' || verdict.kind === 'refused' ? decision.parentId : undefined;
}

/** Pointer travel, in frame pixels, before a new place replaces the one shown. */
export const DROP_STICKY_PX = 6;
/** Probes a held place survives at most: a pointer resting on a boundary still settles, a frame or so later. */
export const DROP_HOLD_PROBES_MAX = 8;

/** The place on screen, where the pointer was when it was taken, and how many probes have held it since. */
export interface ShownDrop {
  readonly view: CanvasDragView;
  readonly at: DropPoint;
  readonly held: number;
}

/**
 * The view to show: `next`, unless it names another place than the one shown while the pointer has moved less than
 * DROP_STICKY_PX since that place was taken. Near the boundary between two places (a midline, an edge band) the
 * pointer's own tremor otherwise flips the line between them every frame. A move past the distance switches at
 * once; so does a scroll under a still pointer (the dragged node's box moved), since the held line would be drawn
 * where the page no longer is; and no place is held for more than DROP_HOLD_PROBES_MAX probes. A change of verdict at
 * the same place, or to nothing, is never held back.
 */
export function stickyView(shown: ShownDrop | undefined, next: CanvasDragView): ShownDrop {
  const fresh: ShownDrop = { view: next, at: next.pointer, held: 0 };
  if (shown === undefined) {
    return fresh;
  }
  const before = placeKey(shown.view);
  const after = placeKey(next);
  if (before === after) {
    return { view: next, at: shown.at, held: 0 };
  }
  if (before === undefined || after === undefined) {
    return fresh;
  }
  const travelled = Math.hypot(next.pointer.x - shown.at.x, next.pointer.y - shown.at.y);
  if (travelled >= DROP_STICKY_PX) {
    return fresh;
  }
  if (shown.held >= DROP_HOLD_PROBES_MAX) {
    return fresh;
  }
  if (scrolledUnder(shown.view, next)) {
    return fresh;
  }
  assert(shown.held < DROP_HOLD_PROBES_MAX, 'stickyView: a held place is inside its bound');
  return { view: { ...shown.view, pointer: next.pointer }, at: shown.at, held: shown.held + 1 };
}

// Whether the page moved under the pointer between two probes: the dragged node's box is where the page is.
function scrolledUnder(before: CanvasDragView, after: CanvasDragView): boolean {
  const was = before.dragged[0];
  const now = after.dragged[0];
  if (was === undefined || now === undefined) {
    return false;
  }
  return Math.abs(was.y - now.y) > 0.5 || Math.abs(was.x - now.x) > 0.5;
}

function placeKey(view: CanvasDragView): string | undefined {
  const place = landing(view.decision, view.verdict);
  if (place === undefined) {
    return undefined;
  }
  return `${place.parentId ?? ''}\u0000${place.index}`;
}

/** What a release does: nothing (a refused place, nothing under the pointer, the place the node already holds), a move, or an insert. */
export type DropAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'move'; readonly id: string; readonly place: { readonly parentId: string | undefined; readonly index: number } }
  | { readonly kind: 'insert'; readonly component: string; readonly place: { readonly parentId: string | undefined; readonly index: number } };

export function dropActionOf(subject: CanvasDragSubject, view: Pick<CanvasDragView, 'decision' | 'verdict'>): DropAction {
  if (view.verdict.kind === 'noop') {
    return { kind: 'none' };
  }
  const place = landing(view.decision, view.verdict);
  if (place === undefined) {
    return { kind: 'none' };
  }
  if (subject.kind === 'new') {
    return { kind: 'insert', component: subject.path ?? subject.label, place };
  }
  return { kind: 'move', id: subject.id, place };
}

/** Where the drop writes: the decision's place, the snapped neighbour, or nowhere. */
export function landing(decision: DropDecision, verdict: CanvasDropVerdict): { readonly parentId: string | undefined; readonly index: number } | undefined {
  switch (verdict.kind) {
    case 'valid':
    case 'noop':
      return decision.kind === 'place' ? { parentId: decision.parentId, index: decision.index } : undefined;
    case 'snap':
      return verdict.to;
    case 'refused':
    case 'none':
      return undefined;
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

function verdictOf(session: DropSession, decision: DropDecision): CanvasDropVerdict {
  switch (decision.kind) {
    case 'none':
      return { kind: 'none' };
    case 'self':
      return { kind: 'refused', reason: { kind: 'self' } };
    case 'refused': {
      const node = session.byId.get(decision.targetId);
      return { kind: 'refused', reason: { kind: 'no-slot', name: node?.name ?? '' } };
    }
    case 'place':
      return decision.noop ? { kind: 'noop' } : placementVerdict(session, { parentId: decision.parentId, index: decision.index });
    default: {
      const exhaustive: never = decision;
      return exhaustive;
    }
  }
}

function placementVerdict(session: DropSession, place: { readonly parentId: string | undefined; readonly index: number }): CanvasDropVerdict {
  const key = `${place.parentId ?? ''}\u0000${place.index}`;
  const known = session.placements.get(key);
  if (known !== undefined) {
    return known;
  }
  if (session.placements.size >= PLACEMENTS_MAX) {
    session.placements.clear(); // A cache, not a record: starting over costs one judgement per place.
  }
  const verdict = judge(session, place);
  session.placements.set(key, verdict);
  assert(session.placements.size <= PLACEMENTS_MAX, 'placementVerdict: the cache stays inside its bound');
  return verdict;
}

function judge(session: DropSession, place: { readonly parentId: string | undefined; readonly index: number }): CanvasDropVerdict {
  if (session.placement === undefined) {
    return { kind: 'valid', warning: undefined }; // A component the model cannot describe: unknown is allowed.
  }
  const resolved = resolveTarget(session.nodes, session.placement, place, session.environment);
  switch (resolved.kind) {
    case 'placed':
      return { kind: 'valid', warning: resolved.warning };
    case 'snapped':
      return { kind: 'snap', to: { parentId: resolved.target.parentId, index: resolved.target.index }, reason: resolved.reason };
    case 'refused':
      return { kind: 'refused', reason: { kind: 'placement', message: resolved.refusal } };
    default: {
      const exhaustive: never = resolved;
      return exhaustive;
    }
  }
}

function guideOf(decision: DropDecision, verdict: CanvasDropVerdict, levels: readonly DropLevel[]) {
  switch (verdict.kind) {
    case 'snap':
      return guideForPlace(levels, verdict.to);
    case 'valid':
    case 'noop':
      return decision.kind === 'place' ? decision.guide : undefined;
    case 'refused':
      // A place the rule refuses still shows where it is, in red: the person sees what was refused.
      return decision.kind === 'place' ? decision.guide : undefined;
    case 'none':
      return undefined;
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

function parentBoxOf(decision: DropDecision, place: { readonly parentId: string | undefined }, levels: readonly DropLevel[]): DropRect | undefined {
  if (decision.kind === 'place' && decision.parentId === place.parentId) {
    return decision.parentBox;
  }
  return levels.find((level) => level.id === place.parentId)?.box;
}

// The Navigator's picture of a place: an empty container's row lights up; anything else is a gap between rows.
function markOf(decision: DropDecision, place: { readonly parentId: string | undefined; readonly index: number }): NavigatorDropMark {
  if (
    decision.kind === 'place' &&
    decision.parentId === place.parentId &&
    decision.mode === 'into' &&
    decision.anchorId === undefined &&
    place.parentId !== undefined
  ) {
    return { kind: 'into', intoId: place.parentId };
  }
  return { kind: 'gap', parentId: place.parentId, index: place.index };
}

/** The rows to open so a mark inside `parentId` can be seen: the parent and every row above it. O(depth). */
export function openedFor(tree: DropTree, parentId: string | undefined): ReadonlySet<string> {
  const opened = new Set<string>();
  let current = parentId;
  for (let depth = 0; depth <= LIMITS.treeDepthMax && current !== undefined; depth++) {
    opened.add(current);
    current = tree.node(current)?.parentId;
  }
  assert(parentId === undefined || opened.has(parentId), 'openedFor: the parent itself opens');
  return opened;
}
