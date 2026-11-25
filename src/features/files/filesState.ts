// What the Files panel remembers per project while the app runs: the folder listings read so far, the open folders,
// the selection, the file in the editor and whether it holds unsaved text, and the panel's cut or copy. Kept outside
// the panel because only the open left panel is mounted (AppShell.tsx, LeftPanel): FilesKeeper.tsx fills it from the
// moment the project opens and keeps it current, so the panel paints the tree in its first frame (docs/ui-loading.md).
//
// Bounds: listings for at most `LISTINGS_MAX` folders per project (the least recently read go first), state for at
// most `PROJECTS_MAX` projects, and at most `watchDirectoriesMax` open folders remembered in browser storage.
import { useSyncExternalStore } from 'react';
import { assert } from '../../../shared/core/assert';
import { FILE_EXPLORER_LIMITS, isWithinPath, parseExplorerPath, rebasePath, type ExplorerListing, type ExplorerPath } from '../../../shared/ipc/fileExplorer';

const LISTINGS_MAX = 2_000;
const PROJECTS_MAX = 8;
const OPEN_STORAGE_PREFIX = 'stacki.files.open:';

export interface FilesClipboard {
  readonly mode: 'copy' | 'cut';
  readonly paths: readonly ExplorerPath[];
}

export interface FilesView {
  readonly listings: ReadonlyMap<ExplorerPath, ExplorerListing>;
  /** Folders whose last read failed or went unanswered; a listing already held stays on screen. */
  readonly failed: ReadonlySet<ExplorerPath>;
  readonly open: ReadonlySet<ExplorerPath>;
  readonly selected: ReadonlySet<ExplorerPath>;
  readonly focused: ExplorerPath | undefined;
  readonly anchor: ExplorerPath | undefined;
  /** The file the editor shows, and whether its text differs from the disk. */
  readonly editor: { readonly path: ExplorerPath; readonly dirty: boolean; readonly opening: number } | undefined;
  readonly clipboard: FilesClipboard | undefined;
}

const views = new Map<string, FilesView>();
const listeners = new Set<() => void>();

function emptyView(projectPath: string): FilesView {
  return {
    listings: new Map(),
    failed: new Set(),
    open: readOpen(projectPath),
    selected: new Set(),
    focused: undefined,
    anchor: undefined,
    editor: undefined,
    clipboard: undefined,
  };
}

export function filesView(projectPath: string): FilesView {
  assert(projectPath.length > 0, 'filesView: a project is named');
  let view = views.get(projectPath);
  if (view === undefined) {
    view = emptyView(projectPath);
    views.set(projectPath, view);
    for (const key of [...views.keys()].slice(0, Math.max(0, views.size - PROJECTS_MAX))) {
      views.delete(key);
    }
  }
  return view;
}

export function updateFilesView(projectPath: string, change: (view: FilesView) => FilesView): void {
  const before = filesView(projectPath);
  const after = change(before);
  if (after === before) {
    return;
  }
  views.set(projectPath, after);
  if (after.open !== before.open) {
    writeOpen(projectPath, after.open);
  }
  for (const listener of [...listeners]) {
    listener();
  }
}

export function useFilesView(projectPath: string): FilesView {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => filesView(projectPath),
  );
}

/** The view with a folder's listing stored, the oldest listings dropped past the bound. */
export function withListing(view: FilesView, listing: ExplorerListing): FilesView {
  const held = view.listings.get(listing.path);
  // A background read that found nothing new changes nothing, so nothing is drawn again.
  if (held !== undefined && sameListing(held, listing) && !view.failed.has(listing.path)) {
    return view;
  }
  const listings = new Map(view.listings);
  listings.delete(listing.path);
  listings.set(listing.path, listing);
  for (const key of [...listings.keys()]) {
    if (listings.size <= LISTINGS_MAX) {
      break;
    }
    if (key !== '') {
      listings.delete(key);
    }
  }
  return { ...view, listings, failed: new Set([...view.failed].filter((each) => each !== listing.path)) };
}

/** The view after a read of `folder` failed: always a new set, so each failed attempt can be told apart. */
export function withFailure(view: FilesView, folder: ExplorerPath): FilesView {
  const failed = new Set([...view.failed].filter((each) => each !== folder));
  failed.add(folder);
  for (const oldest of [...failed].slice(0, Math.max(0, failed.size - FILE_EXPLORER_LIMITS.watchDirectoriesMax))) {
    failed.delete(oldest);
  }
  return { ...view, failed };
}

function sameListing(left: ExplorerListing, right: ExplorerListing): boolean {
  if (left.totalCount !== right.totalCount || left.entries.length !== right.entries.length) {
    return false;
  }
  return left.entries.every((entry, index) => {
    const other = right.entries[index];
    return other !== undefined && other.name === entry.name && other.kind === entry.kind;
  });
}

/** The view with every listing at or under `path` forgotten (it went away), keeping the rest. */
export function withoutListings(view: FilesView, path: ExplorerPath): FilesView {
  const listings = new Map([...view.listings].filter(([key]) => !isWithinPath(path, key)));
  return { ...view, listings, failed: new Set([...view.failed].filter((key) => !isWithinPath(path, key))) };
}

/** The view after `from` became `to`: open folders, selection and the editor follow the entry. */
export function withMoved(view: FilesView, from: ExplorerPath, to: ExplorerPath): FilesView {
  const follow = (path: ExplorerPath): ExplorerPath => (isWithinPath(from, path) ? rebasePath(path, from, to) : path);
  const editor = view.editor === undefined ? undefined : { ...view.editor, path: follow(view.editor.path) };
  return {
    ...withoutListings(view, from),
    open: new Set([...view.open].map(follow)),
    selected: new Set([...view.selected].map(follow)),
    focused: view.focused === undefined ? undefined : follow(view.focused),
    anchor: view.anchor === undefined ? undefined : follow(view.anchor),
    editor,
  };
}

// The open folders are a per-viewer convenience: browser storage, read defensively, bounded, and never required.
function readOpen(projectPath: string): ReadonlySet<ExplorerPath> {
  try {
    const raw = window.localStorage.getItem(OPEN_STORAGE_PREFIX + projectPath);
    if (raw === null) {
      return new Set();
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    const items: readonly unknown[] = parsed;
    const open = new Set<ExplorerPath>();
    for (const item of items.slice(0, FILE_EXPLORER_LIMITS.watchDirectoriesMax)) {
      try {
        const path = parseExplorerPath(item);
        if (path !== '') {
          open.add(path);
        }
      } catch {
        // A stored entry that is not a path is skipped: storage is never trusted.
      }
    }
    return open;
  } catch {
    return new Set();
  }
}

function writeOpen(projectPath: string, open: ReadonlySet<ExplorerPath>): void {
  try {
    window.localStorage.setItem(OPEN_STORAGE_PREFIX + projectPath, JSON.stringify([...open].slice(0, FILE_EXPLORER_LIMITS.watchDirectoriesMax)));
  } catch {
    // Storage full or blocked: the folders are simply closed next time.
  }
}
