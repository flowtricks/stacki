// Reading the installed apps of one project for the CLI: which of them add commands, in what state, and why an app that does not is off.
//
// What makes an app's commands load (all of it, every run, from the files on disk, so an install, an update or `apps disable` takes effect on the
// next call and an MCP session never serves a stale tool list):
//   1. the app is installed: a lock entry in `.stacki/apps/apps.json` and a real folder `.stacki/apps/<id>/` with a readable manifest;
//   2. its manifest `cli` section parses (shared/properties/cli/stackiAppCli.ts) and its commands collide with no core command and no other app;
//   3. `.stacki/cli.json` holds a record for it with `enabled` and `trusted` and the SAME lock digest the lock holds now (an update changes it).
// An app that fails 1 or 2 still loads as an app; only its commands are off, with the reason `stacki apps commands` shows.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { toRecord } from '../../../shared/core/record';
import type { AppPermissionDeclaration } from '../../../shared/properties/appPermissions';
import {
  APP_LIMITS,
  APP_MANIFEST_FILE,
  APPS_DIRECTORY,
  APPS_LOCK_FILE,
  parseAppManifestSource,
  readAppsLockEntries,
  type AppLockEntry,
} from '../../../shared/properties/apps';
import { appCommandSpec, appFileSchema, parseAppCliSection, type AppCliCommand, type AppCliSection } from '../../../shared/properties/cli/stackiAppCli';
import { COMMANDS, toolNameOf, type CommandSpec } from '../../../shared/properties/cli/stackiCommands';
import { appFileProblem } from '../../../shared/properties/cli/stackiFiles';
import { CLI_SETTINGS_FILE, readCliSettings, type CliAppRecord } from '../../../shared/properties/cli/files/cliFile';
import type { FileSchema } from '../../../shared/properties/cli/stackiSchema';

/** Why an app's commands are on or off. `none` is an app that declares no `cli` section. */
export type AppCliState =
  | { readonly kind: 'none' }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'disabled'; readonly reason: string }
  | { readonly kind: 'untrusted'; readonly reason: string }
  | { readonly kind: 'active' };

export interface LoadedApp {
  readonly id: string;
  readonly version: string;
  /** The lock digest now. */
  readonly sha256: string;
  /** The absolute, resolved app folder. */
  readonly folder: string;
  readonly state: AppCliState;
  readonly section: AppCliSection | undefined;
  /** Rows of the commands it declares, whatever the state, so a disabled app's command line still parses and is refused with the reason. */
  readonly specs: readonly CommandSpec[];
  readonly permissions: readonly AppPermissionDeclaration[];
  /** The registry entries of its declared files; registered only while the app is active. */
  readonly files: readonly FileSchema[];
  /** What `.stacki/cli.json` records for it, when it does. */
  readonly record: CliAppRecord | undefined;
}

export interface ProjectApps {
  readonly apps: readonly LoadedApp[];
  /** Why the lock or `cli.json` could not be read at all; commands of every app are off while this holds. */
  readonly failure: string | undefined;
}

const READ_LIMITS = { manifestBytesMax: APP_LIMITS.manifestBytesMax, settingsBytesMax: 64 * 1024 } as const;

/** The first words of the core commands: an app id equal to one would shadow it, or be mistaken for a prefix of it. */
const CORE_NAMESPACES: ReadonlySet<string> = new Set(COMMANDS.map((spec) => spec.words[0] ?? ''));

/** A small text file read without following a link, or why it cannot be. `undefined` text means the file is absent. */
function readSmallText(file: string, bytesMax: number): { readonly text: string | undefined } | { readonly problem: string } {
  try {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat === undefined) {
      return { text: undefined };
    }
    if (!stat.isFile()) {
      return { problem: `${path.basename(file)} is not a plain file (a link or a folder is not followed)` };
    }
    if (stat.size > bytesMax) {
      return { problem: `${path.basename(file)} is larger than ${bytesMax} bytes` };
    }
    return { text: fs.readFileSync(file, 'utf8') };
  } catch (error: unknown) {
    return { problem: `${path.basename(file)} could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function loadProjectApps(root: string): ProjectApps {
  const lock = readSmallText(path.join(root, APPS_LOCK_FILE), APP_LIMITS.lockBytesMax);
  if ('problem' in lock) {
    return { apps: [], failure: lock.problem };
  }
  if (lock.text === undefined) {
    return { apps: [], failure: undefined };
  }
  const reading = readAppsLockEntries(lock.text);
  const settingsText = readSmallText(path.join(root, CLI_SETTINGS_FILE), READ_LIMITS.settingsBytesMax);
  const settings = 'problem' in settingsText ? ({ kind: 'invalid', reason: settingsText.problem } as const) : readCliSettings(settingsText.text);
  const loaded: LoadedApp[] = [];
  const accepted = new Map<string, LoadedApp>();
  for (const entry of [...reading.lock.apps].sort((first, second) => (first.id < second.id ? -1 : 1))) {
    const app = loadApp(root, entry, settings, accepted);
    loaded.push(app);
    if (app.section !== undefined && app.state.kind !== 'refused') {
      accepted.set(app.id, app);
    }
  }
  for (const [id, reason] of reading.entryFailures) {
    loaded.push(blankApp(id, { kind: 'refused', reason }));
  }
  return { apps: loaded.sort((first, second) => (first.id < second.id ? -1 : 1)), failure: reading.fileFailure };
}

function blankApp(id: string, state: AppCliState): LoadedApp {
  return { id, version: '', sha256: '', folder: '', state, section: undefined, specs: [], permissions: [], files: [], record: undefined };
}

function loadApp(root: string, entry: AppLockEntry, settings: ReturnType<typeof readCliSettings>, accepted: ReadonlyMap<string, LoadedApp>): LoadedApp {
  const base = { id: entry.id, version: entry.version, sha256: entry.sha256 };
  const folder = path.join(root, APPS_DIRECTORY, entry.id);
  const stat = fs.lstatSync(folder, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isDirectory()) {
    return {
      ...blankApp(entry.id, { kind: 'refused', reason: `${APPS_DIRECTORY}/${entry.id}/ is missing or is a link: the lock lists an app that is not installed` }),
      ...base,
    };
  }
  const resolved = fs.realpathSync(folder);
  const manifestText = readSmallText(path.join(resolved, APP_MANIFEST_FILE), READ_LIMITS.manifestBytesMax);
  if ('problem' in manifestText || manifestText.text === undefined) {
    const reason = 'problem' in manifestText ? manifestText.problem : `${APP_MANIFEST_FILE} is missing`;
    return { ...blankApp(entry.id, { kind: 'refused', reason }), ...base, folder: resolved };
  }
  let permissions: readonly AppPermissionDeclaration[];
  let section: unknown;
  try {
    const manifest = parseAppManifestSource(manifestText.text);
    if (manifest.id !== entry.id) {
      throw new Error(`${APP_MANIFEST_FILE} names the app "${manifest.id}", not "${entry.id}"`);
    }
    permissions = manifest.permissions;
    const raw: unknown = JSON.parse(manifestText.text);
    section = toRecord(raw)?.['cli'];
  } catch (error: unknown) {
    return { ...blankApp(entry.id, { kind: 'refused', reason: error instanceof Error ? error.message : String(error) }), ...base, folder: resolved };
  }
  const parsed = parseAppCliSection({ appId: entry.id, section, permissionIds: permissions.map((permission) => permission.id) });
  if (parsed.kind === 'none') {
    return { ...blankApp(entry.id, { kind: 'none' }), ...base, folder: resolved, permissions };
  }
  if (parsed.kind === 'refused') {
    return { ...blankApp(entry.id, { kind: 'refused', reason: parsed.reason }), ...base, folder: resolved, permissions };
  }
  const specs = parsed.section.commands.map((command) => appCommandSpec(entry.id, command));
  const files = parsed.section.files.map((file) =>
    appFileSchema(
      entry.id,
      file,
      parsed.section.commands.filter((command) => command.owns.some((own) => own.file === file.id)).map((command) => command.name),
    ),
  );
  const conflict = conflictOf(entry.id, specs, files, accepted);
  if (conflict !== undefined) {
    return { ...blankApp(entry.id, { kind: 'refused', reason: conflict }), ...base, folder: resolved, permissions };
  }
  const record = settings.kind === 'ready' ? settings.apps.get(entry.id) : undefined;
  return {
    ...base,
    folder: resolved,
    state: stateOf(entry, record, settings),
    section: parsed.section,
    specs,
    permissions,
    files,
    record,
  };
}

function stateOf(entry: AppLockEntry, record: CliAppRecord | undefined, settings: ReturnType<typeof readCliSettings>): AppCliState {
  if (settings.kind === 'invalid') {
    return { kind: 'untrusted', reason: `${settings.reason}; fix it or run "stacki apps enable ${entry.id}"` };
  }
  if (record === undefined || !record.enabled) {
    return { kind: 'disabled', reason: `The app's commands are off in this project: run "stacki apps enable ${entry.id}" as an admin.` };
  }
  if (!record.trusted) {
    return { kind: 'untrusted', reason: `${CLI_SETTINGS_FILE} has the app enabled but not trusted: run "stacki apps enable ${entry.id}".` };
  }
  if (record.sha256 !== entry.sha256) {
    return {
      kind: 'untrusted',
      reason: `The app changed since it was trusted (lock digest ${entry.sha256.slice(0, 12)}, trusted ${record.sha256.slice(0, 12)}): review it, then run "stacki apps enable ${entry.id}" again.`,
    };
  }
  return { kind: 'active' };
}

/** Why the commands or files of `appId` cannot load next to the core and the apps already accepted, or undefined. Names both sides. */
function conflictOf(appId: string, specs: readonly CommandSpec[], files: readonly FileSchema[], accepted: ReadonlyMap<string, LoadedApp>): string | undefined {
  if (CORE_NAMESPACES.has(appId)) {
    const core = COMMANDS.find((spec) => spec.words[0] === appId);
    return `The app id "${appId}" is the namespace of the core command "stacki ${core?.words.join(' ') ?? appId}": an app's commands live under its own id, so this app's commands are off.`;
  }
  for (const spec of specs) {
    const core = COMMANDS.find((candidate) => candidate.words.join(' ') === spec.words.join(' ') || toolNameOf(candidate) === toolNameOf(spec));
    if (core !== undefined) {
      return `"stacki ${spec.words.join(' ')}" collides with the core command "stacki ${core.words.join(' ')}".`;
    }
    for (const other of accepted.values()) {
      const clash = other.specs.find((candidate) => candidate.words.join(' ') === spec.words.join(' ') || toolNameOf(candidate) === toolNameOf(spec));
      if (clash !== undefined) {
        return `"stacki ${spec.words.join(' ')}" collides with "stacki ${clash.words.join(' ')}" of the app "${other.id}".`;
      }
    }
  }
  for (const file of files) {
    const problem = appFileProblem(file);
    if (problem !== undefined) {
      return `The settings file ${file.id} is refused: ${problem}.`;
    }
    for (const other of accepted.values()) {
      if (other.files.some((candidate) => candidate.id === file.id || candidate.file === file.file)) {
        return `The settings file ${file.id} (${file.file}) collides with a file of the app "${other.id}".`;
      }
    }
  }
  return undefined;
}

/** The commands of an app, by name. */
export function commandNamed(app: LoadedApp, name: string): AppCliCommand | undefined {
  return app.section?.commands.find((command) => command.name === name);
}
