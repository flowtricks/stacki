// The Files panel's contract (docs/contracts.md, "Files panel"): what the renderer may ask main to list, read, write,
// create, rename, move, copy, trash, import, reveal, find and watch in the open project, and the shapes of the answers.
//
// Every path that crosses is an `ExplorerPath`: project-relative, `/`-separated, with no empty, `.` or `..` segment, no
// backslash and no control character, so no path the renderer sends can climb out of the project by its spelling. Main
// still resolves each one against the project's real location (symbolic links, case) before it touches the disk; this
// module only proves the spelling. The project root itself is the empty path.
//
// Expected failures are values (`Result` with an `ExplorerError`): a file that went missing, a name taken, a refusal to
// touch `.git`. A payload that breaks these shapes is a programmer error and throws at the boundary. Errors carry a code
// and, for a filesystem failure, the system's error code (`EACCES`), never a path or a file's bytes, so nothing that
// reaches a log or a toast can carry a secret's contents.
import { assert } from '../core/assert';
import { boolean, count, digest, list, object, optional, pathText, record, text, type Parser } from '../core/boundary';
import type { Brand, Digest } from '../core/brand';
import { err, ok, type Result } from '../core/result';

export const FILE_EXPLORER_LIMITS = {
  /** Entries one folder listing returns, folders first; a folder with more reports its total beside these. */
  listEntriesMax: 5_000,
  /** UTF-16 units of one file or folder name: every common filesystem stops at 255. */
  nameCharsMax: 255,
  /** Segments of one project-relative path. */
  pathSegmentsMax: 128,
  /** UTF-16 units of one project-relative path. */
  pathCharsMax: 4_096,
  /** Bytes a file may have and still open as text in the editor. */
  textBytesMax: 8 * 1024 * 1024,
  /** Bytes read from the start of a file to tell text from binary (a NUL byte there means binary). */
  sniffBytesMax: 8 * 1024,
  /** Items one move, copy, trash or import may name. */
  batchItemsMax: 1_000,
  /** Files and folders one copy may create, counted before it starts. */
  copyEntriesMax: 20_000,
  /** Bytes one copy may write, counted before it starts. */
  copyBytesMax: 2 * 1024 * 1024 * 1024,
  /** Folders the panel follows for live changes at once: the expanded ones and the open file's. */
  watchDirectoriesMax: 512,
  /** UTF-16 units of a find query. */
  queryCharsMax: 200,
  /** Paths one find returns. */
  findResultsMax: 200,
  /** Entries one find visits before it stops and says it is partial. */
  findVisitedMax: 100_000,
  /** Names one collision answer lists. */
  collisionNamesMax: 50,
  /** Numbered names tried for a free "copy" name before the copy is refused. */
  copyNameAttemptsMax: 1_000,
} as const satisfies Record<string, number>;

/** A project-relative path whose spelling cannot leave the project; `''` is the project root. */
export type ExplorerPath = Brand<string, 'ExplorerPath'>;

export const EXPLORER_ROOT = toExplorerPath('');

/** Builds an `ExplorerPath` after checking every segment; throws on a spelling that is not one. */
export function toExplorerPath(value: string): ExplorerPath {
  assert(value.length <= FILE_EXPLORER_LIMITS.pathCharsMax, 'An explorer path is within its length bound');
  if (value === '') {
    return value as ExplorerPath;
  }
  const segments = value.split('/');
  assert(segments.length <= FILE_EXPLORER_LIMITS.pathSegmentsMax, 'An explorer path is within its segment bound');
  for (const segment of segments) {
    const problem = segmentProblem(segment);
    if (problem !== undefined) {
      throw new Error(`Explorer path: ${problem}`);
    }
  }
  return value as ExplorerPath;
}

/** The wire parser: a string, bounded, that `toExplorerPath` accepts. */
export function parseExplorerPath(input: unknown): ExplorerPath {
  const value = pathText(input);
  if (value.length > FILE_EXPLORER_LIMITS.pathCharsMax) {
    throw new Error('Explorer path exceeds its length bound');
  }
  if (value !== '' && value.split('/').length > FILE_EXPLORER_LIMITS.pathSegmentsMax) {
    throw new Error('Explorer path exceeds its segment bound');
  }
  return toExplorerPath(value);
}

// What is wrong with one segment's spelling, whatever the platform; undefined when nothing is.
function segmentProblem(segment: string): string | undefined {
  if (segment === '') {
    return 'empty segment';
  }
  if (segment === '.' || segment === '..') {
    return 'relative segment';
  }
  if (segment.includes('\\')) {
    return 'backslash';
  }
  if (CONTROL_CHARACTERS.test(segment)) {
    return 'control character';
  }
  if (segment.length > FILE_EXPLORER_LIMITS.nameCharsMax) {
    return 'segment exceeds the name bound';
  }
  return undefined;
}

// The control range is exactly what a name may not hold.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function explorerSegments(path: ExplorerPath): readonly string[] {
  return path === '' ? [] : path.split('/');
}

/** The path of `name` inside `parent`. */
export function childPath(parent: ExplorerPath, name: string): ExplorerPath {
  assert(name.length > 0, 'A child has a name');
  assert(!name.includes('/'), 'A child name is one segment');
  return toExplorerPath(parent === '' ? name : `${parent}/${name}`);
}

/** The folder that holds `path`; undefined for the project root. */
export function parentPath(path: ExplorerPath): ExplorerPath | undefined {
  if (path === '') {
    return undefined;
  }
  const slash = path.lastIndexOf('/');
  return toExplorerPath(slash < 0 ? '' : path.slice(0, slash));
}

/** The last segment of `path`; the empty string for the root. */
export function baseName(path: ExplorerPath): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Whether `candidate` is `ancestor` or lies inside it. */
export function isWithinPath(ancestor: ExplorerPath, candidate: ExplorerPath): boolean {
  if (ancestor === '') {
    return true;
  }
  return candidate === ancestor || candidate.startsWith(`${ancestor}/`);
}

/** `path` with its `from` prefix replaced by `to` (a rename or move of `from` carries what is inside it). */
export function rebasePath(path: ExplorerPath, from: ExplorerPath, to: ExplorerPath): ExplorerPath {
  assert(isWithinPath(from, path), 'Only a path inside the moved entry is rebased');
  assert(from !== '', 'The project root never moves');
  return toExplorerPath(`${to}${path.slice(from.length)}`);
}

/**
 * Whether `.git` or Stacki's write staging holds `path`. Both are listed and readable like any dot-folder (the panel
 * hides nothing), but never written, renamed, moved, deleted or placed into from the panel: git's own files are git's
 * to change, and `.stacki/io` holds the document actors' locks and staged writes. Compared without case, because
 * macOS and Windows folders usually ignore it.
 */
export function isProtectedPath(path: ExplorerPath): boolean {
  const segments = explorerSegments(path).map((segment) => segment.toLowerCase());
  const first = segments[0];
  if (first === '.git') {
    return true;
  }
  return first === '.stacki' && segments[1] === 'io';
}

// ---------------------------------------------------------------------------
// Names a person types (new file, new folder, rename)
// ---------------------------------------------------------------------------

export const ENTRY_NAME_PROBLEMS = ['empty', 'reserved', 'separator', 'control', 'too-long', 'whitespace', 'windows-character', 'windows-name'] as const;
export type EntryNameProblem = (typeof ENTRY_NAME_PROBLEMS)[number];

/** Windows refuses these whole names, with or without an extension (`CON`, `nul.txt`). */
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const WINDOWS_CHARACTERS = /[<>:"|?*]/;

/** What makes `name` unusable as a new file or folder name on `platform`; undefined when it is usable. */
export function entryNameProblem(name: string, platform: string): EntryNameProblem | undefined {
  if (name.length === 0) {
    return 'empty';
  }
  if (name === '.' || name === '..') {
    return 'reserved';
  }
  if (name.includes('/') || name.includes('\\')) {
    return 'separator';
  }
  if (CONTROL_CHARACTERS.test(name)) {
    return 'control';
  }
  if (name.length > FILE_EXPLORER_LIMITS.nameCharsMax) {
    return 'too-long';
  }
  if (name.trim() !== name) {
    return 'whitespace';
  }
  if (platform === 'win32') {
    if (WINDOWS_CHARACTERS.test(name)) {
      return 'windows-character';
    }
    if (WINDOWS_DEVICE_NAME.test(name) || name.endsWith('.')) {
      return 'windows-name';
    }
  }
  return undefined;
}

/** The wire parser for a typed name: refused unless it is usable on every platform's common ground. */
export function parseEntryName(input: unknown): string {
  const name = text(input);
  const problem = entryNameProblem(name, 'posix');
  if (problem !== undefined) {
    throw new Error(`Entry name: ${problem}`);
  }
  return name;
}

// ---------------------------------------------------------------------------
// Listings
// ---------------------------------------------------------------------------

/**
 * What one entry of a folder is. A link is followed only when it leads inside the project (`link-directory`,
 * `link-file`); one that leads out (`link-outside`) is listed but never opened, expanded or written through, and one
 * that leads nowhere is `link-broken`. `other` is a socket, a device or a pipe: listed, never opened.
 */
export const EXPLORER_ENTRY_KINDS = ['directory', 'file', 'link-directory', 'link-file', 'link-outside', 'link-broken', 'other'] as const;
export type ExplorerEntryKind = (typeof EXPLORER_ENTRY_KINDS)[number];

export interface ExplorerEntry {
  readonly name: string;
  readonly kind: ExplorerEntryKind;
}

export interface ExplorerListing {
  readonly path: ExplorerPath;
  /** Folders first, then files, each in natural order (`file2` before `file10`), at most `listEntriesMax`. */
  readonly entries: readonly ExplorerEntry[];
  /** Everything the folder holds, dotfiles included: more than `entries` holds when the folder passes the bound. */
  readonly totalCount: number;
}

/** Whether an entry of this kind can be expanded like a folder. */
export function isFolderKind(kind: ExplorerEntryKind): boolean {
  return kind === 'directory' || kind === 'link-directory';
}

/** Whether an entry of this kind can be opened like a file. */
export function isFileKind(kind: ExplorerEntryKind): boolean {
  return kind === 'file' || kind === 'link-file';
}

// One collator for every host, so main's truncation and the renderer's order agree.
const NATURAL_ORDER = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Folders first, then the rest, each in natural order; ties by code unit, so the order is total. */
export function compareEntries(left: ExplorerEntry, right: ExplorerEntry): number {
  const leftFolder = isFolderKind(left.kind) ? 0 : 1;
  const rightFolder = isFolderKind(right.kind) ? 0 : 1;
  if (leftFolder !== rightFolder) {
    return leftFolder - rightFolder;
  }
  const natural = NATURAL_ORDER.compare(left.name, right.name);
  if (natural !== 0) {
    return natural;
  }
  if (left.name === right.name) {
    return 0;
  }
  return left.name < right.name ? -1 : 1;
}

function parseEntryKind(input: unknown): ExplorerEntryKind {
  const found = EXPLORER_ENTRY_KINDS.find((kind) => kind === input);
  if (found === undefined) {
    throw new Error('Explorer entry: unknown kind');
  }
  return found;
}

export function parseExplorerEntry(input: unknown): ExplorerEntry {
  const value = record(input);
  const name = text(value['name']);
  if (name.includes('/') || segmentProblem(name) !== undefined) {
    throw new Error('Explorer entry: the name is not one segment');
  }
  return { name, kind: parseEntryKind(value['kind']) };
}

export function parseExplorerListing(input: unknown): ExplorerListing {
  const value = record(input);
  const entries = list(parseExplorerEntry)(value['entries']);
  if (entries.length > FILE_EXPLORER_LIMITS.listEntriesMax) {
    throw new Error('Explorer listing exceeds its entry bound');
  }
  const totalCount = count(value['totalCount']);
  if (totalCount < entries.length) {
    throw new Error('Explorer listing: the total is below the entries it holds');
  }
  return { path: parseExplorerPath(value['path']), entries, totalCount };
}

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

export const EXPLORER_MEDIA_KINDS = ['image', 'video', 'audio'] as const;
export type ExplorerMediaKind = (typeof EXPLORER_MEDIA_KINDS)[number];

// By extension: the editor previews these with the browser's own players, read through the app's asset scheme. SVG is
// text (people edit it), so it opens in the code editor.
const MEDIA_EXTENSIONS: Readonly<Record<string, ExplorerMediaKind>> = {
  apng: 'image',
  avif: 'image',
  bmp: 'image',
  gif: 'image',
  ico: 'image',
  jpeg: 'image',
  jpg: 'image',
  png: 'image',
  webp: 'image',
  m4v: 'video',
  mov: 'video',
  mp4: 'video',
  ogv: 'video',
  webm: 'video',
  aac: 'audio',
  flac: 'audio',
  m4a: 'audio',
  mp3: 'audio',
  oga: 'audio',
  ogg: 'audio',
  wav: 'audio',
};

/** The media kind a file name says, by extension; undefined for anything the editor does not preview. */
export function mediaKindOf(name: string): ExplorerMediaKind | undefined {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) {
    return undefined;
  }
  const extension = name.slice(dot + 1).toLowerCase();
  return Object.hasOwn(MEDIA_EXTENSIONS, extension) ? MEDIA_EXTENSIONS[extension] : undefined;
}

/**
 * What opening a file found. Text is strict UTF-8 with no NUL byte in its first `sniffBytesMax` bytes, at most
 * `textBytesMax`; a leading byte-order mark is taken off `text` and reported, and is put back by the write, so bytes the
 * person did not edit stay as they were. Anything else is not opened as text: never decoded lossily, never written.
 */
export type ExplorerContent =
  | {
      readonly kind: 'text';
      readonly text: string;
      readonly checksum: Digest;
      readonly byteOrderMark: boolean;
      readonly sizeBytes: number;
    }
  | { readonly kind: 'media'; readonly media: ExplorerMediaKind; readonly sizeBytes: number }
  | { readonly kind: 'binary'; readonly sizeBytes: number }
  | { readonly kind: 'too-large'; readonly sizeBytes: number };

export function parseExplorerContent(input: unknown): ExplorerContent {
  const value = record(input);
  const sizeBytes = count(value['sizeBytes']);
  switch (value['kind']) {
    case 'text': {
      const body = text(value['text']);
      if (body.startsWith('﻿')) {
        throw new Error('Explorer content: the byte-order mark is reported, never left in the text');
      }
      return { kind: 'text', text: body, checksum: digest(value['checksum']), byteOrderMark: boolean(value['byteOrderMark']), sizeBytes };
    }
    case 'media': {
      const media = EXPLORER_MEDIA_KINDS.find((kind) => kind === value['media']);
      if (media === undefined) {
        throw new Error('Explorer content: unknown media kind');
      }
      return { kind: 'media', media, sizeBytes };
    }
    case 'binary':
      return { kind: 'binary', sizeBytes };
    case 'too-large':
      return { kind: 'too-large', sizeBytes };
    default:
      throw new Error('Explorer content: unknown kind');
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * `not-open`: the request names a project other than the open one. `missing`: the path is gone. `exists`: the name is
 * taken (a create or rename never overwrites). `collision`: a move, copy or import met taken names; `names` lists them
 * and the person decides. `protected`: `.git` or `.stacki/io`, or the project root. `outside`: the path resolves out
 * of the project through a link. `not-directory` / `not-file`: the wrong kind of entry. `into-itself`: a folder moved
 * or copied into itself. `too-large` / `too-many`: past a bound above. `conflict`: the file changed since it was read.
 * `not-text`: a write to a file that is not UTF-8 text. `filesystem`: the system refused; `detail` is its code.
 */
export const EXPLORER_ERROR_CODES = [
  'not-open',
  'missing',
  'exists',
  'collision',
  'protected',
  'outside',
  'not-directory',
  'not-file',
  'into-itself',
  'too-large',
  'too-many',
  'conflict',
  'not-text',
  'filesystem',
] as const;
export type ExplorerErrorCode = (typeof EXPLORER_ERROR_CODES)[number];

export interface ExplorerError {
  readonly code: ExplorerErrorCode;
  /** The taken names of a collision, at most `collisionNamesMax`; empty otherwise. */
  readonly names: readonly string[];
  /** A system error code (`EACCES`, `EXDEV`) for `filesystem`; never a path. */
  readonly detail: string | undefined;
}

export function explorerError(code: ExplorerErrorCode, extra: { readonly names?: readonly string[]; readonly detail?: string } = {}): ExplorerError {
  const names = (extra.names ?? []).slice(0, FILE_EXPLORER_LIMITS.collisionNamesMax);
  return { code, names, detail: extra.detail };
}

const SYSTEM_CODE = /^E[A-Z0-9]{1,15}$/;

export function parseExplorerError(input: unknown): ExplorerError {
  const value = record(input);
  const code = EXPLORER_ERROR_CODES.find((each) => each === value['code']);
  if (code === undefined) {
    throw new Error('Explorer error: unknown code');
  }
  const names = list(text)(value['names']);
  if (names.length > FILE_EXPLORER_LIMITS.collisionNamesMax) {
    throw new Error('Explorer error: too many names');
  }
  const detail = optional(text)(value['detail']);
  if (detail !== undefined && !SYSTEM_CODE.test(detail)) {
    throw new Error('Explorer error: the detail is a system error code');
  }
  return { code, names, detail };
}

/** An explorer reply: `{ ok, value }` or `{ ok, error }`, with each side parsed. */
export function parseExplorerResult<T>(input: unknown, parseValue: (value: unknown) => T): Result<T, ExplorerError> {
  const value = record(input);
  if (boolean(value['ok'])) {
    return ok(parseValue(value['value']));
  }
  return err(parseExplorerError(value['error']));
}

export type ExplorerResult<T> = Result<T, ExplorerError>;

// ---------------------------------------------------------------------------
// Git marks
// ---------------------------------------------------------------------------
//
// The answer of `files:gitStatus`, which marks files and folders the way VS Code's Explorer does. Paths are relative to
// the open project even when the repository starts above it, and a folder git reports as a whole (untracked or ignored)
// is one entry that speaks for everything inside it. The answer is whole or it says so: past a bound it is `too-many`,
// never a shorter list in which a changed file would look clean.

export const FILE_GIT_LIMITS = {
  /** Changed entries one answer holds (the Git panel's own bound, electron/lib/mainLimits.ts `statusFilesMax`). */
  changesMax: 20_000,
  /** Ignored entries one answer holds; past it nothing is dimmed, since dimming only some would mislead. */
  ignoredMax: 20_000,
} as const satisfies Record<string, number>;

/** What happened to an entry, strongest first: a folder holding several shows the first of these that it holds. */
export const FILE_GIT_STATES = ['conflicted', 'modified', 'deleted', 'renamed', 'added', 'untracked'] as const;
export type FileGitState = (typeof FILE_GIT_STATES)[number];

export interface FileGitChange {
  readonly path: ExplorerPath;
  readonly state: FileGitState;
  /** A folder git reports as one entry: everything inside it is in this state. */
  readonly folder: boolean;
  /** Where a renamed entry was, when that is inside the project. */
  readonly from: ExplorerPath | undefined;
}

export interface FileGitIgnored {
  readonly path: ExplorerPath;
  readonly folder: boolean;
}

export type FileGitStatus =
  /** Not a repository: the panel shows nothing about git. */
  | { readonly kind: 'none' }
  /** More changes than the bound: the panel marks nothing and says why. */
  | { readonly kind: 'too-many'; readonly limit: number }
  | {
      readonly kind: 'repository';
      /** The project folder itself, when git reports all of it as one untracked or ignored folder. */
      readonly whole: 'tracked' | 'untracked' | 'ignored';
      readonly changes: readonly FileGitChange[];
      readonly ignored: readonly FileGitIgnored[];
    };

export function parseFileGitState(input: unknown): FileGitState {
  const value = text(input);
  const known = FILE_GIT_STATES.find((state) => state === value);
  if (known === undefined) {
    throw new Error('File git status: unknown state');
  }
  return known;
}

// An entry is something inside the project: the project itself is told by `whole`.
function gitEntryPath(input: unknown): ExplorerPath {
  const path = parseExplorerPath(input);
  if (path === '') {
    throw new Error('File git status: an entry names a path inside the project');
  }
  return path;
}

function gitChange(input: unknown): FileGitChange {
  const value = record(input);
  return {
    path: gitEntryPath(value['path']),
    state: parseFileGitState(value['state']),
    folder: boolean(value['folder']),
    from: optional(gitEntryPath)(value['from']),
  };
}

function gitIgnoredEntry(input: unknown): FileGitIgnored {
  const value = record(input);
  return { path: gitEntryPath(value['path']), folder: boolean(value['folder']) };
}

function boundedGitList<Item>(item: Parser<Item>, limit: number): Parser<readonly Item[]> {
  assert(limit > 0, 'A git list has a bound');
  return (input) => {
    if (Array.isArray(input) && input.length > limit) {
      throw new Error('File git status: the list exceeds its bound');
    }
    return list(item)(input);
  };
}

function wholeState(input: unknown): 'tracked' | 'untracked' | 'ignored' {
  const value = text(input);
  switch (value) {
    case 'tracked':
    case 'untracked':
    case 'ignored':
      return value;
    default:
      throw new Error('File git status: unknown project state');
  }
}

export function parseFileGitStatus(input: unknown): FileGitStatus {
  const value = record(input);
  const kind = text(value['kind']);
  switch (kind) {
    case 'none':
      return { kind };
    case 'too-many':
      return { kind, limit: count(value['limit']) };
    case 'repository':
      return {
        kind,
        whole: wholeState(value['whole']),
        changes: boundedGitList(gitChange, FILE_GIT_LIMITS.changesMax)(value['changes']),
        ignored: boundedGitList(gitIgnoredEntry, FILE_GIT_LIMITS.ignoredMax)(value['ignored']),
      };
    default:
      throw new Error('File git status: unknown kind');
  }
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** What a move or copy does where a name is taken: stop and list them, pick a free name, or move the old one to the Trash first. */
export const COLLISION_CHOICES = ['refuse', 'keep-both', 'replace'] as const;
export type CollisionChoice = (typeof COLLISION_CHOICES)[number];

export const TRANSFER_MODES = ['move', 'copy'] as const;
export type TransferMode = (typeof TRANSFER_MODES)[number];

export const CREATE_KINDS = ['file', 'directory'] as const;
export type CreateKind = (typeof CREATE_KINDS)[number];

function oneOf<const T extends readonly string[]>(values: T, label: string): (input: unknown) => T[number] {
  return (input) => {
    const found = values.find((value) => value === input);
    if (found === undefined) {
      throw new Error(`${label}: unknown value`);
    }
    return found;
  };
}

function explorerPaths(input: unknown): readonly ExplorerPath[] {
  const paths = list(parseExplorerPath)(input);
  if (paths.length === 0) {
    throw new Error('Explorer request names no path');
  }
  if (paths.length > FILE_EXPLORER_LIMITS.batchItemsMax) {
    throw new Error('Explorer request exceeds its batch bound');
  }
  if (new Set(paths).size !== paths.length) {
    throw new Error('Explorer request names a path twice');
  }
  return paths;
}

function absoluteSources(input: unknown): readonly string[] {
  const sources = list(pathText)(input);
  if (sources.length === 0) {
    throw new Error('Explorer import names no file');
  }
  if (sources.length > FILE_EXPLORER_LIMITS.batchItemsMax) {
    throw new Error('Explorer import exceeds its batch bound');
  }
  return sources;
}

function watchedDirectories(input: unknown): readonly ExplorerPath[] {
  const directories = list(parseExplorerPath)(input);
  if (directories.length > FILE_EXPLORER_LIMITS.watchDirectoriesMax) {
    throw new Error('Explorer watch exceeds its folder bound');
  }
  return directories;
}

function findQuery(input: unknown): string {
  const query = text(input);
  if (query.trim().length === 0) {
    throw new Error('Explorer find: an empty query');
  }
  if (query.length > FILE_EXPLORER_LIMITS.queryCharsMax) {
    throw new Error('Explorer find: the query exceeds its bound');
  }
  return query;
}

function editorText(input: unknown): string {
  const value = text(input);
  // UTF-16 units never outnumber UTF-8 bytes, so this refuses only text the write would refuse anyway.
  if (value.length > FILE_EXPLORER_LIMITS.textBytesMax) {
    throw new Error('Explorer write exceeds the text bound');
  }
  if (value.startsWith('﻿')) {
    throw new Error('Explorer write: the byte-order mark is a flag, not text');
  }
  return value;
}

const project = { projectPath: pathText };

export const FILE_EXPLORER_PAYLOADS = {
  'files:list': object({ ...project, path: parseExplorerPath }),
  'files:read': object({ ...project, path: parseExplorerPath }),
  'files:write': object({ ...project, path: parseExplorerPath, text: editorText, byteOrderMark: boolean, base: digest }),
  'files:create': object({ ...project, parent: parseExplorerPath, name: parseEntryName, kind: oneOf(CREATE_KINDS, 'Create kind') }),
  'files:rename': object({ ...project, path: parseExplorerPath, name: parseEntryName }),
  'files:transfer': object({
    ...project,
    paths: explorerPaths,
    target: parseExplorerPath,
    mode: oneOf(TRANSFER_MODES, 'Transfer mode'),
    collision: oneOf(COLLISION_CHOICES, 'Collision choice'),
  }),
  'files:trash': object({ ...project, paths: explorerPaths }),
  'files:import': object({ ...project, sources: absoluteSources, target: parseExplorerPath, collision: oneOf(COLLISION_CHOICES, 'Collision choice') }),
  'files:reveal': object({ ...project, path: parseExplorerPath }),
  'files:find': object({ ...project, query: findQuery }),
  'files:watch': object({ ...project, directories: watchedDirectories }),
  'files:gitStatus': object({ ...project }),
  'files:guardClose': object({ unsaved: boolean }),
  'files:allowClose': object({ proceed: boolean }),
} as const;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** One entry a move, copy or import placed: where it was (a project path, or the outside file for an import) and where it is. */
export interface TransferPlacement {
  readonly from: string;
  readonly to: ExplorerPath;
}

export interface FindMatch {
  readonly path: ExplorerPath;
  /** Whether the match is a folder (it opens in the tree) rather than a file (it opens in the editor). */
  readonly folder: boolean;
}

export interface FindAnswer {
  readonly matches: readonly FindMatch[];
  /** False when the walk stopped at `findVisitedMax` or at `findResultsMax` matches: there may be more. */
  readonly complete: boolean;
}

export interface FileExplorerResults {
  readonly 'files:list': ExplorerResult<ExplorerListing>;
  readonly 'files:read': ExplorerResult<ExplorerContent>;
  readonly 'files:write': ExplorerResult<{ readonly checksum: Digest }>;
  readonly 'files:create': ExplorerResult<{ readonly path: ExplorerPath }>;
  readonly 'files:rename': ExplorerResult<{ readonly path: ExplorerPath }>;
  readonly 'files:transfer': ExplorerResult<{ readonly placed: readonly TransferPlacement[] }>;
  readonly 'files:trash': ExplorerResult<{ readonly count: number }>;
  readonly 'files:import': ExplorerResult<{ readonly placed: readonly TransferPlacement[] }>;
  readonly 'files:reveal': ExplorerResult<{ readonly shown: true }>;
  readonly 'files:find': ExplorerResult<FindAnswer>;
  readonly 'files:watch': { readonly watching: number };
  readonly 'files:gitStatus': FileGitStatus;
  readonly 'files:guardClose': { readonly ok: true };
  readonly 'files:allowClose': { readonly ok: true };
}

export function parsePathValue(input: unknown): { readonly path: ExplorerPath } {
  return { path: parseExplorerPath(record(input)['path']) };
}

export function parseChecksumValue(input: unknown): { readonly checksum: Digest } {
  return { checksum: digest(record(input)['checksum']) };
}

export function parsePlacements(input: unknown): { readonly placed: readonly TransferPlacement[] } {
  const placed = list((each) => {
    const value = record(each);
    return { from: pathText(value['from']), to: parseExplorerPath(value['to']) };
  })(record(input)['placed']);
  if (placed.length > FILE_EXPLORER_LIMITS.batchItemsMax) {
    throw new Error('Explorer placements exceed the batch bound');
  }
  return { placed };
}

export function parseFindAnswer(input: unknown): FindAnswer {
  const value = record(input);
  const matches = list((each) => {
    const match = record(each);
    return { path: parseExplorerPath(match['path']), folder: boolean(match['folder']) };
  })(value['matches']);
  if (matches.length > FILE_EXPLORER_LIMITS.findResultsMax) {
    throw new Error('Explorer find exceeds its result bound');
  }
  return { matches, complete: boolean(value['complete']) };
}

/** The `files:changed` event: the folders whose entries changed, project-relative. */
export function parseFilesChanged(input: unknown): { readonly directories: readonly ExplorerPath[] } {
  return { directories: watchedDirectories(record(input)['directories']) };
}
