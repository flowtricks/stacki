// Installed Stacki apps on disk: `.stacki/apps/<id>/` holds each bundle's files,
// `.stacki/apps/apps.json` the lockfile (shared/properties/apps.ts). Both are
// tracked project files, so Desktop, Studio and every collaborator open the same
// apps at the same digests. Studio's server reads and writes them through this
// same module (studio/scripts/shared-source.json).
//
// A bundle is written whole to a staging folder beside its final place and then
// renamed into it, so a crash leaves the old version or the new one, never half
// of each. The lockfile is replaced atomically the same way. Nothing here runs a
// bundle's files: they are only ever served to the app's sandboxed frame.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { assert } from '../../shared/core/assert';
import { ReferencedError } from '../../shared/properties/i18n/referencedError';
import {
  APP_LIMITS,
  APP_MANIFEST_FILE,
  APPS_DIRECTORY,
  APPS_LOCK_FILE,
  EMPTY_APPS_LOCK,
  EMPTY_APPS_LOCK_READING,
  appFileType,
  parseAppId,
  parseAppManifestSource,
  parseAppsLockSource,
  parseBundlePath,
  readAppsLockEntries,
  serializeAppsLock,
  type AppLockEntry,
  type AppManifest,
  type AppSummary,
  type AppsLock,
  type AppsLockReading,
} from '../../shared/properties/apps';
import type { AppBundle } from '../../shared/properties/appBundle';
import { lockEntriesWithFolders, readFolderBundle, readInstalledApps, type InstalledApps } from './appScan';

const STAGING_PREFIX = '.staging-';

/** The project's lockfile; a project with no apps has none and reads as empty. */
export function readAppsLock(projectRoot: string): AppsLock {
  const file = path.join(projectRoot, APPS_LOCK_FILE);
  let source: string;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error: unknown) {
    if (isMissing(error)) {
      return EMPTY_APPS_LOCK;
    }
    throw error;
  }
  return parseAppsLockSource(source);
}

/**
 * Every installed app, by folder name (appScan.ts): each folder under
 * `.stacki/apps/` that reads as an app, with its lock entry, or as source
 * `local` when the lockfile does not name it. Broken folders are not here;
 * `listInstalledFolders` has those too.
 */
export function listInstalledApps(projectRoot: string): readonly AppSummary[] {
  const summaries = listInstalledFolders(projectRoot).apps;
  assert(summaries.length <= APP_LIMITS.appsMax, 'Installed apps are bounded');
  return summaries;
}

/**
 * The whole Installed list: the apps, and the folders that do not read as one.
 * The lockfile is read entry by entry here (`readAppsLockForList`), so a bad
 * record breaks its own app's row and never the list.
 */
export function listInstalledFolders(projectRoot: string): InstalledApps {
  return readInstalledApps(projectRoot, readAppsLockForList(projectRoot));
}

/** The lockfile for listing: a missing file reads as empty; an unreadable one, or a bad entry, is a failure the list shows as a row. */
export function readAppsLockForList(projectRoot: string): AppsLockReading {
  let source: string;
  try {
    source = fs.readFileSync(path.join(projectRoot, APPS_LOCK_FILE), 'utf8');
  } catch (error: unknown) {
    if (isMissing(error)) {
      return EMPTY_APPS_LOCK_READING;
    }
    return { ...EMPTY_APPS_LOCK_READING, fileFailure: `${APPS_LOCK_FILE} cannot be read: ${String(error).slice(0, 200)}` };
  }
  const reading = readAppsLockEntries(source);
  assert(reading.lock.apps.length <= APP_LIMITS.appsMax, 'A read lockfile is bounded by the app bound');
  return reading;
}

/** One installed app's manifest, read from its folder; the id must match the folder's. */
export function readInstalledManifest(projectRoot: string, id: string): AppManifest {
  const file = path.join(appDirectory(projectRoot, id), APP_MANIFEST_FILE);
  const manifest = parseAppManifestSource(fs.readFileSync(file, 'utf8'));
  if (manifest.id !== id) {
    throw new ReferencedError('apps.error.folderHoldsOtherApp', { folder: `.stacki/apps/${id}`, found: manifest.id });
  }
  return manifest;
}

/**
 * An installed app's files as a bundle, read back from `.stacki/apps/<id>/`: what
 * the secret scan reads and a share commits and releases. Held to the bundle
 * bounds as an upload is: file count, each file's size, the total, path rules.
 * A link inside the folder is refused, so nothing outside it is read.
 */
export function readInstalledBundle(projectRoot: string, id: string): AppBundle {
  const bundle = readFolderBundle(appDirectory(projectRoot, id), id);
  if (bundle.manifest.id !== id) {
    throw new ReferencedError('apps.error.folderHoldsOtherApp', { folder: `.stacki/apps/${id}`, found: bundle.manifest.id });
  }
  assert(
    bundle.files.some((file) => file.path === APP_MANIFEST_FILE),
    'An installed app holds its manifest',
  );
  return bundle;
}

/** Writes a checked bundle into place and records it in the lockfile. Returns its summary. */
export function installAppBundle(projectRoot: string, bundle: AppBundle, entry: AppLockEntry): AppSummary {
  assert(bundle.manifest.id === entry.id, 'A lock entry names the bundle it records');
  assert(bundle.manifest.version === entry.version, 'A lock entry records the bundle’s version');
  const lock = readAppsLock(projectRoot);
  const others = lock.apps.filter((app) => app.id !== entry.id);
  if (others.length >= APP_LIMITS.appsMax) {
    throw new ReferencedError('apps.error.appLimit', { count: APP_LIMITS.appsMax });
  }
  const target = appDirectory(projectRoot, entry.id);
  const staging = path.join(path.dirname(target), `${STAGING_PREFIX}${randomBytes(8).toString('hex')}`);
  fs.mkdirSync(staging, { recursive: true });
  try {
    for (const file of bundle.files) {
      const relative = parseBundlePath(file.path);
      const destination = path.join(staging, ...relative.split('/'));
      assert(isInside(staging, destination), 'A bundle file is written inside its staging folder');
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, file.bytes, { flag: 'wx' });
    }
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
  } catch (error: unknown) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  writeAppsLock(projectRoot, { version: 1, apps: [...others, entry] });
  const summary = { manifest: readInstalledManifest(projectRoot, entry.id), lock: entry };
  assert(summary.manifest.version === entry.version, 'The installed manifest reads back as written');
  return summary;
}

/** Changes one app's lock entry, keeping its files. */
export function updateLockEntry(projectRoot: string, id: string, change: (entry: AppLockEntry) => AppLockEntry): AppLockEntry {
  const lock = readAppsLock(projectRoot);
  const current = lock.apps.find((app) => app.id === id);
  if (current === undefined) {
    throw new ReferencedError('apps.error.notInstalled', { id });
  }
  const next = change(current);
  assert(next.id === id, 'A lock change keeps the app id');
  writeAppsLock(projectRoot, { version: 1, apps: lock.apps.map((app) => (app.id === id ? next : app)) });
  return next;
}

/**
 * Records a lock entry for an app whose folder is already in place and that the
 * lockfile does not name yet (an app added to the project folder, source
 * `local`, that now has a source of its own). Its files stay as they are.
 */
export function recordLockEntry(projectRoot: string, entry: AppLockEntry): AppLockEntry {
  assert(fs.existsSync(appDirectory(projectRoot, entry.id)), 'A recorded app’s folder is in place');
  const lock = readAppsLock(projectRoot);
  assert(!lock.apps.some((app) => app.id === entry.id), 'Only an app the lockfile does not name is recorded');
  if (lock.apps.length >= APP_LIMITS.appsMax) {
    throw new ReferencedError('apps.error.appLimit', { count: APP_LIMITS.appsMax });
  }
  writeAppsLock(projectRoot, { version: 1, apps: [...lock.apps, entry] });
  assert(
    readAppsLock(projectRoot).apps.some((app) => app.id === entry.id),
    'A recorded entry reads back',
  );
  return entry;
}

/** Removes an app's files and its lockfile entry. */
export function uninstallApp(projectRoot: string, id: string): void {
  const lock = readAppsLock(projectRoot);
  // A folder added to the project (source `local`) has no lock entry: removing it removes the folder.
  if (!lock.apps.some((app) => app.id === id) && !fs.existsSync(appDirectory(projectRoot, id))) {
    throw new ReferencedError('apps.error.notInstalled', { id });
  }
  writeAppsLock(projectRoot, { version: 1, apps: lock.apps.filter((app) => app.id !== id) });
  fs.rmSync(appDirectory(projectRoot, id), { recursive: true, force: true });
  assert(!fs.existsSync(appDirectory(projectRoot, id)), 'An uninstalled app leaves no files');
}

/** One file of an installed app, for its sandboxed frame; undefined when there is no such file. */
export function readAppFile(projectRoot: string, id: string, requestPath: string): { readonly bytes: Uint8Array; readonly type: string } | undefined {
  const relative = parseBundlePath(requestPath);
  const type = appFileType(relative);
  assert(type !== undefined, 'parseBundlePath accepts only typed files');
  const directory = appDirectory(projectRoot, id);
  const file = path.join(directory, ...relative.split('/'));
  let real: string;
  try {
    real = fs.realpathSync(file);
  } catch (error: unknown) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
  // A link planted in the folder by hand must not let a frame read outside it.
  if (!isInside(fs.realpathSync(directory), real)) {
    return undefined;
  }
  const stat = fs.statSync(real);
  if (!stat.isFile() || stat.size > APP_LIMITS.fileBytesMax) {
    return undefined;
  }
  return { bytes: fs.readFileSync(real), type };
}

function appDirectory(projectRoot: string, id: string): string {
  const directory = path.join(projectRoot, APPS_DIRECTORY, parseAppId(id));
  assert(isInside(path.join(projectRoot, APPS_DIRECTORY), directory), 'An app folder is inside .stacki/apps');
  return directory;
}

// Every write drops the entries whose folders are gone: the folder is what is installed.
function writeAppsLock(projectRoot: string, lock: AppsLock): void {
  const file = path.join(projectRoot, APPS_LOCK_FILE);
  const source = serializeAppsLock({ version: 1, apps: lockEntriesWithFolders(projectRoot, lock.apps) });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, source, { flag: 'wx' });
  fs.renameSync(temporary, file);
  assert(fs.readFileSync(file, 'utf8') === source, 'The lockfile reads back as written');
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
