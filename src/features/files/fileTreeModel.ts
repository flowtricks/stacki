// The Files panel's tree as values: which rows are on screen for the folders read so far and the folders open, where
// the keyboard goes from a row, what a range selection covers, and where a drop lands. Every function takes values and
// returns values, so the panel's behaviour is tested without a browser (test/renderer/files/fileTreeModel.test.ts).
import { assert } from '../../../shared/core/assert';
import {
  EXPLORER_ROOT,
  childPath,
  isFileKind,
  isFolderKind,
  isProtectedPath,
  isWithinPath,
  parentPath,
  rebasePath,
  type ExplorerEntryKind,
  type ExplorerListing,
  type ExplorerPath,
} from '../../../shared/ipc/fileExplorer';

/** Rows the tree draws at most: past this the deepest open folders show their first entries only. */
export const VISIBLE_ROWS_MAX = 100_000;

export type TreeRow =
  | {
      readonly kind: 'entry';
      readonly path: ExplorerPath;
      readonly name: string;
      readonly entryKind: ExplorerEntryKind;
      readonly depth: number;
      /** For a folder: whether it is open; undefined for anything else. */
      readonly open: boolean | undefined;
      /** For an open folder whose listing has not arrived yet. */
      readonly loading: boolean;
      /** `.git` and `.stacki/io`: listed and readable, never changed from the panel. */
      readonly protected: boolean;
    }
  | { readonly kind: 'more'; readonly path: ExplorerPath; readonly hidden: number; readonly depth: number };

export interface TreeShape {
  readonly listings: ReadonlyMap<ExplorerPath, ExplorerListing>;
  readonly open: ReadonlySet<ExplorerPath>;
}

/** The rows on screen: the root's entries, and inside every open folder its entries, depth first. */
export function visibleRows(shape: TreeShape): readonly TreeRow[] {
  const rows: TreeRow[] = [];
  const root = shape.listings.get(EXPLORER_ROOT);
  if (root === undefined) {
    return rows;
  }
  // An explicit stack instead of recursion: a deep tree cannot exhaust the call stack.
  const stack: { readonly listing: ExplorerListing; readonly depth: number; index: number }[] = [{ listing: root, depth: 0, index: 0 }];
  while (stack.length > 0 && rows.length < VISIBLE_ROWS_MAX) {
    const frame = stack[stack.length - 1];
    assert(frame !== undefined, 'visibleRows: a frame is on the stack');
    const entry = frame.listing.entries[frame.index];
    if (entry === undefined) {
      stack.pop();
      const hidden = frame.listing.totalCount - frame.listing.entries.length;
      if (hidden > 0) {
        rows.push({ kind: 'more', path: frame.listing.path, hidden, depth: frame.depth });
      }
      continue;
    }
    frame.index += 1;
    const path = childPath(frame.listing.path, entry.name);
    const folder = isFolderKind(entry.kind);
    const open = folder ? shape.open.has(path) : undefined;
    const listing = open === true ? shape.listings.get(path) : undefined;
    rows.push({
      kind: 'entry',
      path,
      name: entry.name,
      entryKind: entry.kind,
      depth: frame.depth,
      open,
      loading: open === true && listing === undefined,
      protected: isProtectedPath(path),
    });
    if (listing !== undefined) {
      stack.push({ listing, depth: frame.depth + 1, index: 0 });
    }
  }
  assert(rows.length <= VISIBLE_ROWS_MAX + 1, 'visibleRows: the rows are bounded');
  return rows;
}

/** The row's path, for a row that has one to select. */
export function rowPath(row: TreeRow): ExplorerPath | undefined {
  return row.kind === 'entry' ? row.path : undefined;
}

/** The folders a listing is wanted for: every open folder whose parents are open too, the root first. */
export function wantedFolders(open: ReadonlySet<ExplorerPath>): readonly ExplorerPath[] {
  const wanted = [EXPLORER_ROOT];
  for (const folder of [...open].sort((left, right) => left.length - right.length)) {
    if (ancestorsOpen(folder, open)) {
      wanted.push(folder);
    }
  }
  return wanted;
}

function ancestorsOpen(folder: ExplorerPath, open: ReadonlySet<ExplorerPath>): boolean {
  let parent = parentPath(folder);
  while (parent !== undefined && parent !== EXPLORER_ROOT) {
    if (!open.has(parent)) {
      return false;
    }
    parent = parentPath(parent);
  }
  return true;
}

// ---------------------------------------------------------------------------
// The keyboard
// ---------------------------------------------------------------------------

export type TreeKey = 'ArrowDown' | 'ArrowUp' | 'ArrowRight' | 'ArrowLeft' | 'Home' | 'End' | 'PageDown' | 'PageUp';

export type KeyMove =
  | { readonly kind: 'focus'; readonly path: ExplorerPath }
  | { readonly kind: 'open'; readonly path: ExplorerPath }
  | { readonly kind: 'close'; readonly path: ExplorerPath }
  | { readonly kind: 'none' };

/** Where a key takes the focus, or which folder it opens or closes: the WAI-ARIA tree pattern. */
export function keyMove(rows: readonly TreeRow[], focused: ExplorerPath | undefined, key: TreeKey, pageRows: number): KeyMove {
  const paths = rows.map(rowPath).filter((each): each is ExplorerPath => each !== undefined);
  if (paths.length === 0) {
    return { kind: 'none' };
  }
  const first = paths[0];
  const last = paths[paths.length - 1];
  assert(first !== undefined, 'keyMove: a tree with rows has a first');
  assert(last !== undefined, 'keyMove: a tree with rows has a last');
  const index = focused === undefined ? -1 : paths.indexOf(focused);
  if (index < 0) {
    return { kind: 'focus', path: key === 'End' || key === 'ArrowUp' ? last : first };
  }
  const at = (position: number): ExplorerPath => paths[Math.max(0, Math.min(paths.length - 1, position))] ?? first;
  const row = rows.find((each) => each.kind === 'entry' && each.path === focused);
  switch (key) {
    case 'ArrowDown':
      return { kind: 'focus', path: at(index + 1) };
    case 'ArrowUp':
      return { kind: 'focus', path: at(index - 1) };
    case 'Home':
      return { kind: 'focus', path: first };
    case 'End':
      return { kind: 'focus', path: last };
    case 'PageDown':
      return { kind: 'focus', path: at(index + Math.max(1, pageRows)) };
    case 'PageUp':
      return { kind: 'focus', path: at(index - Math.max(1, pageRows)) };
    case 'ArrowRight':
      if (row?.kind === 'entry' && row.open === false) {
        return { kind: 'open', path: row.path };
      }
      if (row?.kind === 'entry' && row.open === true) {
        const next = paths[index + 1];
        return next !== undefined && parentPath(next) === row.path ? { kind: 'focus', path: next } : { kind: 'none' };
      }
      return { kind: 'none' };
    case 'ArrowLeft': {
      if (row?.kind === 'entry' && row.open === true) {
        return { kind: 'close', path: row.path };
      }
      const parent = parentPath(focused ?? first);
      return parent === undefined || parent === EXPLORER_ROOT ? { kind: 'none' } : { kind: 'focus', path: parent };
    }
    default: {
      const exhaustive: never = key;
      return exhaustive;
    }
  }
}

/** The paths between `anchor` and `target`, both included, in row order: a Shift selection. */
export function rangeBetween(rows: readonly TreeRow[], anchor: ExplorerPath, target: ExplorerPath): readonly ExplorerPath[] {
  const paths = rows.map(rowPath).filter((each): each is ExplorerPath => each !== undefined);
  const from = paths.indexOf(anchor);
  const to = paths.indexOf(target);
  if (from < 0 || to < 0) {
    return [target];
  }
  const range = paths.slice(Math.min(from, to), Math.max(from, to) + 1);
  assert(range.includes(target), 'rangeBetween: the range holds its target');
  return range;
}

/** The selection after a click: a plain click selects one, ⌘/Ctrl toggles one, Shift extends from the anchor. */
export function clickSelection(
  rows: readonly TreeRow[],
  current: ReadonlySet<ExplorerPath>,
  click: { readonly path: ExplorerPath; readonly anchor: ExplorerPath | undefined; readonly toggle: boolean; readonly extend: boolean },
): ReadonlySet<ExplorerPath> {
  if (click.extend && click.anchor !== undefined) {
    return new Set(rangeBetween(rows, click.anchor, click.path));
  }
  if (click.toggle) {
    const next = new Set(current);
    if (next.has(click.path)) {
      next.delete(click.path);
    } else {
      next.add(click.path);
    }
    return next;
  }
  return new Set([click.path]);
}

// ---------------------------------------------------------------------------
// Drops and pastes
// ---------------------------------------------------------------------------

/** The folder a drop on `row` lands in: the folder itself, or the folder holding a file; the root for empty space. */
export function dropFolderOf(row: TreeRow | undefined): ExplorerPath {
  if (row === undefined) {
    return EXPLORER_ROOT;
  }
  if (row.kind === 'more') {
    return row.path;
  }
  if (isFolderKind(row.entryKind)) {
    return row.path;
  }
  return parentPath(row.path) ?? EXPLORER_ROOT;
}

export type DropVerdict = { readonly kind: 'allowed' } | { readonly kind: 'refused'; readonly reason: 'protected' | 'into-itself' | 'same-folder' };

/** Whether moving `sources` into `folder` does anything, and is allowed: not into `.git`, not a folder into itself. */
export function dropVerdict(sources: readonly ExplorerPath[], folder: ExplorerPath, mode: 'move' | 'copy'): DropVerdict {
  if (isProtectedPath(folder)) {
    return { kind: 'refused', reason: 'protected' };
  }
  if (sources.some((source) => isProtectedPath(source))) {
    return { kind: 'refused', reason: 'protected' };
  }
  if (sources.some((source) => isWithinPath(source, folder))) {
    return { kind: 'refused', reason: 'into-itself' };
  }
  if (mode === 'move' && sources.every((source) => parentPath(source) === folder)) {
    return { kind: 'refused', reason: 'same-folder' };
  }
  return { kind: 'allowed' };
}

/** The folder new entries and pastes go into: the focused folder, the folder of the focused file, or the root. */
export function targetFolderOf(rows: readonly TreeRow[], focused: ExplorerPath | undefined): ExplorerPath {
  const row = rows.find((each) => each.kind === 'entry' && each.path === focused);
  return dropFolderOf(row);
}

/** Whether a row opens in the editor (a file, or a link to a file inside the project). */
export function opensAsFile(row: TreeRow): boolean {
  return row.kind === 'entry' && isFileKind(row.entryKind);
}

/** Open folders after `from` became `to` (a rename or move): the open folders inside it follow it. */
export function rebaseOpen(open: ReadonlySet<ExplorerPath>, from: ExplorerPath, to: ExplorerPath): ReadonlySet<ExplorerPath> {
  const next = new Set<ExplorerPath>();
  for (const folder of open) {
    next.add(isWithinPath(from, folder) ? rebasePath(folder, from, to) : folder);
  }
  return next;
}
