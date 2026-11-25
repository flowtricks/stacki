// Payload's fields and values as Stacki's CMS panel edits them.
//
// The panel speaks one vocabulary for every CMS (shared/properties/cmsRemoteSchema.ts:
// field types, and JSON values shaped like Sanity's: a reference is
// `{ _type: "reference", _ref }`, an array row carries `_key` and `_type`). This
// module is the translation, both ways, so the same editors work for Payload:
//
//   Payload                               Stacki
//   text / textarea / email / code        string / text / email / text
//   number, checkbox, date                number, boolean, datetime
//   select / radio (hasMany: a list)      string with options (a list of them)
//   point [longitude, latitude]           geopoint { lat, lng }
//   relationship (hasMany: a list)        reference to `collection.id`
//   upload                                image or file whose asset is `kind-collection-id`
//   group / array / blocks                object / list of objects / list of typed objects
//   json                                  text holding the JSON, parsed on write
//   richText (Lexical)                    text, one paragraph per line: editable when the
//                                         tree is only plain paragraphs, else read-only
//   a localized top-level field           an object with one entry per locale
//
// A document's id is `collection.id`: Payload's ids are per collection, while the panel
// names a document by one string.

import { assert } from '../../shared/core/assert';
import { described } from '../../shared/properties/i18n/messageRef';
import type { RemoteAsset } from '../../shared/properties/cmsRemote';
import {
  REMOTE_SCHEMA_LIMITS,
  remoteList,
  remoteObject,
  type RemoteSchemaField,
  type RemoteType,
  type RemoteValue,
} from '../../shared/properties/cmsRemoteSchema';
import { absoluteUrl, PayloadError } from './payloadClient';
import type { PayloadField } from './payloadSchema';

/** Strings and node counts the panel's value parser accepts; a larger value is shown read-only, cut. */
// eslint-disable-next-line stacki/no-null -- Payload clears a field with JSON null: data it stores, not absence.
const CLEARED: null = null;

const VALUE_CHARS_SAFE = REMOTE_SCHEMA_LIMITS.valueCharsMax - 1_000;
const VALUE_NODES_SAFE = REMOTE_SCHEMA_LIMITS.valueNodesMax - 500;

export interface ValueContext {
  readonly baseUrl: string;
  readonly locales: readonly string[];
  /** The images and files the document's fields point at, filled while values are read. */
  readonly assets: Map<string, RemoteAsset>;
}

// Ids.

/** `posts` and 7 as the panel names them: `posts.7`. */
export function encodeId(slug: string, id: string | number): string {
  assert(slug.length > 0, 'A collection is named');
  assert(!slug.includes('.'), 'A collection slug has no dot');
  return `${slug}.${id}`;
}

export function decodeId(composite: string): { readonly slug: string; readonly id: string | number } | undefined {
  const dot = composite.indexOf('.');
  if (dot < 1 || dot === composite.length - 1) {
    return undefined;
  }
  const slug = composite.slice(0, dot);
  const id = composite.slice(dot + 1);
  // Whole-number ids (SQL, Postgres) are numbers to Payload; anything else (Mongo, UUID) is text.
  return { slug, id: /^\d{1,15}$/.test(id) ? Number(id) : id };
}

// Schema.

export function titleOf(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim();
  return spaced.length === 0 ? name : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A field as the panel's schema lists it. `depth` 0 is a document's own field, the only place a locale is edited. */
export function remoteSchemaField(field: PayloadField, locales: readonly string[], depth = 0): RemoteSchemaField {
  assert(depth <= REMOTE_SCHEMA_LIMITS.typeDepthMax, 'A schema field nests boundedly');
  const nested = hasNestedLocalized(field);
  const base = {
    name: field.name,
    title: titleOf(field.name),
    description: '',
    required: field.required,
    rules: [],
  };
  if (nested) {
    // Locales inside a group or a row are shown as the JSON they are, and not edited.
    return { ...base, type: { kind: 'text', options: [] }, readOnly: 'always' };
  }
  const own = remoteType(field, locales, depth);
  if (field.localized && depth === 0 && locales.length > 0) {
    const perLocale = locales.map((locale): RemoteSchemaField => ({ name: locale, title: locale, description: '', required: false, rules: [], type: own }));
    return {
      ...base,
      required: false,
      type: { kind: 'object', name: `${field.name}Locales`, fields: perLocale, columns: Math.min(Math.max(perLocale.length, 2), 4) },
    };
  }
  return { ...base, type: own };
}

function hasNestedLocalized(field: PayloadField, depth = 0): boolean {
  if (depth > REMOTE_SCHEMA_LIMITS.typeDepthMax) {
    return false;
  }
  switch (field.kind) {
    case 'group':
    case 'array':
      return field.fields.some((inner) => inner.localized || hasNestedLocalized(inner, depth + 1));
    case 'blocks':
      return field.blocks.some((block) => block.fields.some((inner) => inner.localized || hasNestedLocalized(inner, depth + 1)));
    case 'scalar':
    case 'select':
    case 'json':
    case 'richText':
    case 'point':
    case 'numbers':
    case 'relation':
      return false;
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

function remoteType(field: PayloadField, locales: readonly string[], depth: number): RemoteType {
  switch (field.kind) {
    case 'scalar':
      return { kind: field.scalar === 'text' ? 'text' : field.scalar, options: [] };
    case 'select': {
      const options = field.options.map((value) => ({ title: titleOf(value), value }));
      return field.many ? { kind: 'array', of: [{ kind: 'string', options }] } : { kind: 'string', options };
    }
    case 'json':
    case 'richText':
      return { kind: 'text', options: [] };
    case 'point':
      return { kind: 'geopoint' };
    case 'numbers':
      return { kind: 'array', of: [{ kind: 'number', options: [] }] };
    case 'relation': {
      const one: RemoteType = field.upload ? uploadType(field) : { kind: 'reference', to: field.to };
      return field.many ? { kind: 'array', of: [one] } : one;
    }
    case 'group':
      return { kind: 'object', name: field.name, fields: field.fields.map((inner) => remoteSchemaField(inner, locales, depth + 1)) };
    case 'array':
      return { kind: 'array', of: [{ kind: 'object', name: field.name, fields: field.fields.map((inner) => remoteSchemaField(inner, locales, depth + 1)) }] };
    case 'blocks':
      return {
        kind: 'array',
        of: field.blocks.map((block) => ({
          kind: 'object',
          name: block.slug,
          fields: block.fields.map((inner) => remoteSchemaField(inner, locales, depth + 1)),
        })),
      };
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

function uploadType(field: Extract<PayloadField, { readonly kind: 'relation' }>): RemoteType {
  return assetKind(field.to[0]) === 'image' ? { kind: 'image', fields: [] } : { kind: 'file' };
}

/** Pictures are shown as pictures: a collection named for them is an image field, any other a file. */
export function assetKind(slug: string | undefined): 'image' | 'file' {
  return slug !== undefined && /media|image|photo|picture|img|gallery/i.test(slug) ? 'image' : 'file';
}

// Values, Payload to Stacki.

/**
 * A stored value as the panel shows it, or none. `locale` is how it was read: `all` gives every
 * localized field as `{ en, fr }`.
 */
export function toRemoteValue(field: PayloadField, raw: unknown, context: ValueContext, depth = 0): RemoteValue | undefined {
  assert(depth <= REMOTE_SCHEMA_LIMITS.typeDepthMax + 2, 'A value nests boundedly');
  if (raw === null || raw === undefined) {
    return undefined;
  }
  if (hasNestedLocalized(field)) {
    return jsonText(raw);
  }
  if (field.localized && depth === 0 && context.locales.length > 0) {
    return localizedValue(field, raw, context);
  }
  return plainValue(field, raw, context, depth);
}

function localizedValue(field: PayloadField, raw: unknown, context: ValueContext): RemoteValue | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const out: Record<string, RemoteValue> = {};
  for (const locale of context.locales) {
    const value = plainValue(field, Reflect.get(raw, locale), context, 1);
    if (value !== undefined) {
      out[locale] = value;
    }
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function plainValue(field: PayloadField, raw: unknown, context: ValueContext, depth: number): RemoteValue | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  switch (field.kind) {
    case 'scalar':
      return scalarValue(field.scalar, raw);
    case 'select':
      return field.many ? stringList(raw) : typeof raw === 'string' ? raw : undefined;
    case 'json':
      return jsonText(raw);
    case 'richText':
      return lexicalText(raw)?.text;
    case 'point':
      return pointValue(raw);
    case 'numbers':
      return Array.isArray(raw) ? raw.filter((item): item is number => typeof item === 'number' && Number.isFinite(item)) : undefined;
    case 'relation':
      return relationValue(field, raw, context);
    case 'group':
      return groupValue(field.fields, raw, context, depth);
    case 'array':
      return rowsValue(raw, context, depth, (row) => ({ type: field.name, fields: field.fields, row }));
    case 'blocks':
      return rowsValue(raw, context, depth, (row) => {
        const slug = typeof row['blockType'] === 'string' ? row['blockType'] : '';
        const block = field.blocks.find((candidate) => candidate.slug === slug);
        return block === undefined ? undefined : { type: block.slug, fields: block.fields, row };
      });
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

function scalarValue(scalar: Extract<PayloadField, { readonly kind: 'scalar' }>['scalar'], raw: unknown): RemoteValue | undefined {
  switch (scalar) {
    case 'number':
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
    case 'boolean':
      return typeof raw === 'boolean' ? raw : undefined;
    case 'string':
    case 'text':
    case 'datetime':
    case 'email':
      return typeof raw === 'string' ? raw : undefined;
    default: {
      const exhaustive: never = scalar;
      return exhaustive;
    }
  }
}

function stringList(raw: unknown): RemoteValue | undefined {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : undefined;
}

function jsonText(raw: unknown): string {
  const text = JSON.stringify(raw, null, 2);
  return text;
}

function pointValue(raw: unknown): RemoteValue | undefined {
  if (!Array.isArray(raw) || raw.length !== 2) {
    return undefined;
  }
  const pair: unknown[] = raw;
  const lng = pair[0];
  const lat = pair[1];
  return typeof lng === 'number' && typeof lat === 'number' ? { _type: 'geopoint', lat, lng } : undefined;
}

// A relationship's value: an id, a populated document, or `{ relationTo, value }`.
function relationValue(field: Extract<PayloadField, { readonly kind: 'relation' }>, raw: unknown, context: ValueContext): RemoteValue | undefined {
  if (Array.isArray(raw)) {
    const items: unknown[] = raw;
    const refs = items.map((item, index) => relationOne(field, item, context, index)).filter((item): item is RemoteValue => item !== undefined);
    return refs;
  }
  return relationOne(field, raw, context, 0);
}

function relationOne(field: Extract<PayloadField, { readonly kind: 'relation' }>, raw: unknown, context: ValueContext, index: number): RemoteValue | undefined {
  let slug = field.to[0];
  let target: unknown = raw;
  if (typeof raw === 'object' && raw !== null && 'relationTo' in raw && 'value' in raw) {
    const relationTo: unknown = Reflect.get(raw, 'relationTo');
    slug = typeof relationTo === 'string' ? relationTo : slug;
    target = Reflect.get(raw, 'value');
  }
  const id = idOf(target);
  if (slug === undefined || id === undefined) {
    return undefined;
  }
  const composite = encodeId(slug, id);
  if (field.upload) {
    const kind = assetKind(slug);
    const assetId = `${kind}-${slug}-${id}`;
    if (typeof target === 'object' && target !== null && assetId.length <= 200) {
      const url: unknown = Reflect.get(target, 'url');
      const filename: unknown = Reflect.get(target, 'filename');
      if (typeof url === 'string') {
        context.assets.set(assetId, { id: assetId, url: absoluteUrl(context.baseUrl, url), filename: typeof filename === 'string' ? filename : String(id) });
      }
    }
    return { _key: `r${index}-${id}`.slice(0, 120), _type: kind, asset: { _type: 'reference', _ref: assetId } };
  }
  return { _key: `r${index}-${id}`.slice(0, 120), _type: 'reference', _ref: composite };
}

function idOf(target: unknown): string | number | undefined {
  if (typeof target === 'string' || typeof target === 'number') {
    return target;
  }
  if (typeof target === 'object' && target !== null) {
    const id: unknown = Reflect.get(target, 'id');
    return typeof id === 'string' || typeof id === 'number' ? id : undefined;
  }
  return undefined;
}

function groupValue(fields: readonly PayloadField[], raw: unknown, context: ValueContext, depth: number): RemoteValue | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const out: Record<string, RemoteValue> = {};
  for (const inner of fields) {
    const value = plainValue(inner, Reflect.get(raw, inner.name), context, depth + 1);
    if (value !== undefined) {
      out[inner.name] = value;
    }
  }
  return out;
}

interface RowShape {
  readonly type: string;
  readonly fields: readonly PayloadField[];
  readonly row: Record<string, unknown>;
}

function rowsValue(raw: unknown, context: ValueContext, depth: number, shape: (row: Record<string, unknown>) => RowShape | undefined): RemoteValue | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const items: unknown[] = raw;
  const out: RemoteValue[] = [];
  for (const [index, item] of items.slice(0, REMOTE_SCHEMA_LIMITS.valueNodesMax).entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      continue;
    }
    const row = Object.fromEntries(Object.keys(item).map((key): [string, unknown] => [key, Reflect.get(item, key)]));
    const found = shape(row);
    if (found === undefined) {
      continue;
    }
    const id = typeof row['id'] === 'string' && /^[\w$-]{1,120}$/.test(row['id']) ? row['id'] : `row${index}`;
    const fields = groupValue(found.fields, row, context, depth + 1);
    out.push({ ...(typeof fields === 'object' && !Array.isArray(fields) ? fields : {}), _key: id, _type: found.type });
  }
  return out;
}

// Values, Stacki to Payload.

export interface WriteContext {
  /** The ids a document's rows already have; a row keeps its `id` only when Payload issued it. */
  readonly rowIds: ReadonlySet<string>;
  /** The id type of each collection a relationship points at (`number` or text), from `decodeId`. */
  readonly previous: unknown;
}

/** A value the panel wrote, as Payload stores it. A value that cannot be stored is a `PayloadError`, not a guess. */
export function toPayloadValue(field: PayloadField, value: RemoteValue | undefined, context: WriteContext): unknown {
  if (value === undefined) {
    return CLEARED;
  }
  switch (field.kind) {
    case 'scalar':
      return scalarOut(field.scalar, value);
    case 'select':
      return field.many ? listOf(value).filter((item): item is string => typeof item === 'string') : typeof value === 'string' ? value : CLEARED;
    case 'json':
      return parseJson(field.name, value);
    case 'richText':
      return lexicalFrom(field.name, value, context.previous);
    case 'point': {
      const point = objectOf(value);
      const lat = point?.['lat'];
      const lng = point?.['lng'];
      return typeof lat === 'number' && typeof lng === 'number' ? [lng, lat] : CLEARED;
    }
    case 'numbers':
      return listOf(value).filter((item): item is number => typeof item === 'number');
    case 'relation':
      return relationOut(field, value);
    case 'group':
      return groupOut(field.fields, value, context);
    case 'array':
      return rowsOut(value, context, () => ({ fields: field.fields, blockType: undefined }));
    case 'blocks':
      return rowsOut(value, context, (row) => {
        const type = row['_type'];
        const block = field.blocks.find((candidate) => candidate.slug === type);
        return block === undefined ? undefined : { fields: block.fields, blockType: block.slug };
      });
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

function scalarOut(scalar: Extract<PayloadField, { readonly kind: 'scalar' }>['scalar'], value: RemoteValue): unknown {
  switch (scalar) {
    case 'number':
      return typeof value === 'number' ? value : CLEARED;
    case 'boolean':
      return typeof value === 'boolean' ? value : CLEARED;
    case 'string':
    case 'text':
    case 'datetime':
    case 'email':
      return typeof value === 'string' ? value : CLEARED;
    default: {
      const exhaustive: never = scalar;
      return exhaustive;
    }
  }
}

function listOf(value: RemoteValue): readonly RemoteValue[] {
  return remoteList(value) ?? [];
}

function objectOf(value: RemoteValue): { readonly [key: string]: RemoteValue } | undefined {
  return remoteObject(value);
}

function parseJson(name: string, value: RemoteValue): unknown {
  if (typeof value !== 'string') {
    return CLEARED;
  }
  if (value.trim().length === 0) {
    return CLEARED;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    throw invalid(`${titleOf(name)} is not valid JSON.`);
  }
}

function invalid(detail: string): PayloadError {
  return new PayloadError('invalid', undefined, described('settings.cms.payload.error.invalid', { detail }));
}

function relationOut(field: Extract<PayloadField, { readonly kind: 'relation' }>, value: RemoteValue): unknown {
  if (Array.isArray(value)) {
    return listOf(value)
      .map((item) => relationItemOut(field, item))
      .filter((item) => item !== undefined);
  }
  return relationItemOut(field, value) ?? CLEARED;
}

function relationItemOut(field: Extract<PayloadField, { readonly kind: 'relation' }>, value: RemoteValue): unknown {
  const object = objectOf(value);
  if (object === undefined) {
    return undefined;
  }
  let composite: string | undefined;
  if (field.upload) {
    const asset = objectOf(object['asset'] ?? {});
    const reference = asset?.['_ref'];
    const slug = field.to[0];
    if (typeof reference === 'string' && slug !== undefined) {
      const prefix = `${assetKind(slug)}-${slug}-`;
      composite = reference.startsWith(prefix) ? encodeId(slug, reference.slice(prefix.length)) : undefined;
      if (composite === undefined) {
        throw invalid(`The file ${reference} is not in ${slug}.`);
      }
    }
  } else {
    const reference = object['_ref'];
    composite = typeof reference === 'string' ? reference : undefined;
  }
  const decoded = composite === undefined ? undefined : decodeId(composite);
  if (decoded === undefined) {
    return undefined;
  }
  // Several target collections: Payload wants `{ relationTo, value }`.
  return field.to.length > 1 ? { relationTo: decoded.slug, value: decoded.id } : decoded.id;
}

function groupOut(fields: readonly PayloadField[], value: RemoteValue, context: WriteContext): Record<string, unknown> {
  const object = objectOf(value) ?? {};
  const out: Record<string, unknown> = {};
  for (const inner of fields) {
    const entry = object[inner.name];
    out[inner.name] = toPayloadValue(inner, entry, { ...context, previous: undefined });
  }
  return out;
}

function rowsOut(
  value: RemoteValue,
  context: WriteContext,
  shape: (row: { readonly [key: string]: RemoteValue }) => { readonly fields: readonly PayloadField[]; readonly blockType: string | undefined } | undefined,
): unknown[] {
  const out: unknown[] = [];
  for (const item of listOf(value)) {
    const row = objectOf(item);
    if (row === undefined) {
      continue;
    }
    const found = shape(row);
    if (found === undefined) {
      continue;
    }
    const key = row['_key'];
    const body = groupOut(found.fields, row, context);
    // A row keeps the id Payload gave it; a new row gets one from Payload (a made-up id can be refused).
    const withId = typeof key === 'string' && context.rowIds.has(key) ? { ...body, id: key } : body;
    out.push(found.blockType === undefined ? withId : { ...withId, blockType: found.blockType });
  }
  return out;
}

// Lexical rich text.

interface LexicalText {
  readonly text: string;
  /** Only plain paragraphs of plain text: the text can be written back without losing anything. */
  readonly simple: boolean;
}

/** The text of a Lexical tree, one paragraph per line, and whether the tree is only that. */
export function lexicalText(raw: unknown): LexicalText | undefined {
  const root = rootOf(raw);
  if (root === undefined) {
    return undefined;
  }
  const lines: string[] = [];
  let simple = true;
  for (const node of nodesIn(root).slice(0, REMOTE_SCHEMA_LIMITS.valueNodesMax)) {
    const paragraph = paragraphText(node);
    if (paragraph === undefined) {
      simple = false;
      lines.push(plainOf(node));
    } else {
      lines.push(paragraph);
    }
  }
  return { text: lines.join('\n'), simple };
}

function rootOf(raw: unknown): object | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const root: unknown = Reflect.get(raw, 'root');
  return typeof root === 'object' && root !== null && Reflect.get(root, 'type') === 'root' ? root : undefined;
}

function nodesIn(parent: object): readonly object[] {
  const children: unknown = Reflect.get(parent, 'children');
  if (!Array.isArray(children)) {
    return [];
  }
  const items: unknown[] = children;
  return items.filter((child): child is object => typeof child === 'object' && child !== null);
}

// The text of a paragraph made only of unformatted text nodes; none for anything else.
function paragraphText(node: object): string | undefined {
  if (Reflect.get(node, 'type') !== 'paragraph') {
    return undefined;
  }
  let text = '';
  for (const child of nodesIn(node)) {
    const value: unknown = Reflect.get(child, 'text');
    const plain =
      Reflect.get(child, 'type') === 'text' &&
      Reflect.get(child, 'format') === 0 &&
      Reflect.get(child, 'mode') === 'normal' &&
      Reflect.get(child, 'style') === '' &&
      Reflect.get(child, 'detail') === 0;
    if (!plain || typeof value !== 'string' || value.includes('\n')) {
      return undefined;
    }
    text += value;
  }
  return text;
}

// The words in any node, for a preview of what cannot be edited here.
function plainOf(node: object, depth = 0): string {
  assert(depth <= REMOTE_SCHEMA_LIMITS.valueDepthMax, 'A rich text preview reads boundedly');
  const own: unknown = Reflect.get(node, 'text');
  if (typeof own === 'string') {
    return own;
  }
  if (depth >= REMOTE_SCHEMA_LIMITS.valueDepthMax) {
    return '';
  }
  return nodesIn(node)
    .map((child) => plainOf(child, depth + 1))
    .join('');
}

/** Whether a stored rich text can be edited as plain paragraphs. */
export function lexicalEditable(raw: unknown): boolean {
  return raw === null || raw === undefined || lexicalText(raw)?.simple === true;
}

function attributeOf(node: object, name: string): unknown {
  return Reflect.get(node, name);
}

// Plain paragraphs rebuilt from text, keeping the root's own attributes and a paragraph's
// attributes from the old tree so nothing else about the document changes.
function lexicalFrom(name: string, value: RemoteValue, previous: unknown): unknown {
  if (typeof value !== 'string') {
    return CLEARED;
  }
  const old = lexicalText(previous);
  if (old !== undefined && !old.simple) {
    throw invalid(`${titleOf(name)} has formatting Stacki cannot edit. Edit it in Payload.`);
  }
  const root = rootOf(previous);
  const rootAttributes =
    root === undefined
      ? { format: '', indent: 0, version: 1, direction: 'ltr' }
      : {
          format: attributeOf(root, 'format'),
          indent: attributeOf(root, 'indent'),
          version: attributeOf(root, 'version'),
          direction: attributeOf(root, 'direction'),
        };
  const lines = value.split('\n');
  assert(lines.length >= 1, 'Splitting text gives at least one line');
  return {
    root: {
      type: 'root',
      ...rootAttributes,
      children: lines.map((line) => ({
        type: 'paragraph',
        format: '',
        indent: 0,
        version: 1,
        direction: 'ltr',
        textFormat: 0,
        children: line.length === 0 ? [] : [{ type: 'text', mode: 'normal', text: line, style: '', detail: 0, format: 0, version: 1 }],
      })),
    },
  };
}

// Bounds.

/** A value cut to what the panel accepts, and whether it was cut (then it is shown but not written). */
export function boundValue(value: RemoteValue | undefined): { readonly value: RemoteValue | undefined; readonly cut: boolean } {
  let nodes = 0;
  let cut = false;
  const walk = (entry: RemoteValue, depth: number): RemoteValue | undefined => {
    nodes += 1;
    if (nodes > VALUE_NODES_SAFE || depth > REMOTE_SCHEMA_LIMITS.valueDepthMax) {
      cut = true;
      return undefined;
    }
    if (typeof entry === 'string') {
      if (entry.length > VALUE_CHARS_SAFE) {
        cut = true;
        return entry.slice(0, VALUE_CHARS_SAFE);
      }
      return entry;
    }
    if (typeof entry !== 'object') {
      return entry;
    }
    if (Array.isArray(entry)) {
      const items: readonly RemoteValue[] = entry;
      return items.flatMap((item) => {
        const inner = walk(item, depth + 1);
        return inner === undefined ? [] : [inner];
      });
    }
    const out: Record<string, RemoteValue> = {};
    const fields = remoteObject(entry) ?? {};
    for (const key of Object.keys(fields)) {
      const inner = fields[key];
      const kept = inner === undefined ? undefined : walk(inner, depth + 1);
      if (kept !== undefined) {
        out[key] = kept;
      }
    }
    return out;
  };
  const bounded = value === undefined ? undefined : walk(value, 0);
  return { value: bounded, cut };
}
