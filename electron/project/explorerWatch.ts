// The Files panel's live view of the disk: one non-recursive watcher per folder the panel shows (the expanded ones and
// the open file's), so a change anywhere, dot-folders and `.git` included, refreshes exactly the folders it touched,
// and a huge collapsed folder such as `node_modules` costs nothing. The project watcher (projectWatcher.ts) is a
// different reader with different needs (it ignores the app's own saves and anything outside `src/` and `public/`);
// this one hears every change, the app's included, because a tree must show what is on disk.
//
// Bounds: at most `watchDirectoriesMax` folders (the request is refused past it at the boundary); events are
// coalesced per folder for `EVENT_SETTLE_MS`, so a burst (a git checkout, an install) sends one message.
import * as fs from 'node:fs';
import { assert } from '../../shared/core/assert';
import { FILE_EXPLORER_LIMITS, type ExplorerPath } from '../../shared/ipc/fileExplorer';
import { resolveForRead, type ExplorerRoot } from './explorerPaths';

const EVENT_SETTLE_MS = 120;

export interface ExplorerWatch {
  /** Follows exactly `directories` of `root` from now on; answers how many could be watched. */
  readonly follow: (root: ExplorerRoot, directories: readonly ExplorerPath[]) => number;
  readonly close: () => void;
}

export function createExplorerWatch(
  send: (directories: readonly ExplorerPath[]) => void,
  watch: (directory: string, listener: () => void) => fs.FSWatcher = (directory, listener) => fs.watch(directory, { persistent: false }, listener),
): ExplorerWatch {
  const watchers = new Map<ExplorerPath, fs.FSWatcher>();
  const changed = new Set<ExplorerPath>();
  let rootKey: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = (): void => {
    timer = undefined;
    if (changed.size === 0) {
      return;
    }
    const directories = [...changed];
    changed.clear();
    send(directories);
  };
  const heard = (directory: ExplorerPath): void => {
    changed.add(directory);
    timer ??= setTimeout(flush, EVENT_SETTLE_MS);
  };
  const stop = (key: ExplorerPath): void => {
    watchers.get(key)?.close();
    watchers.delete(key);
  };
  const close = (): void => {
    for (const key of [...watchers.keys()]) {
      stop(key);
    }
    changed.clear();
    clearTimeout(timer);
    timer = undefined;
    rootKey = undefined;
  };

  const follow = (root: ExplorerRoot, directories: readonly ExplorerPath[]): number => {
    assert(directories.length <= FILE_EXPLORER_LIMITS.watchDirectoriesMax, 'explorerWatch: the folders are bounded');
    if (rootKey !== root.real) {
      close();
      rootKey = root.real;
    }
    const wanted = new Set(directories);
    for (const key of [...watchers.keys()]) {
      if (!wanted.has(key)) {
        stop(key);
      }
    }
    for (const directory of wanted) {
      if (watchers.has(directory)) {
        continue;
      }
      const resolved = resolveForRead(root, directory);
      if (!resolved.ok || !resolved.value.stats.isDirectory()) {
        continue;
      }
      try {
        const watcher = watch(resolved.value.real, () => heard(directory));
        // A folder removed under its watcher reports an error; the panel hears its parent change instead.
        watcher.on('error', () => stop(directory));
        watchers.set(directory, watcher);
      } catch {
        // Past the system's watcher limit, or unreadable: the folder still refreshes on the panel's own reads.
      }
    }
    assert(watchers.size <= FILE_EXPLORER_LIMITS.watchDirectoriesMax, 'explorerWatch: the watchers are bounded');
    return watchers.size;
  };
  return { follow, close };
}
