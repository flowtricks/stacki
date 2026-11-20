// The Pages panel's Select mode, as pure functions: which rows can be ticked, what a click, a Shift-click range, Select
// all and a folder's checkbox do to the selection, and what the deletion is asked to remove. The selection is a Set
// of keys, so a tick is O(1) and no row does work of its own: a page is keyed by its name (`blog/post.astro`), a folder
// by its path and a slash (`blog/`), the same keys the panel orders its rows by.
//
// One rule holds the folders to the pages: a folder is selected exactly when everything in it is. Ticking a folder
// ticks its whole subtree, unticking one page inside takes its folders' ticks away, and ticking the last page of a
// folder ticks the folder. A folder with nothing in it is ticked on its own. `normalize` restores the rule after every
// change, in one pass over the folders, deepest first.
import { assert } from '../../../shared/core/assert';
import { BOUNDARY_LIMITS } from '../../../shared/core/boundary';
import type { PageOrder } from '../../../shared/properties/pageOrder';
import { isHomePage } from '../../../shared/properties/pageSettings';
import type { PageBulkRemoveRequest } from '../../../shared/properties/pageBulkRemove';
import { orderedPageTree } from './pageTreeOrder';
import type { PageTreeNode } from './pageTree';

/** Why a page cannot be ticked: the homepage is the only page Page settings refuses to delete. */
export type SelectionRefusal = 'homepage';

export interface SelectionRow {
  readonly key: string;
  readonly kind: 'page' | 'folder';
}

export interface SelectionIndex {
  /** A folder's direct children, folders as `rel/` and pages by name. */
  readonly children: ReadonlyMap<string, readonly string[]>;
  /** Every folder, deepest first, so a folder is settled after the folders inside it. */
  readonly folders: readonly string[];
  readonly pages: ReadonlySet<string>;
  /** Pages that cannot be ticked, with why. */
  readonly refused: ReadonlyMap<string, SelectionRefusal>;
}

export type Selection = ReadonlySet<string>;

export const NO_SELECTION: Selection = new Set();

/** The index of a page tree: built once per scan, so ticking never walks the tree. */
export function buildSelectionIndex(root: PageTreeNode): SelectionIndex {
  const children = new Map<string, string[]>();
  const pages = new Set<string>();
  const refused = new Map<string, SelectionRefusal>();
  const folders: Array<{ readonly key: string; readonly depth: number }> = [];
  const pending: Array<{ readonly node: PageTreeNode; readonly rel: string; readonly depth: number }> = [{ node: root, rel: '', depth: 0 }];
  for (let index = 0; index < pending.length; index++) {
    assert(pending.length <= BOUNDARY_LIMITS.itemsMax, 'Page selection: directory count exceeds limit');
    const current = pending[index];
    assert(current !== undefined, 'Page selection: pending directory exists');
    const keys: string[] = [];
    for (const page of current.node.pages) {
      keys.push(page.name);
      pages.add(page.name);
      if (isHomePage(page.name)) {
        refused.set(page.name, 'homepage');
      }
    }
    for (const [name, child] of current.node.directories) {
      const rel = current.rel ? `${current.rel}/${name}` : name;
      keys.push(rel + '/');
      folders.push({ key: rel + '/', depth: current.depth + 1 });
      pending.push({ node: child, rel, depth: current.depth + 1 });
    }
    if (current.rel) {
      children.set(current.rel + '/', keys);
    }
  }
  // Array sort is stable, so folders of one depth keep their discovery order.
  const deepestFirst = folders.sort((left, right) => right.depth - left.depth).map((folder) => folder.key);
  assert(deepestFirst.length === children.size, 'Page selection: every folder has a child list');
  return { children, folders: deepestFirst, pages, refused };
}

/** The rows a person sees, top to bottom: the tree as drawn (collapsed folders hide their pages). */
export function visibleTreeRows(root: PageTreeNode, order: PageOrder, collapsed: ReadonlySet<string>): readonly SelectionRow[] {
  type Work = { readonly kind: 'row'; readonly row: SelectionRow } | { readonly kind: 'directory'; readonly node: PageTreeNode; readonly rel: string };
  const rows: SelectionRow[] = [];
  // Last in, first out: each directory's entries go on in reverse, with a folder's contents beneath its own row, so
  // the rows come off in the order drawn, depth first, without recursion.
  const pending: Work[] = [{ kind: 'directory', node: root, rel: '' }];
  for (let steps = 0; pending.length > 0; steps++) {
    assert(steps <= BOUNDARY_LIMITS.itemsMax, 'Page selection: row count exceeds limit');
    const work = pending.pop();
    assert(work !== undefined, 'Page selection: pending work exists');
    if (work.kind === 'row') {
      rows.push(work.row);
    } else {
      for (const entry of [...orderedPageTree(work.node, work.rel, order)].reverse()) {
        if (entry.kind === 'folder') {
          const rel = entry.key.slice(0, -1);
          if (!collapsed.has(rel)) {
            pending.push({ kind: 'directory', node: entry.node, rel });
          }
        }
        pending.push({ kind: 'row', row: { key: entry.key, kind: entry.kind } });
      }
    }
  }
  return rows;
}

export function pageSelectionRows(pages: readonly { readonly name: string }[]): readonly SelectionRow[] {
  return pages.map((page) => ({ key: page.name, kind: 'page' }));
}

/** Ticks or unticks one row: a page, or a folder with everything in it. A row that cannot be ticked changes nothing. */
export function toggleRow(index: SelectionIndex, selected: Selection, key: string): Selection {
  assert(index.pages.has(key) || index.children.has(key), 'Page selection: the toggled row exists');
  if (index.refused.has(key)) {
    return selected;
  }
  const next = new Set(selected);
  const keys = key.endsWith('/') ? [key, ...descendants(index, key)] : [key];
  if (selected.has(key)) {
    for (const item of keys) {
      next.delete(item);
    }
  } else {
    for (const item of keys) {
      addIfTickable(index, next, item);
    }
  }
  return normalize(index, next);
}

/** Ticks every row from `anchor` to `target` in the order shown (either way round), folders with their contents. */
export function selectRange(index: SelectionIndex, selected: Selection, rows: readonly SelectionRow[], anchor: string, target: string): Selection {
  const from = rows.findIndex((row) => row.key === anchor);
  const to = rows.findIndex((row) => row.key === target);
  if (from < 0 || to < 0) {
    return toggleRow(index, selected, target);
  }
  const next = new Set(selected);
  for (const row of rows.slice(Math.min(from, to), Math.max(from, to) + 1)) {
    addRow(index, next, row.key);
  }
  return normalize(index, next);
}

/** Ticks every row shown (Cmd or Ctrl and A), so a search that shows three pages selects those three. */
export function selectAllRows(index: SelectionIndex, selected: Selection, rows: readonly SelectionRow[]): Selection {
  assert(rows.length <= BOUNDARY_LIMITS.itemsMax, 'Page selection: row count exceeds limit');
  const next = new Set(selected);
  for (const row of rows) {
    addRow(index, next, row.key);
  }
  return normalize(index, next);
}

/** Drops keys the project no longer has (a page deleted or renamed elsewhere) and settles the folders. */
export function pruneSelection(index: SelectionIndex, selected: Selection): Selection {
  const next = new Set<string>();
  for (const key of selected) {
    if (index.pages.has(key) || index.children.has(key)) {
      addIfTickable(index, next, key);
    }
  }
  return normalize(index, next);
}

/** Folders ticked in part: some of what is inside, not all. The panel draws these as indeterminate. */
export function partialFolders(index: SelectionIndex, selected: Selection): ReadonlySet<string> {
  const partial = new Set<string>();
  for (const folder of index.folders) {
    if (!selected.has(folder)) {
      const inside = index.children.get(folder) ?? [];
      if (inside.some((child) => selected.has(child) || partial.has(child))) {
        partial.add(folder);
      }
    }
  }
  return partial;
}

/** What to delete: the pages and folders ticked at the top, never those inside a ticked folder (main takes those along). */
export function selectionTargets(selected: Selection): PageBulkRemoveRequest {
  const pages: string[] = [];
  const folders: string[] = [];
  for (const key of selected) {
    if (!insideSelectedFolder(selected, key)) {
      if (key.endsWith('/')) {
        folders.push(key.slice(0, -1));
      } else {
        pages.push(key);
      }
    }
  }
  return { pages: pages.sort(), folders: folders.sort() };
}

/** The number the action bar shows: the things ticked at the top, so a folder is one however many pages it holds. */
export function selectionCount(selected: Selection): number {
  const targets = selectionTargets(selected);
  return targets.pages.length + targets.folders.length;
}

function insideSelectedFolder(selected: Selection, key: string): boolean {
  const parts = key.endsWith('/') ? key.slice(0, -1).split('/') : key.split('/');
  for (let depth = parts.length - 1; depth > 0; depth--) {
    if (selected.has(parts.slice(0, depth).join('/') + '/')) {
      return true;
    }
  }
  return false;
}

function addRow(index: SelectionIndex, into: Set<string>, key: string): void {
  addIfTickable(index, into, key);
  if (key.endsWith('/')) {
    for (const item of descendants(index, key)) {
      addIfTickable(index, into, item);
    }
  }
}

function addIfTickable(index: SelectionIndex, into: Set<string>, key: string): void {
  if (!index.refused.has(key) && (index.pages.has(key) || index.children.has(key))) {
    into.add(key);
  }
}

// Everything below a folder, found with a queue the size of the subtree.
function descendants(index: SelectionIndex, folder: string): readonly string[] {
  const found: string[] = [];
  const pending = [folder];
  for (let position = 0; position < pending.length; position++) {
    assert(found.length <= BOUNDARY_LIMITS.itemsMax, 'Page selection: subtree exceeds limit');
    const current = pending[position];
    assert(current !== undefined, 'Page selection: pending folder exists');
    for (const child of index.children.get(current) ?? []) {
      found.push(child);
      if (child.endsWith('/')) {
        pending.push(child);
      }
    }
  }
  return found;
}

// A folder with something in it is ticked exactly when all of it is; one with nothing in it keeps its own tick.
function normalize(index: SelectionIndex, selected: Set<string>): Selection {
  for (const folder of index.folders) {
    const inside = index.children.get(folder) ?? [];
    if (inside.length > 0) {
      const whole = inside.every((child) => selected.has(child));
      if (whole) {
        selected.add(folder);
      } else {
        selected.delete(folder);
      }
    }
  }
  assert(selected.size <= index.pages.size + index.folders.length, 'Page selection: only rows of the project are ticked');
  return selected;
}
