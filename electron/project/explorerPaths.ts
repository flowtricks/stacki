// Where a Files panel path lands on disk, and whether the panel may touch it (docs/contracts.md, "Files panel").
//
// The renderer's paths are already spelled inside the project (shared/ipc/fileExplorer.ts). This module resolves them
// against the project's real location, so a symbolic link cannot carry a read or a write out of it:
//
//   read      the path's real location (every link followed) must lie inside the project's real location;
//   folder    the same, it must be a folder, and it must not be `.git` or `.stacki/io` (a create or a move lands there);
//   entry     the entry itself, never followed (a rename, move, copy source or trash acts on a link, not what it points
//             at): its parent must pass `folder`, and the entry must not be protected or the project root.
//
// Real paths come from `realpathSync.native`, which also answers with the case the disk stores, so a comparison on a
// case-insensitive disk is a comparison of the same spelling.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert } from '../../shared/core/assert';
import { err, ok } from '../../shared/core/result';
import {
  baseName,
  explorerError,
  explorerSegments,
  isProtectedPath,
  parentPath,
  toExplorerPath,
  type ExplorerPath,
  type ExplorerResult,
} from '../../shared/ipc/fileExplorer';
import { isPathWithin, sameFilesystemPath } from '../lib/platform';
import { errorCode } from './projectWalk';

export interface ExplorerRoot {
  /** The project folder as the app opened it. */
  readonly lexical: string;
  /** The same folder with every link resolved. */
  readonly real: string;
}

export interface ResolvedPath {
  /** The path as spelled under the project folder. */
  readonly absolute: string;
  /** Its real location, inside the project's. */
  readonly real: string;
  readonly stats: fs.Stats;
}

export interface ResolvedEntry {
  /** The entry as it sits in its parent's real folder: a link here is the link itself. */
  readonly absolute: string;
  readonly parentReal: string;
  readonly name: string;
  readonly stats: fs.Stats;
}

/** The open project, when `projectPath` names it; any other folder is refused, whatever the renderer believes is open. */
export function explorerRoot(projectPath: string, openProject: string | undefined): ExplorerResult<ExplorerRoot> {
  if (openProject === undefined) {
    return err(explorerError('not-open'));
  }
  if (!sameFilesystemPath(projectPath, openProject)) {
    return err(explorerError('not-open'));
  }
  try {
    const real = fs.realpathSync.native(openProject);
    assert(path.isAbsolute(real), 'explorerRoot: a real path is absolute');
    return ok({ lexical: path.resolve(openProject), real });
  } catch (error: unknown) {
    return err(explorerError('missing', { detail: errorCode(error) }));
  }
}

/** The path as spelled under the project folder; nothing on disk is consulted. */
export function lexicalPath(root: ExplorerRoot, target: ExplorerPath): string {
  const absolute = path.join(root.lexical, ...explorerSegments(target));
  assert(isPathWithin(root.lexical, absolute), 'lexicalPath: a checked spelling stays inside the project');
  return absolute;
}

/** The project path of a real location inside the project, or undefined for one outside it. */
export function explorerPathOfReal(root: ExplorerRoot, real: string): ExplorerPath | undefined {
  if (!isPathWithin(root.real, real)) {
    return undefined;
  }
  const relative = path.relative(root.real, real);
  try {
    return toExplorerPath(relative.split(path.sep).join('/'));
  } catch {
    return undefined;
  }
}

/** Reading a file or listing a folder: the real location must be inside the project. Protected folders are readable. */
export function resolveForRead(root: ExplorerRoot, target: ExplorerPath): ExplorerResult<ResolvedPath> {
  const absolute = lexicalPath(root, target);
  let real: string;
  try {
    real = fs.realpathSync.native(absolute);
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return err(explorerError('missing'));
    }
    if (code === 'ELOOP') {
      return err(explorerError('outside'));
    }
    return err(explorerError('filesystem', { detail: code }));
  }
  if (!isPathWithin(root.real, real)) {
    return err(explorerError('outside'));
  }
  try {
    return ok({ absolute, real, stats: fs.statSync(real) });
  } catch (error: unknown) {
    return err(explorerError('filesystem', { detail: errorCode(error) }));
  }
}

/** A folder something is created in or placed into: readable, a folder, and neither spelled nor resolving into a protected one. */
export function resolveFolderTarget(root: ExplorerRoot, target: ExplorerPath): ExplorerResult<ResolvedPath> {
  if (isProtectedPath(target)) {
    return err(explorerError('protected'));
  }
  const resolved = resolveForRead(root, target);
  if (!resolved.ok) {
    return resolved;
  }
  if (!resolved.value.stats.isDirectory()) {
    return err(explorerError('not-directory'));
  }
  const real = explorerPathOfReal(root, resolved.value.real);
  assert(real !== undefined, 'resolveFolderTarget: a resolved folder lies inside the project');
  if (isProtectedPath(real)) {
    return err(explorerError('protected'));
  }
  return resolved;
}

/** An entry acted on as itself (renamed, moved, copied, trashed): not the root, not protected, its parent a usable folder. */
export function resolveEntry(root: ExplorerRoot, target: ExplorerPath): ExplorerResult<ResolvedEntry> {
  const parent = parentPath(target);
  if (parent === undefined) {
    return err(explorerError('protected'));
  }
  if (isProtectedPath(target)) {
    return err(explorerError('protected'));
  }
  const folder = resolveFolderTarget(root, parent);
  if (!folder.ok) {
    return folder;
  }
  const name = baseName(target);
  const absolute = path.join(folder.value.real, name);
  const own = explorerPathOfReal(root, absolute);
  if (own === undefined) {
    return err(explorerError('outside'));
  }
  if (isProtectedPath(own)) {
    return err(explorerError('protected'));
  }
  try {
    return ok({ absolute, parentReal: folder.value.real, name, stats: fs.lstatSync(absolute) });
  } catch (error: unknown) {
    const code = errorCode(error);
    return err(code === 'ENOENT' ? explorerError('missing') : explorerError('filesystem', { detail: code }));
  }
}

/** Whether two `lstat` results are one entry on disk: a case-only rename on a disk that ignores case finds itself. */
export function sameDiskEntry(first: string, second: string): boolean {
  try {
    const left = fs.lstatSync(first, { bigint: true });
    const right = fs.lstatSync(second, { bigint: true });
    return left.dev === right.dev && left.ino === right.ino && left.ino !== 0n;
  } catch {
    return false;
  }
}

/** Whether anything, a broken link included, sits at `absolute`. */
export function occupied(absolute: string): boolean {
  try {
    fs.lstatSync(absolute);
    return true;
  } catch {
    return false;
  }
}
