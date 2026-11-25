// The planner's half of the placement rule (shared/page/placement.ts): whatever asked for an
// insertion, a move or a wrap, the file is written only if the structure it leaves is one the
// model allows. This is the last line of defence: the editor checks the same rule before it
// sends an edit, but a stale panel, a script or a bug must not be able to write a page that
// fails to compile. A refusal is the typed `invalid-placement` rejection, planned before any
// splice exists, so no byte is written.
//
// The model works on a description of the place; here it is read from the projection and the
// bytes. Markdown lists are not markup and are not judged.
import { assert } from '../core/assert';
import { LIMITS } from '../core/limits';
import {
  checkPlacement,
  isDoctypeText,
  PLACEMENT_LIMITS,
  placementNodeOfName,
  type PlacementFrame,
  type PlacementNode,
  type PlacementQuery,
  type PlacementVerdict,
} from '../page/placement';
import type { StructuralPath } from '../page/ref';

import type { ProjectedNode } from '../page/sourceProjection';
import { ancestorsOf, blankText, samePath, siblingsOf, startsWith, textOf, type ValidProjection } from './planSupport';
import { toByteSpan, type ByteString } from '../core/span';
import { err, ok, type Result } from '../core/result';
import type { Placement, RejectionReason } from './intent';

const TAG_AT_START = /^<\s*([A-Za-z][\w.:-]*)/;
const TAG_ANYWHERE = /<\s*([A-Za-z][\w.:-]*)/g;
const DOCTYPE_ANYWHERE = /<!doctype\b/i;

/** The place a node would land: the destination list's owner and the siblings either side of the gap. */
interface Destination {
  readonly frames: readonly PlacementFrame[];
  readonly before: readonly ProjectedNode[];
  readonly after: readonly ProjectedNode[];
}

/** Refuses an insertion of `source` beside or inside `target` when the structure would be invalid. */
export function checkInsertion(
  bytes: ByteString,
  projection: ValidProjection,
  target: ProjectedNode,
  placement: Placement,
  source: string,
): Result<undefined, RejectionReason> {
  if (target.list !== 'markup') {
    return ok(undefined);
  }
  const destination = destinationOf(bytes, projection, target, placement, undefined);
  return verdictResult(checkPlacement(queryFor(bytes, projection, destination, nodeOfSource(source))));
}

/** Refuses a move of `moved` to beside or inside `target` when the structure would be invalid. */
export function checkRelocation(
  bytes: ByteString,
  projection: ValidProjection,
  moved: ProjectedNode,
  target: ProjectedNode,
  placement: Placement,
): Result<undefined, RejectionReason> {
  if (target.list !== 'markup' || moved.list !== 'markup') {
    return ok(undefined);
  }
  const destination = destinationOf(bytes, projection, target, placement, moved);
  return verdictResult(checkPlacement(queryFor(bytes, projection, destination, nodeOfProjected(bytes, projection, moved))));
}

/** Refuses a wrap of the run `first`..`last` in `open` when the wrapper or what it holds would be invalid. */
export function checkWrap(
  bytes: ByteString,
  projection: ValidProjection,
  first: ProjectedNode,
  last: ProjectedNode,
  open: string,
): Result<undefined, RejectionReason> {
  if (first.list !== 'markup') {
    return ok(undefined);
  }
  const siblings = siblingsOf(projection, first);
  const from = siblings.indexOf(first);
  const to = siblings.indexOf(last);
  assert(from >= 0, 'The first wrapped node is among its siblings');
  assert(to >= from, 'The wrapped run is in document order');
  const run = siblings.slice(from, to + 1);
  const outside: Destination = { frames: framesOf(bytes, projection, first.path), before: siblings.slice(0, from), after: siblings.slice(to + 1) };
  const wrapper = nodeOfSource(open);
  const wrapperVerdict = checkPlacement(queryFor(bytes, projection, outside, wrapper));
  if (!wrapperVerdict.ok) {
    return verdictResult(wrapperVerdict);
  }
  const wrapperFrame = frameOfNode(wrapper);
  assert(run.length <= LIMITS.treeNodesMax, 'A wrapped run is inside the node bound');
  for (const [index, node] of run.entries()) {
    const inside: Destination = {
      frames: [...outside.frames, ...(wrapperFrame === undefined ? [] : [wrapperFrame])],
      before: run.slice(0, index),
      after: run.slice(index + 1),
    };
    const verdict = checkPlacement(queryFor(bytes, projection, inside, nodeOfProjected(bytes, projection, node)));
    if (!verdict.ok) {
      return verdictResult(verdict);
    }
  }
  return ok(undefined);
}

function verdictResult(verdict: PlacementVerdict): Result<undefined, RejectionReason> {
  return verdict.ok ? ok(undefined) : err('invalid-placement');
}

function queryFor(bytes: ByteString, projection: ValidProjection, destination: Destination, node: PlacementNode): PlacementQuery {
  return {
    node,
    frames: destination.frames,
    before: destination.before.map((sibling) => nodeOfProjected(bytes, projection, sibling, 'shallow')),
    after: destination.after.map((sibling) => nodeOfProjected(bytes, projection, sibling, 'shallow')),
    document: 'unknown',
  };
}

function destinationOf(
  bytes: ByteString,
  projection: ValidProjection,
  target: ProjectedNode,
  placement: Placement,
  moved: ProjectedNode | undefined,
): Destination {
  const excluded = (node: ProjectedNode): boolean => moved !== undefined && startsWith(node.path, moved.path);
  switch (placement) {
    case 'before':
    case 'after': {
      const siblings = siblingsOf(projection, target).filter((node) => !excluded(node));
      const at = siblings.findIndex((node) => samePath(node.path, target.path));
      assert(at >= 0, 'The anchor is among its siblings');
      const cut = placement === 'before' ? at : at + 1;
      return { frames: framesOf(bytes, projection, target.path), before: siblings.slice(0, cut), after: siblings.slice(cut) };
    }
    case 'first-child':
    case 'last-child': {
      const children = projection.nodes.filter((node) => node.path.length === target.path.length + 1 && startsWith(node.path, target.path) && !excluded(node));
      const cut = placement === 'first-child' ? 0 : children.length;
      return { frames: [...framesOf(bytes, projection, target.path), ...frameOf(bytes, target)], before: children.slice(0, cut), after: children.slice(cut) };
    }
    default: {
      const exhaustive: never = placement;
      return exhaustive;
    }
  }
}

// The frames above a node, outermost first, read from the owners on its path.
function framesOf(bytes: ByteString, projection: ValidProjection, path: StructuralPath): readonly PlacementFrame[] {
  const frames: PlacementFrame[] = [];
  for (const ancestor of ancestorsOf(projection, path)) {
    frames.push(...frameOf(bytes, ancestor));
  }
  assert(frames.length <= PLACEMENT_LIMITS.framesMax, 'A place is no deeper than the page tree');
  return frames;
}

// What a node holding children adds to the place: an element or a component a level; a loop or a branch a transparent one.
function frameOf(bytes: ByteString, node: ProjectedNode): readonly PlacementFrame[] {
  switch (node.kind) {
    case 'element':
    case 'component': {
      const placed = nodeOfName(nameAt(bytes, node), node.kind);
      switch (placed.kind) {
        case 'fragment':
          return [{ kind: 'fragment' }];
        case 'element':
          return [{ kind: 'element', tag: placed.tag }];
        case 'component':
          return [{ kind: 'component', tag: placed.tag }];
        case 'slot':
          return [{ kind: 'fragment' }];
        case 'doctype':
        case 'text':
        case 'comment':
        case 'code':
          return [];
        default: {
          const exhaustive: never = placed;
          return exhaustive;
        }
      }
    }
    case 'map':
    case 'cond':
    case 'branch':
    case 'chunk-group':
      return [{ kind: 'transparent' }];
    case 'raw':
    case 'text':
    case 'expr':
    case 'raw-line':
    case 'comment':
      return [];
    default: {
      const exhaustive: never = node.kind;
      return exhaustive;
    }
  }
}

function frameOfNode(node: PlacementNode): PlacementFrame | undefined {
  switch (node.kind) {
    case 'element':
      return { kind: 'element', tag: node.tag };
    case 'component':
      return { kind: 'component', tag: node.tag };
    case 'fragment':
    case 'slot':
      return { kind: 'fragment' };
    case 'doctype':
    case 'text':
    case 'comment':
    case 'code':
      return undefined;
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

function nameAt(bytes: ByteString, node: ProjectedNode): string {
  const end = Math.min(node.span.end, node.span.start + LIMITS.tagNameCharsMax * 4);
  const match = TAG_AT_START.exec(textOf(bytes, toByteSpan(node.span.start, end)));
  // A fragment `<>` has no name.
  return match?.[1] ?? '';
}

function nodeOfName(name: string, kind: 'element' | 'component'): PlacementNode {
  assert(name.length <= LIMITS.tagNameCharsMax, 'A tag name is inside the tag-name bound');
  return placementNodeOfName(name, kind, undefined);
}

// A node already in the file. `shallow` skips the descendants a sibling never needs.
function nodeOfProjected(bytes: ByteString, projection: ValidProjection, node: ProjectedNode, depth: 'deep' | 'shallow' = 'deep'): PlacementNode {
  switch (node.kind) {
    case 'element':
    case 'component': {
      const placed = nodeOfName(nameAt(bytes, node), node.kind);
      if (depth === 'shallow' || (placed.kind !== 'element' && placed.kind !== 'component')) {
        return placed;
      }
      return { ...placed, descendants: descendantTags(bytes, projection, node) };
    }
    case 'raw':
      return { kind: 'element', tag: nameAt(bytes, node).toLowerCase() };
    case 'text':
      return { kind: 'text', blank: blankText(bytes, node) };
    case 'comment':
      return { kind: 'comment' };
    case 'raw-line':
      return isDoctypeText(textOf(bytes, node.span)) ? { kind: 'doctype' } : { kind: 'code' };
    case 'expr':
    case 'map':
    case 'cond':
    case 'branch':
    case 'chunk-group':
      return { kind: 'code' };
    default: {
      const exhaustive: never = node.kind;
      return exhaustive;
    }
  }
}

function descendantTags(bytes: ByteString, projection: ValidProjection, node: ProjectedNode): readonly string[] {
  const tags = new Set<string>();
  for (const candidate of projection.nodes) {
    if (candidate.path.length > node.path.length && startsWith(candidate.path, node.path) && (candidate.kind === 'element' || candidate.kind === 'component')) {
      tags.add(nameAt(bytes, candidate).toLowerCase());
      if (tags.size >= PLACEMENT_LIMITS.descendantsMax) {
        break;
      }
    }
  }
  return [...tags];
}

// New text, not yet in the file: classified from what it says.
function nodeOfSource(source: string): PlacementNode {
  assert(source.length <= LIMITS.ipcFieldCharsMax, 'Inserted source is inside the field bound');
  if (DOCTYPE_ANYWHERE.test(source)) {
    return { kind: 'doctype' }; // A doctype anywhere in new text is judged as the doctype.
  }
  const trimmed = source.trimStart();
  if (trimmed.startsWith('<!--')) {
    return { kind: 'comment' };
  }
  const first = TAG_AT_START.exec(trimmed)?.[1];
  if (first === undefined) {
    if (trimmed.startsWith('<>')) {
      return { kind: 'fragment' };
    }
    return trimmed.startsWith('{') ? { kind: 'code' } : { kind: 'text', blank: trimmed === '' };
  }
  const placed = nodeOfName(first, /^[a-z]/.test(first) ? 'element' : 'component');
  if (placed.kind !== 'element' && placed.kind !== 'component') {
    return placed;
  }
  const descendants = new Set<string>();
  for (const match of source.matchAll(TAG_ANYWHERE)) {
    const name = match[1];
    if (name !== undefined && descendants.size < PLACEMENT_LIMITS.descendantsMax) {
      descendants.add(name.toLowerCase());
    }
  }
  return { ...placed, descendants: [...descendants] };
}
