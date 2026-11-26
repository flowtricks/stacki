// The open project's files, for component, path, class and variable suggestions and for the type checker's roots. A
// bounded walk that skips dependencies, build output and hidden folders and never follows a folder link (so a linked
// workspace cannot loop it). A recursive watch says what changed; where a system cannot watch, the walk is repeated
// after a few seconds instead.
import * as fs from 'node:fs';
import { CODE_INTEL_LIMITS } from '../../../shared/ipc/codeIntel';
import { assert } from '../../../shared/core/assert';
import { slashed } from './paths';

const SKIPPED_FOLDERS: ReadonlySet<string> = new Set(['node_modules', 'dist', 'build', 'coverage', 'release', 'bower_components', 'vendor']);
const REWALK_UNWATCHED_MS = 5_000;
/** Changed files remembered one by one; past this every file is read again. */
const CHANGES_REMEMBERED_MAX = 500;

export interface ProjectFiles {
  /** Absolute, forward-slashed. */
  readonly files: readonly string[];
  readonly folders: ReadonlySet<string>;
  /** Folder → the names inside it. */
  readonly children: ReadonlyMap<string, readonly FolderEntry[]>;
  /** False when a bound stopped the walk. */
  readonly complete: boolean;
}

export interface FolderEntry {
  readonly name: string;
  readonly folder: boolean;
}

export interface ProjectIndex {
  readonly root: string;
  /** The files as they are now; walked on first use and again after a change that added, removed or renamed one. */
  readonly files: () => ProjectFiles;
  /** Rises whenever anything under the project changed. */
  readonly generation: () => number;
  /** The files changed since the last call, or `all` when they were too many to name. */
  readonly takeChanges: () => readonly string[] | 'all';
  readonly dispose: () => void;
}

export function createProjectIndex(root: string, clock: () => number = Date.now): ProjectIndex {
  const base = slashed(root).replace(/\/+$/, '');
  let walked: ProjectFiles | undefined;
  let walkedAtMs = 0;
  let generation = 0;
  let changes: string[] | 'all' = [];
  const noted = (relative: string | undefined, event: string): void => {
    if (relative !== undefined && ignoredChange(relative)) {
      return;
    }
    generation += 1;
    if (relative === undefined) {
      changes = 'all';
      walked = undefined;
      return;
    }
    if (event === 'rename') {
      walked = undefined;
    }
    if (changes !== 'all') {
      changes.push(`${base}/${relative}`);
      if (changes.length > CHANGES_REMEMBERED_MAX) {
        changes = 'all';
      }
    }
  };
  const watcher = watchFolder(base, noted);
  return {
    root: base,
    files: () => {
      const stale = watcher === undefined && clock() - walkedAtMs > REWALK_UNWATCHED_MS;
      if (walked === undefined || stale) {
        walked = walk(base);
        walkedAtMs = clock();
        if (stale) {
          generation += 1;
          changes = 'all';
        }
      }
      return walked;
    },
    generation: () => generation,
    takeChanges: () => {
      const taken = changes;
      changes = [];
      return taken;
    },
    dispose: () => watcher?.close(),
  };
}

function ignoredChange(relative: string): boolean {
  // `.astro` is where Astro writes the project's generated types, so its changes are read.
  const parts = relative.split('/');
  return parts.some((part) => part === '.git' || part === 'node_modules' || part === 'dist');
}

function watchFolder(root: string, noted: (relative: string | undefined, event: string) => void): fs.FSWatcher | undefined {
  try {
    const watcher = fs.watch(root, { recursive: true, persistent: false }, (event, file) => {
      noted(typeof file === 'string' ? slashed(file) : undefined, event);
    });
    // A watched folder that goes away reports an error; the walk that follows finds it gone.
    watcher.on('error', () => noted(undefined, 'rename'));
    return watcher;
  } catch {
    return undefined;
  }
}

function walk(root: string): ProjectFiles {
  const files: string[] = [];
  const folders = new Set<string>([root]);
  const children = new Map<string, FolderEntry[]>();
  let complete = true;
  const pending: Array<{ readonly folder: string; readonly depth: number }> = [{ folder: root, depth: 0 }];
  // Breadth first, so a bound cuts the deepest folders rather than whole later siblings.
  for (let next = 0; next < pending.length; next++) {
    assert(next < CODE_INTEL_LIMITS.indexDirectoriesMax, 'The walk stays within its folder bound');
    const current = pending[next];
    assert(current !== undefined, 'A queued folder exists');
    const entries: FolderEntry[] = [];
    children.set(current.folder, entries);
    for (const entry of readFolder(current.folder)) {
      const absolute = `${current.folder}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIPPED_FOLDERS.has(entry.name) || entry.name.startsWith('.')) {
          continue;
        }
        entries.push({ name: entry.name, folder: true });
        folders.add(absolute);
        if (current.depth < CODE_INTEL_LIMITS.indexDepthMax && pending.length < CODE_INTEL_LIMITS.indexDirectoriesMax) {
          pending.push({ folder: absolute, depth: current.depth + 1 });
        } else {
          complete = false;
        }
      } else if (entry.isFile() && entry.name !== '.DS_Store') {
        if (files.length >= CODE_INTEL_LIMITS.indexFilesMax) {
          complete = false;
          continue;
        }
        entries.push({ name: entry.name, folder: false });
        files.push(absolute);
      }
    }
  }
  return { files, folders, children, complete };
}

function readFolder(folder: string): readonly fs.Dirent[] {
  try {
    return fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    // Gone or unreadable: it holds nothing to suggest.
    return [];
  }
}
