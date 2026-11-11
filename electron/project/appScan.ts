// What is installed, read from the folder (shared/properties/appFolders.ts):
// every `.stacki/apps/<folder>/` that holds a bundle is an installed app, merged
// with the lockfile's record of it. Desktop's main process and the Studio server
// both list apps through here (by way of appStore.ts), so the two agree.
//
// A folder is read whole, as an upload is: every file within the bundle bounds,
// paths held to parseBundlePath, links refused, and the same checks a zip gets
// (shared/properties/appBundle.ts bundleFromFiles). Hidden files (`.DS_Store`)
// are skipped: no bundle may hold one and the frame is never served one. A
// folder the lockfile does not name is listed with source `local` and its
// digest, SHA-256 over its sorted files; nothing is written for it.
//
// Reading every byte of fifty apps on every list would be slow, so each folder's
// reading is kept against a stamp of its files' paths, sizes and times, which a
// walk of stat calls finds. A folder whose stamp has not moved is not read again.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assert } from '../../shared/core/assert';
import {
  APP_LIMITS,
  APP_MANIFEST_FILE,
  APPS_DIRECTORY,
  APPS_LOCK_FILE,
  appsFailureMessage,
  parseBundlePath,
  type AppLockEntry,
  type AppManifest,
  type AppSummary,
  type AppsLock,
  type AppsLockReading,
} from '../../shared/properties/apps';
import { bundleFromFiles, type AppBundle, type BundleFile } from '../../shared/properties/appBundle';
import { APP_FOLDER_LIMITS, type AppFolderBroken, type AppFolderStamps } from '../../shared/properties/appFolders';

/** One folder under `.stacki/apps/` as a scan read it: an app, with its digest, or the reason it is not one. */
export type AppFolderRead =
  | {
      readonly kind: 'app';
      readonly folder: string;
      readonly manifest: AppManifest;
      readonly sha256: string;
      /** When its manifest was last written (ISO): what a folder-only app's `installedAt` says. */
      readonly addedAt: string;
    }
  | { readonly kind: 'broken'; readonly folder: string; readonly message: string };

/** The Installed list: the apps, and the folders that do not read as one. */
export interface InstalledApps {
  readonly apps: readonly AppSummary[];
  readonly broken: readonly AppFolderBroken[];
}

const STAMP_CHARS = 32;
/** Readings kept: each folder of a few projects. */
const CACHE_ENTRIES_MAX = APP_FOLDER_LIMITS.entriesMax * 2;
const cache = new Map<string, { readonly stamp: string; readonly read: AppFolderRead }>();

/**
 * The Installed list of a project: each folder merged with its lock entry.
 * - In the lockfile: listed with that record (its source, auto-update switch and digest).
 * - Not in the lockfile: listed at once, with source `local`. Nothing is written for it:
 *   the folder alone says it is installed, so a pull or a copy never dirties the lockfile.
 * - Broken: a row with its reason, never run. A lock entry whose folder is gone is not listed.
 */
export function readInstalledApps(projectRoot: string, lock: AppsLockReading): InstalledApps {
  return mergeInstalledApps(lock.lock, readAppFolders(projectRoot), lock);
}

/** No lockfile failures: what a lockfile that parsed whole reads as. */
const LOCK_READ_WHOLE: Pick<AppsLockReading, 'entryFailures' | 'fileFailure'> = { entryFailures: new Map(), fileFailure: undefined };

/**
 * The merge `readInstalledApps` describes, over folders already read. Pure, for its tests.
 * A folder whose lock entry is invalid is a broken row with that reason; a lockfile that
 * cannot be read at all is one row of its own, and its apps list as their folders read.
 */
export function mergeInstalledApps(
  lock: AppsLock,
  folders: readonly AppFolderRead[],
  failures: Pick<AppsLockReading, 'entryFailures' | 'fileFailure'> = LOCK_READ_WHOLE,
): InstalledApps {
  const entries = new Map(lock.apps.map((entry) => [entry.id, entry]));
  const apps: AppSummary[] = [];
  const broken: AppFolderBroken[] = [];
  for (const read of folders) {
    if (read.kind === 'broken') {
      broken.push({ folder: read.folder, message: read.message });
      continue;
    }
    assert(read.manifest.id === read.folder, 'A folder reads as an app only under its own id');
    const entryFailure = failures.entryFailures.get(read.folder);
    if (entryFailure === undefined) {
      apps.push({ manifest: read.manifest, lock: entries.get(read.folder) ?? localLockEntry(read) });
    } else {
      broken.push({ folder: read.folder, message: entryFailure });
    }
  }
  assert(apps.length + broken.length === folders.length, 'Every folder is one row');
  if (failures.fileFailure !== undefined) {
    broken.push({ folder: path.basename(APPS_LOCK_FILE), message: failures.fileFailure });
  }
  assert(apps.length <= APP_LIMITS.appsMax, 'Installed apps are bounded by the app bound');
  return { apps, broken };
}

/** The record a folder the lockfile does not name is listed with: source `local`, its digest, never auto-updated. */
function localLockEntry(read: Extract<AppFolderRead, { readonly kind: 'app' }>): AppLockEntry {
  const entry: AppLockEntry = {
    id: read.folder,
    version: read.manifest.version,
    sha256: read.sha256,
    installedAt: read.addedAt,
    source: { kind: 'local' },
    update: undefined,
    autoUpdate: false,
  };
  assert(entry.id === read.manifest.id, 'A local entry names its folder’s app');
  return entry;
}

/** Every folder under `.stacki/apps/`, sorted by name; dotfiles and plain files are skipped. */
export function readAppFolders(projectRoot: string): readonly AppFolderRead[] {
  const reads: AppFolderRead[] = [];
  let apps = 0;
  for (const entry of appsDirectoryEntries(projectRoot)) {
    if (entry.kind === 'file') {
      continue;
    }
    if (entry.kind === 'link') {
      reads.push({ kind: 'broken', folder: entry.name, message: 'This is a link. An app’s folder holds its files itself.' });
      continue;
    }
    if (apps < APP_LIMITS.appsMax) {
      const read = readAppFolder(projectRoot, entry.name);
      apps += read.kind === 'app' ? 1 : 0;
      reads.push(read);
    } else {
      reads.push({ kind: 'broken', folder: entry.name, message: `A project has at most ${APP_LIMITS.appsMax} apps; this folder is past the limit.` });
    }
  }
  assert(reads.length <= APP_FOLDER_LIMITS.entriesMax, 'A scan is bounded by the entries it read');
  return reads;
}

/** One folder, from its kept reading when its files have not moved. */
export function readAppFolder(projectRoot: string, folder: string): AppFolderRead {
  const directory = appFolderPath(projectRoot, folder);
  let files: readonly FolderFile[];
  try {
    files = listFolderFiles(directory, folder);
  } catch (error: unknown) {
    return { kind: 'broken', folder, message: expectedFailure(error) };
  }
  const stamp = filesStamp(files);
  const kept = cache.get(directory);
  if (kept !== undefined && kept.stamp === stamp) {
    return kept.read;
  }
  const read = readFolderAsApp(directory, folder, files);
  cache.delete(directory);
  cache.set(directory, { stamp, read });
  if (cache.size > CACHE_ENTRIES_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  assert(cache.size <= CACHE_ENTRIES_MAX, 'Kept folder readings are bounded');
  return read;
}

/**
 * A folder's files as a bundle, checked as an upload is. Throws with the reason;
 * `label` names the folder in it. The digest is `appFolderDigest` of the files.
 */
export function readFolderBundle(directory: string, label: string): AppBundle {
  return bundleFromFiles(readFolderFiles(directory, label, listFolderFiles(directory, label)));
}

/** SHA-256 (hex) over a bundle's files: each sorted path, its length and its bytes, so no two bundles share one. */
export function appFolderDigest(files: readonly BundleFile[]): string {
  const sorted = [...files].sort((left, right) => (left.path < right.path ? -1 : 1));
  const hash = createHash('sha256');
  for (const file of sorted) {
    hash.update(`${file.path}\0${file.bytes.byteLength}\0`);
    hash.update(file.bytes);
  }
  const digest = hash.digest('hex');
  assert(digest.length === 64, 'A SHA-256 is 64 hex characters');
  return digest;
}

/** Whether the file route may serve `id`'s files: its folder reads as that app now. A broken or missing folder serves nothing. */
export function appFolderRuns(projectRoot: string, id: string): boolean {
  if (!fs.existsSync(appFolderPath(projectRoot, id))) {
    return false;
  }
  return readAppFolder(projectRoot, id).kind === 'app';
}

/** Each folder's stamp and one over the files beside them: what a change notice compares (Desktop's watcher, Studio's poll). */
export function readAppFolderStamps(projectRoot: string): AppFolderStamps {
  const folders: Record<string, string> = {};
  const beside: string[] = [];
  for (const entry of appsDirectoryEntries(projectRoot)) {
    const full = path.join(projectRoot, APPS_DIRECTORY, entry.name);
    if (entry.kind === 'directory') {
      folders[entry.name] = folderStampOrTime(full, entry.name);
    } else {
      beside.push(statLine(entry.name, full));
    }
  }
  return { folders, files: digestLines(beside) };
}

/** The lockfile without the entries whose folders are gone: what the next lockfile write keeps. */
export function lockEntriesWithFolders(projectRoot: string, apps: readonly AppLockEntry[]): readonly AppLockEntry[] {
  const kept = apps.filter((entry) => fs.existsSync(appFolderPath(projectRoot, entry.id)));
  assert(kept.length <= apps.length, 'Pruning never adds an entry');
  return kept;
}

// ---------------------------------------------------------------------------
// Reading a folder
// ---------------------------------------------------------------------------

interface FolderFile {
  readonly path: string;
  readonly sizeBytes: number;
  readonly line: string;
}

type DirectoryEntry = { readonly kind: 'directory' | 'file' | 'link'; readonly name: string };

// The visible entries of `.stacki/apps/`, sorted; none when the folder does not exist.
function appsDirectoryEntries(projectRoot: string): readonly DirectoryEntry[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(projectRoot, APPS_DIRECTORY), { withFileTypes: true });
  } catch (error: unknown) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
  if (entries.length > APP_FOLDER_LIMITS.entriesMax) {
    throw new Error(`${APPS_DIRECTORY} holds more than ${APP_FOLDER_LIMITS.entriesMax} entries`);
  }
  const visible: DirectoryEntry[] = [];
  for (const entry of entries) {
    // Dotfiles are skipped, and with them an install's staging folder (appStore.ts `.staging-`).
    if (entry.name.startsWith('.')) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      visible.push({ kind: 'link', name: entry.name });
    } else if (entry.isDirectory()) {
      visible.push({ kind: 'directory', name: entry.name });
    } else {
      // The lockfile, the settings file, and any stray file: none is an app.
      visible.push({ kind: 'file', name: entry.name });
    }
  }
  return visible.sort((left, right) => (left.name < right.name ? -1 : 1));
}

function readFolderAsApp(directory: string, folder: string, files: readonly FolderFile[]): AppFolderRead {
  let bundle: AppBundle;
  try {
    bundle = bundleFromFiles(readFolderFiles(directory, folder, files));
  } catch (error: unknown) {
    return { kind: 'broken', folder, message: expectedFailure(error) };
  }
  const id = bundle.manifest.id;
  if (id !== folder) {
    return { kind: 'broken', folder, message: `The folder is named "${folder}" but its stacki-app.json says "id": "${id}". Rename one to match.` };
  }
  let addedAt: string;
  try {
    // The manifest can go between the read and this stat (an agent mid-edit): that folder is broken, not the list.
    addedAt = fs.statSync(path.join(directory, APP_MANIFEST_FILE)).mtime.toISOString();
  } catch (error: unknown) {
    return { kind: 'broken', folder, message: expectedFailure(error) };
  }
  return { kind: 'app', folder, manifest: bundle.manifest, sha256: appFolderDigest(bundle.files), addedAt };
}

// The folder's files, breadth first over at most pathDepthMax levels, by stat
// alone. Hidden names are skipped; a link, a path the bundle rules refuse, or
// more files than a bundle may hold fails the folder with its reason.
function listFolderFiles(directory: string, label: string): readonly FolderFile[] {
  const files: FolderFile[] = [];
  let entriesSeen = 0;
  let level: readonly string[] = [''];
  for (let depth = 0; level.length > 0; depth += 1) {
    if (depth >= APP_LIMITS.pathDepthMax) {
      throw new Error(`${APPS_DIRECTORY}/${label} is nested more than ${APP_LIMITS.pathDepthMax} folders deep`);
    }
    const next: string[] = [];
    for (const relative of level) {
      const entries = fs.readdirSync(path.join(directory, ...relative.split('/').filter(Boolean)), { withFileTypes: true });
      entriesSeen += entries.length;
      if (entriesSeen > APP_LIMITS.filesMax * 2) {
        throw new Error(`${APPS_DIRECTORY}/${label} holds more than ${APP_LIMITS.filesMax} files`);
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) {
          continue;
        }
        const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
        if (entry.isSymbolicLink()) {
          throw new Error(`${APPS_DIRECTORY}/${label}/${child} is a link; an app’s folder holds files only`);
        }
        if (entry.isDirectory()) {
          next.push(child);
          continue;
        }
        if (files.length >= APP_LIMITS.filesMax) {
          throw new Error(`${APPS_DIRECTORY}/${label} holds more than ${APP_LIMITS.filesMax} files`);
        }
        const bundlePath = parseBundlePath(child);
        const full = path.join(directory, ...bundlePath.split('/'));
        files.push({ path: bundlePath, sizeBytes: fs.statSync(full).size, line: statLine(bundlePath, full) });
      }
    }
    level = next;
  }
  assert(files.length <= APP_LIMITS.filesMax, 'A folder’s files are bounded');
  return files;
}

// Each file's bytes, every size bound checked before a byte is read.
function readFolderFiles(directory: string, label: string, files: readonly FolderFile[]): readonly BundleFile[] {
  let totalBytes = 0;
  for (const file of files) {
    if (file.sizeBytes > APP_LIMITS.fileBytesMax) {
      throw new Error(`${APPS_DIRECTORY}/${label}/${file.path} exceeds ${APP_LIMITS.fileBytesMax} bytes`);
    }
    totalBytes += file.sizeBytes;
  }
  if (totalBytes > APP_LIMITS.bundleBytesMax) {
    throw new Error(`${APPS_DIRECTORY}/${label} exceeds ${APP_LIMITS.bundleBytesMax} bytes`);
  }
  const read = files.map((file) => {
    const bytes = fs.readFileSync(path.join(directory, ...file.path.split('/')));
    // A file that grew between the stat and the read is held to the same bound.
    if (bytes.byteLength > APP_LIMITS.fileBytesMax) {
      throw new Error(`${APPS_DIRECTORY}/${label}/${file.path} exceeds ${APP_LIMITS.fileBytesMax} bytes`);
    }
    return { path: file.path, bytes: new Uint8Array(bytes) };
  });
  assert(read.length === files.length, 'Every listed file is read');
  return read;
}

// A stamp that moves with any file's path, size or times.
function filesStamp(files: readonly FolderFile[]): string {
  return digestLines(files.map((file) => file.line));
}

// A folder that cannot be walked still gets a stamp, from its own times, so fixing it is heard.
function folderStampOrTime(directory: string, label: string): string {
  try {
    return filesStamp(listFolderFiles(directory, label));
  } catch (error: unknown) {
    return digestLines([statLine(label, directory), expectedFailure(error)]);
  }
}

function statLine(name: string, full: string): string {
  const stat = fs.lstatSync(full);
  return `${name}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}`;
}

function digestLines(lines: readonly string[]): string {
  const stamp = createHash('sha256')
    .update([...lines].sort().join('\n'))
    .digest('hex')
    .slice(0, STAMP_CHARS);
  assert(stamp.length <= APP_FOLDER_LIMITS.stampCharsMax, 'A stamp fits its wire bound');
  return stamp;
}

function appFolderPath(projectRoot: string, folder: string): string {
  const parent = path.join(projectRoot, APPS_DIRECTORY);
  const directory = path.join(parent, folder);
  assert(path.dirname(directory) === parent, 'An app folder is one level inside .stacki/apps');
  return directory;
}

// A folder that fails to read is a row with the reason; a broken invariant still crashes (AGENTS.md §3).
function expectedFailure(error: unknown): string {
  if (error instanceof Error && error.message.startsWith('Assertion failed')) {
    throw error;
  }
  return appsFailureMessage(error);
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
