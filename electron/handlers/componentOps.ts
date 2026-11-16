// Duplicating and deleting components and component folders (the Components panel's "…" menu).
//
// Every write goes through the document actors (createProjectText, writeProjectMetadata), so a copy
// appears whole or not at all and a project setting is never overwritten blind. Nothing here rewrites a
// reference: a copy is a new file holding the original's bytes, and a deletion refuses a component that
// any file still uses.
//
// A deletion is undoable and never a bare unlink. The file (or folder) goes to the operating system's
// Trash, the way the app deletes collections and images, and main keeps what it removed (the texts, and
// the `.stacki` settings it cleaned) under a token, so Undo can put every byte back through the same
// actors. Metadata is restored only while it still reads as this deletion left it: a later edit to a
// setting is never undone silently.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert } from '../../shared/core/assert';
import { err, ok, type Result } from '../../shared/core/result';
import { parseComponentRules, type ComponentRule } from '../../shared/properties/componentAccess';
import { parseDefaultsSource } from '../../shared/properties/componentDefaults';
import {
  COMPONENT_OP_LIMITS,
  copyName,
  dropDefaultsFor,
  dropRulesFor,
  targetOwns,
  type ComponentOpError,
  type ComponentOpErrorCode,
  type ComponentOpTarget,
} from '../../shared/properties/componentOps';
import { parseProjectRolesSource, serializeProjectRoles } from '../../shared/properties/projectRoles';
import type { MetadataKind } from '../../shared/properties/projectMetadata';
import { isPathDescendant } from '../lib/platform';
import { readSource } from '../lib/mainLimits';
import { translateMain } from '../lib/mainLocale';
import { projectFoldersFor } from '../lib/projectFolders';
import { componentUsage } from '../properties/componentUsage';
import { readProjectMetadata, writeProjectMetadata } from '../project/projectMetadata';
import { createProjectText } from '../documents/documentWrites';

export interface ComponentCopied {
  readonly kind: 'component' | 'folder';
  /** The copy, project-relative. */
  readonly path: string;
  /** The copy's name: the file's name without `.astro`, or the folder's. */
  readonly name: string;
  /** Files written. */
  readonly files: number;
}

export interface ComponentRemoved {
  readonly name: string;
  /** Files taken out. */
  readonly files: number;
  /** What Undo hands back to `restoreRemoved`. */
  readonly undo: string;
}

export interface ComponentRestored {
  readonly files: number;
  /** Whether the `.stacki` entries the deletion cleaned were put back: only while they still read as the deletion left them. */
  readonly metadata: 'restored' | 'kept' | 'untouched';
}

export interface ComponentOpsHost {
  /** Moves a file or folder to the operating system's Trash. */
  readonly trash: (target: string) => Promise<void>;
}

/** One file of a target, read once: what a copy writes and what a restore puts back. */
export interface TargetFile {
  readonly rel: string;
  readonly absolute: string;
  readonly text: string;
}

export interface Resolved {
  readonly target: ComponentOpTarget;
  readonly absolute: string;
  readonly root: string;
  readonly files: readonly TargetFile[];
  /** Folders under the target, deepest-last, so a restore can recreate empty ones. */
  readonly directories: readonly string[];
}

type Failure = Result<never, ComponentOpError>;

/** A deleted target's undo: the files, and each `.stacki` file as it was and as the deletion left it. */
interface RemovalRecord {
  readonly projectPath: string;
  readonly directories: readonly string[];
  readonly files: readonly TargetFile[];
  readonly metadata: readonly MetadataChange[];
}

export interface MetadataChange {
  readonly kind: MetadataKind;
  readonly before: string;
  readonly after: string;
}

/** Deletions main can still undo, oldest forgotten first (COMPONENT_OP_LIMITS.undoEntriesMax). */
export class ComponentRemovalStore {
  readonly #entries = new Map<string, RemovalRecord>();
  #next = 0;

  record(entry: RemovalRecord): string {
    this.#next += 1;
    const token = `component-removal-${this.#next}`;
    this.#entries.set(token, entry);
    while (this.#entries.size > COMPONENT_OP_LIMITS.undoEntriesMax) {
      const oldest = this.#entries.keys().next();
      assert(oldest.done !== true, 'A store over its bound has an oldest entry');
      this.#entries.delete(oldest.value);
    }
    assert(this.#entries.size <= COMPONENT_OP_LIMITS.undoEntriesMax, 'The store stays within its bound');
    return token;
  }

  take(token: string): RemovalRecord | undefined {
    const entry = this.#entries.get(token);
    this.#entries.delete(token);
    return entry;
  }
}

/** What a copy would do, worked out and not written: the target as it is, the free name, and where the copy lands. */
export interface DuplicatePlan {
  readonly resolved: Resolved;
  readonly destination: string;
  readonly name: string;
}

/** The copy's name and place, with no write: the one rule the Components panel and the `stacki` command line share. */
export function planDuplicateTarget(projectPath: string, target: ComponentOpTarget): Result<DuplicatePlan, ComponentOpError> {
  const resolved = resolveTarget(projectPath, target);
  if (!resolved.ok) {
    return resolved;
  }
  const { absolute } = resolved.value;
  const parent = path.dirname(absolute);
  const taken = new Set(fs.readdirSync(parent).map((entry) => entry.toLowerCase()));
  const extension = target.kind === 'component' ? '.astro' : '';
  const stem = path.basename(absolute, extension);
  const name = copyName(stem, (candidate) => taken.has(`${candidate}${extension}`.toLowerCase()));
  if (name === undefined) {
    return failure('name-unavailable', translateMain('error.component.nameUnavailable', { name: stem }));
  }
  const destination = path.join(parent, `${name}${extension}`);
  assert(!fs.existsSync(destination), 'A copy never lands on an existing path');
  return ok({ resolved: resolved.value, destination, name });
}

/** A copy of one component file, or of a folder and every component in it, under a name no sibling has. */
export function duplicateComponentTarget(projectPath: string, target: ComponentOpTarget): Result<ComponentCopied, ComponentOpError> {
  const planned = planDuplicateTarget(projectPath, target);
  if (!planned.ok) {
    return planned;
  }
  const { resolved, destination, name } = planned.value;
  const written = writeCopy(resolved.absolute, destination, resolved.files);
  if (!written.ok) {
    return written;
  }
  const rel = toPosix(path.relative(projectPath, destination));
  assert(written.value === resolved.files.length, 'Every file of the target was copied');
  return ok({ kind: target.kind, path: rel, name, files: resolved.files.length });
}

/** What a deletion would do, worked out and not written: the target, and the `.stacki` text it would clean. */
export interface RemovalPlan {
  readonly resolved: Resolved;
  readonly changes: readonly MetadataChange[];
}

/** Refuses a target that is used or outside the component folders, else says what a deletion would remove and clean. No write. */
export function planRemoveTarget(projectPath: string, target: ComponentOpTarget): Result<RemovalPlan, ComponentOpError> {
  const resolved = resolveTarget(projectPath, target);
  if (!resolved.ok) {
    return resolved;
  }
  const used = firstUse(projectPath, resolved.value.files);
  if (used !== undefined) {
    return failure('in-use', translateMain('error.component.inUse', { name: used.name, count: used.count }));
  }
  const changes = planMetadataChanges(projectPath, target);
  return changes.ok ? ok({ resolved: resolved.value, changes: changes.value }) : changes;
}

/**
 * Deletes a component, or a folder of components, that nothing uses: the metadata that names it is cleaned, the file goes to the
 * Trash, and the reply carries the token Undo sends back. Used anywhere (by any file but itself): refused, nothing changed.
 */
export async function removeComponentTarget(
  projectPath: string,
  target: ComponentOpTarget,
  store: ComponentRemovalStore,
  host: ComponentOpsHost,
): Promise<Result<ComponentRemoved, ComponentOpError>> {
  const resolved = resolveTarget(projectPath, target);
  if (!resolved.ok) {
    return resolved;
  }
  const { absolute, files, directories } = resolved.value;
  const used = firstUse(projectPath, files);
  if (used !== undefined) {
    return failure('in-use', translateMain('error.component.inUse', { name: used.name, count: used.count }));
  }
  const changes = cleanMetadata(projectPath, target);
  if (!changes.ok) {
    return changes;
  }
  try {
    await host.trash(absolute);
  } catch (error: unknown) {
    restoreMetadata(projectPath, changes.value, 'after');
    return failure(
      'write-failed',
      translateMain('error.component.writeFailed', { file: toPosix(path.relative(projectPath, absolute)), reason: String(error) }),
    );
  }
  assert(!fs.existsSync(absolute), 'A deleted target is gone from the project');
  const undo = store.record({ projectPath, directories, files, metadata: changes.value });
  return ok({ name: path.basename(absolute, target.kind === 'component' ? '.astro' : ''), files: files.length, undo });
}

/** Undo of a deletion: the files return through the actors, and the settings only if nothing changed them since. */
export function restoreRemovedComponent(token: string, store: ComponentRemovalStore): Result<ComponentRestored, ComponentOpError> {
  const record = store.take(token);
  if (record === undefined) {
    return failure('unknown-undo', translateMain('error.component.unknownUndo'));
  }
  const first = record.files[0] ?? record.directories[0];
  assert(first !== undefined || record.files.length === 0, 'A removal record names what it removed');
  for (const directory of record.directories) {
    fs.mkdirSync(directory, { recursive: true });
  }
  let restored = 0;
  for (const file of record.files) {
    if (fs.existsSync(file.absolute)) {
      return failure('write-failed', translateMain('error.component.writeFailed', { file: file.rel, reason: translateMain('error.component.alreadyThere') }));
    }
    try {
      fs.mkdirSync(path.dirname(file.absolute), { recursive: true });
      createProjectText(file.absolute, file.text);
    } catch (error: unknown) {
      return failure('write-failed', translateMain('error.component.writeFailed', { file: file.rel, reason: String(error) }));
    }
    restored += 1;
  }
  assert(restored === record.files.length, 'Every removed file is written back');
  return ok({ files: restored, metadata: putMetadataBack(record) });
}

// What the project's settings say about the target now, cleaned. Nothing is written: both files must parse first.
export function planMetadataChanges(projectPath: string, target: ComponentOpTarget): Result<readonly MetadataChange[], ComponentOpError> {
  const planned: MetadataChange[] = [];
  const defaults = readProjectMetadata(projectPath, 'components');
  if (!defaults.ok) {
    return failure('write-failed', defaults.error.message);
  }
  const defaultsSource = defaults.value.source;
  if (defaultsSource !== undefined) {
    const parsed = parseDefaultsSource(defaultsSource);
    if (!parsed.ok) {
      return failure('write-failed', translateMain('error.component.metadataBroken', { file: '.stacki/components.json' }));
    }
    const cleaned = dropDefaultsFor(parsed.value, (file) => targetOwns(target, file));
    const after = `${JSON.stringify(cleaned, undefined, 2)}\n`;
    if (JSON.stringify(cleaned) !== JSON.stringify(parsed.value)) {
      planned.push({ kind: 'components', before: defaultsSource, after });
    }
  }
  const roles = readProjectMetadata(projectPath, 'roles');
  if (!roles.ok) {
    return failure('write-failed', roles.error.message);
  }
  const rolesSource = roles.value.source;
  if (rolesSource !== undefined) {
    const next = cleanRoles(rolesSource, target);
    if (!next.ok) {
      return next;
    }
    if (next.value !== undefined) {
      planned.push({ kind: 'roles', before: rolesSource, after: next.value });
    }
  }
  return ok(planned);
}

// Writes the planned changes in order; a failure puts back the ones already written.
function cleanMetadata(projectPath: string, target: ComponentOpTarget): Result<readonly MetadataChange[], ComponentOpError> {
  const planned = planMetadataChanges(projectPath, target);
  if (!planned.ok) {
    return planned;
  }
  const applied: MetadataChange[] = [];
  for (const change of planned.value) {
    const written = writeProjectMetadata(projectPath, { kind: change.kind, source: change.after, base: change.before });
    if (!written.ok) {
      restoreMetadata(projectPath, applied, 'after');
      return failure('write-failed', written.error.message);
    }
    applied.push(change);
  }
  return ok(applied);
}

// The roles file without the rules that name the target, or undefined when no rule does.
function cleanRoles(source: string, target: ComponentOpTarget): Result<string | undefined, ComponentOpError> {
  let roles;
  try {
    roles = parseProjectRolesSource(source);
  } catch {
    return failure('write-failed', translateMain('error.component.metadataBroken', { file: '.stacki/roles.json' }));
  }
  let touched = false;
  const next = roles.roles.map((role) => {
    const rules: readonly ComponentRule[] = dropRulesFor(role.componentRules, target);
    if (rules.length === role.componentRules.length) {
      return role;
    }
    touched = true;
    return { ...role, componentRules: parseComponentRules(rules) };
  });
  return ok(touched ? serializeProjectRoles({ ...roles, roles: next }) : undefined);
}

// Writes each change's other side back, but only while the file still holds `expected`'s side.
function restoreMetadata(projectPath: string, changes: readonly MetadataChange[], from: 'before' | 'after'): 'restored' | 'kept' {
  let result: 'restored' | 'kept' = 'restored';
  for (const change of changes) {
    const current = readProjectMetadata(projectPath, change.kind);
    const holds = current.ok && current.value.source === (from === 'after' ? change.after : change.before);
    if (!holds) {
      result = 'kept';
      continue;
    }
    const written = writeProjectMetadata(projectPath, {
      kind: change.kind,
      source: from === 'after' ? change.before : change.after,
      base: from === 'after' ? change.after : change.before,
    });
    if (!written.ok) {
      result = 'kept';
    }
  }
  return result;
}

function putMetadataBack(record: RemovalRecord): ComponentRestored['metadata'] {
  if (record.metadata.length === 0) {
    return 'untouched';
  }
  return restoreMetadata(record.projectPath, record.metadata, 'after');
}

// The first component of the target that something still uses, with how many places use it.
function firstUse(projectPath: string, files: readonly TargetFile[]): { readonly name: string; readonly count: number } | undefined {
  for (const file of files) {
    const name = path.basename(file.absolute, '.astro');
    const usage = componentUsage({ projectPath, name, exclude: file.absolute });
    if (usage.total > 0) {
      return { name, count: usage.total };
    }
  }
  return undefined;
}

// Copies every file to the same relative place under the destination, all or nothing: a failure removes what this call made.
export function writeCopy(source: string, destination: string, files: readonly TargetFile[]): Result<number, ComponentOpError> {
  const made: string[] = [];
  const isFolder = fs.statSync(source).isDirectory();
  try {
    for (const file of files) {
      const target = isFolder ? path.join(destination, path.relative(source, file.absolute)) : destination;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      createProjectText(target, file.text);
      made.push(target);
    }
    return ok(made.length);
  } catch (error: unknown) {
    for (const file of made) {
      fs.rmSync(file, { force: true });
    }
    if (isFolder) {
      removeEmptyFolders(destination);
    }
    return failure('write-failed', translateMain('error.component.writeFailed', { file: path.basename(destination), reason: String(error) }));
  }
}

// Removes the folders a failed copy made, deepest first, by listing them iteratively: no recursion.
function removeEmptyFolders(folder: string): void {
  const found: string[] = [];
  const pending = [folder];
  for (let visited = 0; pending.length > 0 && visited <= COMPONENT_OP_LIMITS.folderFilesMax * COMPONENT_OP_LIMITS.folderDepthMax; visited += 1) {
    const current = pending.pop();
    assert(current !== undefined, 'A non-empty list has a last entry');
    if (!fs.existsSync(current)) {
      continue;
    }
    found.push(current);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        pending.push(path.join(current, entry.name));
      }
    }
  }
  for (const directory of found.reverse()) {
    if (fs.readdirSync(directory).length === 0) {
      fs.rmdirSync(directory);
    }
  }
}

// The target as it is on disk: inside a component folder of this project, no links, only component files, within the bounds.
export function resolveTarget(projectPath: string, target: ComponentOpTarget): Result<Resolved, ComponentOpError> {
  assert(projectPath.length > 0, 'A project is named');
  const rel = cleanRelative(target.path);
  if (rel === undefined) {
    return failure('outside-components', translateMain('error.component.outside'));
  }
  const folder = projectFoldersFor(projectPath, 'components').find((candidate) => rel.startsWith(`${candidate}/`));
  if (folder === undefined) {
    return failure('outside-components', translateMain('error.component.outside'));
  }
  const root = path.join(projectPath, ...folder.split('/'));
  const absolute = path.join(projectPath, ...rel.split('/'));
  assert(isPathDescendant(root, absolute), 'A resolved target is under a component folder');
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(absolute);
    // A link anywhere on the way could point outside the project: the real path must stay under the real component folder.
    if (metadata.isSymbolicLink() || !isPathDescendant(fs.realpathSync(root), fs.realpathSync(absolute))) {
      return failure('outside-components', translateMain('error.component.outside'));
    }
  } catch {
    return failure('missing', translateMain('error.component.missing', { name: path.basename(rel) }));
  }
  if (target.kind === 'component') {
    if (!metadata.isFile() || path.extname(absolute) !== '.astro') {
      return failure('not-a-component', translateMain('error.component.notComponent'));
    }
    return ok({ target: { kind: 'component', path: rel }, absolute, root, files: [readTarget(projectPath, absolute)], directories: [] });
  }
  if (!metadata.isDirectory()) {
    return failure('not-a-component', translateMain('error.component.notComponent'));
  }
  const walked = walkFolder(projectPath, absolute);
  if (!walked.ok) {
    return walked;
  }
  return ok({ target: { kind: 'folder', path: rel }, absolute, root, files: walked.value.files, directories: walked.value.directories });
}

// Every file under a folder, read once. Anything but a plain component file refuses the whole folder: it is not ours to copy or delete.
function walkFolder(
  projectPath: string,
  folder: string,
): Result<{ readonly files: readonly TargetFile[]; readonly directories: readonly string[] }, ComponentOpError> {
  const files: TargetFile[] = [];
  const directories: string[] = [folder];
  let bytes = 0;
  const pending: { readonly directory: string; readonly depth: number }[] = [{ directory: folder, depth: 0 }];
  // Each folder is visited once and the walk is capped at folderFilesMax files, so the loop is bounded by the walk itself.
  for (let visited = 0; pending.length > 0 && visited <= COMPONENT_OP_LIMITS.folderFilesMax * COMPONENT_OP_LIMITS.folderDepthMax; visited += 1) {
    const current = pending.pop();
    assert(current !== undefined, 'A non-empty list has a last entry');
    if (current.depth > COMPONENT_OP_LIMITS.folderDepthMax) {
      return failure('too-large', translateMain('error.component.tooLarge'));
    }
    for (const entry of fs.readdirSync(current.directory, { withFileTypes: true })) {
      const absolute = path.join(current.directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(absolute);
        pending.push({ directory: absolute, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name) !== '.astro') {
        return failure('foreign-files', translateMain('error.component.foreignFiles'));
      }
      const file = readTarget(projectPath, absolute);
      bytes += Buffer.byteLength(file.text, 'utf8');
      if (files.length >= COMPONENT_OP_LIMITS.folderFilesMax || bytes > COMPONENT_OP_LIMITS.folderBytesMax) {
        return failure('too-large', translateMain('error.component.tooLarge'));
      }
      files.push(file);
    }
  }
  assert(pending.length === 0, 'The walk visited every folder');
  return ok({ files, directories });
}

function readTarget(projectPath: string, absolute: string): TargetFile {
  return { rel: toPosix(path.relative(projectPath, absolute)), absolute, text: readSource(absolute) };
}

// The project-relative `/` path of a request, or undefined when it is empty, absolute, or climbs out.
function cleanRelative(input: string): string | undefined {
  const rel = input.replaceAll('\\', '/');
  const segments = rel.split('/');
  if (rel.length === 0 || rel.startsWith('/') || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return undefined;
  }
  return rel;
}

function failure(code: ComponentOpErrorCode, message: string): Failure {
  return err({ code, message });
}

function toPosix(file: string): string {
  return file.split(path.sep).join('/');
}
