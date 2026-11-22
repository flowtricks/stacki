// Upgrading an installed Studio from Settings: which version is newer, which files the upgrade replaces
// that the project had changed, and what the box offers. One pure module, used by Desktop's main process (which
// reads the disk and the release feed) and by the renderer (which draws the answer).
//
// What an upgrade does is fixed by Studio's updater (studio/docs/releases.md): it stages the new release, then
// replaces the whole `studio/` folder, keeping only the retained paths (`retainedPath`: `cloudflare/`, `.studio`,
// `.wrangler`, `.studio-state` and `.env*` / `.dev.vars*`). Nothing is merged, and the previous folder is kept
// whole under `.stacki/studio/updates`. So a project's own changes are never a reason to refuse: they are backed
// up first and the upgrade goes ahead. A "changed file" is only what the person may want to look at afterwards:
//   - modifiedFile: a Studio file whose content differs from the release the project installed.
//   - addedFile:    a file the release does not contain, outside the retained paths (the upgrade drops it).
//   - removedFile:  a file the release contains that the project deleted (the upgrade brings it back).
// Generated folders (`node_modules`, `dist`) are rebuilt by the install and never count.
import { assert } from '../core/assert';
import { list, record, text } from '../core/boundary';
import { retainedPath } from './studioRelease';

export const STUDIO_UPGRADE_LIMITS = {
  /** Changed files named to the person; the rest are counted. */
  changesListedMax: 25,
  /** Files read from an installed Studio before the scan gives up (the note then says nothing about changes). */
  filesScannedMax: 6000,
  /** Bytes read across those files for the same reason. */
  bytesScannedMax: 64_000_000,
  versionCharsMax: 40,
  pathCharsMax: 500,
  backupNameCharsMax: 120,
} as const;

/** Top-level folders the install regenerates; they never count as changes. */
export const STUDIO_GENERATED_ROOTS = ['node_modules', 'dist', 'test-results'] as const;
/** Where the last upgrade is recorded, inside the updater's own folder (`.stacki/studio/updates`). */
export const STUDIO_UPGRADE_MANIFEST = 'last-upgrade.json';

export type StudioVersionOrder = 'behind' | 'current' | 'ahead' | 'invalid';
export type StudioChangeKind = 'modifiedFile' | 'addedFile' | 'removedFile';

export interface StudioChange {
  readonly kind: StudioChangeKind;
  readonly path: string;
}

export interface StudioChangedFiles {
  /** The first `changesListedMax`, in a fixed order: modified, added, removed; by path within a kind. */
  readonly listed: readonly StudioChange[];
  /** Every changed file found, listed or not. */
  readonly total: number;
}

/** What an upgrade left behind: the versions, and the changed files it backed up (undefined when the folder could not be compared). */
export interface StudioUpgradeNote {
  readonly from: string;
  readonly to: string;
  readonly changed: StudioChangedFiles | undefined;
}

export type StudioUpgradeCheck =
  /** Offline, no published release, or a version Stacki cannot compare: the box offers nothing. */
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'current'; readonly version: string; readonly previous: StudioUpgradeNote | undefined }
  | { readonly kind: 'ready'; readonly installed: string; readonly latest: string; readonly previous: StudioUpgradeNote | undefined };

export type StudioUpgradeResult =
  { readonly kind: 'upgraded'; readonly version: string; readonly note: StudioUpgradeNote } | { readonly kind: 'error'; readonly message: string };
export type StudioRestoreResult = { readonly kind: 'restored'; readonly version: string } | { readonly kind: 'error'; readonly message: string };

/** The file `STUDIO_UPGRADE_MANIFEST` holds: which backup folder the note belongs to. */
export interface StudioUpgradeManifest {
  readonly format: 1;
  readonly backup: string;
  readonly note: StudioUpgradeNote;
}

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const BACKUP_NAME_PATTERN = /^backup-[0-9A-Za-z.-]+$/;

/** The three numbers of an exact stable version (`1.4.12`), or undefined for anything else, prereleases and build tags included. */
export function parseStableVersion(input: string): readonly [number, number, number] | undefined {
  if (input.length > STUDIO_UPGRADE_LIMITS.versionCharsMax) {
    return undefined;
  }
  const match = VERSION_PATTERN.exec(input);
  if (!match) {
    return undefined;
  }
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  for (const part of parts) {
    if (!Number.isSafeInteger(part)) {
      return undefined;
    }
  }
  return parts;
}

/** How the installed version stands against the latest published one; `invalid` when either is not an exact stable version. */
export function compareStudioVersions(installed: string, latest: string): StudioVersionOrder {
  const have = parseStableVersion(installed);
  const want = parseStableVersion(latest);
  if (have === undefined || want === undefined) {
    return 'invalid';
  }
  for (let index = 0; index < have.length; index += 1) {
    const before = have[index];
    const after = want[index];
    assert(before !== undefined, 'A parsed version has three parts');
    assert(after !== undefined, 'A parsed version has three parts');
    if (after > before) {
      return 'behind';
    }
    if (after < before) {
      return 'ahead';
    }
  }
  return 'current';
}

function isGeneratedPath(file: string): boolean {
  const first = file.split('/')[0] ?? '';
  return STUDIO_GENERATED_ROOTS.some((root) => root === first);
}

/**
 * The files an upgrade would replace that the project had changed. `pristine` maps each file of the release the project
 * installed to a digest of its content; `installed` maps every file found in the project's `studio/` folder the same way.
 * Paths are POSIX, relative to `studio/`. Retained and generated paths are skipped: the updater keeps or rebuilds them.
 */
export function detectChangedFiles(input: {
  readonly pristine: ReadonlyMap<string, string>;
  readonly installed: ReadonlyMap<string, string>;
}): StudioChangedFiles {
  assert(input.pristine.size > 0, 'A release always carries files');
  const modified: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [file, digest] of input.installed) {
    if (retainedPath(file) || isGeneratedPath(file)) {
      continue;
    }
    const expected = input.pristine.get(file);
    if (expected === undefined) {
      added.push(file);
    } else if (expected !== digest) {
      modified.push(file);
    }
  }
  for (const file of input.pristine.keys()) {
    if (!input.installed.has(file)) {
      removed.push(file);
    }
  }
  const changes: StudioChange[] = [];
  for (const [kind, files] of [
    ['modifiedFile', modified],
    ['addedFile', added],
    ['removedFile', removed],
  ] as const) {
    for (const path of [...files].sort()) {
      changes.push({ kind, path });
    }
  }
  const listed = changes.slice(0, STUDIO_UPGRADE_LIMITS.changesListedMax);
  assert(listed.length <= changes.length, 'The listed changes are a prefix of all of them');
  return { listed, total: changes.length };
}

/** What the box offers: nothing, "up to date", or one upgrade. A project's own changes never change this answer. */
export function decideUpgrade(input: {
  readonly installed: string;
  readonly latest: string | undefined;
  readonly previous: StudioUpgradeNote | undefined;
}): StudioUpgradeCheck {
  if (input.latest === undefined) {
    return { kind: 'unavailable' };
  }
  const order = compareStudioVersions(input.installed, input.latest);
  switch (order) {
    case 'invalid':
      return { kind: 'unavailable' };
    case 'current':
    case 'ahead':
      return { kind: 'current', version: input.installed, previous: input.previous };
    case 'behind':
      return { kind: 'ready', installed: input.installed, latest: input.latest, previous: input.previous };
    default: {
      const exhaustive: never = order;
      return exhaustive;
    }
  }
}

/** The command that upgrades by hand, from the project folder: Studio's own updater, which `npm create stacki` is not (it leaves an installed Studio alone). */
export function manualUpgradeCommand(latest: string): string {
  assert(parseStableVersion(latest) !== undefined, 'The manual command names an exact stable version');
  return `node studio/dist/cli.mjs update . ${latest} --replace-customizations`;
}

const CHANGE_KINDS = ['modifiedFile', 'addedFile', 'removedFile'] as const;

function parseChange(input: unknown): StudioChange {
  const value = record(input);
  const kind = CHANGE_KINDS.find((candidate) => candidate === value['kind']);
  if (kind === undefined) {
    throw new Error('Invalid Studio changed file');
  }
  const path = text(value['path']);
  if (path.length === 0 || path.length > STUDIO_UPGRADE_LIMITS.pathCharsMax) {
    throw new Error('Invalid Studio changed file path');
  }
  return { kind, path };
}

function parseChanged(input: unknown): StudioChangedFiles {
  const value = record(input);
  const listed = list(parseChange)(value['listed']);
  if (listed.length > STUDIO_UPGRADE_LIMITS.changesListedMax) {
    throw new Error('Too many listed Studio changed files');
  }
  const total = value['total'];
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < listed.length) {
    throw new Error('Invalid Studio changed file total');
  }
  return { listed, total };
}

function parseVersion(input: unknown): string {
  const version = text(input);
  if (parseStableVersion(version) === undefined) {
    throw new Error('Expected an exact stable Studio version');
  }
  return version;
}

export function parseStudioUpgradeNote(input: unknown): StudioUpgradeNote {
  const value = record(input);
  const changed = value['changed'];
  return { from: parseVersion(value['from']), to: parseVersion(value['to']), changed: changed === undefined ? undefined : parseChanged(changed) };
}

function parseOptionalNote(input: unknown): StudioUpgradeNote | undefined {
  return input === undefined ? undefined : parseStudioUpgradeNote(input);
}

export function parseStudioUpgradeCheck(input: unknown): StudioUpgradeCheck {
  const value = record(input);
  switch (value['kind']) {
    case 'unavailable':
      return { kind: 'unavailable' };
    case 'current':
      return { kind: 'current', version: parseVersion(value['version']), previous: parseOptionalNote(value['previous']) };
    case 'ready':
      return {
        kind: 'ready',
        installed: parseVersion(value['installed']),
        latest: parseVersion(value['latest']),
        previous: parseOptionalNote(value['previous']),
      };
    default:
      throw new Error('Invalid Studio upgrade check');
  }
}

export function parseStudioUpgradeResult(input: unknown): StudioUpgradeResult {
  const value = record(input);
  switch (value['kind']) {
    case 'upgraded':
      return { kind: 'upgraded', version: parseVersion(value['version']), note: parseStudioUpgradeNote(value['note']) };
    case 'error':
      return { kind: 'error', message: text(value['message']) };
    default:
      throw new Error('Invalid Studio upgrade result');
  }
}

export function parseStudioRestoreResult(input: unknown): StudioRestoreResult {
  const value = record(input);
  switch (value['kind']) {
    case 'restored':
      return { kind: 'restored', version: parseVersion(value['version']) };
    case 'error':
      return { kind: 'error', message: text(value['message']) };
    default:
      throw new Error('Invalid Studio restore result');
  }
}

/** The backup name is read back from disk and joined to a path, so it must be a plain `backup-…` folder name. */
export function parseStudioUpgradeManifest(input: unknown): StudioUpgradeManifest {
  const value = record(input);
  if (value['format'] !== 1) {
    throw new Error('Unsupported Studio upgrade manifest');
  }
  const backup = text(value['backup']);
  if (backup.length > STUDIO_UPGRADE_LIMITS.backupNameCharsMax || !BACKUP_NAME_PATTERN.test(backup)) {
    throw new Error('Invalid Studio backup name');
  }
  return { format: 1, backup, note: parseStudioUpgradeNote(value['note']) };
}
