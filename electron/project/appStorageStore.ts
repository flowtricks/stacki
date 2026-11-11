// App storage on disk (shared/properties/appStorage.ts holds the contract): one
// JSON file per app and scope. Project values are `.stacki/app-data/<id>.json`
// in the project; local values are `<id>.json` in a folder the host names for
// this person (Desktop's user data, a Studio's home folder). Desktop's main
// process and the Studio server both use this module
// (studio/scripts/shared-source.json), so the two keep the same files.
//
// Writes are atomic: the new file is written beside the old under a temporary
// name and renamed over it, so a crash leaves the old values or the new ones,
// never half of each. Every write is read back and checked.
//
// The store remembers the last values it read or wrote of each file. A write
// tells listeners at once, with the writer's token; the project folder's watcher
// compares what is on disk with what the store remembers, so the store's own
// write echoes as nothing, and a pull, a checkout or a teammate's edit is
// heard with no writer.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { assert } from '../../shared/core/assert';
import { APP_LIMITS, parseAppId } from '../../shared/properties/apps';
import {
  APP_DATA_DIRECTORY,
  appStorageChange,
  changedAppStorageKeys,
  nextAppStorageValues,
  parseAppStorageSource,
  serializeAppStorage,
  type AppStorageChange,
  type AppStorageValues,
} from '../../shared/properties/appStorage';

/** Where one scope's files are: the project's data folder, or this person's folder for local values. */
export type AppStorageTarget = { readonly scope: 'project' } | { readonly scope: 'local'; readonly directory: string };

export type AppStorageOutcome = { readonly applied: true } | { readonly applied: false; readonly reason: string };

export interface AppStorageStore {
  readonly get: (appId: string, target: AppStorageTarget, key: string) => string | undefined;
  readonly keys: (appId: string, target: AppStorageTarget) => readonly string[];
  /** Sets a value, or removes it for undefined; a full scope is an expected refusal, not a throw. */
  readonly set: (appId: string, target: AppStorageTarget, key: string, value: string | undefined, writer: string) => AppStorageOutcome;
  /** Starts hearing the project's data folder; the returned function stops. */
  readonly watch: () => () => void;
}

const STORAGE_LIMITS = {
  /** How long the watcher waits for a burst of file events (a pull writes many) to settle. */
  settleMs: 100,
  /** Files the watcher reads in one pass: one per installed app, and room for stray ones. */
  filesPerPassMax: APP_LIMITS.appsMax * 2,
} as const satisfies Record<string, number>;

const TEMPORARY_PREFIX = '.';

/** A person's local folder for one project, under a host's own storage root: the project is named by a digest of its path. */
export function localAppStorageDirectory(root: string, projectKey: string, personKey: string): string {
  assert(projectKey.length > 0, 'Local storage names its project');
  assert(personKey.length > 0, 'Local storage names its person');
  const project = createHash('sha256').update(projectKey).digest('hex').slice(0, 24);
  const person = createHash('sha256').update(personKey).digest('hex').slice(0, 24);
  return path.join(root, project, person);
}

/**
 * Removes an uninstalled app's values: the project's file and this person's
 * local one, as its settings go with it (appSettingsStore.ts forgetAppSettings).
 * The project file's removal commits like any other change, and Git keeps it.
 */
export function forgetAppStorage(projectRoot: string, localDirectory: string, appId: string): void {
  const name = `${parseAppId(appId)}.json`;
  for (const file of [path.join(projectRoot, APP_DATA_DIRECTORY, name), path.join(localDirectory, name)]) {
    fs.rmSync(file, { force: true });
    assert(!fs.existsSync(file), 'A forgotten app keeps no stored values');
  }
}

export function createAppStorageStore(options: {
  readonly projectRoot: string;
  readonly notify: (change: AppStorageChange) => void;
  readonly watch?: typeof fs.watch;
}): AppStorageStore {
  const { projectRoot, notify } = options;
  const watch = options.watch ?? fs.watch;
  const dataDirectory = path.join(projectRoot, APP_DATA_DIRECTORY);
  /** The last values read or written, by absolute file path. */
  const remembered = new Map<string, AppStorageValues>();
  let rearm: (() => void) | undefined;

  const fileOf = (appId: string, target: AppStorageTarget): string => {
    const name = `${parseAppId(appId)}.json`;
    const directory = target.scope === 'project' ? dataDirectory : target.directory;
    const file = path.join(directory, name);
    assert(path.dirname(file) === directory, 'A storage file sits directly in its folder');
    return file;
  };
  const read = (file: string): AppStorageValues => {
    const values = readValues(file);
    remembered.set(file, values);
    return values;
  };
  const store: AppStorageStore = {
    get: (appId, target, key) => read(fileOf(appId, target)).get(key),
    keys: (appId, target) => [...read(fileOf(appId, target)).keys()].sort(),
    set: (appId, target, key, value, writer) => {
      const file = fileOf(appId, target);
      const current = read(file);
      if (current.get(key) === value) {
        return { applied: true };
      }
      const next = nextAppStorageValues(current, key, value);
      if (!next.ok) {
        return { applied: false, reason: next.reason };
      }
      const created = !fs.existsSync(path.dirname(file));
      writeValues(file, next.values);
      remembered.set(file, next.values);
      notify(appStorageChange(appId, target.scope, [key], writer));
      // The project's data folder may have been made just now: the watcher starts hearing it.
      if (created && target.scope === 'project') {
        rearm?.();
      }
      return { applied: true };
    },
    watch: () => {
      let watcher: fs.FSWatcher | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;
      const settle = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (!stopped) {
            compare();
          }
        }, STORAGE_LIMITS.settleMs);
        timer.unref();
      };
      // Every app file against what the store remembers: a change from outside is heard without a writer.
      const compare = (): void => {
        const changes = outsideChanges(dataDirectory, remembered);
        for (const change of changes) {
          notify(change);
        }
      };
      const arm = (): void => {
        watcher?.close();
        watcher = undefined;
        // Watch the data folder when it exists; until then its parent, to hear it appear.
        const target = fs.existsSync(dataDirectory) ? dataDirectory : path.dirname(dataDirectory);
        if (!fs.existsSync(target)) {
          return;
        }
        if (target === dataDirectory) {
          rememberAll(dataDirectory, remembered);
        }
        watcher = watch(target, { recursive: false }, (_event, filename) => {
          if (stopped) {
            return;
          }
          const name = filename === null ? undefined : String(filename);
          if (target !== dataDirectory) {
            if (name === path.basename(dataDirectory)) {
              // Re-arming happens in this event's callback, not beneath itself: each call ends before the next can start.
              rearm?.();
              settle();
            }
            return;
          }
          if (name !== undefined && name.startsWith(TEMPORARY_PREFIX)) {
            return;
          }
          settle();
        });
        // The watcher only listens for outside edits; the server that owns it keeps the process
        // alive. Holding it open would keep Studio, Desktop or a test running after everything else stopped.
        watcher.unref();
      };
      rearm = arm;
      arm();
      return () => {
        stopped = true;
        clearTimeout(timer);
        watcher?.close();
        rearm = undefined;
      };
    },
  };
  return store;
}

/** The changes on disk since the store last looked, one notice per app; a file that no longer parses is skipped until it does. */
function outsideChanges(dataDirectory: string, remembered: Map<string, AppStorageValues>): readonly AppStorageChange[] {
  const changes: AppStorageChange[] = [];
  const present = new Set<string>();
  for (const file of appFiles(dataDirectory)) {
    present.add(file);
    let values: AppStorageValues;
    try {
      values = readValues(file);
    } catch {
      continue; // A file mid-merge (conflict markers) is heard again once it parses.
    }
    const keys = changedAppStorageKeys(remembered.get(file) ?? new Map(), values);
    remembered.set(file, values);
    if (keys.length > 0) {
      changes.push(appStorageChange(path.basename(file, '.json'), 'project', keys, undefined));
    }
  }
  // A file removed outright (a checkout) removes every key it held.
  for (const [file, values] of [...remembered]) {
    if (path.dirname(file) === dataDirectory && !present.has(file)) {
      remembered.delete(file);
      if (values.size > 0) {
        changes.push(appStorageChange(path.basename(file, '.json'), 'project', [...values.keys()].sort(), undefined));
      }
    }
  }
  assert(changes.length <= STORAGE_LIMITS.filesPerPassMax * 2, 'One pass notices each file at most once');
  return changes;
}

function rememberAll(dataDirectory: string, remembered: Map<string, AppStorageValues>): void {
  for (const file of appFiles(dataDirectory)) {
    if (!remembered.has(file)) {
      try {
        remembered.set(file, readValues(file));
      } catch {
        remembered.set(file, new Map());
      }
    }
  }
}

// The app files in the data folder: `<id>.json` for a valid id, bounded per pass.
function appFiles(dataDirectory: string): readonly string[] {
  let names: readonly string[];
  try {
    names = fs.readdirSync(dataDirectory);
  } catch (error: unknown) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
  const files: string[] = [];
  for (const name of names) {
    if (files.length >= STORAGE_LIMITS.filesPerPassMax) {
      break;
    }
    if (!name.endsWith('.json') || name.startsWith(TEMPORARY_PREFIX)) {
      continue;
    }
    try {
      parseAppId(name.slice(0, -'.json'.length));
    } catch {
      continue;
    }
    files.push(path.join(dataDirectory, name));
  }
  return files;
}

function readValues(file: string): AppStorageValues {
  let source: string;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error: unknown) {
    if (isMissing(error)) {
      return new Map();
    }
    throw error;
  }
  return parseAppStorageSource(source);
}

function writeValues(file: string, values: AppStorageValues): void {
  const source = serializeAppStorage(values);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `${TEMPORARY_PREFIX}${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporary, source, { flag: 'wx' });
    fs.renameSync(temporary, file);
  } catch (error: unknown) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  assert(fs.readFileSync(file, 'utf8') === source, 'Stored values read back as written');
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
