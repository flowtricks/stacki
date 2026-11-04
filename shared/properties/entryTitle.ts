// The name an entry shows by in the CMS panel: its list row, its editor's
// header, and the choices a reference to it offers.
//
// One rule, in order:
//   1. A field named as a name: the keys both CMS backends read (Sanity's
//      list query coalesces the same four, sanityPreview.ts), then the few
//      Astro collections use besides.
//   2. Otherwise the first field, in schema order, that holds short text: a
//      one-line string or a number. A stats card whose fields are Number,
//      Header and Description is named by its number, as its first field.
//   3. Otherwise the entry's id, which a glob collection derives from the
//      file name and so is always something.
//   4. Only then "untitled".
//
// Matching is by exact key: `Header` is the stats card's second field, not a
// name field, and treating it as one would put the card's caption before the
// figure the author wrote first.

import { assert } from '../core/assert';
import { toArray, toRecord } from '../core/record';

/** The name fields Sanity's list query also reads, in its order. */
export const NAME_KEYS = ['title', 'name', 'heading', 'label'] as const;

/** Name fields only Astro collections use; read after the shared ones. */
const ASTRO_NAME_KEYS = ['header', 'question', 'siteName', 'quote'] as const;

/** A name past this is cut, so a long field cannot stretch a list row. */
export const ENTRY_TITLE_CHARS_MAX = 200;

/** Fields read for a name at most, so a record with thousands of keys costs a bounded scan. */
const ENTRY_TITLE_FIELDS_MAX = 200;

/** What gives an entry its name when it has none. */
export const UNTITLED = 'untitled';

// A string that names a picture file is a path, not a name.
const IMAGE_PATH = /\.(?:avif|gif|jpe?g|png|svg|webp)$/i;

/** The fields a collection's schema declares, in order, and those that never hold a name. */
export interface TitleFields {
  readonly order: readonly string[];
  /** Images and references: their values are paths and ids, not names. */
  readonly skipped: readonly string[];
}

export const NO_TITLE_FIELDS: TitleFields = { order: [], skipped: [] };

/** The schema's declared fields as `entryTitleOf` reads them. */
export function titleFieldsOf(schema: unknown): TitleFields {
  const properties = toRecord(toRecord(schema)?.['properties']);
  if (properties === undefined) {
    return NO_TITLE_FIELDS;
  }
  const order: string[] = [];
  const skipped: string[] = [];
  for (const [name, property] of Object.entries(properties).slice(0, ENTRY_TITLE_FIELDS_MAX)) {
    order.push(name);
    if (namesNothing(property)) {
      skipped.push(name);
    }
  }
  assert(order.length <= ENTRY_TITLE_FIELDS_MAX, 'Title fields are bounded');
  assert(skipped.length <= order.length, 'Only declared fields are skipped');
  return { order, skipped };
}

/** The name an entry shows by: a name field, its first short text field, its id, or "untitled". */
export function entryTitleOf(data: unknown, context: { readonly id: string; readonly fields: TitleFields }): string {
  const title = entryNameOf(data, context.fields) ?? (context.id.trim() || UNTITLED);
  const shown = title.slice(0, ENTRY_TITLE_CHARS_MAX);
  assert(shown.length > 0, 'An entry is always named');
  assert(shown.length <= ENTRY_TITLE_CHARS_MAX, 'An entry name is bounded');
  return shown;
}

/** Steps 1 and 2 alone: the name an entry's own fields give it, or nothing (a new entry's slug follows it). */
export function entryNameOf(data: unknown, fields: TitleFields): string | undefined {
  const record = toRecord(data) ?? {};
  const name = namedTitle(record) ?? firstTextTitle(record, fields);
  assert(name === undefined || name.trim() !== '', 'A name is never blank');
  return name?.slice(0, ENTRY_TITLE_CHARS_MAX);
}

function namedTitle(record: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of [...NAME_KEYS, ...ASTRO_NAME_KEYS]) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  return undefined;
}

// The schema's order first; then, for a field the schema does not declare (or
// a collection with no schema), the order the file wrote them in.
function firstTextTitle(record: Readonly<Record<string, unknown>>, fields: TitleFields): string | undefined {
  const declared = new Set(fields.order);
  const names = [...fields.order, ...Object.keys(record).filter((name) => !declared.has(name))].slice(0, ENTRY_TITLE_FIELDS_MAX);
  for (const name of names) {
    if (fields.skipped.includes(name)) {
      continue;
    }
    const text = shortText(record[name]);
    if (text !== undefined) {
      return text;
    }
  }
  return undefined;
}

// Text that reads as a name: one line, short, not a picture's path; a number as written.
function shortText(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value.trim();
  if (text === '') {
    return undefined;
  }
  if (text.length > ENTRY_TITLE_CHARS_MAX) {
    return undefined;
  }
  if (text.includes('\n')) {
    return undefined;
  }
  return IMAGE_PATH.test(text) ? undefined : text;
}

// An image or a reference, by the marks the config reader puts on its schema
// node, or on either branch of the nullable union an optional one becomes.
function namesNothing(property: unknown): boolean {
  const node = toRecord(property);
  if (node === undefined) {
    return false;
  }
  const branches = toArray(node['anyOf']) ?? toArray(node['oneOf']) ?? [];
  return [node, ...branches.slice(0, 2)].some((each) => {
    const branch = toRecord(each);
    if (branch === undefined) {
      return false;
    }
    if (branch['astroImage'] === true) {
      return true;
    }
    return branch['astroReference'] !== undefined;
  });
}
