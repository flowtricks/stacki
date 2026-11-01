// Inserting, duplicating and removing nodes: each gesture as the edit request
// main plans and the shown model it predicts, and the tree operations those
// predictions are built from — replacing, inserting and removing a node
// (editGestures.ts).

import { assert } from '../../shared/core/assert';
import type { EditorModel, EditorNode } from './pageView';
import type { Edit } from '../../shared/engine/editRequest';
import { LIMITS } from '../../shared/core/limits';
import type { EditGesture } from './pageEdits';

export type Urgency = boolean | 'live';

/** A copy of the model with one node replaced; every list on the path to it
 * is new, every other node shared. Unchanged when no node has the id. */
export function withNode(model: EditorModel, nodeId: string, update: (node: EditorNode) => EditorNode): EditorModel {
  const nodes = replacedIn(model.nodes, nodeId, 0, update);
  return nodes === model.nodes ? model : { ...model, nodes };
}

// Recursion bounded by the tree's depth bound, asserted.
export function replacedIn(list: readonly EditorNode[], nodeId: string, depth: number, update: (node: EditorNode) => EditorNode): readonly EditorNode[] {
  assert(depth <= LIMITS.treeDepthMax, 'A model is no deeper than its bound');
  for (const [index, node] of list.entries()) {
    if (node.id === nodeId) {
      return list.map((candidate, at) => (at === index ? update(candidate) : candidate));
    }
    const children = node.children;
    if (Array.isArray(children)) {
      const replaced = replacedIn(children, nodeId, depth + 1, update);
      if (replaced !== children) {
        const parent = withChildren(node, replaced);
        return list.map((candidate, at) => (at === index ? parent : candidate));
      }
    }
  }
  return list;
}

// --- Insert and remove (the §11.6 insert/remove step) --------------------------------

/** Where a new node lands: a list inside a parent (undefined: the page's root
 * list) and a position in it, as the insert palette and paste state it. */
export interface InsertPlace {
  readonly parentId: string | undefined;
  readonly index: number;
}

export type Placement = 'before' | 'after' | 'first-child' | 'last-child';

/** Insert one new node. The request places it beside the node now at that
 * position (before it, or after the last one), or inside an empty parent;
 * main prints it at its indentation. On a page whose body is empty there is
 * nothing to stand beside: it is the body's first node (`append-body`). */
export function insertGesture(model: EditorModel, node: EditorNode, place: InsertPlace | undefined, options: { readonly urgency: Urgency }): EditGesture {
  const beside = besidePlace(model, place);
  return {
    coalesceKey: undefined,
    urgency: options.urgency,
    stream: undefined,
    request: (refOf) => {
      if (beside === undefined && model.nodes.every(blank)) {
        return [{ tag: 'append-body', nodes: [node] }];
      }
      const target = beside === undefined ? undefined : refOf(beside.anchorId);
      if (beside === undefined || target === undefined) {
        return undefined;
      }
      const edit: Edit = {
        tag: 'insert-node',
        target,
        placement: beside.placement,
        content: { tag: 'nodes', nodes: [node] },
      };
      return [edit];
    },
    apply: (current) => withInserted(current, node, place),
  };
}

/** A copy of a node right after it: the request copies the node's own bytes
 * (plan §3.4: never a reprint), the effect its clone with new ids. */
export function duplicateGesture(nodeId: string, clone: EditorNode, options: { readonly urgency: Urgency }): EditGesture {
  return {
    coalesceKey: undefined,
    urgency: options.urgency,
    stream: undefined,
    request: (refOf) => {
      const target = refOf(nodeId);
      if (target === undefined) {
        return undefined;
      }
      const content = { tag: 'copy' as const, source: target };
      return [{ tag: 'insert-node', target, placement: 'after', content }];
    },
    apply: (current) => withInsertedAfter(current, nodeId, clone),
  };
}

/** Remove nodes, in the order given (a note before the node it annotates).
 * What the removal leaves unused in the frontmatter is its own gesture,
 * sequenced after this one (App.tsx, removeNode). */
export function removalGesture(nodeIds: readonly string[], options: { readonly urgency: Urgency }): EditGesture {
  return {
    coalesceKey: undefined,
    urgency: options.urgency,
    stream: undefined,
    request: (refOf) => {
      const edits: Edit[] = [];
      for (const id of nodeIds) {
        const target = refOf(id);
        if (target === undefined) {
          return undefined;
        }
        edits.push({ tag: 'remove-node', target });
      }
      return edits;
    },
    apply: (model) => withoutNodes(model, nodeIds),
  };
}

/** The model without the given nodes (and their subtrees). */
export function withoutNodes(model: EditorModel, nodeIds: readonly string[]): EditorModel {
  const gone = new Set(nodeIds);
  const nodes = filteredList(model.nodes, gone, 0);
  return nodes === model.nodes ? model : { ...model, nodes };
}

export function filteredList(list: readonly EditorNode[], gone: ReadonlySet<string>, depth: number): readonly EditorNode[] {
  assert(depth <= LIMITS.treeDepthMax, 'A model is no deeper than its bound');
  let changed = false;
  const next: EditorNode[] = [];
  for (const node of list) {
    if (gone.has(node.id)) {
      changed = true;
      continue;
    }
    const children = node.children;
    if (Array.isArray(children)) {
      const kept = filteredList(children, gone, depth + 1);
      if (kept !== children) {
        changed = true;
        next.push(withChildren(node, kept));
        continue;
      }
    }
    next.push(node);
  }
  return changed ? next : list;
}

/** The model with `node` inserted where `place` says — the legacy
 * insertIntoModel's rule, without editing a model in place: no place, or a
 * parent that is gone, means the end of the page. */
export function withInserted(model: EditorModel, node: EditorNode, place: InsertPlace | undefined): EditorModel {
  const parentId = place?.parentId;
  if (parentId === undefined || !containsNode(model.nodes, parentId)) {
    const index = place === undefined || parentId !== undefined ? model.nodes.length : place.index;
    return { ...model, nodes: spliced(model.nodes, Math.min(index, model.nodes.length), node) };
  }
  const index = place?.index ?? 0;
  return withNode(model, parentId, (parent) => {
    const children = parent.children ?? [];
    return withChildren(parent, spliced(children, Math.min(index, children.length), node));
  });
}

export function withInsertedAfter(model: EditorModel, anchorId: string, node: EditorNode): EditorModel {
  const nodes = afterIn(model.nodes, anchorId, node, 0);
  return nodes === model.nodes ? model : { ...model, nodes };
}

export function afterIn(list: readonly EditorNode[], anchorId: string, node: EditorNode, depth: number): readonly EditorNode[] {
  assert(depth <= LIMITS.treeDepthMax, 'A model is no deeper than its bound');
  for (const [index, candidate] of list.entries()) {
    if (candidate.id === anchorId) {
      return spliced(list, index + 1, node);
    }
    const children = candidate.children;
    if (Array.isArray(children)) {
      const replaced = afterIn(children, anchorId, node, depth + 1);
      if (replaced !== children) {
        const parent = withChildren(candidate, replaced);
        return list.map((item, at) => (at === index ? parent : item));
      }
    }
  }
  return list;
}

/** A node with other children. Object.assign keeps the node's own variant; a
 * spread widens it. An element emptied of children loses the inner source the
 * parser stored for it: the legacy printer writes that source back for an
 * element without children (to keep `<div>\n</div>` as written), so a stale
 * one would put the removed child back (found by the parity sweep: a moved
 * node was written twice, a deleted one stayed). */
export function withChildren(node: EditorNode, children: readonly EditorNode[]): EditorNode {
  const copy = Object.assign({}, node, { children });
  if (children.length === 0) {
    Reflect.deleteProperty(copy, 'source');
  }
  return copy;
}

export function spliced(list: readonly EditorNode[], index: number, node: EditorNode): readonly EditorNode[] {
  return [...list.slice(0, index), node, ...list.slice(index)];
}

export function containsNode(list: readonly EditorNode[], nodeId: string): boolean {
  const pending = [...list];
  for (let visited = 0; visited < pending.length; visited++) {
    assert(visited < LIMITS.treeNodesMax, 'A model stays inside its node bound');
    const node = pending[visited];
    assert(node !== undefined, 'The visit index lies inside the list');
    if (node.id === nodeId) {
      return true;
    }
    if (node.children !== undefined) {
      pending.push(...node.children);
    }
  }
  return false;
}

// The node a new one stands beside: the one at the position (before it), or
// the last one (after it), or an empty parent (inside it). Blank text between
// root nodes is a separator, never a neighbour to stand beside.
export function besidePlace(
  model: EditorModel,
  place: InsertPlace | undefined,
  moving: ReadonlySet<string> = new Set(),
): { readonly anchorId: string; readonly placement: Placement } | undefined {
  const parentId = place?.parentId;
  const parent = parentId === undefined ? undefined : findNode(model.nodes, parentId);
  const list = parent === undefined ? model.nodes : (parent.children ?? []);
  const index = parent === undefined && parentId !== undefined ? list.length : Math.min(place?.index ?? list.length, list.length);
  // A loop body and a conditional branch are code-owned lists. Their child
  // nodes cannot safely serve as sibling anchors, because they are repeated
  // source nodes or sit inside a JavaScript expression. Address the list's
  // structural owner at either edge instead.
  const structuralEdge = index === 0 || index === list.length;
  if (structuralEdge && (parent?.kind === 'map' || parent?.kind === 'branch')) {
    return {
      anchorId: parent.id,
      placement: index === 0 ? 'first-child' : 'last-child',
    };
  }
  // Neither a separator nor what is moving is a neighbour to stand beside.
  const standing = (node: EditorNode) => !blank(node) && !moving.has(node.id);
  const at = list.slice(index).find(standing);
  if (at !== undefined) {
    return { anchorId: at.id, placement: 'before' };
  }
  const last = list.slice(0, index).filter(standing).pop();
  if (last !== undefined) {
    return { anchorId: last.id, placement: 'after' };
  }
  return parent === undefined ? undefined : { anchorId: parent.id, placement: 'first-child' };
}

export function blank(node: EditorNode): boolean {
  return node.kind === 'text' && /^\s*$/.test(node.value ?? '');
}

export function findNode(list: readonly EditorNode[], nodeId: string): EditorNode | undefined {
  const pending = [...list];
  for (let visited = 0; visited < pending.length; visited++) {
    assert(visited < LIMITS.treeNodesMax, 'A model stays inside its node bound');
    const node = pending[visited];
    assert(node !== undefined, 'The visit index lies inside the list');
    if (node.id === nodeId) {
      return node;
    }
    if (node.children !== undefined) {
      pending.push(...node.children);
    }
  }
  return undefined;
}
