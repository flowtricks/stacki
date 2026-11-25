// What a Payload server says about its own collections and their fields.
//
// Payload 3 has no REST endpoint that describes a collection: `/api/access`
// lists names and permissions only. Two sources fill the gap, best first:
//
//   1. GraphQL introspection (`POST /api/graphql`, on by default): exact field
//      types, required flags, select options, nested groups, array rows, block
//      types, localized fields (a `locale` argument) and `_status` (drafts).
//   2. Sampling: a few documents read with `depth=0`, whose values show the
//      shape. Fields that are empty in every sample, a select's options and a
//      block's fields cannot be seen this way, so a sampled schema is honest
//      about being a guess: such a field is a plain string.
//
// The result is a tree of `PayloadField`s, which payloadValues.ts turns into
// Stacki's field types (shared/properties/cmsRemoteSchema.ts) and translates
// values with, in both directions.

import { assert } from '../../shared/core/assert';
import { payloadRequest, type PayloadTarget } from './payloadClient';

export const PAYLOAD_SCHEMA_LIMITS = {
  collectionsMax: 60,
  fieldsMax: 120,
  depthMax: 6,
  sampleDocumentsMax: 8,
  introspectionBytesMax: 8 * 1024 * 1024,
  localesMax: 20,
  optionsMax: 200,
  refDepthMax: 8,
  repliesDocumentsMax: 1000,
} as const;

/** Fields Payload adds itself or keeps private: never shown, never written. */
export const PAYLOAD_SYSTEM_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'createdAt',
  'updatedAt',
  '_status',
  'deletedAt',
  '_verified',
  '_verificationToken',
  'sessions',
  'salt',
  'hash',
  'apiKey',
  'apiKeyIndex',
  'enableAPIKey',
  'loginAttempts',
  'lockUntil',
  'resetPasswordToken',
  'resetPasswordExpiration',
  'password',
]);

/** The fields an upload collection gets for its file; shown, never edited. */
export const PAYLOAD_UPLOAD_FIELDS: ReadonlySet<string> = new Set([
  'url',
  'thumbnailURL',
  'filename',
  'mimeType',
  'filesize',
  'width',
  'height',
  'focalX',
  'focalY',
  'sizes',
]);

export type PayloadScalar = 'string' | 'text' | 'number' | 'boolean' | 'datetime' | 'email';

export type PayloadField = {
  readonly name: string;
  readonly required: boolean;
  /** Stored once per locale (a top-level one is edited one locale at a time). */
  readonly localized: boolean;
} & (
  | { readonly kind: 'scalar'; readonly scalar: PayloadScalar }
  | { readonly kind: 'select'; readonly options: readonly string[]; readonly many: boolean }
  | { readonly kind: 'json' }
  | { readonly kind: 'richText' }
  | { readonly kind: 'point' }
  | { readonly kind: 'numbers' }
  | { readonly kind: 'relation'; readonly to: readonly string[]; readonly many: boolean; readonly upload: boolean }
  | { readonly kind: 'group'; readonly fields: readonly PayloadField[] }
  | { readonly kind: 'array'; readonly fields: readonly PayloadField[] }
  | { readonly kind: 'blocks'; readonly blocks: readonly PayloadBlock[] }
);

export interface PayloadBlock {
  /** The `blockType` a row stores. */
  readonly slug: string;
  readonly fields: readonly PayloadField[];
}

export interface PayloadCollection {
  readonly slug: string;
  /** `versions.drafts` is on: a draft write leaves the live content alone. */
  readonly drafts: boolean;
  /** An upload collection: documents are files. */
  readonly upload: boolean;
  /** Documents (with drafts counted) when last listed. */
  readonly count: number;
  readonly fields: readonly PayloadField[];
}

export interface PayloadSchema {
  readonly collections: ReadonlyMap<string, PayloadCollection>;
  readonly locales: readonly string[];
  /** Whether GraphQL introspection answered (field types are exact). */
  readonly graphql: boolean;
}

// Reading the server.

interface CachedSchema {
  readonly at: number;
  readonly schema: PayloadSchema;
}
const SCHEMA_TTL_MS = 60_000;
const schemas = new Map<string, CachedSchema>();

export function clearPayloadSchemas(): void {
  schemas.clear();
}

/**
 * Every collection this account can see (or the ones the connection names),
 * with its fields. Kept for a minute so opening the panel reads the server
 * once; `fresh` asks again (Detect, Test connection).
 */
export async function loadPayloadSchema(
  target: PayloadTarget,
  options: { readonly named: readonly string[]; readonly reuse: 'allowed' | 'never' },
): Promise<PayloadSchema> {
  const key = `${target.baseUrl}|${target.collection}|${options.named.join(',')}`;
  const cached = schemas.get(key);
  if (options.reuse === 'allowed' && cached !== undefined && Date.now() - cached.at < SCHEMA_TTL_MS) {
    return cached.schema;
  }
  const slugs = await collectionSlugs(target, options.named);
  const graph = await introspect(target, slugs);
  const locales = graph?.locales ?? [];
  const collections = new Map<string, PayloadCollection>();
  // Locales found by sampling `?locale=all`, for a server whose GraphQL is off.
  const sampled = new Set<string>();
  // One collection after another: the account's server is not a batch job, and the cap is small.
  for (const slug of slugs.slice(0, PAYLOAD_SCHEMA_LIMITS.collectionsMax)) {
    const collection = await describeCollection(target, slug, graph, sampled);
    if (collection !== undefined) {
      collections.set(slug, collection);
    }
  }
  const schema: PayloadSchema = {
    collections,
    locales: locales.length > 0 ? locales : [...sampled].slice(0, PAYLOAD_SCHEMA_LIMITS.localesMax),
    graphql: graph !== undefined,
  };
  assert(schema.collections.size <= PAYLOAD_SCHEMA_LIMITS.collectionsMax, 'A schema holds a bounded set of collections');
  schemas.set(key, { at: Date.now(), schema });
  if (schemas.size > 32) {
    schemas.clear();
  }
  return schema;
}

// `/api/access` names every collection the account can see; a connection that names its own
// collections adds them (and is the only source when the access list is hidden).
async function collectionSlugs(target: PayloadTarget, named: readonly string[]): Promise<readonly string[]> {
  const found: string[] = [];
  try {
    const access = await payloadRequest(target, { method: 'GET', path: '/api/access' });
    const collections: unknown = typeof access === 'object' && access !== null ? Reflect.get(access, 'collections') : undefined;
    if (typeof collections === 'object' && collections !== null) {
      for (const slug of Object.keys(collections)) {
        // Payload's own bookkeeping collections are not content.
        if (!slug.startsWith('payload-') && !slug.startsWith('payload_') && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(slug)) {
          found.push(slug);
        }
      }
    }
  } catch (error: unknown) {
    // A server that hides the access list still works with named collections; any other failure is the person's to see.
    if (named.length === 0) {
      throw error;
    }
  }
  return [...new Set([...found, ...named])];
}

async function describeCollection(
  target: PayloadTarget,
  slug: string,
  graph: Introspection | undefined,
  sampled: Set<string>,
): Promise<PayloadCollection | undefined> {
  let sample: unknown;
  try {
    sample = await payloadRequest(target, {
      method: 'GET',
      path: `/api/${slug}`,
      query: { limit: PAYLOAD_SCHEMA_LIMITS.sampleDocumentsMax, page: 1, depth: 0, draft: true },
    });
  } catch (error: unknown) {
    // A collection the account cannot read, or one that does not exist, is left out; the rest still list.
    if (isRefusal(error)) {
      return undefined;
    }
    throw error;
  }
  const docs = documentsOf(sample);
  const count = totalOf(sample, docs.length);
  const typeName = graph?.typeNames.get(slug);
  const graphType = typeName === undefined ? undefined : graph?.types.get(typeName);
  const upload =
    graphType === undefined
      ? looksLikeUpload(docs)
      : graphType.fields.some((field) => field.name === 'filename') && graphType.fields.some((field) => field.name === 'mimeType');
  const drafts = graphType === undefined ? docs.some((document) => '_status' in document) : graphType.fields.some((field) => field.name === '_status');
  const fields =
    graph !== undefined && graphType !== undefined
      ? fieldsFromGraph(graph, graphType, { upload }, 0, new Set([graphType.name]))
      : fieldsFromSamples(docs, { upload });
  assert(fields.length <= PAYLOAD_SCHEMA_LIMITS.fieldsMax, 'A collection has a bounded set of fields');
  // GraphQL puts a `locale` argument on relationships, not on localized scalars, so it cannot say which fields are localized.
  const localized = await sampleLocalized(target, slug, sampled);
  const marked = fields.map((field) => (localized.has(field.name) ? { ...field, localized: true } : field));
  return { slug, drafts, upload, count, fields: await refine(target, slug, marked, docs) };
}

function isRefusal(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const failure: unknown = Reflect.get(error, 'failure');
  return failure === 'forbidden' || failure === 'notFound' || failure === 'unauthorized';
}

export function documentsOf(reply: unknown): readonly Record<string, unknown>[] {
  const docs = rowsOf(typeof reply === 'object' && reply !== null ? Reflect.get(reply, 'docs') : undefined);
  const out: Record<string, unknown>[] = [];
  for (const document of docs.slice(0, PAYLOAD_SCHEMA_LIMITS.repliesDocumentsMax)) {
    if (typeof document === 'object' && document !== null && !Array.isArray(document)) {
      out.push(Object.fromEntries(Object.keys(document).map((key): [string, unknown] => [key, Reflect.get(document, key)])));
    }
  }
  return out;
}

function rowsOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function totalOf(reply: unknown, fallback: number): number {
  const total: unknown = typeof reply === 'object' && reply !== null ? Reflect.get(reply, 'totalDocs') : undefined;
  return typeof total === 'number' && Number.isSafeInteger(total) && total >= 0 ? total : fallback;
}

function looksLikeUpload(docs: readonly Record<string, unknown>[]): boolean {
  return docs.some((document) => typeof document['filename'] === 'string' && typeof document['mimeType'] === 'string');
}

// GraphQL introspection.

interface GraphRef {
  readonly kind: string;
  readonly name: string | undefined;
  readonly ofType: GraphRef | undefined;
}
interface GraphField {
  readonly name: string;
  readonly type: GraphRef;
}
interface GraphType {
  readonly name: string;
  readonly kind: string;
  readonly fields: readonly GraphField[];
  readonly enumValues: readonly string[];
  readonly possibleTypes: readonly string[];
}
export interface Introspection {
  readonly types: ReadonlyMap<string, GraphType>;
  /** Collection slug to the name of its document type. */
  readonly typeNames: ReadonlyMap<string, string>;
  /** Document type name to its collection slug. */
  readonly slugsByType: ReadonlyMap<string, string>;
  readonly locales: readonly string[];
}

const INTROSPECTION_QUERY = `{ __schema { queryType { fields { name type { name kind ofType { name kind ofType { name kind } } } } } types { name kind enumValues { name } possibleTypes { name } fields { name type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } } } } }`;

/** The server's GraphQL schema, or none when GraphQL is off, refused or not Payload's. */
export async function introspect(target: PayloadTarget, slugs: readonly string[]): Promise<Introspection | undefined> {
  let reply: unknown;
  try {
    reply = await payloadRequest(target, { method: 'POST', path: '/api/graphql', body: { query: INTROSPECTION_QUERY }, timeoutMs: 30_000 });
  } catch {
    // GraphQL is optional: off, blocked or failing, sampling takes over.
    return undefined;
  }
  return parseIntrospection(reply, slugs);
}

export function parseIntrospection(reply: unknown, slugs: readonly string[]): Introspection | undefined {
  const schema = child(child(reply, 'data'), '__schema');
  const typeList: unknown = schema === undefined ? undefined : Reflect.get(schema, 'types');
  const queryFields: unknown = child(child(schema, 'queryType'), 'fields') === undefined ? undefined : Reflect.get(child(schema, 'queryType') ?? {}, 'fields');
  if (!Array.isArray(typeList) || !Array.isArray(queryFields) || typeList.length > 20_000) {
    return undefined;
  }
  const types = new Map<string, GraphType>();
  for (const raw of typeList) {
    const parsed = parseGraphType(raw);
    if (parsed !== undefined) {
      types.set(parsed.name, parsed);
    }
  }
  const typeNames = new Map<string, string>();
  const slugsByType = new Map<string, string>();
  const collectionsFound = collectionTypes(queryFields, types);
  // A slug is matched to its type by normalised name; a type no known slug matches keeps its normalised name.
  const matched = new Set<string>();
  for (const slug of slugs) {
    const documentType = collectionsFound.get(normalise(slug));
    if (documentType !== undefined) {
      typeNames.set(slug, documentType);
      matched.add(normalise(slug));
    }
  }
  for (const [fieldName, documentType] of collectionsFound) {
    if (!matched.has(fieldName)) {
      typeNames.set(fieldName, documentType);
    }
  }
  for (const [name, type] of typeNames) {
    slugsByType.set(type, name);
  }
  const localeEnum = types.get('LocaleInputType');
  const locales = localeEnum?.enumValues.filter((value) => value !== 'all').slice(0, PAYLOAD_SCHEMA_LIMITS.localesMax) ?? [];
  return { types, typeNames, slugsByType, locales };
}

// The paginated query fields (`Posts` returns `Posts { docs: [Post] }`) name each collection's
// document type. The slug is not in GraphQL, so a field is matched to a slug by its normalised name
// when slugs are known: `Posts`/`allMedia`/`PayloadPreferences` for `posts`/`media`/`payload-preferences`.
function collectionTypes(queryFields: readonly unknown[], types: ReadonlyMap<string, GraphType>): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const raw of queryFields) {
    const name = nameOf(raw);
    const returned = namedType(parseRef(typeOf(raw)));
    if (typeof name !== 'string' || returned === undefined) {
      continue;
    }
    const paginated = types.get(returned);
    const docs = paginated?.fields.find((field) => field.name === 'docs');
    const documentType = docs === undefined ? undefined : namedType(docs.type);
    if (documentType !== undefined) {
      out.set(normalise(name.replace(/^all(?=[A-Z])/, '')), documentType);
    }
  }
  return out;
}

function typeOf(raw: unknown): unknown {
  return typeof raw === 'object' && raw !== null ? Reflect.get(raw, 'type') : undefined;
}

function normalise(text: string): string {
  return text.replace(/[-_]/g, '').toLowerCase();
}

function child(value: unknown, key: string): object | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const inner: unknown = Reflect.get(value, key);
  return typeof inner === 'object' && inner !== null ? inner : undefined;
}

function parseRef(raw: unknown, depth = 0): GraphRef | undefined {
  assert(depth <= PAYLOAD_SCHEMA_LIMITS.refDepthMax, 'A type reference nests boundedly');
  if (typeof raw !== 'object' || raw === null || depth > PAYLOAD_SCHEMA_LIMITS.refDepthMax) {
    return undefined;
  }
  const kind: unknown = Reflect.get(raw, 'kind');
  const name: unknown = Reflect.get(raw, 'name');
  if (typeof kind !== 'string') {
    return undefined;
  }
  return { kind, name: typeof name === 'string' ? name : undefined, ofType: parseRef(Reflect.get(raw, 'ofType'), depth + 1) };
}

function parseGraphType(raw: unknown): GraphType | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const name: unknown = Reflect.get(raw, 'name');
  const kind: unknown = Reflect.get(raw, 'kind');
  if (typeof name !== 'string' || typeof kind !== 'string' || name.startsWith('__')) {
    return undefined;
  }
  const fields: GraphField[] = [];
  const rawFields: unknown = Reflect.get(raw, 'fields');
  if (Array.isArray(rawFields)) {
    for (const entry of rawFields.slice(0, 400)) {
      const nameValue: unknown = typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'name') : undefined;
      const ref = parseRef(typeOf(entry));
      if (typeof nameValue === 'string' && ref !== undefined) {
        fields.push({ name: nameValue, type: ref });
      }
    }
  }
  return { name, kind, fields, enumValues: namesOf(Reflect.get(raw, 'enumValues')), possibleTypes: namesOf(Reflect.get(raw, 'possibleTypes')) };
}

function nameOf(value: unknown): string | undefined {
  const name: unknown = typeof value === 'object' && value !== null ? Reflect.get(value, 'name') : undefined;
  return typeof name === 'string' ? name : undefined;
}

function namesOf(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value
        .map(nameOf)
        .filter((item): item is string => item !== undefined)
        .slice(0, PAYLOAD_SCHEMA_LIMITS.optionsMax)
    : [];
}

function namedType(ref: GraphRef | undefined): string | undefined {
  let current = ref;
  for (let step = 0; step < 6 && current !== undefined; step += 1) {
    if (current.name !== undefined && current.kind !== 'NON_NULL' && current.kind !== 'LIST') {
      return current.name;
    }
    current = current.ofType;
  }
  return undefined;
}

interface Unwrapped {
  readonly name: string;
  readonly kind: string;
  readonly list: boolean;
  readonly required: boolean;
}

function unwrap(ref: GraphRef): Unwrapped | undefined {
  const required = ref.kind === 'NON_NULL';
  let current: GraphRef | undefined = required ? ref.ofType : ref;
  let list = false;
  for (let step = 0; step < 6 && current !== undefined; step += 1) {
    if (current.kind === 'LIST') {
      list = true;
      current = current.ofType;
    } else if (current.kind === 'NON_NULL') {
      current = current.ofType;
    } else if (current.name !== undefined) {
      return { name: current.name, kind: current.kind, list, required };
    } else {
      return undefined;
    }
  }
  return undefined;
}

function fieldsFromGraph(
  graph: Introspection,
  type: GraphType,
  upload: { readonly upload: boolean },
  depth: number,
  seen: ReadonlySet<string>,
): readonly PayloadField[] {
  assert(depth <= PAYLOAD_SCHEMA_LIMITS.depthMax, 'A schema walk stays shallow');
  const out: PayloadField[] = [];
  for (const field of type.fields.slice(0, PAYLOAD_SCHEMA_LIMITS.fieldsMax)) {
    if (PAYLOAD_SYSTEM_FIELDS.has(field.name) || (upload.upload && depth === 0 && PAYLOAD_UPLOAD_FIELDS.has(field.name))) {
      continue;
    }
    const mapped = fieldFromGraph(graph, field, depth, seen);
    if (mapped !== undefined) {
      out.push(mapped);
    }
  }
  return out;
}

function fieldFromGraph(graph: Introspection, field: GraphField, depth: number, seen: ReadonlySet<string>): PayloadField | undefined {
  const unwrapped = unwrap(field.type);
  if (unwrapped === undefined) {
    return undefined;
  }
  const base = { name: field.name, required: unwrapped.required, localized: false };
  const target = graph.types.get(unwrapped.name);
  switch (unwrapped.kind) {
    case 'SCALAR':
      return scalarFromGraph(base, unwrapped);
    case 'ENUM':
      return { ...base, kind: 'select', options: target?.enumValues ?? [], many: unwrapped.list };
    case 'OBJECT': {
      const slug = graph.slugsByType.get(unwrapped.name);
      if (slug !== undefined) {
        return { ...base, kind: 'relation', to: [slug], many: unwrapped.list, upload: isUploadType(target) };
      }
      return objectFromGraph(graph, base, unwrapped, target, depth, seen);
    }
    case 'UNION': {
      // A union of collection types is a polymorphic relationship's value; any other is blocks.
      const members = target?.possibleTypes ?? [];
      const slugs = members.map((member) => graph.slugsByType.get(member));
      if (members.length > 0 && slugs.every((slug) => slug !== undefined)) {
        return { ...base, kind: 'relation', to: slugs.filter((slug): slug is string => slug !== undefined), many: unwrapped.list, upload: false };
      }
      return blocksFromGraph(graph, base, members, depth, seen);
    }
    default:
      return undefined;
  }
}

function isUploadType(type: GraphType | undefined): boolean {
  return type !== undefined && type.fields.some((field) => field.name === 'filename') && type.fields.some((field) => field.name === 'mimeType');
}

function scalarFromGraph(base: { readonly name: string; readonly required: boolean; readonly localized: boolean }, unwrapped: Unwrapped): PayloadField {
  switch (unwrapped.name) {
    case 'Int':
    case 'Float':
      return unwrapped.list ? { ...base, kind: 'numbers' } : { ...base, kind: 'scalar', scalar: 'number' };
    case 'Boolean':
      return { ...base, kind: 'scalar', scalar: 'boolean' };
    case 'DateTime':
      return { ...base, kind: 'scalar', scalar: 'datetime' };
    case 'EmailAddress':
      return { ...base, kind: 'scalar', scalar: 'email' };
    case 'JSON':
      return { ...base, kind: 'json' };
    default:
      return unwrapped.list ? { ...base, kind: 'select', options: [], many: true } : { ...base, kind: 'scalar', scalar: 'string' };
  }
}

function objectFromGraph(
  graph: Introspection,
  base: { readonly name: string; readonly required: boolean; readonly localized: boolean },
  unwrapped: Unwrapped,
  type: GraphType | undefined,
  depth: number,
  seen: ReadonlySet<string>,
): PayloadField | undefined {
  // A relationship to a collection the schema does not expose, or a cycle, is not walked.
  if (type === undefined || seen.has(type.name) || depth + 1 > PAYLOAD_SCHEMA_LIMITS.depthMax) {
    return { ...base, kind: 'json' };
  }
  // A polymorphic relationship: `{ relationTo, value }`.
  if (type.fields.some((field) => field.name === 'relationTo') && type.fields.some((field) => field.name === 'value')) {
    const value = type.fields.find((field) => field.name === 'value');
    const members = value === undefined ? [] : (graph.types.get(namedType(value.type) ?? '')?.possibleTypes ?? []);
    const to = members.map((member) => graph.slugsByType.get(member)).filter((slug): slug is string => slug !== undefined);
    return { ...base, kind: 'relation', to, many: unwrapped.list, upload: false };
  }
  const fields = fieldsFromGraph(graph, type, { upload: false }, depth + 1, new Set([...seen, type.name])).filter((field) => field.name !== 'id');
  return unwrapped.list ? { ...base, kind: 'array', fields } : { ...base, kind: 'group', fields };
}

function blocksFromGraph(
  graph: Introspection,
  base: { readonly name: string; readonly required: boolean; readonly localized: boolean },
  members: readonly string[],
  depth: number,
  seen: ReadonlySet<string>,
): PayloadField {
  const blocks: PayloadBlock[] = [];
  for (const member of members.slice(0, 24)) {
    const type = graph.types.get(member);
    if (type === undefined || depth + 1 > PAYLOAD_SCHEMA_LIMITS.depthMax) {
      continue;
    }
    const fields = fieldsFromGraph(graph, type, { upload: false }, depth + 1, new Set([...seen, type.name])).filter(
      (field) => field.name !== 'id' && field.name !== 'blockName' && field.name !== 'blockType',
    );
    // GraphQL names a block type `Hero`; its slug (`hero`) is what rows store, lower-camel as a first guess,
    // corrected against sampled rows by `refine`.
    blocks.push({ slug: member.charAt(0).toLowerCase() + member.slice(1), fields });
  }
  return { ...base, kind: 'blocks', blocks };
}

// Sampling.

function fieldsFromSamples(docs: readonly Record<string, unknown>[], mode: { readonly upload: boolean }): readonly PayloadField[] {
  const names: string[] = [];
  for (const document of docs) {
    for (const name of Object.keys(document)) {
      if (!names.includes(name) && !PAYLOAD_SYSTEM_FIELDS.has(name) && !(mode.upload && PAYLOAD_UPLOAD_FIELDS.has(name))) {
        names.push(name);
      }
    }
  }
  const out: PayloadField[] = [];
  for (const name of names.slice(0, PAYLOAD_SCHEMA_LIMITS.fieldsMax)) {
    const values = docs.map((document) => document[name]).filter((value) => value !== null && value !== undefined);
    out.push(fieldFromValues(name, values, 0));
  }
  return out;
}

const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function fieldFromValues(name: string, values: readonly unknown[], depth: number): PayloadField {
  const base = { name, required: false, localized: false };
  const first = values[0];
  if (first === undefined) {
    return { ...base, kind: 'scalar', scalar: 'string' };
  }
  if (typeof first === 'string') {
    if (DATE.test(first)) {
      return { ...base, kind: 'scalar', scalar: 'datetime' };
    }
    return { ...base, kind: 'scalar', scalar: first.includes('\n') || first.length > 160 ? 'text' : 'string' };
  }
  if (typeof first === 'number') {
    return { ...base, kind: 'scalar', scalar: 'number' };
  }
  if (typeof first === 'boolean') {
    return { ...base, kind: 'scalar', scalar: 'boolean' };
  }
  if (Array.isArray(first)) {
    return fieldFromLists(base, values.filter(Array.isArray), depth);
  }
  if (typeof first === 'object') {
    return fieldFromObjects(
      base,
      values.filter((value): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)),
      depth,
    );
  }
  return { ...base, kind: 'json' };
}

function fieldFromLists(
  base: { readonly name: string; readonly required: boolean; readonly localized: boolean },
  lists: readonly unknown[][],
  depth: number,
): PayloadField {
  const items = lists.flat();
  const first = items[0];
  if (first === undefined) {
    return { ...base, kind: 'array', fields: [] };
  }
  if (typeof first === 'string') {
    return { ...base, kind: 'select', options: [], many: true };
  }
  if (typeof first === 'number') {
    return { ...base, kind: 'numbers' };
  }
  const rows = items.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item));
  if (rows.some((row) => typeof row['blockType'] === 'string')) {
    const slugs = [...new Set(rows.map((row) => row['blockType']).filter((slug): slug is string => typeof slug === 'string'))];
    return {
      ...base,
      kind: 'blocks',
      blocks: slugs.map((slug) => ({
        slug,
        fields: subFields(
          rows.filter((row) => row['blockType'] === slug),
          depth,
        ),
      })),
    };
  }
  if (rows.every((row) => 'relationTo' in row && 'value' in row)) {
    const to = [...new Set(rows.map((row) => row['relationTo']).filter((slug): slug is string => typeof slug === 'string'))];
    return { ...base, kind: 'relation', to, many: true, upload: false };
  }
  return { ...base, kind: 'array', fields: subFields(rows, depth) };
}

function fieldFromObjects(
  base: { readonly name: string; readonly required: boolean; readonly localized: boolean },
  objects: readonly Record<string, unknown>[],
  depth: number,
): PayloadField {
  const first = objects[0];
  if (first === undefined) {
    return { ...base, kind: 'json' };
  }
  const root: unknown = first['root'];
  if (typeof root === 'object' && root !== null && Reflect.get(root, 'type') === 'root') {
    return { ...base, kind: 'richText' };
  }
  if ('relationTo' in first && 'value' in first) {
    const to = [...new Set(objects.map((object) => object['relationTo']).filter((slug): slug is string => typeof slug === 'string'))];
    return { ...base, kind: 'relation', to, many: false, upload: false };
  }
  // Keys a Stacki field name cannot hold (a JSON field's free-form keys) make it opaque JSON.
  const keys = objects.flatMap((object) => Object.keys(object));
  if (depth >= PAYLOAD_SCHEMA_LIMITS.depthMax || keys.some((key) => !/^[A-Za-z0-9_][\w-]{0,63}$/.test(key))) {
    return { ...base, kind: 'json' };
  }
  return { ...base, kind: 'group', fields: subFields(objects, depth) };
}

function subFields(rows: readonly Record<string, unknown>[], depth: number): readonly PayloadField[] {
  const names: string[] = [];
  for (const row of rows) {
    for (const name of Object.keys(row)) {
      if (name !== 'id' && name !== 'blockType' && name !== 'blockName' && !names.includes(name)) {
        names.push(name);
      }
    }
  }
  return names.slice(0, PAYLOAD_SCHEMA_LIMITS.fieldsMax).map((name) =>
    fieldFromValues(
      name,
      rows.map((row) => row[name]).filter((value) => value !== null && value !== undefined),
      depth + 1,
    ),
  );
}

// Refining an exact schema with what the documents show.

// GraphQL cannot tell rich text from other JSON, a point from a list of numbers, nor a block's real slug.
async function refine(
  target: PayloadTarget,
  slug: string,
  fields: readonly PayloadField[],
  docs: readonly Record<string, unknown>[],
): Promise<readonly PayloadField[]> {
  const out: PayloadField[] = [];
  for (const field of fields) {
    out.push(await refineOne(target, slug, field, docs));
  }
  return out;
}

// The values a field holds in the sample, or in one document that holds it: a field empty in the newest
// documents (rich text on old posts) is told apart from other JSON by a document that has it.
async function evidence(target: PayloadTarget, slug: string, name: string, docs: readonly Record<string, unknown>[]): Promise<readonly unknown[]> {
  const sampled = docs.map((document) => document[name]).filter((value) => value !== null && value !== undefined);
  if (sampled.length > 0) {
    return sampled;
  }
  try {
    const reply = await payloadRequest(target, {
      method: 'GET',
      path: `/api/${slug}`,
      query: { [`where[${name}][exists]`]: true, limit: 1, depth: 0, draft: true },
    });
    return documentsOf(reply)
      .map((document) => document[name])
      .filter((value) => value !== null && value !== undefined);
  } catch {
    return [];
  }
}

async function refineOne(target: PayloadTarget, slug: string, field: PayloadField, docs: readonly Record<string, unknown>[]): Promise<PayloadField> {
  const needsEvidence = field.kind === 'json' || field.kind === 'numbers' || field.kind === 'blocks';
  const values = needsEvidence ? await evidence(target, slug, field.name, docs) : [];
  switch (field.kind) {
    case 'json': {
      const first = values[0];
      const root: unknown = typeof first === 'object' && first !== null ? Reflect.get(first, 'root') : undefined;
      return typeof root === 'object' && root !== null && Reflect.get(root, 'type') === 'root' ? { ...field, kind: 'richText' } : field;
    }
    case 'numbers': {
      const first = values[0];
      const pointLike = Array.isArray(first) && first.length === 2 && /point|location|coord|geo|position|latlng|where/i.test(field.name);
      return pointLike ? { name: field.name, required: field.required, localized: field.localized, kind: 'point' } : field;
    }
    case 'blocks': {
      const slugs = new Set(
        values
          .flatMap((value): readonly unknown[] => rowsOf(value))
          .map((row): unknown => (typeof row === 'object' && row !== null ? Reflect.get(row, 'blockType') : undefined)),
      );
      const real = [...slugs].filter((slug): slug is string => typeof slug === 'string');
      return {
        ...field,
        blocks: field.blocks.map((block) => ({ ...block, slug: real.find((slug) => normalise(slug) === normalise(block.slug)) ?? block.slug })),
      };
    }
    case 'scalar':
    case 'select':
    case 'richText':
    case 'point':
    case 'relation':
    case 'group':
    case 'array':
      return field;
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

const LOCALE_CODE = /^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?$/;

// A localized field reads as `{ en, fr }` under `?locale=all`; a field whose value is such an object
// is localized, and its keys are the locales. A server without localization ignores the parameter.
async function sampleLocalized(target: PayloadTarget, slug: string, sampled: Set<string>): Promise<ReadonlySet<string>> {
  const names = new Set<string>();
  let reply: unknown;
  try {
    reply = await payloadRequest(target, { method: 'GET', path: `/api/${slug}`, query: { limit: 3, depth: 0, locale: 'all', draft: true } });
  } catch {
    return names;
  }
  for (const document of documentsOf(reply)) {
    for (const [name, value] of Object.entries(document)) {
      const keys = typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.keys(value) : [];
      if (keys.length > 0 && keys.every((key) => LOCALE_CODE.test(key)) && !PAYLOAD_SYSTEM_FIELDS.has(name)) {
        names.add(name);
        for (const key of keys) {
          sampled.add(key);
        }
      }
    }
  }
  return names;
}
