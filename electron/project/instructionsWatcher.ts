// Live updates for the Instructions panel: the project's Markdown lives at its
// root and in dot folders (`.claude/`, `.cursor/`) that the source watcher
// (projectWatcher.ts) never looks at, so this watches the project itself and
// sends `instructions:changed` with the project-relative files a burst touched.
// The app's own saves are skipped (`isSelfWrite`): the panel already holds what
// it wrote. `.stacki/instructions.json` is announced too, Git checkouts
// included, because it decides what the panel lists.
//
// Recursive watching is cheap where the operating system offers it (macOS and
// Windows). Elsewhere Node walks every folder, node_modules included, so there
// only the root and the agents' own folders are watched; a doc deeper in the
// tree then shows on the panel's next listing (it lists again on focus).
import fs from 'fs';
import path from 'path';
import { assert } from '../../shared/core/assert';
import { INSTRUCTIONS_FILE, SKIPPED_DIRECTORIES, isInstructionFileName } from '../../shared/properties/instructions';

/** The part of `fs.watch` this uses; the filename is checked where it is read. */
export type WatchFolder = (folder: string, options: { readonly recursive: boolean }, listener: (event: string, filename: unknown) => void) => { close(): void };

interface InstructionsWatchDeps {
  readonly projectPath: string;
  readonly send: (channel: string, payload: unknown) => void;
  readonly isSelfWrite: (absolutePath: string) => boolean;
  readonly noteExternalChange: (absolutePath: string) => void;
  readonly platform?: NodeJS.Platform;
  readonly watch?: WatchFolder;
}

/** Files one announcement names; a larger burst (a checkout) names none, which means "list again". */
const FILES_PER_ANNOUNCEMENT_MAX = 200;
const DEBOUNCE_MS = 150;
/** The folders watched where watching is not recursive: where agents keep their files. */
const SHALLOW_FOLDERS = ['.claude', '.agents', '.cursor', '.github', '.codex', '.gemini', 'docs'];

export function watchInstructions({
  projectPath,
  send,
  isSelfWrite,
  noteExternalChange,
  platform = process.platform,
  watch = fs.watch,
}: InstructionsWatchDeps): { readonly close: () => void } {
  assert(path.isAbsolute(projectPath), 'watchInstructions: the project path is absolute');
  const watchers: { close(): void }[] = [];
  const files = new Set<string>();
  let overflow = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const announce = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (closed) {
        return;
      }
      send('instructions:changed', { files: overflow ? [] : [...files] });
      files.clear();
      overflow = false;
    }, DEBOUNCE_MS);
  };
  const heard = (base: string, filename: unknown): void => {
    if (closed) {
      return;
    }
    if (typeof filename !== 'string' && !Buffer.isBuffer(filename)) {
      // The system coalesced a change without naming it: list again.
      overflow = true;
      announce();
      return;
    }
    const relative = [base, filename.toString().split(path.sep).join('/')].filter((part) => part !== '').join('/');
    if (!concerns(relative)) {
      return;
    }
    const absolute = path.join(projectPath, ...relative.split('/'));
    if (isSelfWrite(absolute)) {
      return;
    }
    noteExternalChange(absolute);
    if (files.size < FILES_PER_ANNOUNCEMENT_MAX) {
      files.add(relative);
    } else {
      overflow = true;
    }
    announce();
  };
  const recursive = platform === 'darwin' || platform === 'win32';
  try {
    if (recursive) {
      watchers.push(watch(projectPath, { recursive: true }, (_event, filename) => heard('', filename)));
    } else {
      watchers.push(watch(projectPath, { recursive: false }, (_event, filename) => heard('', filename)));
      for (const folder of SHALLOW_FOLDERS) {
        const absolute = path.join(projectPath, folder);
        if (fs.existsSync(absolute)) {
          watchers.push(watch(absolute, { recursive: true }, (_event, filename) => heard(folder, filename)));
        }
      }
    }
  } catch (error: unknown) {
    for (const watcher of watchers) {
      watcher.close();
    }
    throw error;
  }
  return {
    close: () => {
      closed = true;
      clearTimeout(timer);
      files.clear();
      for (const watcher of watchers) {
        watcher.close();
      }
    },
  };
}

/** Whether a changed path is one the panel lists, a folder that may hold some, or its settings. */
export function concerns(relative: string): boolean {
  assert(!relative.startsWith('/'), 'A watched path is project-relative');
  if (relative === INSTRUCTIONS_FILE) {
    return true;
  }
  const segments = relative.split('/');
  if (segments.some((segment) => SKIPPED_DIRECTORIES.has(segment))) {
    return false;
  }
  const name = segments[segments.length - 1] ?? '';
  if (name === '') {
    return false;
  }
  if (isInstructionFileName(name, segments.slice(0, -1).join('/'))) {
    return true;
  }
  // A name without an extension may be a folder created, renamed or removed.
  return !name.includes('.');
}
