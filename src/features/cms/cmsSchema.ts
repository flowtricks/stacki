import { assert } from '../../../shared/core/assert';
import { BOUNDARY_LIMITS, data as parseData } from '../../../shared/core/boundary';
import { toArray, toRecord } from '../../../shared/core/record';
export interface CmsFile {
  readonly rel: string;
  readonly name: string;
  readonly dir: string;
  readonly error?: string;
  readonly data?: unknown;
}
export interface Collection {
  readonly rel: string;
  readonly name: string;
  readonly dir: string;
  readonly label: string;
  readonly error: string | undefined;
  readonly items: readonly unknown[];
  readonly single: boolean;
  readonly rootKey: string | undefined;
  readonly raw?: Readonly<Record<string, unknown>>;
}
export interface CmsField {
  readonly key: string;
  readonly label: string;
  readonly type: FieldType;
}
type ObjectEdit = (object: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>;

// Turns the JSON files under src/ into something a CMS can show: a collection
// of items, each with typed fields. Nothing here is configured — the shape is
// inferred from the data that's already in the file, so a designer can edit
// content without knowing it's JSON.

const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|svg|ico)$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}|$)/;
/**
 * A CSS colour written out: a hex value, or a colour function such as
 * `rgba(0, 0, 0, 0.5)` or `hsl(210 50% 40%)`. Names like `red` are left out, as
 * a word is as likely to be plain text. Stacki's colour picker reads them all.
 */
const HEX_COLOR = '#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})';
const COLOR_FUNCTION = '(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\([^()]*\\)';
export const CSS_COLOR = new RegExp(`^(?:${HEX_COLOR}|${COLOR_FUNCTION})$`, 'i');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  toRecord(value) !== undefined;

/**
 * A value the CMS carries as source rather than data: `{ __expr: "new
 * Date().getFullYear() - FOUNDED" }`. Anything in a data file or a page's
 * frontmatter that isn't a literal arrives this way, so it can still be seen
 * and edited — as code — instead of being invisible. Written back verbatim.
 * The same marker is produced and consumed in electron/content/jsCollections.ts.
 */
export const EXPR_KEY = '__expr';
export const isExpr = (
  value: unknown,
): value is Record<string, unknown> & { readonly __expr: string } =>
  isPlainObject(value) && typeof value[EXPR_KEY] === 'string';

// Field types, most specific first. When items disagree about a field (one has
// a short string, another a paragraph) the earlier type wins.
export const CMS_FIELD_TYPES = [
  'code',
  'objects',
  'object',
  'list',
  'boolean',
  'number',
  'color',
  'email',
  'phone',
  'link',
  'image',
  'date',
  'longtext',
  'text',
  'empty',
] as const;
export type FieldType = (typeof CMS_FIELD_TYPES)[number];

export function inferType(value: unknown): FieldType {
  // A name bound to a picture is a picture. The file says which one — the CMS
  // is handed that beside the name — so the field can show it and swap it,
  // rather than showing the word `dailyDevotionals` in a code box.
  if (isExpr(value)) {
    return typeof value['__asset'] === 'string' && IMAGE_RE.test(value['__asset'])
      ? 'image'
      : 'code';
  }
  if (value === null || value === undefined || value === '') {
    return 'empty';
  }
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (typeof value === 'number') {
    return 'number';
  }
  const values = toArray(value);
  if (values) {
    if (values.length && values.every(isPlainObject)) {
      return 'objects';
    }
    return 'list';
  }
  if (isPlainObject(value)) {
    return 'object';
  }
  const text = String(value);
  if (IMAGE_RE.test(text)) {
    return 'image';
  }
  if (CSS_COLOR.test(text.trim())) {
    return 'color';
  }
  if (DATE_RE.test(text)) {
    return 'date';
  }
  if (text.startsWith('mailto:') || EMAIL_RE.test(text)) {
    return 'email';
  }
  if (text.startsWith('tel:')) {
    return 'phone';
  }
  // Only absolute URLs — a relative path is as likely to be a slug or a
  // filename as a link, and a URL input would fight the user over it.
  if (/^https?:\/\//.test(text)) {
    return 'link';
  }
  if (text.length > 80 || text.includes('\n')) {
    return 'longtext';
  }
  return 'text';
}

// Human label for a file or key: "site-settings.json" → "Site settings",
// "featuredImage" → "Featured image".
export function labelize(raw: unknown): string {
  const base = String(raw).replace(/\.json$/i, '');
  const words = base
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  if (!words) {
    return base;
  }
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

// How a file maps onto a collection:
//   [ {...}, {...} ]              → a list of items
//   { "posts": [ {...} ] }        → the same, remembering the wrapper key
//   { "title": "...", ... }       → one item (a settings file)
// Files whose object has several arrays stay a single item, so each array
// shows up as its own repeater field rather than guessing which one is "the"
// collection.
export function collectionOf(file: CmsFile): Collection {
  const base = {
    rel: file.rel,
    name: file.name,
    dir: file.dir,
    label: labelize(file.name),
    error: file.error || undefined,
  };
  const data = file.data;
  if (file.error || data === undefined) {
    return { ...base, items: [], single: false, rootKey: undefined };
  }

  const rows = toArray(data);
  if (rows) {
    return { ...base, rootKey: undefined, items: rows, single: false };
  }
  if (isPlainObject(data)) {
    const arrayKeys = Object.keys(data).filter((key) => Array.isArray(data[key]));
    const rootKey = arrayKeys[0];
    const rows = rootKey === undefined ? undefined : toArray(data[rootKey]);
    if (arrayKeys.length === 1 && rootKey !== undefined && rows?.every(isPlainObject)) {
      // `raw` keeps the wrapper's other keys so writing back doesn't drop them.
      return { ...base, rootKey, raw: data, items: rows, single: false };
    }
    return { ...base, rootKey: undefined, items: [data], single: true };
  }
  // A bare string/number at the top level: one item holding that value.
  return { ...base, rootKey: undefined, items: [data], single: true };
}

// Puts edited items back in the shape the file had.
export function reassemble(collection: Collection, items: readonly unknown[]): unknown {
  if (collection.single) {
    return items[0] ?? {};
  }
  if (collection.rootKey) {
    return { ...(collection.raw || {}), [collection.rootKey]: items };
  }
  return items;
}

// The fields of a collection: the union of every item's keys, in the order
// they first appear, with a type inferred from the values present.
export function fieldsOf(items: readonly unknown[]): readonly CmsField[] {
  assert(items.length <= BOUNDARY_LIMITS.itemsMax, 'CMS item count exceeds limit');
  const order = [];
  const types = new Map<string, FieldType>();
  for (const item of items) {
    if (!isPlainObject(item)) {
      continue;
    }
    for (const [key, value] of Object.entries(item)) {
      if (!types.has(key)) {
        order.push(key);
        types.set(key, inferType(value));
      } else {
        const seen = types.get(key);
        assert(seen !== undefined, 'Known CMS field must have a type');
        const next = inferType(value);
        if (
          next !== 'empty' &&
          (seen === 'empty' || CMS_FIELD_TYPES.indexOf(next) < CMS_FIELD_TYPES.indexOf(seen))
        ) {
          types.set(key, next);
        }
      }
    }
  }
  return order.map((key) => {
    const type = types.get(key);
    assert(type !== undefined, 'Ordered CMS field must have a type');
    return { key, label: labelize(key), type };
  });
}

// The CMS edits content, while expression markers retain project code for
// round-tripping. Keep those values in the data model but leave them out of
// content forms; imported image references are still content.
export function contentFieldsOf(items: readonly unknown[]): readonly CmsField[] {
  return fieldsOf(items).filter(
    (field) =>
      field.type !== 'code' &&
      items.some((item) => {
        if (isExpr(item)) {
          return false;
        }
        const record = toRecord(item);
        return record !== undefined && contentValue(record[field.key], 0);
      }),
  );
}

export function collectionHasContent(collection: Collection): boolean {
  if (collection.error !== undefined || collection.items.length === 0) {
    return true;
  }
  const fields = fieldsOf(collection.items);
  if (fields.length > 0) {
    return contentFieldsOf(collection.items).length > 0;
  }
  return collection.items.some((item) => contentValue(item, 0));
}

function contentValue(value: unknown, depth: number): boolean {
  assert(depth <= BOUNDARY_LIMITS.depthMax, 'CMS content value exceeds depth limit');
  if (isExpr(value)) {
    return inferType(value) === 'image';
  }
  const record = toRecord(value);
  if (record !== undefined) {
    const values = Object.values(record);
    return values.length === 0 || values.some((child) => contentValue(child, depth + 1));
  }
  const list = toArray(value);
  if (list !== undefined) {
    return list.length === 0 || list.some((child) => contentValue(child, depth + 1));
  }
  return true;
}

const TITLE_KEYS = [
  'name',
  'title',
  'label',
  'heading',
  'headline',
  'question',
  'slug',
  'id',
  'key',
];

// What to call an item in the list. Falls back to the first short string.
export function titleOf(item: unknown, index: number): string {
  if (!isPlainObject(item)) {
    // A list of plain values labels itself; blank ones still need a handle.
    const own = String(item ?? '').trim();
    return own || `Item ${index + 1}`;
  }
  for (const key of TITLE_KEYS) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  for (const value of Object.values(item)) {
    if (typeof value === 'string' && value.trim() && value.length <= 60) {
      return value.trim();
    }
  }
  return `Item ${index + 1}`;
}

// A blank value of the same shape, so "New item" arrives with the collection's
// fields already in place instead of an empty object.
export function blankLike(value: unknown, depth = 0): unknown {
  assert(depth <= BOUNDARY_LIMITS.depthMax, 'CMS value exceeds depth limit');
  const type = inferType(value);
  if (type === 'boolean') {
    return false;
  }
  if (type === 'number') {
    return 0;
  }
  if (type === 'objects') {
    return [];
  }
  if (type === 'list') {
    return [];
  }
  if (type === 'object' && isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const field of contentFieldsOf([value])) {
      out[field.key] = blankLike(value[field.key], depth + 1);
    }
    return out;
  }
  return '';
}

export function blankItem(items: readonly unknown[]): unknown {
  const template = items.find(isPlainObject);
  if (!template) {
    // A collection of plain values (["Halcyon", "Verdant"]) gets another
    // value of the same kind, not an empty object.
    const sample = items.find((i) => i !== null && i !== undefined);
    return sample === undefined ? {} : blankLike(sample);
  }
  const out: Record<string, unknown> = {};
  for (const field of contentFieldsOf(items)) {
    const sample = items.find((i) => isPlainObject(i) && i[field.key] !== undefined);
    out[field.key] = blankLike(isPlainObject(sample) ? sample[field.key] : '');
  }
  return out;
}

// A typed-in field name becomes a JS-friendly key, so the code that reads the
// file gets `client.jobTitle` rather than `client["Job title"]`.
export function keyFor(name: unknown): string {
  const words = String(name)
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) {
    return '';
  }
  return words
    .map((word, i) =>
      i === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join('');
}

export function emptyValueFor(type: string): unknown {
  if (type === 'code') {
    return { [EXPR_KEY]: '' };
  }
  if (type === 'boolean') {
    return false;
  }
  if (type === 'number') {
    return 0;
  }
  if (type === 'list' || type === 'objects') {
    return [];
  }
  if (type === 'object') {
    return {};
  }
  return '';
}

// Copies an item, giving slug-ish fields a distinct value so duplicates don't
// collide on routes that use them.
export function duplicateItem(item: unknown): unknown {
  const decoded: unknown = JSON.parse(JSON.stringify(item));
  const copy: unknown = parseData(decoded);
  if (isPlainObject(copy)) {
    for (const key of ['slug', 'id']) {
      if (typeof copy[key] === 'string' && copy[key]) {
        copy[key] = `${copy[key]}-copy`;
      }
    }
    for (const key of ['name', 'title']) {
      if (typeof copy[key] === 'string' && copy[key]) {
        copy[key] = `${copy[key]} copy`;
        break;
      }
    }
  }
  return copy;
}

export { isPlainObject };

// ---------------------------------------------------------------------------
// Schema edits — the collection's shape, changed across every item at once.
// A `path` addresses a level: [] is the item itself, ['team'] the objects
// inside each item's `team` array (or its `team` group).
// ---------------------------------------------------------------------------

// Every object living at `path`, for reading the fields defined there.
export function objectsAt(
  items: readonly unknown[],
  path: readonly string[],
): readonly Record<string, unknown>[] {
  assert(path.length <= BOUNDARY_LIMITS.depthMax, 'CMS path exceeds depth limit');
  let current = items.filter(isPlainObject);
  for (const key of path) {
    const next: Record<string, unknown>[] = [];
    for (const object of current) {
      const value = object[key];
      const values = toArray(value);
      if (values) {
        next.push(...values.filter(isPlainObject));
      } else if (isPlainObject(value)) {
        next.push(value);
      }
    }
    assert(next.length <= BOUNDARY_LIMITS.itemsMax, 'CMS object count exceeds limit');
    current = next;
  }
  return current;
}

export const fieldsAt = (items: readonly unknown[], path: readonly string[]) =>
  fieldsOf(objectsAt(items, path));

export const contentFieldsAt = (items: readonly unknown[], path: readonly string[]) =>
  contentFieldsOf(objectsAt(items, path));

function transformAt(
  value: unknown,
  path: readonly string[],
  depth: number,
  edit: ObjectEdit,
): unknown {
  // Each level consumes one key of a path its callers bound to depthMax.
  assert(depth <= BOUNDARY_LIMITS.depthMax, 'CMS transform exceeds depth limit');
  if (!path.length) {
    return isPlainObject(value) ? edit(value) : value;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const [key, ...rest] = path;
  assert(key !== undefined, 'Nonempty CMS path must have a key');
  const child = value[key];
  if (child === undefined) {
    return value;
  }
  return {
    ...value,
    [key]: toArray(child)
      ? (toArray(child) ?? []).map((entry) => transformAt(entry, rest, depth + 1, edit))
      : transformAt(child, rest, depth + 1, edit),
  };
}

export function applyToItems(
  items: readonly unknown[],
  path: readonly string[],
  edit: ObjectEdit,
): readonly unknown[] {
  assert(path.length <= BOUNDARY_LIMITS.depthMax, 'CMS path exceeds depth limit');
  assert(items.length <= BOUNDARY_LIMITS.itemsMax, 'CMS item count exceeds limit');
  return items.map((item) => transformAt(item, path, 0, edit));
}

// Renaming rebuilds the object so the field keeps its position in the file.
export const renameKey =
  (from: string, to: string): ObjectEdit =>
  (object) => {
    if (!(from in object) || from === to) {
      return object;
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(object)) {
      out[key === from ? to : key] = value;
    }
    return out;
  };

export const dropKey =
  (key: string): ObjectEdit =>
  (object) => {
    if (!(key in object)) {
      return object;
    }
    const out = { ...object };
    delete out[key];
    return out;
  };

export const putKey =
  (key: string, type: string): ObjectEdit =>
  (object) =>
    key in object ? object : { ...object, [key]: emptyValueFor(type) };

export const orderKeys =
  (keys: readonly string[]): ObjectEdit =>
  (object) => {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (key in object) {
        out[key] = object[key];
      }
    }
    for (const key of Object.keys(object)) {
      if (!(key in out)) {
        out[key] = object[key];
      }
    }
    return out;
  };
