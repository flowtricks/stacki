import type { PageModel, PageNode } from '../../../shared/page/pageNode';
import type { Diagnostic } from '../../../shared/page/sourceProjection';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { treeBudget } from '../../editor/treeView';
import { rowChildren, rowHost } from '../../editor/branches';
import { hidesChildRows } from '../../editor/treeSelection';

export type NavigatorNode = PageNode;
export type NavigatorModel = Pick<PageModel, 'nodes' | 'imports'>;

export type StructurePageState =
  | {
      readonly editable: true;
      readonly model: NavigatorModel;
      readonly source: string;
    }
  | {
      readonly editable: false;
      readonly source: string;
      readonly reason?: string;
      readonly bail?: { readonly what: string; readonly near: string } | undefined;
    };

/** The page as the navigator draws it (plan §3.6): a tree to edit visually, or
 * a parse error, which is a state of the page like any other — the navigator
 * switches over it exhaustively and offers the code editor. */
export type StructureProjection =
  | { readonly tag: 'valid'; readonly state: Extract<StructurePageState, { editable: true }> }
  | {
      readonly tag: 'parse-error';
      readonly state: Extract<StructurePageState, { editable: false }>;
      readonly diagnostics: readonly Diagnostic[];
    };

export function structureProjection(state: StructurePageState): StructureProjection {
  if (state.editable) {
    return { tag: 'valid', state };
  }
  const message = state.reason ?? 'This page cannot be parsed.';
  const near = state.bail?.near;
  return { tag: 'parse-error', state, diagnostics: [{ message, near: near || undefined }] };
}

export type DropLocation = {
  /** The parent the drop lands inside; undefined for the page's root list. */
  readonly parentId: string | undefined;
  readonly index: number;
};

export type DropTarget =
  { readonly kind: 'gap'; readonly parentId: string | undefined; readonly index: number } | { readonly kind: 'into'; readonly intoId: string };

export interface FoundNavigatorNode {
  readonly node: NavigatorNode;
  readonly parent: NavigatorNode | undefined;
  readonly siblings: readonly NavigatorNode[];
  readonly index: number;
}

export function navigatorChildren(node: NavigatorNode): readonly NavigatorNode[] {
  return rowChildren(node);
}

export function navigatorHost(node: NavigatorNode): NavigatorNode {
  return rowHost(node) ?? node;
}

export function defaultCollapsed(node: NavigatorNode): boolean {
  return navigatorChildren(node).length > 0;
}

export function initialCollapseMap(nodes: readonly NavigatorNode[]): ReadonlyMap<string, boolean> {
  assert(nodes.length <= LIMITS.treeNodesMax, 'Navigator: root node limit exceeded');
  // Open the page's first wrapper, regardless of its name, without expanding every section.
  const first = nodes.find((node) => {
    const children = navigatorChildren(node);
    if (children.length > 0) {
      return !hidesChildRows(node, children);
    }
    return false;
  });
  const toggled = new Map<string, boolean>(first === undefined ? [] : [[first.id, false]]);
  assert(toggled.size <= 1, 'Navigator: at most one root opens by default');
  return toggled;
}

export function findNavigatorNode(nodes: readonly NavigatorNode[], id: string): NavigatorNode | undefined {
  return findNodeWalk(nodes, id, 0, treeBudget());
}

export function findVisibleNode(nodes: readonly NavigatorNode[], id: string): FoundNavigatorNode | undefined {
  return findVisibleWalk(nodes, id, undefined, 0, treeBudget());
}

export function navigatorAncestors(nodes: readonly NavigatorNode[], id: string): readonly NavigatorNode[] {
  return findAncestorWalk(nodes, id, [], 0, treeBudget()) ?? [];
}

export interface CollapseOptions {
  readonly collapsed: boolean;
}

export function collapseMap(nodes: readonly NavigatorNode[], options: CollapseOptions): ReadonlyMap<string, boolean> {
  const result = new Map<string, boolean>();
  collapseMapWalk(nodes, options, result, 0, treeBudget());
  return result;
}

function findNodeWalk(nodes: readonly NavigatorNode[], id: string, depth: number, visit: (depth: number) => void): NavigatorNode | undefined {
  assert(depth <= LIMITS.treeDepthMax, 'Navigator: tree depth limit exceeded');
  for (const node of nodes) {
    visit(depth);
    if (node.id === id) {
      return node;
    }
    const children = 'children' in node ? (node.children ?? []) : [];
    const found = findNodeWalk(children, id, depth + 1, visit);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function findVisibleWalk(
  nodes: readonly NavigatorNode[],
  id: string,
  parent: NavigatorNode | undefined,
  depth: number,
  visit: (depth: number) => void,
): FoundNavigatorNode | undefined {
  assert(depth <= LIMITS.treeDepthMax, 'Navigator: tree depth limit exceeded');
  for (const [index, node] of nodes.entries()) {
    visit(depth);
    if (node.id === id) {
      return { node, parent, siblings: nodes, index };
    }
    const found = findVisibleWalk(navigatorChildren(node), id, node, depth + 1, visit);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function findAncestorWalk(
  nodes: readonly NavigatorNode[],
  id: string,
  trail: readonly NavigatorNode[],
  depth: number,
  visit: (depth: number) => void,
): readonly NavigatorNode[] | undefined {
  assert(depth <= LIMITS.treeDepthMax, 'Navigator: tree depth limit exceeded');
  for (const node of nodes) {
    visit(depth);
    if (node.id === id) {
      return trail;
    }
    const found = findAncestorWalk(navigatorChildren(node), id, [...trail, node], depth + 1, visit);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function collapseMapWalk(
  nodes: readonly NavigatorNode[],
  options: CollapseOptions,
  result: Map<string, boolean>,
  depth: number,
  visit: (depth: number) => void,
): void {
  assert(depth <= LIMITS.treeDepthMax, 'Navigator: tree depth limit exceeded');
  for (const node of nodes) {
    visit(depth);
    const children = navigatorChildren(node);
    if (children.length > 0) {
      result.set(node.id, options.collapsed);
      collapseMapWalk(children, options, result, depth + 1, visit);
    }
  }
}
