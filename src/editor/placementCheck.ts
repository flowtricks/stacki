// The editor's half of the placement rule (shared/page/placement.ts): it describes a place in the
// live tree, asks the model, and finds the nearest place that works when the one asked for does
// not. Every way of putting a node on the page asks here before it builds an edit: Navigator and
// canvas drops, the insert palette, paste, duplicate, move, wrap, and the Apps insert. The
// planner asks the same model again on the bytes, so a stale panel still cannot write a page that
// fails to compile.
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import {
  checkPlacement,
  frontmatterRefusal,
  isDoctypeText,
  placementNodeOfName,
  PLACEMENT_LIMITS,
  selfDropRefusal,
  type PlacementDocument,
  type PlacementFrame,
  type PlacementMessage,
  type PlacementNode,
  type PlacementVerdict,
} from '../../shared/page/placement';
import { tagOfComponent, type InsertTarget } from './insertTarget';
import type { TreeView } from './treeView';

export interface PlacementInsertable {
  readonly name: string;
  readonly renderTag?: { readonly tag?: string | undefined; readonly prop?: string | undefined } | undefined;
}

/** What is being placed: a node already on the page (a move), or one about to be made. */
export type PlacementSubject = { readonly kind: 'existing'; readonly id: string } | { readonly kind: 'new'; readonly node: PlacementNode };

export interface PlacementEnvironment {
  readonly insertables: readonly PlacementInsertable[] | undefined;
  readonly document: PlacementDocument;
}

/** The file kind a path names, for the rules that depend on it (a slot, a bare list item). */
export function documentOfPath(path: string | undefined): PlacementDocument {
  if (path === undefined) {
    return 'unknown';
  }
  if (/\.(md|mdx)$/i.test(path) || /(^|[\\/])src[\\/]pages[\\/]/.test(path)) {
    return 'page';
  }
  return path.endsWith('.astro') ? 'component' : 'unknown';
}

/** The model's node for one in the tree. `deep` also lists the element tags beneath it, for the nesting rules. */
export function placementNodeOf(node: TreeView, environment: PlacementEnvironment, depth: 'deep' | 'shallow'): PlacementNode {
  switch (node.kind) {
    case 'element':
    case 'component': {
      const named = placementNodeOfName(
        node.kind === 'component' && node.name === undefined ? '' : (node.name ?? ''),
        node.kind,
        renderedTagOf(node, environment),
      );
      if (depth === 'shallow' || (named.kind !== 'element' && named.kind !== 'component')) {
        return named;
      }
      return { ...named, descendants: descendantTags(node) };
    }
    case 'raw':
      return { kind: 'element', tag: (node.name ?? '').toLowerCase() };
    case 'text':
      return { kind: 'text', blank: /^\s*$/.test(node.value ?? '') };
    case 'comment':
      return { kind: 'comment' };
    case 'raw-line':
      return isDoctypeText(node.value ?? '') ? { kind: 'doctype' } : { kind: 'code' };
    default:
      return { kind: 'code' };
  }
}

function renderedTagOf(node: TreeView, environment: PlacementEnvironment): string | undefined {
  if (node.kind !== 'component') {
    return undefined;
  }
  const component = (environment.insertables ?? []).find((candidate) => candidate.name === node.name);
  return tagOfComponent(component, node);
}

function descendantTags(node: TreeView): readonly string[] {
  const tags = new Set<string>();
  const pending: TreeView[] = [...(node.children ?? [])];
  for (let visited = 0; visited < pending.length && tags.size < PLACEMENT_LIMITS.descendantsMax; visited++) {
    assert(visited < LIMITS.treeNodesMax, 'A subtree stays inside the node bound');
    const next = pending[visited];
    assert(next !== undefined, 'The visit index lies inside the list');
    if ((next.kind === 'element' || next.kind === 'component') && next.name !== undefined && next.name !== '') {
      tags.add(next.name.toLowerCase());
    }
    pending.push(...(next.children ?? []));
  }
  return [...tags];
}

/** The node an insert-palette item makes, as the model sees it; undefined for an item the model does not judge. */
export function placementNodeOfItem(
  item: { readonly type: string; readonly tag?: string; readonly name?: string },
  environment: PlacementEnvironment,
): PlacementNode | undefined {
  switch (item.type) {
    case 'element':
      return item.tag === undefined ? undefined : placementNodeOfName(item.tag, 'element', undefined);
    case 'component':
    case 'astroAsset': {
      const component = (environment.insertables ?? []).find((candidate) => candidate.name === item.name);
      return { kind: 'component', tag: tagOfComponent(component) };
    }
    case 'doctype':
      return { kind: 'doctype' };
    case 'comment':
      return { kind: 'comment' };
    case 'text':
      return { kind: 'text', blank: false };
    case 'style':
    case 'script':
      return { kind: 'element', tag: item.type };
    case 'map':
    case 'cond':
    case 'expr':
      return { kind: 'code' };
    default:
      return undefined;
  }
}

interface Located {
  readonly node: TreeView;
  /** The chain of owners from the root list to the node, nearest last; the node is not in it. */
  readonly owners: readonly TreeView[];
}

/** Finds a node and its owners; undefined for an id not in the tree. Iterative, bounded by the tree's limits. */
function locate(nodes: readonly TreeView[], id: string): Located | undefined {
  const stack: { readonly node: TreeView; readonly owners: readonly TreeView[] }[] = nodes.map((node) => ({ node, owners: [] }));
  for (let visited = 0; visited < stack.length; visited++) {
    assert(visited <= LIMITS.treeNodesMax, 'The tree stays inside the node bound');
    const entry = stack[visited];
    assert(entry !== undefined, 'The visit index lies inside the stack');
    if (entry.node.id === id) {
      return entry;
    }
    assert(entry.owners.length <= LIMITS.treeDepthMax, 'The tree stays inside the depth bound');
    for (const child of entry.node.children ?? []) {
      stack.push({ node: child, owners: [...entry.owners, entry.node] });
    }
  }
  return undefined;
}

function frameOf(owner: TreeView, environment: PlacementEnvironment): PlacementFrame {
  switch (owner.kind) {
    case 'element':
    case 'component': {
      const named = placementNodeOfName(owner.name ?? '', owner.kind, renderedTagOf(owner, environment));
      if (named.kind === 'element') {
        return { kind: 'element', tag: named.tag };
      }
      if (named.kind === 'component') {
        return { kind: 'component', tag: named.tag };
      }
      return { kind: 'fragment' };
    }
    default:
      return { kind: 'transparent' };
  }
}

function subtreeHas(node: TreeView, id: string): boolean {
  return locate([node], id) !== undefined;
}

/** The verdict for putting `subject` at `target`: the model's, plus the editor's own refusals (the frontmatter, a node into itself). */
export function checkTarget(nodes: readonly TreeView[], subject: PlacementSubject, target: InsertTarget, environment: PlacementEnvironment): PlacementVerdict {
  return checkTargetReplacing(nodes, subject, target, environment, undefined);
}

/** The same, for a place the node `replaced` stands in and will leave (a wrap puts the wrapper where the wrapped node was). */
function checkTargetReplacing(
  nodes: readonly TreeView[],
  subject: PlacementSubject,
  target: InsertTarget,
  environment: PlacementEnvironment,
  replaced: string | undefined,
): PlacementVerdict {
  assert(Number.isSafeInteger(target.index), 'A drop index is an integer');
  assert(target.index >= 0, 'A drop index is not negative');
  if (target.parentId === 'frontmatter') {
    return frontmatterRefusal();
  }
  let list = nodes;
  let owners: readonly TreeView[] = [];
  if (target.parentId !== undefined) {
    const found = locate(nodes, target.parentId);
    if (found === undefined) {
      return frontmatterRefusal(); // A parent the tree does not hold is no place for a node.
    }
    list = found.node.children ?? [];
    owners = [...found.owners, found.node];
  }
  let moving: string | undefined = undefined;
  let node: PlacementNode;
  if (subject.kind === 'existing') {
    const located = locate(nodes, subject.id);
    if (located === undefined) {
      return selfDropRefusal(); // A node that is gone cannot be placed.
    }
    if (target.parentId !== undefined && subjectContains(located.node, target.parentId)) {
      return selfDropRefusal();
    }
    moving = subject.id;
    node = placementNodeOf(located.node, environment, 'deep');
  } else {
    node = subject.node;
  }
  const standing = (sibling: TreeView): boolean => sibling.id !== moving && sibling.id !== replaced;
  const before = list
    .slice(0, target.index)
    .filter(standing)
    .map((sibling) => placementNodeOf(sibling, environment, 'shallow'));
  const after = list
    .slice(target.index)
    .filter(standing)
    .map((sibling) => placementNodeOf(sibling, environment, 'shallow'));
  const cut = (siblings: readonly PlacementNode[]): readonly PlacementNode[] => siblings.slice(0, PLACEMENT_LIMITS.siblingsMax);
  return checkPlacement({
    node,
    frames: owners.map((owner) => frameOf(owner, environment)),
    before: cut(before),
    after: cut(after),
    document: environment.document,
  });
}

function subjectContains(node: TreeView, id: string): boolean {
  return node.id === id || subtreeHas(node, id);
}

/** Where a node asked to go, and where it can: the place itself, or the nearest valid one with the reason it moved. */
export type PlacementResolution =
  | { readonly kind: 'placed'; readonly target: InsertTarget; readonly warning: PlacementMessage | undefined }
  | { readonly kind: 'snapped'; readonly target: InsertTarget; readonly reason: PlacementMessage; readonly warning: PlacementMessage | undefined }
  | { readonly kind: 'refused'; readonly refusal: PlacementMessage };

export function resolveTarget(
  nodes: readonly TreeView[],
  subject: PlacementSubject,
  target: InsertTarget,
  environment: PlacementEnvironment,
): PlacementResolution {
  const verdict = checkTarget(nodes, subject, target, environment);
  if (verdict.ok) {
    return { kind: 'placed', target, warning: verdict.warning };
  }
  // Into itself or into the frontmatter has no neighbour worth offering: a drop that names no real place is refused, not moved.
  const snapped = verdict.reason === 'self-drop' || verdict.reason === 'frontmatter' ? undefined : snapTarget(nodes, subject, target, environment);
  if (snapped === undefined) {
    return { kind: 'refused', refusal: verdict };
  }
  return { kind: 'snapped', target: snapped.target, reason: verdict, warning: snapped.warning };
}

/** The nearest valid place: the top of the page for a document part, else out through each ancestor, after it and then before it. */
export function snapTarget(
  nodes: readonly TreeView[],
  subject: PlacementSubject,
  target: InsertTarget,
  environment: PlacementEnvironment,
): { readonly target: InsertTarget; readonly warning: PlacementMessage | undefined } | undefined {
  const attempt = (candidate: InsertTarget): { readonly target: InsertTarget; readonly warning: PlacementMessage | undefined } | undefined => {
    const verdict = checkTarget(nodes, subject, candidate, environment);
    // A neighbour the model could only warn about is not offered: moving a node somewhere unsure is no help.
    return verdict.ok && verdict.warning === undefined ? { target: candidate, warning: undefined } : undefined;
  };
  for (const candidate of documentTops(nodes, subject, environment)) {
    const found = attempt(candidate);
    if (found !== undefined) {
      return found;
    }
  }
  let ownerId = target.parentId;
  for (let depth = 0; depth < LIMITS.treeDepthMax && ownerId !== undefined && ownerId !== 'frontmatter'; depth++) {
    const located = locate(nodes, ownerId);
    if (located === undefined) {
      return undefined;
    }
    const parent = located.owners.at(-1);
    const siblings = parent === undefined ? nodes : (parent.children ?? []);
    const at = siblings.findIndex((sibling) => sibling.id === ownerId);
    assert(at >= 0, 'An owner is among its siblings');
    for (const index of [at + 1, at]) {
      const found = attempt({ parentId: parent?.id, index });
      if (found !== undefined) {
        return found;
      }
    }
    ownerId = parent?.id;
  }
  return attempt({ parentId: undefined, index: nodes.length });
}

// The doctype and `<html>` belong at the very top of the page, whatever was aimed at.
function documentTops(nodes: readonly TreeView[], subject: PlacementSubject, environment: PlacementEnvironment): readonly InsertTarget[] {
  let node: PlacementNode | undefined = undefined;
  if (subject.kind === 'new') {
    node = subject.node;
  } else {
    const located = locate(nodes, subject.id);
    node = located === undefined ? undefined : placementNodeOf(located.node, environment, 'shallow');
  }
  if (node?.kind === 'doctype') {
    return [{ parentId: undefined, index: 0 }];
  }
  if (node?.kind === 'element' && node.tag.toLowerCase() === 'html') {
    const leading = nodes.findIndex(
      (sibling) => placementNodeOf(sibling, environment, 'shallow').kind !== 'comment' && placementNodeOf(sibling, environment, 'shallow').kind !== 'doctype',
    );
    return [{ parentId: undefined, index: leading < 0 ? nodes.length : leading }];
  }
  return [];
}

/** The verdict for wrapping the node `nodeId` in a new `<wrapper>`: the wrapper where the node stands, and the node inside the wrapper. */
export function checkWrap(nodes: readonly TreeView[], nodeId: string, wrapper: string, environment: PlacementEnvironment): PlacementVerdict {
  const located = locate(nodes, nodeId);
  if (located === undefined) {
    return selfDropRefusal();
  }
  const parent = located.owners.at(-1);
  const siblings = parent === undefined ? nodes : (parent.children ?? []);
  const index = siblings.findIndex((sibling) => sibling.id === nodeId);
  assert(index >= 0, 'A wrapped node is among its siblings');
  const wrapperNode: PlacementNode = {
    kind: 'element',
    tag: wrapper,
    descendants: [...descendantTags(located.node), ...(located.node.kind === 'element' ? [located.node.name ?? ''] : [])],
  };
  const outside = checkTargetReplacing(nodes, { kind: 'new', node: wrapperNode }, { parentId: parent?.id, index }, environment, nodeId);
  if (!outside.ok) {
    return outside;
  }
  const frames: PlacementFrame[] = [...located.owners.map((owner) => frameOf(owner, environment)), { kind: 'element', tag: wrapper }];
  return checkPlacement({ node: placementNodeOf(located.node, environment, 'deep'), frames, before: [], after: [], document: environment.document });
}
