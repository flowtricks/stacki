// The project's components as the Roles tab's tree: folders and components, each with the state a role's
// hidden-component rules give it (shared/properties/componentAccess.ts). It is pure and linear: one pass
// groups the files into folders and counts what a role may add, and `flattenRows` lists only the rows that
// show, so the tab can draw a window of them and stay responsive with thousands of components.
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import {
  COMPONENT_ACCESS_LIMITS,
  componentAccessIndex,
  inheritedState,
  resolveComponent,
  type ComponentAccessIndex,
  type ComponentDecision,
  type ComponentRule,
  type ComponentState,
} from '../../../shared/properties/componentAccess';

/** A folder's switch: everything in it visible, some hidden, or all hidden. */
export type FolderState = 'visible' | 'mixed' | 'hidden';

export type ComponentTreeRow =
  | {
      readonly kind: 'folder';
      readonly path: string;
      readonly name: string;
      readonly depth: number;
      readonly disclosure: 'open' | 'closed';
      /** Components under it, and how many of them the role may add. */
      readonly total: number;
      readonly visible: number;
      readonly state: FolderState;
      /** What the folders above say about it: a note such as "hidden by folder X" when one does. */
      readonly inherited: ComponentDecision;
    }
  | {
      readonly kind: 'component';
      readonly path: string;
      readonly name: string;
      readonly depth: number;
      readonly state: ComponentState;
      readonly decision: ComponentDecision;
    };

interface FolderNode {
  readonly path: string;
  readonly name: string;
  readonly depth: number;
  readonly folders: Map<string, FolderNode>;
  readonly files: { readonly path: string; readonly state: ComponentState; readonly decision: ComponentDecision }[];
  total: number;
  visible: number;
}

export interface ComponentTree {
  readonly roots: readonly FolderNode[];
  readonly total: number;
  readonly visible: number;
  readonly index: ComponentAccessIndex;
  /** Every folder path, so a caller can open them all. */
  readonly folderPaths: readonly string[];
}

/** Groups `files` into folders and resolves each against `rules`. */
export function buildComponentTree(files: readonly string[], rules: readonly ComponentRule[]): ComponentTree {
  assert(files.length <= LIMITS.scanEntriesMax, 'The component tree is bounded by the scan');
  const index = componentAccessIndex(rules);
  const roots = new Map<string, FolderNode>();
  const folderPaths: string[] = [];
  let visible = 0;
  for (const file of [...files].sort()) {
    const segments = file.split('/');
    assert(segments.length <= COMPONENT_ACCESS_LIMITS.pathDepthMax + 1, 'A component sits within the depth bound');
    const resolution = resolveComponent(index, file);
    visible += resolution.state === 'visible' ? 1 : 0;
    let level = roots;
    let parent: FolderNode | undefined;
    for (let depth = 0; depth < segments.length - 1; depth += 1) {
      const path = segments.slice(0, depth + 1).join('/');
      let node = level.get(path);
      if (node === undefined) {
        node = { path, name: segments[depth] ?? path, depth, folders: new Map(), files: [], total: 0, visible: 0 };
        level.set(path, node);
        folderPaths.push(path);
      }
      node.total += 1;
      node.visible += resolution.state === 'visible' ? 1 : 0;
      parent = node;
      level = node.folders;
    }
    if (parent !== undefined) {
      parent.files.push({ path: file, state: resolution.state, decision: resolution.decision });
    }
  }
  assert(visible <= files.length, 'The visible count is among the components');
  return { roots: [...roots.values()], total: files.length, visible, index, folderPaths };
}

/** The folders open when the tab first shows: the top two levels, where a project's component folders sit. */
export function initialOpenFolders(tree: ComponentTree): ReadonlySet<string> {
  return new Set(tree.folderPaths.filter((path) => path.split('/').length <= 2));
}

/**
 * The rows to draw, top to bottom. A search keeps the components whose path holds the words and the folders
 * above them, all open; without one only the open folders' children show.
 */
export function flattenRows(tree: ComponentTree, open: ReadonlySet<string>, query: string): readonly ComponentTreeRow[] {
  const words = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '');
  const rows: ComponentTreeRow[] = [];
  const walk = (nodes: readonly FolderNode[]): void => {
    for (const node of nodes) {
      appendFolder(tree, node, open, words, rows);
    }
  };
  walk(tree.roots);
  assert(rows.length <= tree.folderPaths.length + tree.total, 'Rows are folders and components');
  return rows;
}

// Iteration over an explicit stack: the depth is bounded by the parser, and no recursion is needed.
function appendFolder(tree: ComponentTree, root: FolderNode, open: ReadonlySet<string>, words: readonly string[], rows: ComponentTreeRow[]): void {
  const stack: FolderNode[] = [root];
  for (let guard = 0; stack.length > 0; guard += 1) {
    assert(guard <= tree.folderPaths.length, 'Each folder is visited once');
    const node = stack.pop();
    assert(node !== undefined, 'The stack holds a folder');
    const matching = node.files.filter((file) => matches(file.path, words));
    const searching = words.length > 0;
    const below = searching ? subtreeMatches(node, words) : true;
    if (!below) {
      continue;
    }
    const expanded = searching || open.has(node.path);
    rows.push({
      kind: 'folder',
      path: node.path,
      name: node.name,
      depth: node.depth,
      disclosure: expanded ? 'open' : 'closed',
      total: node.total,
      visible: node.visible,
      state: node.visible === node.total ? 'visible' : node.visible === 0 ? 'hidden' : 'mixed',
      inherited: inheritedState(tree.index, node.path).decision,
    });
    if (!expanded) {
      continue;
    }
    // Folders come after this folder's own components in the list, so they are pushed to pop in order.
    const children = [...node.folders.values()].reverse();
    const own = matching.map((file): ComponentTreeRow => ({
      kind: 'component',
      path: file.path,
      name: leaf(file.path),
      depth: node.depth + 1,
      state: file.state,
      decision: file.decision,
    }));
    // Components first, then subfolders: emit the components now and defer the subfolders to the stack.
    rows.push(...own);
    stack.push(...children);
  }
}

function subtreeMatches(node: FolderNode, words: readonly string[]): boolean {
  const pending: FolderNode[] = [node];
  for (let guard = 0; pending.length > 0; guard += 1) {
    assert(guard <= LIMITS.scanEntriesMax, 'A search visits each folder once');
    const current = pending.pop();
    assert(current !== undefined, 'The pending list holds a folder');
    if (current.files.some((file) => matches(file.path, words))) {
      return true;
    }
    pending.push(...current.folders.values());
  }
  return false;
}

function matches(path: string, words: readonly string[]): boolean {
  const lower = path.toLowerCase();
  return words.every((word) => lower.includes(word));
}

function leaf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
