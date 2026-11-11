// Project files as apps read and write them (shared/properties/appFiles.ts holds
// the contract): one module for Desktop's main process (electron/handlers/
// appFilesHandlers.ts) and the Studio server (studio/src/features/apps/
// appsServer.ts), so both refuse the same paths and keep the same budget.
//
// How a path is checked: the contract's parser refuses traversal, absolute
// paths and the refused folders by name; here the deepest part of the path that
// exists is resolved to its real path, which must still be inside the project's
// real path and must pass the same refusals, so a symbolic link cannot lead out
// of the project, into `.git/`, or into another app's folder.
//
// How a write lands: through the host's own writer (`writeFile`), which is the
// editor's save path on Desktop (the document actors) and an atomic write the
// Studio server's watcher hears. Every change answers with the states its paths
// held before and after, which the editor keeps as one undo step and restores
// with a `restore` operation.
import fs from 'node:fs';
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import {
  APP_FILE_LIMITS,
  appFilePathRefusal,
  type AppFileAnswer,
  type AppFileContent,
  type AppFileEntry,
  type AppFileListing,
  type AppFileOperation,
  type AppFileState,
} from '../../shared/properties/appFiles';
import { appsFailureMessage, type AppsResult } from '../../shared/properties/apps';

/** How a host writes one file: its save path. `text` is the bytes as UTF-8 when they are text. */
export type AppFileWriter = (absolute: string, bytes: Uint8Array, text: string | undefined) => void;

/** Each app's writes in the last minute, for the per-minute budget. */
export interface AppFileBudget {
  /** Counts one change of `bytes` for the app, or throws (an expected failure) when the minute's budget is spent. */
  readonly spend: (appId: string, bytes: number) => void;
}

export function createAppFileBudget(now: () => number): AppFileBudget {
  const spent = new Map<string, { atMs: number; bytes: number }[]>();
  return {
    spend: (appId, bytes) => {
      assert(bytes >= 0, 'A write spends a nonnegative number of bytes');
      const nowMs = now();
      const recent = (spent.get(appId) ?? []).filter((entry) => nowMs - entry.atMs < APP_FILE_LIMITS.budgetWindowMs);
      if (recent.length >= APP_FILE_LIMITS.writesPerMinuteMax) {
        throw new Error(`An app may change at most ${APP_FILE_LIMITS.writesPerMinuteMax} files a minute; try again shortly`);
      }
      const bytesSpent = recent.reduce((total, entry) => total + entry.bytes, 0);
      if (bytesSpent + bytes > APP_FILE_LIMITS.writeBytesPerMinuteMax) {
        throw new Error(`An app may write at most ${APP_FILE_LIMITS.writeBytesPerMinuteMax} bytes a minute; try again shortly`);
      }
      recent.push({ atMs: nowMs, bytes });
      spent.delete(appId);
      spent.set(appId, recent);
      // The oldest app's record goes first: the map holds at most one entry per installed app.
      for (const key of spent.keys()) {
        if (spent.size <= APP_FILE_LIMITS.budgetAppsMax) {
          break;
        }
        spent.delete(key);
      }
      assert(recent.length <= APP_FILE_LIMITS.writesPerMinuteMax, 'The budget window is bounded');
    },
  };
}

/**
 * Runs one file operation for `appId` in the project at `projectRoot`. Expected
 * failures (a refused path, a missing file, a spent budget) are a message; a
 * broken invariant throws.
 */
export function runAppFileOperation(
  projectRoot: string,
  appId: string,
  operation: AppFileOperation,
  host: { readonly budget: AppFileBudget; readonly writeFile: AppFileWriter },
): AppsResult<AppFileAnswer> {
  try {
    const root = fs.realpathSync(projectRoot);
    return { ok: true, value: dispatch(root, appId, operation, host) };
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('Assertion failed')) {
      throw error;
    }
    return { ok: false, message: appsFailureMessage(error) };
  }
}

function dispatch(
  root: string,
  appId: string,
  operation: AppFileOperation,
  host: { readonly budget: AppFileBudget; readonly writeFile: AppFileWriter },
): AppFileAnswer {
  switch (operation.kind) {
    case 'list':
      return { kind: 'listing', listing: listFolder(root, appId, operation.dir) };
    case 'read':
      return { kind: 'content', content: readFile(root, appId, operation.path) };
    case 'write': {
      const bytes = operation.encoding === 'base64' ? Buffer.from(operation.content, 'base64') : Buffer.from(operation.content, 'utf8');
      if (bytes.byteLength > APP_FILE_LIMITS.fileBytesMax) {
        throw new Error(`A file an app writes is at most ${APP_FILE_LIMITS.fileBytesMax} bytes`);
      }
      const target = resolveInside(root, appId, operation.path);
      if (isDirectory(target)) {
        throw new Error(`${operation.path} is a folder`);
      }
      host.budget.spend(appId, bytes.byteLength);
      return change(root, appId, [...missingParents(root, operation.path), operation.path], () => {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        host.writeFile(target, bytes, operation.encoding === 'utf8' ? operation.content : textOf(bytes));
      });
    }
    case 'delete': {
      const target = resolveInside(root, appId, operation.path);
      const stats = lstatOf(target);
      if (stats === undefined) {
        throw new Error(`${operation.path} does not exist`);
      }
      if (stats.isDirectory() && fs.readdirSync(target).length > 0) {
        throw new Error(`${operation.path} is a folder with files in it; delete its files first`);
      }
      host.budget.spend(appId, 0);
      return change(root, appId, [operation.path], () => removePath(target));
    }
    case 'move': {
      const source = resolveInside(root, appId, operation.from);
      const target = resolveInside(root, appId, operation.to);
      if (!lstatOf(source)?.isFile()) {
        throw new Error(`${operation.from} is not a file; apps move one file at a time`);
      }
      if (lstatOf(target) !== undefined) {
        throw new Error(`${operation.to} already exists`);
      }
      host.budget.spend(appId, 0);
      return change(root, appId, [operation.from, ...missingParents(root, operation.to), operation.to], () => {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(source, target);
      });
    }
    case 'mkdir': {
      const target = resolveInside(root, appId, operation.path);
      const existing = lstatOf(target);
      if (existing !== undefined && !existing.isDirectory()) {
        throw new Error(`${operation.path} is a file`);
      }
      host.budget.spend(appId, 0);
      return change(root, appId, [...missingParents(root, operation.path), ...(existing === undefined ? [operation.path] : [])], () => {
        fs.mkdirSync(target, { recursive: true });
      });
    }
    case 'restore':
      // The person's undo or redo: it puts back what a change found, so it is not the app's to budget.
      return change(
        root,
        appId,
        operation.states.map((state) => state.path),
        () => restoreStates(root, appId, operation.states, host.writeFile),
      );
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}

// A change: the states of its paths before, the work, and the states after.
function change(root: string, appId: string, paths: readonly string[], work: () => void): AppFileAnswer {
  assert(paths.length <= APP_FILE_LIMITS.restorePathsMax, 'A change touches a bounded number of paths');
  const before = paths.map((relative) => stateOf(root, appId, relative));
  work();
  const after = paths.map((relative) => stateOf(root, appId, relative));
  assert(before.length === after.length, 'A change records each path before and after');
  return { kind: 'changed', change: { paths, before, after } };
}

/**
 * Puts each path back to a state: folders and files are made shallowest first,
 * and removed deepest first, so a folder exists before its file and empties
 * before it goes.
 */
function restoreStates(root: string, appId: string, states: readonly AppFileState[], writeFile: AppFileWriter): void {
  const depth = (state: AppFileState): number => state.path.split('/').length;
  const removals = states.filter((state) => state.kind === 'absent').sort((left, right) => depth(right) - depth(left));
  const creations = states.filter((state) => state.kind !== 'absent').sort((left, right) => depth(left) - depth(right));
  assert(removals.length + creations.length === states.length, 'Every state is restored once');
  for (const state of removals) {
    const target = resolveInside(root, appId, state.path);
    const stats = lstatOf(target);
    if (stats?.isDirectory() === true && fs.readdirSync(target).length > 0) {
      throw new Error(`${state.path} now holds other files; it was left as it is`);
    }
    if (stats !== undefined) {
      removePath(target);
    }
  }
  for (const state of creations) {
    const target = resolveInside(root, appId, state.path);
    if (state.kind === 'directory') {
      fs.mkdirSync(target, { recursive: true });
    } else if (state.kind === 'file') {
      const bytes = Buffer.from(state.base64, 'base64');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      writeFile(target, bytes, textOf(bytes));
    }
  }
}

// The folders above `relative` that do not exist yet, shallowest first: a write makes them, and its undo removes them.
function missingParents(root: string, relative: string): readonly string[] {
  const segments = relative.split('/');
  const missing: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    const parent = segments.slice(0, index).join('/');
    if (lstatOf(path.join(root, parent)) === undefined) {
      missing.push(parent);
    }
  }
  assert(missing.length < APP_FILE_LIMITS.pathSegmentsMax, 'Missing parents are bounded by the path depth');
  return missing;
}

function stateOf(root: string, appId: string, relative: string): AppFileState {
  const target = resolveInside(root, appId, relative);
  const stats = lstatOf(target);
  if (stats === undefined) {
    return { path: relative, kind: 'absent' };
  }
  if (stats.isDirectory()) {
    return { path: relative, kind: 'directory' };
  }
  assert(stats.size <= APP_FILE_LIMITS.fileBytesMax * 2, 'A file an app changed is near the file bound');
  if (stats.size > APP_FILE_LIMITS.fileBytesMax) {
    throw new Error(`${relative} exceeds ${APP_FILE_LIMITS.fileBytesMax} bytes; apps change only files within the bound`);
  }
  return { path: relative, kind: 'file', base64: fs.readFileSync(target).toString('base64') };
}

function listFolder(root: string, appId: string, relative: string): AppFileListing {
  const folder = relative === '' ? root : resolveInside(root, appId, relative);
  if (!isDirectory(folder)) {
    throw new Error(`${relative} is not a folder`);
  }
  const entries: AppFileEntry[] = [];
  let truncated = false;
  const names = fs.readdirSync(folder, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1));
  for (const entry of names) {
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
    // Links are left out: what they lead to is checked only when an app names it.
    if (entry.isSymbolicLink() || appFilePathRefusal(child, appId) !== undefined) {
      continue;
    }
    if (entries.length >= APP_FILE_LIMITS.listEntriesMax) {
      truncated = true;
      break;
    }
    if (entry.isDirectory()) {
      entries.push({ path: child, kind: 'directory', sizeBytes: 0 });
    } else if (entry.isFile()) {
      const sizeBytes = fs.statSync(path.join(folder, entry.name)).size;
      entries.push({ path: child, kind: 'file', sizeBytes: Math.min(sizeBytes, APP_FILE_LIMITS.fileBytesMax) });
    }
  }
  assert(entries.length <= APP_FILE_LIMITS.listEntriesMax, 'A listing is bounded');
  return { entries, truncated };
}

function readFile(root: string, appId: string, relative: string): AppFileContent {
  const target = resolveInside(root, appId, relative);
  const stats = lstatOf(target);
  if (stats === undefined || !stats.isFile()) {
    throw new Error(`${relative} is not a file`);
  }
  if (stats.size > APP_FILE_LIMITS.fileBytesMax) {
    throw new Error(`${relative} exceeds ${APP_FILE_LIMITS.fileBytesMax} bytes`);
  }
  const bytes = fs.readFileSync(target);
  const text = textOf(bytes);
  return text === undefined
    ? { path: relative, encoding: 'base64', content: bytes.toString('base64'), sizeBytes: bytes.byteLength }
    : { path: relative, encoding: 'utf8', content: text, sizeBytes: bytes.byteLength };
}

/**
 * The absolute path of `relative`, after checking its real path: the deepest
 * part that exists resolves inside the project's real path, and the path it
 * resolves to passes the same refusals as the path named.
 */
function resolveInside(root: string, appId: string, relative: string): string {
  const segments = relative.split('/');
  let existing = root;
  let rest: string[] = segments;
  for (let index = segments.length; index > 0; index -= 1) {
    const candidate = path.join(root, ...segments.slice(0, index));
    if (lstatOf(candidate) !== undefined) {
      existing = candidate;
      rest = segments.slice(index);
      break;
    }
  }
  const real = fs.realpathSync(existing);
  const resolved = path.join(real, ...rest);
  const inside = path.relative(root, resolved);
  if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new Error(`${relative} leads outside the project`);
  }
  const refusal = appFilePathRefusal(inside.split(path.sep).join('/'), appId);
  if (refusal !== undefined) {
    throw new Error(refusal);
  }
  assert(resolved.startsWith(root + path.sep), 'A resolved app path is inside the project');
  return resolved;
}

function removePath(target: string): void {
  const stats = lstatOf(target);
  assert(stats !== undefined, 'Only an existing path is removed');
  if (stats.isDirectory()) {
    fs.rmdirSync(target);
  } else {
    fs.unlinkSync(target);
  }
}

function lstatOf(target: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(target);
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return undefined;
    }
    throw error;
  }
}

function isDirectory(target: string): boolean {
  return lstatOf(target)?.isDirectory() === true;
}

// The bytes as text when they are valid UTF-8 without NUL; undefined for binary.
function textOf(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) {
    return undefined;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
