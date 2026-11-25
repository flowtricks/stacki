// Folders handed to Stacki from outside the app: dropped on its icon (macOS `open-file`, which a Dock drop
// sends once Info.plist declares folders, package.json build.mac.extendInfo), named on the command line at
// launch, or named by a second launch on Windows and Linux (`second-instance`). Also the window drop's own
// check of a path the renderer names (shared/ipc/folderOpen.ts).
//
// Why a queue: macOS sends `open-file` before the app is ready when the drop is what launched it, and a
// folder can arrive while the window is reloading (leaving one project for another). Neither has a page to
// tell. The queue holds those folders until the renderer says it listens (`project:takeOpenedFolders`), and
// holds again from the moment the window starts loading a new page, so nothing is sent into a page that is
// going away. It is bounded, and a folder already waiting is not queued twice.
//
// Why main decides what a path is: the renderer's path comes from drag data, which a page could forge. Main
// stats it here, refuses a file, a missing path and a loop of links, and only then classifies the folder.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { assert } from '../../shared/core/assert';
import { BOUNDARY_LIMITS } from '../../shared/core/boundary';
import { err, ok, type Result } from '../../shared/core/result';
import { defaultAstroCopyName } from '../../shared/ipc/astroCopy';
import { FOLDER_OPEN_LIMITS, type FolderOpenChoice, type FolderRejection } from '../../shared/ipc/folderOpen';
import { classifySiteFolder } from './plainSiteScan';
import { errorCode } from '../documents/atomicWrite';

/** The three file-system reads the check makes, so a test can stand in for the disk. */
export interface FolderFileSystem {
  readonly lstat: (target: string) => { isSymbolicLink(): boolean };
  readonly realpath: (target: string) => string;
  readonly stat: (target: string) => { isDirectory(): boolean };
}

const NODE_FILE_SYSTEM: FolderFileSystem = {
  lstat: (target) => fs.lstatSync(target),
  realpath: (target) => fs.realpathSync.native(target),
  stat: (target) => fs.statSync(target),
};

/**
 * The folder at `candidate`, or why it is not one. A link is followed and its target is what opens; a link
 * that points nowhere is `missing`, and a loop of links is `unreadable`. The answer is absolute and resolved.
 */
export function inspectFolderPath(candidate: string, system: FolderFileSystem = NODE_FILE_SYSTEM): Result<string, FolderRejection> {
  if (candidate.length === 0) {
    return err('unreadable');
  }
  if (candidate.length > BOUNDARY_LIMITS.pathLengthMax) {
    return err('unreadable');
  }
  if (candidate.includes('\0')) {
    return err('unreadable');
  }
  if (!path.isAbsolute(candidate)) {
    return err('unreadable');
  }
  const resolved = path.resolve(candidate);
  let linked: boolean;
  try {
    linked = system.lstat(resolved).isSymbolicLink();
  } catch (error: unknown) {
    return err(rejectionFor(error));
  }
  let real: string;
  try {
    // Also what finds a loop of links above the folder itself (ELOOP).
    real = system.realpath(resolved);
  } catch (error: unknown) {
    return err(rejectionFor(error));
  }
  let directory: boolean;
  try {
    directory = system.stat(real).isDirectory();
  } catch (error: unknown) {
    return err(rejectionFor(error));
  }
  if (!directory) {
    return err('notFolder');
  }
  const folder = linked ? real : resolved;
  assert(path.isAbsolute(folder), 'inspectFolderPath: the folder is absolute');
  return ok(folder);
}

/** What "Open from folder" makes of `folder`, a folder `inspectFolderPath` accepted. */
export function siteFolderChoice(folder: string): Exclude<FolderOpenChoice, { readonly kind: 'rejected' }> {
  assert(path.isAbsolute(folder), 'siteFolderChoice: an absolute folder');
  assert(path.resolve(folder) === folder, 'siteFolderChoice: a resolved folder');
  const kind = classifySiteFolder(folder);
  switch (kind) {
    case 'astro':
      return { kind, projectPath: folder };
    case 'plainWebsite':
      return { kind, sourcePath: folder, parentPath: path.dirname(folder), name: defaultAstroCopyName(path.basename(folder)), homePath: os.homedir() };
    case 'notWebsite':
      return { kind, folderPath: folder };
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** The whole answer for one path: refused, or classified. */
export function folderOpenChoice(candidate: string, system: FolderFileSystem = NODE_FILE_SYSTEM): FolderOpenChoice {
  const inspected = inspectFolderPath(candidate, system);
  if (inspected.ok) {
    return siteFolderChoice(inspected.value);
  }
  return { kind: 'rejected', reason: inspected.error };
}

/**
 * The folder paths in a launch's arguments. `skip` is how many leading arguments are the program itself:
 * one for a packaged app, two in development (Electron and the app's folder). Switches (`--flag`, macOS's
 * `-psn_…`) are left out, a Linux launcher's `file://` URL becomes its path, and a relative path is read
 * from `workingDirectory`. Whether each one is a folder is `inspectFolderPath`'s question, not this one's.
 */
export function launchFolderArguments(argv: readonly string[], options: { readonly skip: number; readonly workingDirectory: string }): readonly string[] {
  assert(Number.isSafeInteger(options.skip), 'launchFolderArguments: skip is an integer');
  assert(options.skip >= 0, 'launchFolderArguments: skip is not negative');
  const candidates: string[] = [];
  for (const argument of argv.slice(options.skip, options.skip + FOLDER_OPEN_LIMITS.argumentsMax)) {
    if (argument.length === 0) {
      continue;
    }
    if (argument.startsWith('-')) {
      continue;
    }
    const local = localPath(argument);
    if (local !== undefined) {
      candidates.push(path.resolve(options.workingDirectory, local));
    }
  }
  assert(candidates.length <= FOLDER_OPEN_LIMITS.argumentsMax, 'launchFolderArguments: bounded by the argument limit');
  return candidates;
}

/** What happened to one folder handed to the queue. */
export type FolderArrival = 'delivered' | 'queued' | 'duplicate' | 'full';

export interface FolderOpenQueue {
  /** A folder arrived: sent at once while the renderer listens, held otherwise. */
  readonly add: (folder: string) => FolderArrival;
  /** The renderer listens from now on: the folders held so far, oldest first, and the queue is empty. */
  readonly take: () => readonly string[];
  /** The page is going away (a reload, a crash, a closed window): hold folders until the next take. */
  readonly hold: () => void;
  /** Whether a renderer listens: what decides between sending a folder and making a window for it. */
  readonly listening: () => boolean;
}

/** The queue. `deliver` sends one folder to a renderer that listens; it is never called while holding. */
export function createFolderOpenQueue(deliver: (folder: string) => void): FolderOpenQueue {
  let state: 'holding' | 'listening' = 'holding';
  let pending: string[] = [];
  return {
    add: (folder) => {
      assert(folder.length > 0, 'FolderOpenQueue.add: a path');
      if (state === 'listening') {
        assert(pending.length === 0, 'FolderOpenQueue: nothing is held while the renderer listens');
        deliver(folder);
        return 'delivered';
      }
      if (pending.includes(folder)) {
        return 'duplicate';
      }
      if (pending.length < FOLDER_OPEN_LIMITS.queueMax) {
        pending = [...pending, folder];
        return 'queued';
      }
      return 'full';
    },
    take: () => {
      const taken = pending;
      pending = [];
      state = 'listening';
      assert(taken.length <= FOLDER_OPEN_LIMITS.queueMax, 'FolderOpenQueue.take: bounded by the queue limit');
      return taken;
    },
    hold: () => {
      state = 'holding';
    },
    listening: () => state === 'listening',
  };
}

// A launcher's file URL as a path; any other URL is not a folder Stacki was handed.
function localPath(argument: string): string | undefined {
  if (argument.startsWith('file://')) {
    try {
      return fileURLToPath(argument);
    } catch {
      return undefined;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(argument)) {
    return undefined;
  }
  return argument;
}

function rejectionFor(error: unknown): FolderRejection {
  const code = errorCode(error);
  if (code === 'ENOENT') {
    return 'missing';
  }
  if (code === 'ENOTDIR') {
    // A file stands where a folder of the path should be.
    return 'missing';
  }
  return 'unreadable';
}
