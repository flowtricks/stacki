/*
 * The insert palette's remembered tab: the palette opens on the tab it was last left on. A person's way of
 * working, not a site's, so it is kept for the app as a whole, in the same local storage as the Style
 * Editor's preferences (src/features/style/model/toolPreferences.ts). Best-effort: storage that is missing,
 * full or holds something else falls back to All results and never blocks the palette from opening.
 */
import type { InsertTab } from './insertGrid';
import { parseInsertFolderKey, type InsertFolderKey } from './insertFolders';

const INSERT_TAB_KEY = 'stacki.insertPalette.tab';

/** The tab a first-time palette opens on. */
export const INSERT_TAB_DEFAULT: InsertTab = 'all';

const INSERT_TABS: readonly InsertTab[] = ['all', 'components', 'elements', 'other'];

/** A stored tab, or the default: storage is shared with every earlier build, so what it holds is parsed like any input. */
export function parseStoredInsertTab(raw: unknown): InsertTab {
  return INSERT_TABS.find((tab) => tab === raw) ?? INSERT_TAB_DEFAULT;
}

export function loadInsertTab(): InsertTab {
  try {
    return parseStoredInsertTab(localStorage.getItem(INSERT_TAB_KEY));
  } catch {
    return INSERT_TAB_DEFAULT;
  }
}

export function saveInsertTab(tab: InsertTab): void {
  try {
    localStorage.setItem(INSERT_TAB_KEY, tab);
  } catch {
    /* noop: an unsaved tab is only forgotten until the next pick */
  }
}

/*
 * The remembered folder pill on the Components tab. Folder names belong to a project, so this one is kept
 * per project: a short list of [project, folder] pairs, newest first, capped so a person who opens many
 * projects never grows it without bound. A project with no pill chosen has no entry.
 */
const INSERT_FOLDERS_KEY = 'stacki.insertPalette.folders';

/** Projects whose folder pill is remembered; the oldest is forgotten first. */
export const insertFolderProjectsMax = 50;

/** One project's identity is a path or a workspace id; anything longer is not one. */
const projectKeyCharsMax = 4096;

export type StoredInsertFolders = ReadonlyArray<readonly [string, InsertFolderKey]>;

/** The stored list, or an empty one: unreadable, malformed or oversized entries are dropped, never trusted. */
export function parseStoredInsertFolders(raw: unknown): StoredInsertFolders {
  if (typeof raw !== 'string') {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  // Read as unknowns: `Array.isArray` narrows to `any[]`, which would let an entry through unchecked.
  const stored: readonly unknown[] = parsed;
  const entries: Array<readonly [string, InsertFolderKey]> = [];
  for (const entry of stored.slice(0, insertFolderProjectsMax)) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      continue;
    }
    const pair: readonly unknown[] = entry;
    const project = pair[0];
    const folder = pair[1];
    const key = parseInsertFolderKey(folder);
    if (typeof project === 'string' && project.length > 0 && project.length <= projectKeyCharsMax && key !== undefined) {
      entries.push([project, key]);
    }
  }
  return entries;
}

/** The folder pill this project last had selected, or undefined (none, or nothing to tell projects apart by). */
export function loadInsertFolder(project: string | undefined): InsertFolderKey | undefined {
  if (project === undefined) {
    return undefined;
  }
  try {
    return parseStoredInsertFolders(localStorage.getItem(INSERT_FOLDERS_KEY)).find(([stored]) => stored === project)?.[1];
  } catch {
    return undefined;
  }
}

/** Remembers `folder` for `project`, or forgets the project's pill when it is undefined. */
export function saveInsertFolder(project: string | undefined, folder: InsertFolderKey | undefined): void {
  if (project === undefined) {
    return;
  }
  try {
    const others = parseStoredInsertFolders(localStorage.getItem(INSERT_FOLDERS_KEY)).filter(([stored]) => stored !== project);
    const next = folder === undefined ? others : [[project, folder] as const, ...others];
    localStorage.setItem(INSERT_FOLDERS_KEY, JSON.stringify(next.slice(0, insertFolderProjectsMax)));
  } catch {
    /* noop: an unsaved pill is only forgotten until the next pick */
  }
}
