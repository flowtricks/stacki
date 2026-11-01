import { parsePageOrder } from './pageOrder';
import { COMPONENT_SOURCE_FILE, parseComponentSources } from './componentSources';
import { validateGuidePreferences } from './guidePreferences';
import { parsePublishSource } from '../properties/publishConfig';
// Only these reviewed project files are exposed through the metadata transport.
import { object, optional, record, text, boolean } from '../core/boundary';
import { parseComponentDefaults, DEFAULT_LIMITS } from './componentDefaults';
import type { Result } from '../core/result';
import { parseStyleKeepList } from './styleKeepList';

export const METADATA_FILES = {
  componentSources: COMPONENT_SOURCE_FILE,
  components: '.stacki/components.json',
  guide: '.stacki/guide.json',
  pages: '.stacki/pages.json',
  publish: '.stacki/publish.json',
  styles: '.stacki/styles.json',
} as const;
export type MetadataKind = keyof typeof METADATA_FILES;
export interface MetadataFile {
  readonly source?: string;
}
export function metadataKind(input: unknown): MetadataKind {
  if (input === 'componentSources') {
    return input;
  }
  if (input === 'components' || input === 'guide' || input === 'publish' || input === 'pages' || input === 'styles') {
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
