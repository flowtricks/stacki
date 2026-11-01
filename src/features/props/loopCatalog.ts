// What a loop can be pointed at, for the Source menu: the project's Astro
// content collections, the document types of its Sanity connection, and each
// one's fields as the filter and sort menus offer them. The CMS panel's own
// reads are reused (remoteSource.ts), so a collection shows here exactly when
// it shows there, with the same field names and choices.

import { assert } from '../../../shared/core/assert';
import { toRecord } from '../../../shared/core/record';
import { ASTRO_CONTENT_ID } from '../../../shared/properties/astroContent';
import type { RemoteSchemaField, RemoteType } from '../../../shared/properties/cmsRemoteSchema';
import type { LoopField, LoopFieldKind, LoopSource, LoopSourceKind } from '../../editor/loopQuery';
import { isFieldPath } from '../../editor/loopQuery';
import { listCmsConnections, remoteReferenceOptions } from '../../ipc/cmsConnectionsBridge';
import { readText } from '../../ipc/bridge';
import { remoteCollections, remoteTemplate } from '../../ipc/remoteSource';

export const LOOP_CATALOG_LIMITS = {
  collectionsMax: 200,
  fieldsMax: 200,
  optionsMax: 500,
  projectsCachedMax: 8,
  packageCharsMax: 1_000_000,
} as const;

export interface CatalogCollection {
  readonly source: LoopSource;
  readonly title: string;
  readonly count: number | undefined;
}

export type SanityAvailability =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'connected';
      readonly label: string;
      readonly connectionId: string;
      readonly client: 'available' | 'unavailable';
    };

export interface LoopCatalog {
  readonly collections: readonly CatalogCollection[];
  readonly sanity: SanityAvailability;
}

/** A field the menus offer, with the documents a reference may name. */
export interface CatalogField extends LoopField {
  /** The types or collections a reference field points at, whose items are its choices. */
  readonly references: readonly string[];
}

export async function loadCatalog(projectPath: string): Promise<LoopCatalog> {
  const [astro, sanity] = await Promise.all([
    astroCollections(projectPath),
    sanityCatalog(projectPath),
  ]);
  const collections = [...astro, ...sanity.collections].slice(
    0,
    LOOP_CATALOG_LIMITS.collectionsMax,
  );
  assert(collections.length <= LOOP_CATALOG_LIMITS.collectionsMax, 'The catalog is bounded');
  return { collections, sanity: sanity.availability };
}

async function astroCollections(projectPath: string): Promise<readonly CatalogCollection[]> {
  const result = await remoteCollections(projectPath, ASTRO_CONTENT_ID).catch(() => undefined);
  if (!result?.ok) {
    return [];
  }
  return result.value.map((collection) => ({
    source: { kind: 'astro', collection: collection.name },
    title: titled(collection.name),
    count: collection.count,
  }));
}

async function sanityCatalog(projectPath: string): Promise<{
  readonly collections: readonly CatalogCollection[];
  readonly availability: SanityAvailability;
}> {
  const list = await listCmsConnections(projectPath).catch(() => undefined);
  const connection = list?.connections.find((candidate) => candidate.kind === 'sanity');
  if (connection === undefined) {
    return { collections: [], availability: { kind: 'none' } };
  }
  const [result, client] = await Promise.all([
    remoteCollections(projectPath, connection.id).catch(() => undefined),
    sanityClientIn(projectPath),
  ]);
  const collections: CatalogCollection[] = result?.ok
    ? result.value.map((collection) => ({
        source: { kind: 'sanity', collection: collection.name },
        title: titled(collection.name),
        count: collection.count,
      }))
    : [];
  return {
    collections,
    availability: {
      kind: 'connected',
      label: connection.label,
      connectionId: connection.id,
      client,
    },
  };
}

// `sanity:client` exists only with the @sanity/astro integration installed; a
// query importing it anywhere else would fail to build.
async function sanityClientIn(projectPath: string): Promise<'available' | 'unavailable'> {
  const text = await readText(projectPath, 'package.json').catch(() => '');
  return hasDependency(text, '@sanity/astro') ? 'available' : 'unavailable';
}

/** Whether a package.json's text lists `name` as a dependency of either kind. */
export function hasDependency(text: string, name: string): boolean {
  if (text.length === 0 || text.length > LOOP_CATALOG_LIMITS.packageCharsMax) {
    return false;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return false;
  }
  const record = toRecord(manifest);
  const dependencies = toRecord(record?.['dependencies']);
  const development = toRecord(record?.['devDependencies']);
  return typeof dependencies?.[name] === 'string' || typeof development?.[name] === 'string';
}

/** A collection's fields, as the filter and sort menus offer them. */
export async function loadFields(
  projectPath: string,
  catalog: LoopCatalog,
  source: LoopSource,
): Promise<readonly CatalogField[] | undefined> {
  const connectionId = connectionOf(catalog, source.kind);
  if (connectionId === undefined) {
    return undefined;
  }
  const template = await remoteTemplate(projectPath, connectionId, source.collection).catch(
    () => undefined,
  );
  if (!template?.ok) {
    return undefined;
  }
  return catalogFields(template.value.fields, source.kind);
}

/** The documents a reference field may name, as choices. */
export async function loadReferenceChoices(
  projectPath: string,
  catalog: LoopCatalog,
  source: LoopSource,
  types: readonly string[],
): Promise<readonly { readonly title: string; readonly value: string }[]> {
  const connectionId = connectionOf(catalog, source.kind);
  if (connectionId === undefined || source.kind !== 'sanity' || types.length === 0) {
    return [];
  }
  const result = await remoteReferenceOptions(projectPath, connectionId, types).catch(
    () => undefined,
  );
  if (!result?.ok) {
    return [];
  }
  return result.value
    .slice(0, LOOP_CATALOG_LIMITS.optionsMax)
    .map((option) => ({ title: option.title, value: option.id }));
}

function connectionOf(catalog: LoopCatalog, kind: LoopSourceKind): string | undefined {
  if (kind === 'astro') {
    return ASTRO_CONTENT_ID;
  }
  return catalog.sanity.kind === 'connected' ? catalog.sanity.connectionId : undefined;
}

// Sanity documents carry these on every type, as visual builders show
// "Created on" and "Updated on" beside a collection's own fields.
const SANITY_SYSTEM_FIELDS: readonly CatalogField[] = [
  { path: '_createdAt', title: 'Created on', kind: 'date', options: [], references: [] },
  { path: '_updatedAt', title: 'Updated on', kind: 'date', options: [], references: [] },
];

/** A schema's top-level fields as filter and sort fields. */
export function catalogFields(
  fields: readonly RemoteSchemaField[],
  kind: LoopSourceKind,
): readonly CatalogField[] {
  const out: CatalogField[] = [];
  for (const field of fields.slice(0, LOOP_CATALOG_LIMITS.fieldsMax)) {
    const mapped = catalogField(field, kind);
    if (mapped !== undefined && isFieldPath(mapped.path)) {
      out.push(mapped);
    }
  }
  const all = kind === 'sanity' ? [...out, ...SANITY_SYSTEM_FIELDS] : out;
  assert(
    all.length <= LOOP_CATALOG_LIMITS.fieldsMax + SANITY_SYSTEM_FIELDS.length,
    'Catalog fields are bounded',
  );
  return all;
}

function catalogField(field: RemoteSchemaField, source: LoopSourceKind): CatalogField | undefined {
  const type = field.type;
  const base = { title: field.title || titled(field.name), options: [], references: [] };
  switch (type.kind) {
    case 'string':
    case 'text':
    case 'url':
    case 'email': {
      if (type.asset === 'image') {
        return { ...base, path: field.name, kind: 'image' };
      }
      const options = type.options
        .slice(0, LOOP_CATALOG_LIMITS.optionsMax)
        .map((option) => ({ title: option.title, value: option.value }));
      // An Astro choice may be a reference (stored as `{ collection, id }`); the
      // writer compares either by id, so both are offered as a reference.
      const kind: LoopFieldKind = options.length > 0 && source === 'astro' ? 'reference' : 'text';
      return { ...base, path: field.name, kind, options };
    }
    case 'slug':
      return {
        ...base,
        path: source === 'sanity' ? `${field.name}.current` : field.name,
        kind: 'text',
      };
    case 'number':
      return { ...base, path: field.name, kind: 'number' };
    case 'boolean':
      return { ...base, path: field.name, kind: 'boolean' };
    case 'date':
    case 'datetime':
      return { ...base, path: field.name, kind: 'date' };
    case 'image':
      return { ...base, path: field.name, kind: 'image' };
    case 'reference':
      return { ...base, path: field.name, kind: 'reference', references: type.to };
    case 'array':
      return listField(field, type.of, base);
    case 'geopoint':
    case 'object':
    case 'file':
    case 'richText':
      return { ...base, path: field.name, kind: 'other' };
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

// A list of text or of references can be asked whether it has a value; any
// other list only whether it has items.
function listField(
  field: RemoteSchemaField,
  members: readonly RemoteType[],
  base: Pick<CatalogField, 'title' | 'options' | 'references'>,
): CatalogField {
  if (members.length > 0 && members.every((member) => member.kind === 'reference')) {
    const references = members.flatMap((member) => (member.kind === 'reference' ? member.to : []));
    return { ...base, path: field.name, kind: 'list', references };
  }
  const textual =
    members.length > 0 &&
    members.every((member) => member.kind === 'string' || member.kind === 'text');
  const options = members
    .flatMap((member) => (member.kind === 'string' ? member.options : []))
    .map((option) => ({ title: option.title, value: option.value }));
  return {
    ...base,
    path: field.name,
    kind: textual ? 'list' : 'other',
    options: options.slice(0, LOOP_CATALOG_LIMITS.optionsMax),
  };
}

/** `case-studies` → "Case Studies", `sermonSpeaker` → "Sermon Speaker". */
export function titled(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_.-]+/)
    .filter((word) => word !== '');
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') || name;
}
