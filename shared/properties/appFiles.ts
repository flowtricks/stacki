// Project files as an app reads and writes them (`stacki.files.*`, docs/apps.md
// "Project files"). This module is the contract both hosts share: which paths an
// app may name, every bound, the params of each call, and the answers that cross
// IPC or HTTP. The file system work itself is electron/project/appFilesStore.ts,
// one module for Desktop's main process and the Studio server.
//
// What an app may never name, whatever its role:
// - a path that climbs out of the project, is absolute, or holds `.`, `..`,
//   empty segments, backslashes or NUL;
// - `.git/` and `node_modules/` anywhere in the path: Git's own state and
//   installed packages are not the project's source;
// - `.env` files: the project's own secrets, which an app reads through its
//   settings instead;
// - `.stacki/apps/` outside the app's own folder (the lockfile, the settings
//   file, other apps' bundles), and other apps' stored data in
//   `.stacki/app-data/`.
// The same rules run again on the real path once symbolic links resolve, so a
// link cannot lead out of the project or into a refused folder.
import { assert } from '../core/assert';
import { record, text } from '../core/boundary';
import { toArray } from '../core/record';
import { APPS_DIRECTORY, parseAppId } from './apps';

export const APP_FILE_LIMITS = {
  /** One file an app reads or writes: the editor's own editable file bound (MAIN_LIMITS.editableFileBytesMax). */
  fileBytesMax: 5 * 1024 * 1024,
  /** Entries one `files.list` answers with; past it, `truncated` is true. */
  listEntriesMax: 1000,
  /** A project path an app names. */
  pathCharsMax: 512,
  /** Segments in one project path. */
  pathSegmentsMax: 32,
  /** Writes, deletes, moves and folder creations one app may make in a minute. */
  writesPerMinuteMax: 120,
  /** Bytes one app may write in a minute. */
  writeBytesPerMinuteMax: 32 * 1024 * 1024,
  /** The window the two budgets above count over. */
  budgetWindowMs: 60_000,
  /** Paths one undo step restores: a move touches two, a folder creation one per new folder. */
  restorePathsMax: 40,
  /**
   * The before and after states one undo step may hold, in base64 characters. The editor keeps
   * LIMITS.undoEntriesMax steps; at this bound they hold at most a few hundred MiB in the worst case,
   * and a change past it is made without an undo step (the editor says so).
   */
  undoSnapshotCharsMax: 4 * 1024 * 1024,
  /** Apps whose write budgets one host tracks at once (APP_LIMITS.appsMax). */
  budgetAppsMax: 50,
} as const satisfies Record<string, number>;

export const APP_FILE_ENCODINGS = ['utf8', 'base64'] as const;
export type AppFileEncoding = (typeof APP_FILE_ENCODINGS)[number];

/** One entry of a folder, as `files.list` answers it. */
export interface AppFileEntry {
  /** Relative to the project, `/`-separated. */
  readonly path: string;
  readonly kind: 'file' | 'directory';
  /** A file's size; 0 for a folder. */
  readonly sizeBytes: number;
}

export interface AppFileListing {
  readonly entries: readonly AppFileEntry[];
  /** Whether the folder held more than APP_FILE_LIMITS.listEntriesMax entries. */
  readonly truncated: boolean;
}

/** A file's content: UTF-8 text when it is valid text, else base64. */
export interface AppFileContent {
  readonly path: string;
  readonly encoding: AppFileEncoding;
  readonly content: string;
  readonly sizeBytes: number;
}

/** What one path held before or after a change: what an undo step puts back. */
export type AppFileState =
  | { readonly path: string; readonly kind: 'absent' }
  | { readonly path: string; readonly kind: 'directory' }
  | { readonly path: string; readonly kind: 'file'; readonly base64: string };

/** A change an app made: the paths it touched, and their states before and after, for one undo step. */
export interface AppFileChange {
  readonly paths: readonly string[];
  readonly before: readonly AppFileState[];
  readonly after: readonly AppFileState[];
}

/** A file call as it crosses to the host's store: the app it is for, and what it does. */
export type AppFileOperation =
  | { readonly kind: 'list'; readonly dir: string }
  | { readonly kind: 'read'; readonly path: string }
  | { readonly kind: 'write'; readonly path: string; readonly content: string; readonly encoding: AppFileEncoding }
  | { readonly kind: 'delete'; readonly path: string }
  | { readonly kind: 'move'; readonly from: string; readonly to: string }
  | { readonly kind: 'mkdir'; readonly path: string }
  /** Undo or redo of an earlier change: the person's step, so it does not count against the app's budget. */
  | { readonly kind: 'restore'; readonly states: readonly AppFileState[] };

/** What the store answers for each operation. */
export type AppFileAnswer =
  | { readonly kind: 'listing'; readonly listing: AppFileListing }
  | { readonly kind: 'content'; readonly content: AppFileContent }
  | { readonly kind: 'changed'; readonly change: AppFileChange };

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SEGMENT_FORBIDDEN = /[\\\0:*?"<>|]/;

/**
 * A project path an app names: relative, `/`-separated, bounded, never climbing
 * and never into a refused folder for `appId` (the header). `''` (the project
 * root) only where `allowRoot` says so: `files.list` of the whole project. An
 * undefined `appId` checks only what holds for every app: the RPC's params
 * parser runs before it knows which app asks.
 */
export function parseAppFilePath(input: unknown, appId: string | undefined, options: { readonly allowRoot: boolean }): string {
  const raw = text(input);
  const path = raw.replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (path === '' || path === '.') {
    if (options.allowRoot) {
      return '';
    }
    throw new Error('path names a file or folder in the project');
  }
  if (path.length > APP_FILE_LIMITS.pathCharsMax) {
    throw new Error(`path is at most ${APP_FILE_LIMITS.pathCharsMax} characters`);
  }
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    throw new Error('path is relative to the project, not absolute');
  }
  const segments = path.split('/');
  if (segments.length > APP_FILE_LIMITS.pathSegmentsMax) {
    throw new Error('path is nested too deeply');
  }
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error('path names a file without ., .. or empty segments');
    }
    if (SEGMENT_FORBIDDEN.test(segment) || /[\u0000-\u001f]/.test(segment)) {
      throw new Error(`"${segment.slice(0, 40)}" is not a file name an app may use`);
    }
  }
  const refusal = appFilePathRefusal(path, appId);
  if (refusal !== undefined) {
    throw new Error(refusal);
  }
  assert(!path.startsWith('/'), 'An app file path is relative');
  assert(!segments.includes('..'), 'An app file path never climbs');
  return path;
}

/**
 * Why an app may not touch a well-formed project path, or undefined when it may.
 * Run on the path as named and again on its real path (appFilesStore.ts).
 */
export function appFilePathRefusal(path: string, appId: string | undefined): string | undefined {
  const segments = path.split('/');
  if (segments.some((segment) => segment.toLowerCase() === '.git')) {
    return 'Apps cannot read or change Git’s own files (.git/)'; // i18n-ignore: refusal returned to the app over the SDK for its developer.
  }
  if (segments.some((segment) => segment === 'node_modules')) {
    return 'Apps cannot read or change installed packages (node_modules/)'; // i18n-ignore: refusal returned to the app over the SDK for its developer.
  }
  const name = segments[segments.length - 1] ?? '';
  if (/^\.env(?:\..*)?$/i.test(name)) {
    return 'Apps cannot read or change the project’s .env secrets; use app settings'; // i18n-ignore: refusal returned to the app over the SDK for its developer.
  }
  if (appId === undefined) {
    return undefined;
  }
  const id = parseAppId(appId);
  const appsPrefix = `${APPS_DIRECTORY}/`;
  if (path === APPS_DIRECTORY) {
    return 'Apps can reach only their own folder in .stacki/apps/'; // i18n-ignore: refusal returned to the app over the SDK for its developer.
  }
  if (path.startsWith(appsPrefix)) {
    const owner = path.slice(appsPrefix.length).split('/')[0];
    if (owner !== id) {
      return 'Apps can reach only their own folder in .stacki/apps/'; // i18n-ignore: refusal returned to the app over the SDK for its developer.
    }
  }
  const dataPrefix = '.stacki/app-data/';
  if (path.startsWith(dataPrefix) && path !== `${dataPrefix}${id}.json`) {
    return 'Apps cannot read or change another app’s stored data; use stacki.storage'; // i18n-ignore: refusal returned to the app over the SDK for its developer.
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Params, as the RPC parses them (appsRpc.ts APP_METHODS)
// ---------------------------------------------------------------------------

/** `files.write`'s content: bounded, and base64 only when it is base64. */
export function parseAppFileContent(content: unknown, encoding: unknown): { readonly content: string; readonly encoding: AppFileEncoding } {
  const parsedEncoding = encoding === undefined ? 'utf8' : APP_FILE_ENCODINGS.find((known) => known === encoding);
  if (parsedEncoding === undefined) {
    throw new Error('encoding is utf8 or base64');
  }
  const value = text(content);
  if (parsedEncoding === 'base64') {
    if (value.length > Math.ceil(APP_FILE_LIMITS.fileBytesMax / 3) * 4) {
      throw new Error(`content exceeds ${APP_FILE_LIMITS.fileBytesMax} bytes`);
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
      throw new Error('content is not base64');
    }
    return { content: value, encoding: 'base64' };
  }
  // A UTF-8 character is at most 3 bytes per UTF-16 unit; the store checks the exact size.
  if (value.length > APP_FILE_LIMITS.fileBytesMax) {
    throw new Error(`content exceeds ${APP_FILE_LIMITS.fileBytesMax} bytes`);
  }
  return { content: value, encoding: 'utf8' };
}

/**
 * The params of a file method as the RPC sees them, before the app id is known:
 * paths are checked for shape here and for the app's own refusals by
 * `parseAppFileOperation`, which the dispatcher runs with the app's id.
 */
export function parseFilePathShape(input: unknown, options: { readonly allowRoot: boolean }): string {
  return parseAppFilePath(input, undefined, options);
}

/** An operation crossing to the store, every path checked for `appId`. */
export function parseAppFileOperation(input: unknown, appId: string): AppFileOperation {
  const value = record(input);
  switch (value['kind']) {
    case 'list':
      return { kind: 'list', dir: parseAppFilePath(value['dir'], appId, { allowRoot: true }) };
    case 'read':
      return { kind: 'read', path: parseAppFilePath(value['path'], appId, { allowRoot: false }) };
    case 'write':
      return { kind: 'write', path: parseAppFilePath(value['path'], appId, { allowRoot: false }), ...parseAppFileContent(value['content'], value['encoding']) };
    case 'delete':
      return { kind: 'delete', path: parseAppFilePath(value['path'], appId, { allowRoot: false }) };
    case 'move': {
      const from = parseAppFilePath(value['from'], appId, { allowRoot: false });
      const to = parseAppFilePath(value['to'], appId, { allowRoot: false });
      if (from === to) {
        throw new Error('from and to name the same path');
      }
      return { kind: 'move', from, to };
    }
    case 'mkdir':
      return { kind: 'mkdir', path: parseAppFilePath(value['path'], appId, { allowRoot: false }) };
    case 'restore': {
      const states = parseAppFileStates(value['states'], appId);
      if (states.length === 0) {
        throw new Error('An undo step restores at least one path');
      }
      return { kind: 'restore', states };
    }
    default:
      throw new Error('A file operation is list, read, write, delete, move, mkdir or restore');
  }
}

/** The states an undo step restores, each path checked for `appId`. */
export function parseAppFileStates(input: unknown, appId: string): readonly AppFileState[] {
  const items = toArray(input);
  if (items === undefined || items.length > APP_FILE_LIMITS.restorePathsMax) {
    throw new Error(`A change names at most ${APP_FILE_LIMITS.restorePathsMax} paths`);
  }
  return items.map((item) => parseAppFileState(item, appId));
}

function parseAppFileState(input: unknown, appId: string): AppFileState {
  const value = record(input);
  const path = parseAppFilePath(value['path'], appId, { allowRoot: false });
  switch (value['kind']) {
    case 'absent':
      return { path, kind: 'absent' };
    case 'directory':
      return { path, kind: 'directory' };
    case 'file':
      return { path, kind: 'file', base64: parseAppFileContent(value['base64'], 'base64').content };
    default:
      throw new Error('A file state is absent, directory or file');
  }
}

// ---------------------------------------------------------------------------
// Answers, as they come back over IPC or HTTP
// ---------------------------------------------------------------------------

/** A store's answer, checked against the operation that asked for it. */
export function parseAppFileAnswer(input: unknown, appId: string): AppFileAnswer {
  const value = record(input);
  switch (value['kind']) {
    case 'listing':
      return { kind: 'listing', listing: parseListing(value['listing'], appId) };
    case 'content':
      return { kind: 'content', content: parseContent(value['content'], appId) };
    case 'changed':
      return { kind: 'changed', change: parseChange(value['change'], appId) };
    default:
      throw new Error('A file answer is a listing, content or a change');
  }
}

function parseListing(input: unknown, appId: string): AppFileListing {
  const value = record(input);
  const items = toArray(value['entries']);
  if (items === undefined || items.length > APP_FILE_LIMITS.listEntriesMax) {
    throw new Error('A listing holds a bounded list of entries');
  }
  if (typeof value['truncated'] !== 'boolean') {
    throw new Error('A listing says whether it was cut');
  }
  const entries = items.map((item): AppFileEntry => {
    const entry = record(item);
    const kind = entry['kind'] === 'file' || entry['kind'] === 'directory' ? entry['kind'] : undefined;
    if (kind === undefined) {
      throw new Error('An entry is a file or a directory');
    }
    return { path: parseAppFilePath(entry['path'], appId, { allowRoot: false }), kind, sizeBytes: sizeOf(entry['sizeBytes']) };
  });
  return { entries, truncated: value['truncated'] };
}

function parseContent(input: unknown, appId: string): AppFileContent {
  const value = record(input);
  const parsed = parseAppFileContent(value['content'], value['encoding']);
  return { path: parseAppFilePath(value['path'], appId, { allowRoot: false }), ...parsed, sizeBytes: sizeOf(value['sizeBytes']) };
}

function parseChange(input: unknown, appId: string): AppFileChange {
  const value = record(input);
  const paths = toArray(value['paths']);
  if (paths === undefined || paths.length > APP_FILE_LIMITS.restorePathsMax) {
    throw new Error('A change names a bounded list of paths');
  }
  return {
    paths: paths.map((path) => parseAppFilePath(path, appId, { allowRoot: false })),
    before: parseAppFileStates(value['before'], appId),
    after: parseAppFileStates(value['after'], appId),
  };
}

function sizeOf(input: unknown): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0 || input > APP_FILE_LIMITS.fileBytesMax) {
    throw new Error('A size is a whole number of bytes within the file bound');
  }
  return input;
}
