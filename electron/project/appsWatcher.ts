// Hears `.stacki/apps/` change, so the Installed list follows the folder within
// about a second (docs/apps.md, "Apps added as a folder"): an app copied in, an
// agent writing a bundle, a pull, a removed folder, an edited manifest. Part of
// the project watcher (projectWatcher.ts), closed with it.
//
// A burst of events (an agent writes many files; a pull writes many more) is
// waited out for `settleMs`, then the folders' stamps (appScan.ts) are compared
// with the last ones, and `apps:foldersChanged` names the folders that moved. The
// stamps, not the event's file name, decide: macOS may coalesce an event and name
// no file, and an app's own write (an install) must be heard too, so its frame
// reloads on its new files.
import fs from 'node:fs';
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import { APPS_DIRECTORY } from '../../shared/properties/apps';
import { APP_FOLDER_LIMITS, changedAppFolders, type AppFoldersChange, type AppFolderStamps } from '../../shared/properties/appFolders';
import { readAppFolderStamps } from './appScan';

export interface AppsWatcherDeps {
  readonly projectPath: string;
  readonly send: (channel: 'apps:foldersChanged', payload: AppFoldersChange) => void;
  readonly watch?: typeof fs.watch;
  /** Runs `run` after `delayMs`; returns the cancel. Tests pass a fake clock. */
  readonly schedule?: (delayMs: number, run: () => void) => () => void;
  /** The stamps now; tests may pass a fake disk. */
  readonly readStamps?: (projectPath: string) => AppFolderStamps;
}

const defaultSchedule = (delayMs: number, run: () => void): (() => void) => {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
};

/** Starts hearing `.stacki/apps/`; undefined when the project has no `.stacki` folder yet (its first save re-arms the watch). */
export function watchAppFolders(deps: AppsWatcherDeps): { readonly close: () => void } | undefined {
  const directory = path.join(deps.projectPath, '.stacki');
  if (!fs.existsSync(directory)) {
    return undefined;
  }
  const watch = deps.watch ?? fs.watch;
  const listener = createAppFoldersListener(deps);
  // Recursive over `.stacki`, not `.stacki/apps`: the apps folder may be created after the watch starts.
  const watcher = watch(directory, { recursive: true }, (_event, filename) => listener.heard(filename ? String(filename) : undefined));
  return {
    close: () => {
      listener.close();
      watcher.close();
    },
  };
}

/** The debounce and comparison, apart from the operating system's watcher, for tests. */
export function createAppFoldersListener(deps: AppsWatcherDeps): { readonly heard: (name: string | undefined) => void; readonly close: () => void } {
  const schedule = deps.schedule ?? defaultSchedule;
  const readStamps = deps.readStamps ?? readAppFolderStamps;
  const appsPrefix = path.relative('.stacki', APPS_DIRECTORY);
  let last = readStamps(deps.projectPath);
  let cancel: (() => void) | undefined;
  let closed = false;
  const settle = (): void => {
    cancel = undefined;
    if (closed) {
      return;
    }
    const next = readStamps(deps.projectPath);
    const change = changedAppFolders(last, next);
    last = next;
    if (change.any) {
      assert(change.folders.length <= APP_FOLDER_LIMITS.entriesMax * 2, 'A change names a bounded set of folders');
      deps.send('apps:foldersChanged', { folders: change.folders });
    }
  };
  return {
    heard: (name) => {
      if (closed) {
        return;
      }
      // Another part of `.stacki` (folders.json, the generated preview) is not the apps folder.
      if (name !== undefined) {
        if (!isUnder(appsPrefix, name)) {
          return;
        }
      }
      cancel?.();
      cancel = schedule(APP_FOLDER_LIMITS.settleMs, settle);
    },
    close: () => {
      closed = true;
      cancel?.();
      cancel = undefined;
    },
  };
}

// Whether a name `fs.watch` reported under `.stacki` is the apps folder or inside it.
function isUnder(prefix: string, name: string): boolean {
  if (name === prefix) {
    return true;
  }
  return name.startsWith(`${prefix}/`) || name.startsWith(`${prefix}${path.sep}`);
}
