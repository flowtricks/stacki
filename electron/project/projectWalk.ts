// A folder walk that cannot loop, crash or stall on the shapes real projects have.
//
// Why: every scan used to recurse with `readdirSync`, which (a) throws on the first folder
// it may not read, so one `chmod 000` stopped the whole project from opening, (b) never
// followed a symlink, so a linked shared folder was invisible, and (c) would recurse forever
// if it did follow one that points at an ancestor. This walker reports what it could not read as
// data, follows links, and ends by construction: each real folder is opened once (the
// `visited` set holds real paths), so the work is bounded by the size of the tree itself and
// no fixed cap is needed. It is iterative, so a deep tree cannot exhaust the call stack.
//
// How: `walkFolder` visits every file and folder under `root` in directory order, a folder
// before its children, and returns the problems it met. A visitor returns `'skip'` for a
// folder to leave it unopened.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSync, type SlicedWork } from '../lib/slicedWork';

export type WalkProblemKind = 'unreadable-folder' | 'unreadable-link' | 'link-cycle' | 'missing';

export interface WalkProblem {
  readonly kind: WalkProblemKind;
  /** Absolute path as the walk reached it (through any links). */
  readonly path: string;
  /** The system error code (`EACCES`), or `ELOOP` for a link that points back into the walk. */
  readonly code: string;
}

export interface WalkEntry {
  readonly kind: 'file' | 'directory';
  /** Absolute path as the walk reached it. */
  readonly path: string;
  readonly name: string;
  /** Whether the entry is a symbolic link (its `kind` is what the link points at). */
  readonly linked: boolean;
}

export type WalkVerdict = 'descend' | 'skip';

interface Frame {
  readonly folder: string;
  readonly entries: readonly fs.Dirent[];
  next: number;
}

/** The system error code of a thrown value, or `UNKNOWN`. */
export function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'UNKNOWN';
}

/**
 * Walks `root`, calling `visit` for each file and folder. A folder the visitor answers
 * `'skip'` to is not opened. Returns what could not be read; never throws for the tree's contents.
 */
export function walkFolder(root: string, visit: (entry: WalkEntry) => WalkVerdict | undefined): readonly WalkProblem[] {
  return runSync(walkFolderSliced(root, visit));
}

/** The same walk as a generator that yields after each entry, so a long scan can give the event loop a turn (lib/slicedWork.ts). */
export function* walkFolderSliced(root: string, visit: (entry: WalkEntry) => WalkVerdict | undefined): SlicedWork<readonly WalkProblem[]> {
  const problems: WalkProblem[] = [];
  const visited = new Set<string>();
  const frames: Frame[] = [];

  const open = (folder: string): void => {
    let real: string;
    try {
      real = fs.realpathSync(folder);
    } catch (error: unknown) {
      problems.push({ kind: 'missing', path: folder, code: errorCode(error) });
      return;
    }
    if (visited.has(real)) {
      problems.push({ kind: 'link-cycle', path: folder, code: 'ELOOP' });
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch (error: unknown) {
      problems.push({ kind: 'unreadable-folder', path: folder, code: errorCode(error) });
      return;
    }
    visited.add(real);
    frames.push({ folder, entries, next: 0 });
  };

  open(root);
  // Each pass consumes one entry or retires one frame, and a frame exists once per real folder.
  while (frames.length > 0) {
    const frame = frames[frames.length - 1];
    if (frame === undefined) {
      break;
    }
    const entry = frame.entries[frame.next];
    frame.next += 1;
    if (entry === undefined) {
      frames.pop();
      yield;
      continue;
    }
    const full = path.join(frame.folder, entry.name);
    const resolved = resolveEntry(entry, full, problems);
    if (resolved === undefined) {
      continue;
    }
    const verdict = visit({ kind: resolved, path: full, name: entry.name, linked: entry.isSymbolicLink() });
    if (resolved === 'directory' && verdict !== 'skip') {
      open(full);
    }
  }
  return problems;
}

// What an entry is, following a link; undefined for anything else (sockets, broken links).
function resolveEntry(entry: fs.Dirent, full: string, problems: WalkProblem[]): 'file' | 'directory' | undefined {
  if (entry.isDirectory()) {
    return 'directory';
  }
  if (entry.isFile()) {
    return 'file';
  }
  if (entry.isSymbolicLink()) {
    try {
      const target = fs.statSync(full);
      return target.isDirectory() ? 'directory' : target.isFile() ? 'file' : undefined;
    } catch (error: unknown) {
      problems.push({ kind: 'unreadable-link', path: full, code: errorCode(error) });
      return undefined;
    }
  }
  return undefined;
}
