import { parsePageOrder } from './pageOrder';
import { COMPONENT_SOURCE_FILE, parseComponentSources } from './componentSources';
import { validateGuidePreferences } from './guidePreferences';
import { parsePublishSource } from '../properties/publishConfig';
// Only these reviewed project files are exposed through the metadata transport.
import { object, optional, record, text, boolean } from '../core/boundary';
import { parseComponentDefaults, DEFAULT_LIMITS } from './componentDefaults';
import type { Result } from '../core/result';
import { parseStyleKeepList } from './styleKeepList';
import { PROJECT_FOLDERS_FILE, parseProjectFolders } from './projectFolders';
import { ROLES_FILE, parseProjectRolesSource } from './projectRoles';
import { INSTRUCTIONS_FILE, parseInstructionSettings } from './instructions';
import { AUDIT_IGNORES_FILE, parseAuditIgnores } from './auditIgnores';
import { VARIABLE_VISIBILITY_FILE, parseVariableVisibilitySource } from './variableVisibility';

export const METADATA_FILES = {
  audits: AUDIT_IGNORES_FILE,
  componentSources: COMPONENT_SOURCE_FILE,
  components: '.stacki/components.json',
  folders: PROJECT_FOLDERS_FILE,
  guide: '.stacki/guide.json',
  instructions: INSTRUCTIONS_FILE,
  pages: '.stacki/pages.json',
  publish: '.stacki/publish.json',
  roles: ROLES_FILE,
  styles: '.stacki/styles.json',
  variables: VARIABLE_VISIBILITY_FILE,
} as const;
export type MetadataKind = keyof typeof METADATA_FILES;
export interface MetadataFile {
  readonly source?: string;
}
export function metadataKind(input: unknown): MetadataKind {
  if (input === 'componentSources') {
    return input;
  }
  if (
    input === 'components' ||
    input === 'guide' ||
    input === 'publish' ||
    input === 'pages' ||
    input === 'styles' ||
    input === 'folders' ||
    input === 'roles' ||
    input === 'instructions' ||
    input === 'audits' ||
    input === 'variables'
  ) {
    return input;
  }
  throw new Error('Unknown project metadata file');
}
export function metadataSource(input: unknown): string {
  const source = text(input);
  if (source.length > DEFAULT_LIMITS.sourceCharsMax) {
    throw new Error('Project metadata exceeds 256 KiB');
  }
  return source;
}
export const parseMetadataFile = object({ source: optional(metadataSource) });
export const parseMetadataWrite = object({
  kind: metadataKind,
  source: metadataSource,
  base: optional(metadataSource),
});
export function parseMetadataResult(input: unknown): Result<MetadataFile> {
  const value = record(input);
  if (boolean(value['ok'])) {
    return { ok: true, value: parseMetadataFile(value['value']) };
  }
  const error = object({ code: text, message: text })(value['error']);
  return { ok: false, error };
}
export function validateMetadata(kind: MetadataKind, source: string): void {
  metadataSource(source);
  if (kind === 'publish') {
    parsePublishSource(source);
    return;
  }
  if (kind === 'roles') {
    parseProjectRolesSource(source);
    return;
  }
  if (kind === 'variables') {
    // Writes of a file the parser refuses never reach disk: a failure is thrown to the transport like the others.
    const parsed = parseVariableVisibilitySource(source);
    if (!parsed.ok) {
      throw new Error(parsed.error.message);
    }
    return;
  }
  const input: unknown = JSON.parse(source);
  if (kind === 'componentSources') {
    parseComponentSources(input);
    return;
  }
  if (kind === 'pages') {
    parsePageOrder(input);
    return;
  }
  if (kind === 'styles') {
    parseStyleKeepList(input);
    return;
  }
  if (kind === 'folders') {
    parseProjectFolders(input);
    return;
  }
  if (kind === 'instructions') {
    parseInstructionSettings(input);
    return;
  }
  if (kind === 'audits') {
    parseAuditIgnores(input);
    return;
  }
  if (kind === 'components') {
    parseComponentDefaults(input);
  } else {
    const value = record(input);
    if (value['version'] !== 1) {
      throw new Error('Unsupported guide settings version');
    }
    validateGuidePreferences(value['settings']);
  }
}
