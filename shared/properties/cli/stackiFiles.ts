// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// Every `.stacki` file the CLI can edit, by name, and every one it will never touch. This is the list the coverage test walks:
// a file the app writes that is in neither list fails it (test/shared/properties/cli/stackiSchemaCoverage.test.ts).
import { assert } from '../../core/assert';
import { toRecord } from '../../core/record';
import { err, ok, type Result } from '../../core/result';
import { validateMetadata, type MetadataKind } from '../projectMetadata';
import type { CliError } from './stackiOutput';
import type { DomainFolderEntry, FileSchema, UnsettableEntry } from './stackiSchema';
import { AUDITS_FILE } from './files/auditsFile';
import { APPS_FILE } from './files/appsFile';
import { APP_SETTINGS_FILE } from './files/appSettingsFile';
import { BREAKPOINT_SYNC_FILE } from './files/breakpointSyncFile';
import { BREAKPOINTS_FILE } from './files/breakpointsFile';
import { CLI_FILE } from './files/cliFile';
import { COMPONENT_CANVAS_FILE_SCHEMA } from './files/componentCanvasFile';
import { COMPONENT_SOURCES_FILE } from './files/componentSourcesFile';
import { COMPONENTS_FILE } from './files/componentsFile';
import { FOLDERS_FILE } from './files/foldersFile';
import { GUIDE_FILE } from './files/guideFile';
import { INSTRUCTIONS_FILE } from './files/instructionsFile';
import { PAGES_FILE } from './files/pagesFile';
import { PUBLISH_FILE } from './files/publishFile';
import { PUBLISH_DESTINATIONS_FILE } from './files/publishDestinationsFile';
import { ROLES_FILE } from './files/rolesFile';
import { STYLES_FILE } from './files/stylesFile';
import { VARIABLES_FILE } from './files/variablesFile';

export const STACKI_FILES: readonly FileSchema[] = [
  AUDITS_FILE,
  APPS_FILE,
  APP_SETTINGS_FILE,
  BREAKPOINT_SYNC_FILE,
  BREAKPOINTS_FILE,
  CLI_FILE,
  COMPONENT_CANVAS_FILE_SCHEMA,
  COMPONENT_SOURCES_FILE,
  COMPONENTS_FILE,
  FOLDERS_FILE,
  GUIDE_FILE,
  INSTRUCTIONS_FILE,
  PAGES_FILE,
  PUBLISH_FILE,
  PUBLISH_DESTINATIONS_FILE,
  ROLES_FILE,
  STYLES_FILE,
  VARIABLES_FILE,
];

/** The `.stacki` entries the CLI never reads, prints or writes, each with the reason. */
export const STACKI_UNSETTABLE: readonly UnsettableEntry[] = [
  { path: '.stacki/preview/', reason: 'Generated preview checkouts: rebuilt by the app, ignored by git.' },
  { path: '.stacki/canvas/', reason: 'Generated defaults-preview canvases: created and removed by the app, ignored by git.' },
  { path: '.stacki/io/', reason: 'Write staging and lock files of the document actors, and the CLI undo journal: not settings.' },
  { path: '.stacki/studio/', reason: 'Studio server state (workspace git, uploads, drafts, update staging): machine state of one running Studio.' },
  { path: '.stacki/studio-app-secrets/', reason: 'App secrets and tokens: secret-bearing, never read, printed or written by the CLI.' },
  { path: '.stacki/studio-media/', reason: 'Media account connections: secret-bearing credentials, never read, printed or written by the CLI.' },
  { path: '.stacki/studio-cms/', reason: 'CMS connection credentials (Sanity, EmDash): secret-bearing, never read, printed or written by the CLI.' },
  { path: '.stacki/studio-app-storage/', reason: 'Per-app stored data written by installed apps at runtime: app data, not project settings.' },
  {
    path: '.stacki/apps/',
    reason:
      'Installed app bundles (.stacki/apps/<id>/: the app\'s own code and assets): only "apps add" and "apps remove" install or remove them; apps.json and settings.json beside them are settable files.',
  },
  {
    path: '.stacki/cms.json',
    reason:
      'CMS field-type notes written by the CMS panel as an untyped map with no parser in the app: the CLI will not write data the app cannot validate. Needs an app-side parser first.',
  },
  { path: '.stacki/app-data/', reason: 'Per-app stored data written by installed apps at runtime: app data, not project settings.' },
];

/** The `.stacki` folders only domain commands change: `config` refuses them and names the commands instead. */
export const STACKI_DOMAIN_FOLDERS: readonly DomainFolderEntry[] = [
  {
    path: '.stacki/agents/',
    description:
      'Paired agents (one <name>.json each, shared/properties/projectAgents.ts). Each is the source of two generated files (.claude/agents/<name>.md, .codex/agents/<name>.toml) that a raw write would leave stale, so the agents commands write all three with the generator Settings > Agents uses.',
    requires: 'instructions:edit',
    commands: ['agents create', 'agents sync', 'agents delete'],
    generates: ['.claude/agents/', '.codex/agents/'],
  },
];

/** The domain folder `file` (project-relative) lies in, or is generated from; undefined for any other path. */
export function domainFolderOf(file: string): DomainFolderEntry | undefined {
  assert(file.length >= 0, 'A path has a length');
  return STACKI_DOMAIN_FOLDERS.find((entry) => file.startsWith(entry.path) || entry.generates.some((folder) => file.startsWith(folder)));
}

// ----- Files installed apps declare -----
//
// Why module state: the registry is the one list `stacki schema`, `stacki config`, `stacki doctor` and the MCP schema resources read, and the
// files an app declares exist only for one project (the apps installed, enabled and trusted there). Every entry point sets the list at the start
// of its run from that project's enabled apps (`loadExtensions`, `runCommand`), and the MCP session reloads it on every call, so tools/list and the
// schema resources follow an install, a removal or an `apps disable` between two calls. A run never reads another run's list: it replaces it first.
// The core list, STACKI_FILES, never changes, and an app file can never take a core id or path.
export const APP_FILE_LIMITS = {
  /** Files one app declares. */
  perAppMax: 8,
  /** Files all apps declare together: the apps bound times the per-app bound. */
  totalMax: 50 * 8,
  /** Folders under `.stacki/apps/<id>/` a declared file may sit in. */
  depthMax: 4,
  /** The name after `<appId>.` in a file id. */
  nameCharsMax: 32,
} as const satisfies Record<string, number>;

const APP_FILE_NAME = /^[a-z][a-z0-9-]*$/;
const APP_FILE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const APP_OWN_FILES = new Set(['stacki-app.json', 'package.json']);

let appFiles: readonly FileSchema[] = [];

/** Why `file` cannot be the path of a settings file `appId` declares, or undefined: its own folder or `.stacki/<appId>.json`, never a core path. */
export function appFilePathProblem(appId: string, file: string): string | undefined {
  assert(appId.length > 0, 'An app has an id');
  const own = `.stacki/${appId}.json`;
  const folder = `.stacki/apps/${appId}/`;
  if (file !== own && !file.startsWith(folder)) {
    return `${file} is outside ${folder} and is not ${own}`;
  }
  if (STACKI_FILES.some((entry) => entry.file === file)) {
    return `${file} is a core Stacki path`;
  }
  if (file === own) {
    // `.stacki/<appId>.json` must not be one of the app-owned paths the CLI never touches (`.stacki/cms.json`); the app's own folder is under
    // `.stacki/apps/`, which the unsettable list names as a whole for the bundles, so only this form is compared with it.
    return STACKI_UNSETTABLE.some((entry) => file === entry.path || file.startsWith(entry.path)) ? `${file} is a path the CLI never touches` : undefined;
  }
  const segments = file.slice(folder.length).split('/');
  if (segments.length > APP_FILE_LIMITS.depthMax || !segments.every((segment) => APP_FILE_SEGMENT.test(segment))) {
    return `${file} must sit at most ${APP_FILE_LIMITS.depthMax} folders deep, with plain names`;
  }
  const last = segments[segments.length - 1] ?? '';
  if (!last.endsWith('.json') || APP_OWN_FILES.has(last)) {
    return `${file} must be a .json file other than the app's own manifest`;
  }
  return undefined;
}

/** Why `file` cannot be registered as an app's, or undefined: the checks every app file passes at load, the same for any app. */
export function appFileProblem(file: FileSchema): string | undefined {
  assert(file.id.length > 0, 'A file has an id');
  const appId = file.appId;
  if (appId === undefined) {
    return `${file.id} names no app`;
  }
  const name = file.id.startsWith(`${appId}.`) ? file.id.slice(appId.length + 1) : undefined;
  if (name === undefined || name.length > APP_FILE_LIMITS.nameCharsMax || !APP_FILE_NAME.test(name)) {
    return `file id "${file.id}" must be "${appId}.<name>" with a lowercase name of at most ${APP_FILE_LIMITS.nameCharsMax} characters`;
  }
  if (STACKI_FILES.some((entry) => entry.id === file.id)) {
    return `file id "${file.id}" is a core file id`;
  }
  if (file.validate === undefined) {
    return `${file.id} has no validator`;
  }
  return appFilePathProblem(appId, file.file);
}

/**
 * Replaces the app files of this run. Throws when a file breaks a rule `appFileProblem` states or ids or paths repeat: the loader checked them
 * first and refused the app, so a failure here is a bug in the loader, not a bad app.
 */
export function registerAppFiles(files: readonly FileSchema[]): void {
  assert(files.length >= 0, 'Registered files are a list');
  if (files.length > APP_FILE_LIMITS.totalMax) {
    throw new Error(`Assertion failed: at most ${APP_FILE_LIMITS.totalMax} app files`);
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const file of files) {
    const problem = appFileProblem(file);
    if (problem !== undefined) {
      throw new Error(`Assertion failed: app file ${file.id}: ${problem}`);
    }
    if (ids.has(file.id) || paths.has(file.file)) {
      throw new Error(`Assertion failed: app file ${file.id} repeats an id or a path`);
    }
    ids.add(file.id);
    paths.add(file.file);
  }
  appFiles = [...files];
}

export function clearAppFiles(): void {
  assert(allFiles().length >= 0, 'The registry is a list');
  appFiles = [];
}

/** The core files, then the files of the apps enabled in this run's project. */
export function allFiles(): readonly FileSchema[] {
  assert(STACKI_FILES.length > 0, 'The registry holds the core files');
  return appFiles.length === 0 ? STACKI_FILES : [...STACKI_FILES, ...appFiles];
}

export function fileSchemaById(id: string): FileSchema | undefined {
  assert(id.length >= 0, 'An id has a length');
  return allFiles().find((file) => file.id === id);
}

export function fileSchemaByPath(file: string): FileSchema | undefined {
  assert(file.length >= 0, 'A path has a length');
  return allFiles().find((entry) => entry.file === file);
}

export function isMetadataKind(kind: string | undefined): kind is MetadataKind {
  assert(allFiles().length > 0, 'The registry is not empty');
  return kind !== undefined && STACKI_FILES.some((file) => file.metadataKind === kind);
}

/** The app's own parser applied to finished text: the reason it refuses, or undefined. Throws nothing. */
export function refusalOfSource(file: FileSchema, source: string): string | undefined {
  assert(file.file.startsWith('.stacki/'), 'A file is under .stacki');
  try {
    if (isMetadataKind(file.metadataKind)) {
      validateMetadata(file.metadataKind, source);
    } else if (file.validate !== undefined) {
      file.validate(source);
    } else {
      return `${file.file} has no parser to check it with`;
    }
    return undefined;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The text the app would write for `document`: its canonical writer when it has one, otherwise two-space JSON. */
export function serializeDocument(file: FileSchema, document: Record<string, unknown>): string {
  assert(file.file.startsWith('.stacki/'), 'A file is under .stacki');
  return file.serialize === undefined ? `${JSON.stringify(document, undefined, 2)}\n` : file.serialize(document);
}

/** A document read from text: the object, or why the file is not one. */
export function parseDocumentText(file: FileSchema, source: string): Result<Record<string, unknown>, CliError> {
  assert(file.file.startsWith('.stacki/'), 'A file is under .stacki');
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error: unknown) {
    return err({ code: 'invalid-file', message: `${file.file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` });
  }
  const record = toRecord(parsed);
  return record === undefined ? err({ code: 'invalid-file', message: `${file.file} is not a JSON object` }) : ok(record);
}
