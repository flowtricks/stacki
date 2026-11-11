// The folder side of installed apps (docs/apps.md, "Apps added as a folder").
// `.stacki/apps/<id>/` is the source of truth for what is installed: a folder
// that holds a valid bundle is an installed app the moment it is there, whether
// Stacki wrote it or a person, an AI agent, a pull or a copy put it there. The
// lockfile (shared/properties/apps.ts) adds what a folder cannot say: where the
// app came from, its auto-update switch and its digest; a folder it does not
// name is listed with source `local`.
//
// A folder that does not read as an app is a broken row with the reason, in the
// same Installed list, so nothing in the folder is ever silently hidden. This
// module is the contract for those rows, for the change notice that tells an
// editor the folder moved, and for the stamps Studio polls in place of a file
// watcher.
import { assert } from '../core/assert';
import { record, text } from '../core/boundary';
import { toArray } from '../core/record';
import { APP_LIMITS, appsFailureMessage, parseAppSummary, type AppSummary } from './apps';

export const APP_FOLDER_LIMITS = {
  /** Entries read from `.stacki/apps/` in one scan: every app's folder, the lockfile, the settings file and stray files. */
  entriesMax: APP_LIMITS.appsMax * 4,
  /** A folder's name as the wire carries it; the file system's own bound. */
  folderCharsMax: 255,
  /**
   * How long a burst of file events (a pull, an agent writing a bundle file by file) must
   * be quiet before it counts as settled: Desktop's watcher waits this long before its
   * notice, and the editor again before a running app acts on one (appFolderChanges.ts).
   */
  settleMs: 500,
  /** How often Studio's editor asks whether the folder changed; it has no file watcher of its own. */
  pollMs: 1000,
  /** A folder's stamp: a digest of its files' paths, sizes and modification times. */
  stampCharsMax: 64,
} as const satisfies Record<string, number>;

/** A folder under `.stacki/apps/` that does not read as an app: an Installed row with the reason, never run. */
export interface AppFolderBroken {
  readonly folder: string;
  readonly message: string;
}

/** Which app folders changed, by folder name: added, removed or edited. Empty when only the lockfile or settings did. */
export interface AppFoldersChange {
  readonly folders: readonly string[];
}

/** What Studio polls: each folder's stamp, and one stamp over the files beside them (the lockfile, the settings). */
export interface AppFolderStamps {
  readonly folders: Readonly<Record<string, string>>;
  readonly files: string;
}

/**
 * A folder name under `.stacki/apps/`: one segment, not hidden, no separators.
 * Not an app id: a broken folder may be named anything a file system allows.
 */
export function parseAppFolderName(input: unknown): string {
  const folder = text(input);
  if (folder.length === 0 || folder.length > APP_FOLDER_LIMITS.folderCharsMax) {
    throw new Error(`An app folder name is 1 to ${APP_FOLDER_LIMITS.folderCharsMax} characters`);
  }
  if (folder.startsWith('.') || /[\\/\0]/.test(folder)) {
    throw new Error('An app folder name is one visible path segment');
  }
  assert(folder !== '..', 'A folder name never climbs');
  return folder;
}

export function parseAppFolderBroken(input: unknown): AppFolderBroken {
  const value = record(input);
  const message = text(value['message']).trim();
  if (message.length === 0 || message.length > APP_LIMITS.messageCharsMax) {
    throw new Error(`A broken row's reason is 1 to ${APP_LIMITS.messageCharsMax} characters`);
  }
  return { folder: parseAppFolderName(value['folder']), message };
}

export function parseAppFoldersBroken(input: unknown): readonly AppFolderBroken[] {
  const items = toArray(input);
  if (items === undefined || items.length > APP_FOLDER_LIMITS.entriesMax) {
    throw new Error('Expected a bounded list of broken app folders');
  }
  return items.map(parseAppFolderBroken);
}

/** The Installed list as the editor reads it off the wire: the apps that parse, and a broken row for each one that does not. */
export interface InstalledAppList {
  readonly apps: readonly AppSummary[];
  readonly broken: readonly AppFolderBroken[];
}

/**
 * The host's app list, parsed one app at a time. An app the editor cannot read
 * (a manifest check this build makes and the host's did not, or a host from
 * another version) is a broken row with its reason, under its folder's name; the
 * other apps list as usual. Only a malformed list fails as a whole.
 */
export function parseInstalledAppList(input: unknown): InstalledAppList {
  const items = toArray(input);
  if (items === undefined) {
    throw new Error('Expected a list of apps');
  }
  if (items.length > APP_LIMITS.appsMax) {
    throw new Error('Too many apps');
  }
  const apps: AppSummary[] = [];
  const broken: AppFolderBroken[] = [];
  for (const [index, item] of items.entries()) {
    try {
      apps.push(parseAppSummary(item));
    } catch (error: unknown) {
      // A broken invariant is the editor's own bug, not the app's: it still crashes (AGENTS.md §3).
      if (error instanceof Error && error.message.startsWith('Assertion failed')) {
        throw error;
      }
      broken.push({ folder: summaryFolder(item, index), message: appsFailureMessage(error) });
    }
  }
  assert(apps.length + broken.length === items.length, 'Every listed app is one row');
  assert(apps.length <= APP_LIMITS.appsMax, 'Listed apps are bounded by the app bound');
  return { apps, broken };
}

/** The apps of a host's list that this editor can read; an action's reply drops the rest, which the next list shows as broken rows. */
export function parseReadableAppSummaries(input: unknown): readonly AppSummary[] {
  return parseInstalledAppList(input).apps;
}

/** The Installed list's broken rows: the host's broken folders, then each unreadable app no folder row already names. */
export function joinBrokenRows(folders: readonly AppFolderBroken[], unreadable: readonly AppFolderBroken[]): readonly AppFolderBroken[] {
  const named = new Set(folders.map((row) => row.folder));
  const rows = [...folders, ...unreadable.filter((row) => !named.has(row.folder))];
  assert(rows.length >= folders.length, 'Joining never drops a broken folder');
  assert(rows.length <= folders.length + unreadable.length, 'Joining adds each unreadable app at most once');
  return rows;
}

// The folder an unreadable summary names: its manifest's id when that is a folder name, else its place in the list.
function summaryFolder(item: unknown, index: number): string {
  const fallback = `app-${index + 1}`;
  if (typeof item !== 'object' || item === null) {
    return fallback;
  }
  const manifest: unknown = Reflect.get(item, 'manifest');
  if (typeof manifest !== 'object' || manifest === null) {
    return fallback;
  }
  try {
    return parseAppFolderName(Reflect.get(manifest, 'id'));
  } catch {
    return fallback;
  }
}

export function parseAppFoldersChange(input: unknown): AppFoldersChange {
  const items = toArray(record(input)['folders']);
  if (items === undefined || items.length > APP_FOLDER_LIMITS.entriesMax) {
    throw new Error('Expected a bounded list of changed app folders');
  }
  return { folders: items.map(parseAppFolderName) };
}

export function parseAppFolderStamps(input: unknown): AppFolderStamps {
  const value = record(input);
  const folders = record(value['folders']);
  const entries = Object.entries(folders);
  if (entries.length > APP_FOLDER_LIMITS.entriesMax) {
    throw new Error('Expected a bounded set of app folder stamps');
  }
  const parsed: Record<string, string> = {};
  for (const [folder, stamp] of entries) {
    parsed[parseAppFolderName(folder)] = parseStamp(stamp);
  }
  return { folders: parsed, files: parseStamp(value['files']) };
}

function parseStamp(input: unknown): string {
  const stamp = text(input);
  if (stamp.length > APP_FOLDER_LIMITS.stampCharsMax || !/^[0-9a-f]*$/.test(stamp)) {
    throw new Error('An app folder stamp is a short hex digest');
  }
  return stamp;
}

/**
 * The folders whose stamps differ between two readings: added, removed or edited,
 * sorted. `any` also counts the files beside the folders (the lockfile, the
 * settings), which change the list without changing any app's files.
 */
export function changedAppFolders(before: AppFolderStamps, after: AppFolderStamps): { readonly folders: readonly string[]; readonly any: boolean } {
  const names = new Set([...Object.keys(before.folders), ...Object.keys(after.folders)]);
  assert(names.size <= APP_FOLDER_LIMITS.entriesMax * 2, 'Two bounded readings name a bounded set of folders');
  const folders = [...names].filter((name) => before.folders[name] !== after.folders[name]).sort();
  const any = folders.length > 0 || before.files !== after.files;
  assert(folders.length <= names.size, 'Only folders either reading named can have changed');
  return { folders, any };
}
