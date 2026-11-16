// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// Every `.stacki` file the CLI can edit, by name, and every one it will never touch. This is the list the coverage test walks:
// a file the app writes that is in neither list fails it (test/shared/properties/cli/stackiSchemaCoverage.test.ts).
import { toRecord } from '../../core/record';
import { err, ok, type Result } from '../../core/result';
import { validateMetadata, type MetadataKind } from '../projectMetadata';
import type { CliError } from './stackiOutput';
import type { FileSchema, UnsettableEntry } from './stackiSchema';
import { AUDITS_FILE } from './files/auditsFile';
import { APPS_FILE } from './files/appsFile';
import { APP_SETTINGS_FILE } from './files/appSettingsFile';
import { BREAKPOINT_SYNC_FILE } from './files/breakpointSyncFile';
import { BREAKPOINTS_FILE } from './files/breakpointsFile';
import { COMPONENT_SOURCES_FILE } from './files/componentSourcesFile';
import { COMPONENTS_FILE } from './files/componentsFile';
import { FOLDERS_FILE } from './files/foldersFile';
import { GUIDE_FILE } from './files/guideFile';
import { INSTRUCTIONS_FILE } from './files/instructionsFile';
import { PAGES_FILE } from './files/pagesFile';
import { PUBLISH_FILE } from './files/publishFile';
import { ROLES_FILE } from './files/rolesFile';
import { STYLES_FILE } from './files/stylesFile';
import { VARIABLES_FILE } from './files/variablesFile';

export const STACKI_FILES: readonly FileSchema[] = [
  AUDITS_FILE,
  APPS_FILE,
  APP_SETTINGS_FILE,
  BREAKPOINT_SYNC_FILE,
  BREAKPOINTS_FILE,
  COMPONENT_SOURCES_FILE,
  COMPONENTS_FILE,
  FOLDERS_FILE,
  GUIDE_FILE,
  INSTRUCTIONS_FILE,
  PAGES_FILE,
  PUBLISH_FILE,
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

export function fileSchemaById(id: string): FileSchema | undefined {
  return STACKI_FILES.find((file) => file.id === id);
}

export function fileSchemaByPath(file: string): FileSchema | undefined {
  return STACKI_FILES.find((entry) => entry.file === file);
}

export function isMetadataKind(kind: string | undefined): kind is MetadataKind {
  return kind !== undefined && STACKI_FILES.some((file) => file.metadataKind === kind);
}

/** The app's own parser applied to finished text: the reason it refuses, or undefined. Throws nothing. */
export function refusalOfSource(file: FileSchema, source: string): string | undefined {
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
  return file.serialize === undefined ? `${JSON.stringify(document, undefined, 2)}\n` : file.serialize(document);
}

/** A document read from text: the object, or why the file is not one. */
export function parseDocumentText(file: FileSchema, source: string): Result<Record<string, unknown>, CliError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error: unknown) {
    return err({ code: 'invalid-file', message: `${file.file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` });
  }
  const record = toRecord(parsed);
  return record === undefined ? err({ code: 'invalid-file', message: `${file.file} is not a JSON object` }) : ok(record);
}
