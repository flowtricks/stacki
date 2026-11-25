// What the Files panel does to the open project's disk (docs/contracts.md, "Files panel"): list a folder, open a file,
// save it, create, rename, move, copy, trash, import and find. Every path is resolved by explorerPaths.ts first, so
// nothing here reads through a link that leaves the project or writes into `.git` or `.stacki/io`.
//
// The rules that make it safe to point at a real project:
//
//   - Nothing is overwritten silently. A create or rename into a taken name is `exists`; a move, copy or import into
//     taken names is `collision` with the names listed, and only the person's answer (`keep-both`, `replace`) goes on.
//     `replace` moves the old entry to the Trash first, where it can be got back.
//   - Text is saved through the file's document actor (documentWrites.ts), witnessed by the checksum it was read with:
//     a file that changed since is `conflict`, never written over. The bytes the person did not edit stay as they were,
//     the byte-order mark included (it is a flag on the wire, put back here).
//   - Deleting is the operating system's Trash, never an unlink.
//   - A copy walks its source first and refuses past `copyEntriesMax` entries or `copyBytesMax` bytes, so a dropped
//     `node_modules` cannot fill the disk. A link inside a copied folder is copied as a link, never followed.
//   - Errors name a code and the system's error code, never a path or file contents.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert } from '../../shared/core/assert';
import type { Digest } from '../../shared/core/brand';
import { err, ok } from '../../shared/core/result';
import { decodeUtf8, toByteString } from '../../shared/core/span';
import {
  EXPLORER_ROOT,
  FILE_EXPLORER_LIMITS,
  baseName,
  childPath,
  compareEntries,
  explorerError,
  isProtectedPath,
  isWithinPath,
  mediaKindOf,
  parentPath,
  type CollisionChoice,
  type CreateKind,
  type ExplorerContent,
  type ExplorerEntry,
  type ExplorerEntryKind,
  type ExplorerListing,
  type ExplorerPath,
  type ExplorerResult,
  type FindAnswer,
  type FindMatch,
  type TransferMode,
  type TransferPlacement,
} from '../../shared/ipc/fileExplorer';
import { digestOf } from '../documents/atomicWrite';
import { createProjectText, documentHost } from '../documents/documentWrites';
import { isPathWithin } from '../lib/platform';
import { explorerPathOfReal, occupied, resolveEntry, resolveFolderTarget, resolveForRead, sameDiskEntry, type ExplorerRoot } from './explorerPaths';
import { errorCode } from './projectWalk';

/** What the operations need from the outside world: the Trash, which tests replace with a folder of their own. */
export interface ExplorerDisk {
  readonly trash: (absolute: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** One folder's entries, dotfiles and `.git` included, folders first in natural order, at most `listEntriesMax`. */
export function listFolder(root: ExplorerRoot, folder: ExplorerPath): ExplorerResult<ExplorerListing> {
  const resolved = resolveForRead(root, folder);
  if (!resolved.ok) {
    return resolved;
  }
  if (!resolved.value.stats.isDirectory()) {
    return err(explorerError('not-directory'));
  }
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(resolved.value.real, { withFileTypes: true });
  } catch (error: unknown) {
    return err(explorerError('filesystem', { detail: errorCode(error) }));
  }
  const entries: ExplorerEntry[] = [];
  for (const dirent of dirents) {
    entries.push({ name: dirent.name, kind: entryKind(root, path.join(resolved.value.real, dirent.name), dirent) });
  }
  entries.sort(compareEntries);
  const shown = entries.slice(0, FILE_EXPLORER_LIMITS.listEntriesMax);
  assert(shown.length <= FILE_EXPLORER_LIMITS.listEntriesMax, 'listFolder: the listing is bounded');
  return ok({ path: folder, entries: shown, totalCount: entries.length });
}

// What one entry is. A link is followed only to learn its kind, and counts as a folder or file only when it lands
// inside the project.
function entryKind(root: ExplorerRoot, absolute: string, dirent: fs.Dirent): ExplorerEntryKind {
  if (dirent.isDirectory()) {
    return 'directory';
  }
  if (dirent.isFile()) {
    return 'file';
  }
  if (!dirent.isSymbolicLink()) {
    return 'other';
  }
  let real: string;
  let stats: fs.Stats;
  try {
    real = fs.realpathSync.native(absolute);
    stats = fs.statSync(real);
  } catch {
    return 'link-broken';
  }
  if (!isPathWithin(root.real, real)) {
    return 'link-outside';
  }
  if (stats.isDirectory()) {
    return 'link-directory';
  }
  return stats.isFile() ? 'link-file' : 'other';
}

/** What opening a file finds: text (strict UTF-8, no NUL in its first bytes), previewable media, or neither. */
export function readExplorerFile(root: ExplorerRoot, file: ExplorerPath): ExplorerResult<ExplorerContent> {
  const resolved = resolveForRead(root, file);
  if (!resolved.ok) {
    return resolved;
  }
  const { real, stats } = resolved.value;
  if (!stats.isFile()) {
    return err(explorerError('not-file'));
  }
  const sizeBytes = stats.size;
  const media = mediaKindOf(baseName(file));
  if (media !== undefined) {
    return ok({ kind: 'media', media, sizeBytes });
  }
  if (sizeBytes > FILE_EXPLORER_LIMITS.textBytesMax) {
    return ok({ kind: 'too-large', sizeBytes });
  }
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(real);
  } catch (error: unknown) {
    return err(explorerError('filesystem', { detail: errorCode(error) }));
  }
  // A writer may have grown the file between the stat and the read.
  if (bytes.length > FILE_EXPLORER_LIMITS.textBytesMax) {
    return ok({ kind: 'too-large', sizeBytes: bytes.length });
  }
  if (bytes.subarray(0, FILE_EXPLORER_LIMITS.sniffBytesMax).includes(0)) {
    return ok({ kind: 'binary', sizeBytes: bytes.length });
  }
  const decoded = decodeUtf8(toByteString(new Uint8Array(bytes)));
  if (!decoded.ok) {
    return ok({ kind: 'binary', sizeBytes: bytes.length });
  }
  const byteOrderMark = decoded.value.startsWith('﻿');
  const text = byteOrderMark ? decoded.value.slice(1) : decoded.value;
  return ok({ kind: 'text', text, checksum: digestOf(bytes), byteOrderMark, sizeBytes: bytes.length });
}

// ---------------------------------------------------------------------------
// Saving text
// ---------------------------------------------------------------------------

export interface ExplorerWrite {
  readonly file: ExplorerPath;
  readonly text: string;
  readonly byteOrderMark: boolean;
  /** The checksum of the bytes the text was edited from. */
  readonly base: Digest;
}

/** Saves edited text through the file's actor, only while the file still holds the bytes named by `base`. */
export function writeExplorerFile(root: ExplorerRoot, write: ExplorerWrite): ExplorerResult<{ readonly checksum: Digest; readonly real: string }> {
  if (isProtectedPath(write.file)) {
    return err(explorerError('protected'));
  }
  const resolved = resolveForRead(root, write.file);
  if (!resolved.ok) {
    return resolved;
  }
  const own = explorerPathOfReal(root, resolved.value.real);
  assert(own !== undefined, 'writeExplorerFile: a resolved file lies inside the project');
  if (isProtectedPath(own)) {
    return err(explorerError('protected'));
  }
  if (!resolved.value.stats.isFile()) {
    return err(explorerError('not-file'));
  }
  // The actor writes the link's target, so a link inside the project stays a link.
  const real = resolved.value.real;
  const host = documentHost();
  const current = host.documents.current(real);
  if (!current.ok) {
    return err(current.error.code === 'missing' ? explorerError('missing') : explorerError('filesystem'));
  }
  if (current.value.checksum !== write.base) {
    return err(explorerError('conflict'));
  }
  if (!decodeUtf8(current.value.bytes).ok) {
    return err(explorerError('not-text'));
  }
  host.noteWrite(real);
  const report = host.documents.writeText(real, `${write.byteOrderMark ? '﻿' : ''}${write.text}`, write.base);
  switch (report.tag) {
    case 'applied':
      return ok({ checksum: report.checksum, real });
    case 'rejected':
      return err(STALE_REASONS.has(report.reason) ? explorerError('conflict') : explorerError('filesystem'));
    case 'uncertain':
    case 'backpressured':
      return err(explorerError('filesystem'));
    default: {
      const exhaustive: never = report;
      return exhaustive;
    }
  }
}

const STALE_REASONS: ReadonlySet<string> = new Set(['region-externally-modified', 'write-race', 'merge-conflict', 'anchor-moved']);

// ---------------------------------------------------------------------------
// Creating and renaming
// ---------------------------------------------------------------------------

/** A new empty file (through its actor, which never overwrites) or folder in `parent`. */
export function createEntry(root: ExplorerRoot, parent: ExplorerPath, name: string, kind: CreateKind): ExplorerResult<{ readonly path: ExplorerPath }> {
  const folder = resolveFolderTarget(root, parent);
  if (!folder.ok) {
    return folder;
  }
  const target = childPath(parent, name);
  if (isProtectedPath(target)) {
    return err(explorerError('protected'));
  }
  const absolute = path.join(folder.value.real, name);
  if (occupied(absolute)) {
    return err(explorerError('exists'));
  }
  try {
    if (kind === 'directory') {
      fs.mkdirSync(absolute);
    } else {
      createProjectText(absolute, '');
    }
  } catch (error: unknown) {
    return err(occupied(absolute) ? explorerError('exists') : explorerError('filesystem', { detail: errorCode(error) }));
  }
  return ok({ path: target });
}

/**
 * Renames an entry in its folder. A taken name is refused; a name that differs only in case and finds the same entry
 * (a disk that ignores case) is renamed through a temporary name in the same folder, which every disk honours.
 */
export function renameEntry(root: ExplorerRoot, source: ExplorerPath, name: string): ExplorerResult<{ readonly path: ExplorerPath }> {
  const entry = resolveEntry(root, source);
  if (!entry.ok) {
    return entry;
  }
  const parent = parentPath(source);
  assert(parent !== undefined, 'renameEntry: a resolved entry has a parent');
  const target = childPath(parent, name);
  if (isProtectedPath(target)) {
    return err(explorerError('protected'));
  }
  if (name === entry.value.name) {
    return ok({ path: source });
  }
  const absolute = path.join(entry.value.parentReal, name);
  try {
    if (occupied(absolute)) {
      if (!sameDiskEntry(entry.value.absolute, absolute)) {
        return err(explorerError('exists'));
      }
      const passing = path.join(entry.value.parentReal, `.stacki-rename-${process.pid}-${Date.now().toString(36)}`);
      assert(!occupied(passing), 'renameEntry: the passing name is free');
      fs.renameSync(entry.value.absolute, passing);
      fs.renameSync(passing, absolute);
    } else {
      fs.renameSync(entry.value.absolute, absolute);
    }
  } catch (error: unknown) {
    return err(explorerError('filesystem', { detail: errorCode(error) }));
  }
  return ok({ path: target });
}

// ---------------------------------------------------------------------------
// Moving and copying
// ---------------------------------------------------------------------------

export interface TransferRequest {
  readonly sources: readonly ExplorerPath[];
  readonly target: ExplorerPath;
  readonly mode: TransferMode;
  readonly collision: CollisionChoice;
}

interface PlannedItem {
  readonly from: string;
  readonly absolute: string;
  readonly name: string;
  readonly directory: boolean;
}

/** Moves or copies entries into the folder `target`, deciding every taken name by `collision`. */
export async function transferEntries(
  root: ExplorerRoot,
  request: TransferRequest,
  disk: ExplorerDisk,
): Promise<ExplorerResult<{ readonly placed: readonly TransferPlacement[] }>> {
  const folder = resolveFolderTarget(root, request.target);
  if (!folder.ok) {
    return folder;
  }
  const items: PlannedItem[] = [];
  for (const source of outermost(request.sources)) {
    const entry = resolveEntry(root, source);
    if (!entry.ok) {
      return entry;
    }
    const directory = entry.value.stats.isDirectory();
    if (directory && isWithinPath(source, request.target)) {
      return err(explorerError('into-itself'));
    }
    items.push({ from: source, absolute: entry.value.absolute, name: entry.value.name, directory });
  }
  return placeItems(items, { folderReal: folder.value.real, target: request.target, mode: request.mode, collision: request.collision }, disk);
}

/** Copies files and folders from outside the app (a Finder drop) into `target`, never moving or changing the originals. */
export async function importEntries(
  root: ExplorerRoot,
  request: { readonly sources: readonly string[]; readonly target: ExplorerPath; readonly collision: CollisionChoice },
  disk: ExplorerDisk,
): Promise<ExplorerResult<{ readonly placed: readonly TransferPlacement[] }>> {
  const folder = resolveFolderTarget(root, request.target);
  if (!folder.ok) {
    return folder;
  }
  const items: PlannedItem[] = [];
  for (const source of request.sources) {
    if (!path.isAbsolute(source)) {
      return err(explorerError('missing'));
    }
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(source);
    } catch {
      return err(explorerError('missing'));
    }
    if (stats.isDirectory() && isPathWithin(source, folder.value.real)) {
      return err(explorerError('into-itself'));
    }
    items.push({ from: source, absolute: source, name: path.basename(source), directory: stats.isDirectory() });
  }
  return placeItems(items, { folderReal: folder.value.real, target: request.target, mode: 'copy', collision: request.collision }, disk);
}

interface Placement {
  readonly folderReal: string;
  readonly target: ExplorerPath;
  readonly mode: TransferMode;
  readonly collision: CollisionChoice;
}

// Decides each item's name, refuses collisions the person has not answered, then moves or copies item by item.
async function placeItems(
  items: readonly PlannedItem[],
  placement: Placement,
  disk: ExplorerDisk,
): Promise<ExplorerResult<{ readonly placed: readonly TransferPlacement[] }>> {
  assert(items.length <= FILE_EXPLORER_LIMITS.batchItemsMax, 'placeItems: the batch is bounded');
  const names = new Set<string>();
  const taken: string[] = [];
  for (const item of items) {
    if (names.has(item.name.toLowerCase())) {
      return err(explorerError('collision', { names: [item.name] }));
    }
    names.add(item.name.toLowerCase());
    const absolute = path.join(placement.folderReal, item.name);
    // Moving an entry onto itself (into the folder it is already in) changes nothing, and is no collision.
    const itself = placement.mode === 'move' && sameDiskEntry(item.absolute, absolute);
    if (!itself && occupied(absolute)) {
      taken.push(item.name);
    }
  }
  if (taken.length > 0 && placement.collision === 'refuse') {
    return err(explorerError('collision', { names: taken }));
  }
  if (placement.mode === 'copy') {
    const budget = copyBudget(items);
    if (!budget.ok) {
      return budget;
    }
  }
  const placed: TransferPlacement[] = [];
  for (const item of items) {
    const done = await placeOne(item, placement, disk);
    if (!done.ok) {
      return placed.length === 0 ? done : ok({ placed });
    }
    if (done.value !== undefined) {
      placed.push({ from: item.from, to: childPath(placement.target, done.value) });
    }
  }
  return ok({ placed });
}

// Moves or copies one item; answers the name it took, or undefined for a move onto itself.
async function placeOne(item: PlannedItem, placement: Placement, disk: ExplorerDisk): Promise<ExplorerResult<string | undefined>> {
  let name = item.name;
  let absolute = path.join(placement.folderReal, name);
  if (placement.mode === 'move' && sameDiskEntry(item.absolute, absolute)) {
    if (path.basename(item.absolute) === name) {
      return ok(undefined);
    }
  } else if (occupied(absolute)) {
    if (placement.collision === 'keep-both') {
      const free = freeCopyName(placement.folderReal, item.name);
      if (free === undefined) {
        return err(explorerError('too-many'));
      }
      name = free;
      absolute = path.join(placement.folderReal, name);
    } else if (placement.collision === 'replace') {
      try {
        await disk.trash(absolute);
      } catch (error: unknown) {
        return err(explorerError('filesystem', { detail: errorCode(error) }));
      }
    } else {
      return err(explorerError('collision', { names: [name] }));
    }
  }
  try {
    if (placement.mode === 'move') {
      fs.renameSync(item.absolute, absolute);
    } else {
      copyTree(item.absolute, absolute);
    }
  } catch (error: unknown) {
    return err(explorerError('filesystem', { detail: errorCode(error) }));
  }
  return ok(name);
}

/** "name copy.ext", then "name copy 2.ext", ...: the first free one, or undefined past `copyNameAttemptsMax`. */
export function freeCopyName(folder: string, name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  for (let attempt = 1; attempt <= FILE_EXPLORER_LIMITS.copyNameAttemptsMax; attempt += 1) {
    const candidate = attempt === 1 ? `${stem} copy${extension}` : `${stem} copy ${attempt}${extension}`;
    if (candidate.length <= FILE_EXPLORER_LIMITS.nameCharsMax && !occupied(path.join(folder, candidate))) {
      return candidate;
    }
  }
  return undefined;
}

// The entries and bytes a copy would write, counted without following a link; refused past the bounds.
function copyBudget(items: readonly PlannedItem[]): ExplorerResult<{ readonly entries: number; readonly bytes: number }> {
  let entries = 0;
  let bytes = 0;
  const pending = items.map((item) => item.absolute);
  while (pending.length > 0) {
    const next = pending.pop();
    assert(next !== undefined, 'copyBudget: a pending entry exists');
    entries += 1;
    if (entries > FILE_EXPLORER_LIMITS.copyEntriesMax) {
      return err(explorerError('too-large'));
    }
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(next);
    } catch (error: unknown) {
      return err(explorerError('filesystem', { detail: errorCode(error) }));
    }
    if (stats.isDirectory()) {
      try {
        pending.push(...fs.readdirSync(next).map((child) => path.join(next, child)));
      } catch (error: unknown) {
        return err(explorerError('filesystem', { detail: errorCode(error) }));
      }
    } else if (stats.isFile()) {
      bytes += stats.size;
      if (bytes > FILE_EXPLORER_LIMITS.copyBytesMax) {
        return err(explorerError('too-large'));
      }
    }
  }
  return ok({ entries, bytes });
}

// Copies a file, a link (as a link) or a folder and what it holds. Every created entry is new: files are copied
// exclusively (COPYFILE_EXCL), so nothing that appears meanwhile is replaced. The walk is iterative and bounded by
// copyBudget, which ran first.
function copyTree(source: string, target: string): void {
  const pending: { readonly source: string; readonly target: string }[] = [{ source, target }];
  let copied = 0;
  while (pending.length > 0) {
    const next = pending.pop();
    assert(next !== undefined, 'copyTree: a pending entry exists');
    copied += 1;
    assert(copied <= FILE_EXPLORER_LIMITS.copyEntriesMax + FILE_EXPLORER_LIMITS.batchItemsMax, 'copyTree: the walk stays within its budget');
    const stats = fs.lstatSync(next.source);
    if (stats.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(next.source), next.target);
    } else if (stats.isDirectory()) {
      fs.mkdirSync(next.target);
      for (const child of fs.readdirSync(next.source)) {
        pending.push({ source: path.join(next.source, child), target: path.join(next.target, child) });
      }
    } else if (stats.isFile()) {
      fs.copyFileSync(next.source, next.target, fs.constants.COPYFILE_EXCL);
    }
  }
}

// The sources with any source inside another dropped: moving a folder moves what it holds.
function outermost(sources: readonly ExplorerPath[]): readonly ExplorerPath[] {
  return sources.filter((source) => !sources.some((other) => other !== source && isWithinPath(other, source)));
}

// ---------------------------------------------------------------------------
// Trash
// ---------------------------------------------------------------------------

/** Moves each entry (a link as itself) to the operating system's Trash. */
export async function trashEntries(
  root: ExplorerRoot,
  sources: readonly ExplorerPath[],
  disk: ExplorerDisk,
): Promise<ExplorerResult<{ readonly count: number }>> {
  const absolutes: string[] = [];
  for (const source of outermost(sources)) {
    const entry = resolveEntry(root, source);
    if (!entry.ok) {
      return entry;
    }
    absolutes.push(entry.value.absolute);
  }
  let trashed = 0;
  for (const absolute of absolutes) {
    try {
      await disk.trash(absolute);
    } catch (error: unknown) {
      return trashed === 0 ? err(explorerError('filesystem', { detail: errorCode(error) })) : ok({ count: trashed });
    }
    trashed += 1;
  }
  return ok({ count: trashed });
}

// ---------------------------------------------------------------------------
// Find
// ---------------------------------------------------------------------------

// Folders a find does not open: git's object store and installed packages are large, generated and never what a
// person looks for by name. Their own names still match.
const FIND_SKIPPED = new Set(['.git', 'node_modules']);

/**
 * Paths whose name contains `query` (ignoring case), dotfiles and dot-folders included. The walk is breadth-first,
 * does not follow links, and stops at `findVisitedMax` entries or `findResultsMax` matches; whole-name matches sort
 * first, then names that start with the query, then shorter paths.
 */
export function findEntries(root: ExplorerRoot, query: string): ExplorerResult<FindAnswer> {
  const needle = query.trim().toLowerCase();
  assert(needle.length > 0, 'findEntries: the query is not blank');
  const matches: FindMatch[] = [];
  const queue: ExplorerPath[] = [EXPLORER_ROOT];
  let visited = 0;
  let complete = true;
  for (let index = 0; index < queue.length; index += 1) {
    const folder = queue[index];
    assert(folder !== undefined, 'findEntries: a queued folder exists');
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(path.join(root.real, ...splitPath(folder)), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      visited += 1;
      if (visited > FILE_EXPLORER_LIMITS.findVisitedMax) {
        return ok({ matches: ranked(matches, needle), complete: false });
      }
      const entry = childPath(folder, dirent.name);
      if (dirent.name.toLowerCase().includes(needle)) {
        if (matches.length >= FILE_EXPLORER_LIMITS.findResultsMax) {
          complete = false;
        } else {
          matches.push({ path: entry, folder: dirent.isDirectory() });
        }
      }
      if (dirent.isDirectory() && !FIND_SKIPPED.has(dirent.name)) {
        queue.push(entry);
      }
    }
  }
  return ok({ matches: ranked(matches, needle), complete });
}

function splitPath(folder: ExplorerPath): readonly string[] {
  return folder === '' ? [] : folder.split('/');
}

function ranked(matches: readonly FindMatch[], needle: string): readonly FindMatch[] {
  const score = (match: FindMatch): number => {
    const name = baseName(match.path).toLowerCase();
    if (name === needle) {
      return 0;
    }
    return name.startsWith(needle) ? 1 : 2;
  };
  return [...matches].sort((left, right) => {
    const byScore = score(left) - score(right);
    if (byScore !== 0) {
      return byScore;
    }
    if (left.path.length !== right.path.length) {
      return left.path.length - right.path.length;
    }
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });
}
