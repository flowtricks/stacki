// A content collection's settings, as the CMS panel edits them: its name, and
// its fields in order, each with the parts of its zod schema a form can change
// — help text (`.describe()`), required or not (`.optional()`), and a minimum
// and maximum (`.min()`, `.max()`: characters for text, the value for numbers).
// They are read from, and written to, the project's content config itself
// (astroSchemaEdit.ts). A field whose schema holds more than that — a union, a
// transform — is listed but left as it is written.

import { record, text } from '../core/boundary';
import { assert } from '../core/assert';
import {
  parseFieldChecks,
  parseFieldDefault,
  parseFieldOptions,
  type FieldChecks,
  type FieldDefault,
} from './fieldChecks';

export const COLLECTION_SETTINGS_LIMITS = {
  fieldsMax: 200,
  descriptionCharsMax: 500,
  fieldNameCharsMax: 64,
} as const;

/**
 * The kinds of field a collection's settings know, as a CMS names them. Each is
 * a zod schema in the content config (astroSchemaEdit.ts): text is a string,
 * a link a `.url()` string, an option a `z.enum`, an image `image()`, a
 * reference `reference('collection')`, and their lists `z.array(…)`; a group
 * is a nested `z.object`, key–value pairs a `z.record`, a constant a
 * `z.literal`, and any value `z.unknown()`. Rich text,
 * a phone number and a file are strings too, so once written they read back as
 * plain text.
 */
export const SETTINGS_FIELD_KINDS = [
  'text',
  'richText',
  'image',
  'multiImage',
  'videoLink',
  'link',
  'email',
  'phone',
  'number',
  'date',
  'switch',
  'color',
  'option',
  'file',
  'reference',
  'multiReference',
  'list',
  'group',
  'keyValue',
  'constant',
  'any',
  'other',
] as const;
export type SettingsFieldKind = (typeof SETTINGS_FIELD_KINDS)[number];

/** The kinds a new field may be: every kind but one written by hand. */
export type NewFieldKind = Exclude<SettingsFieldKind, 'other'>;

/** The kinds that point at another collection, and so name it when added. */
export function pointsAtCollection(kind: SettingsFieldKind): boolean {
  return kind === 'reference' || kind === 'multiReference';
}

export interface SettingsField {
  readonly name: string;
  readonly kind: SettingsFieldKind;
  readonly description: string | undefined;
  readonly required: boolean;
  /** Its zod checks (fieldChecks.ts): lengths, ranges, a pattern and the like. */
  readonly checks: FieldChecks;
  /** An option field's values (`z.enum([…])`); absent for every other kind. */
  readonly options: readonly string[] | undefined;
  /** Its `.default(…)`, filled in when an entry leaves it out. */
  readonly defaultValue: FieldDefault | undefined;
  /** Its schema is a plain type with these settings: a form can rewrite it. */
  readonly editable: boolean;
  /** The collection a reference points at; absent for every other kind. */
  readonly target?: string | undefined;
}

export interface CollectionSettings {
  readonly name: string;
  /** Where its entries live, as its loader says (`src/content/blog`, `src/data/team.json`). */
  readonly source: string | undefined;
  readonly fields: readonly SettingsField[];
}

/** A field's settings as the form saves them. */
export interface FieldUpdate {
  readonly name: string;
  readonly description: string | undefined;
  readonly required: boolean;
  readonly checks: FieldChecks;
  readonly options: readonly string[] | undefined;
  readonly defaultValue: FieldDefault | undefined;
}

export type SettingsChange =
  | { readonly kind: 'renameCollection'; readonly to: string }
  | { readonly kind: 'reorder'; readonly order: readonly string[] }
  | { readonly kind: 'renameField'; readonly from: string; readonly to: string }
  | { readonly kind: 'updateField'; readonly update: FieldUpdate }
  | {
      readonly kind: 'addField';
      readonly name: string;
      readonly fieldKind: NewFieldKind;
      /** The collection a reference points at; absent for every other kind. */
      readonly target: string | undefined;
    }
  | { readonly kind: 'removeField'; readonly name: string }
  | { readonly kind: 'deleteCollection' };

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const NEW_KINDS: readonly NewFieldKind[] = SETTINGS_FIELD_KINDS.filter(
  (kind): kind is NewFieldKind => kind !== 'other',
);

/** A field's name as typed: letters, digits, `-` and `_`, starting with a letter. */
export function parseSettingsFieldName(input: unknown): string {
  const name = text(input).trim();
  if (name.length === 0) {
    throw new Error('Name the field.');
  }
  if (!FIELD_NAME.test(name)) {
    throw new Error('A field name starts with a letter and holds letters, digits, - and _.');
  }
  assert(name.length <= COLLECTION_SETTINGS_LIMITS.fieldNameCharsMax, 'A field name is short');
  return name;
}

export function parseSettingsChange(input: unknown): SettingsChange {
  const value = record(input);
  switch (value['kind']) {
    case 'renameCollection':
      return { kind: 'renameCollection', to: parseCollectionRename(value['to']) };
    case 'reorder':
      return { kind: 'reorder', order: parseOrder(value['order']) };
    case 'renameField': {
      const from = parseSettingsFieldName(value['from']);
      const to = parseSettingsFieldName(value['to']);
      if (from === to) {
        throw new Error('The field already has that name.');
      }
      return { kind: 'renameField', from, to };
    }
    case 'updateField':
      return { kind: 'updateField', update: parseFieldUpdate(value['update']) };
    case 'addField': {
      const fieldKind = parseNewKind(value['fieldKind']);
      const target = value['target'] === undefined ? undefined : text(value['target']);
      if (pointsAtCollection(fieldKind) && target === undefined) {
        throw new Error('Choose the collection the field refers to.');
      }
      if (target !== undefined && !/^[A-Za-z_][\w.-]{0,127}$/.test(target)) {
        throw new Error('Invalid collection name.');
      }
      return {
        kind: 'addField',
        name: parseSettingsFieldName(value['name']),
        fieldKind,
        target: pointsAtCollection(fieldKind) ? target : undefined,
      };
    }
    case 'removeField':
      return { kind: 'removeField', name: parseSettingsFieldName(value['name']) };
    case 'deleteCollection':
      return { kind: 'deleteCollection' };
    default:
      throw new Error('Unknown collection settings change.');
  }
}

export function parseFieldUpdate(input: unknown): FieldUpdate {
  const value = record(input);
  const required = value['required'];
  if (typeof required !== 'boolean') {
    throw new Error('Say whether the field is required.');
  }
  const description = value['description'] === undefined ? undefined : text(value['description']);
  if (
    description !== undefined &&
    description.length > COLLECTION_SETTINGS_LIMITS.descriptionCharsMax
  ) {
    throw new Error('Help text is at most 500 characters.');
  }
  return {
    name: parseSettingsFieldName(value['name']),
    description: description === undefined || description.trim() === '' ? undefined : description,
    required,
    checks: parseFieldChecks(value['checks']),
    options: parseFieldOptions(value['options']),
    defaultValue: parseFieldDefault(value['defaultValue']),
  };
}

export function parseCollectionSettings(input: unknown): CollectionSettings {
  const value = record(input);
  const fields = value['fields'];
  if (!Array.isArray(fields) || fields.length > COLLECTION_SETTINGS_LIMITS.fieldsMax) {
    throw new Error('Expected the collection’s fields.');
  }
  const items: readonly unknown[] = fields;
  const parsed = items.map(parseSettingsField);
  assert(parsed.length <= COLLECTION_SETTINGS_LIMITS.fieldsMax, 'A collection has bounded fields');
  return {
    name: parseAstroCollectionNameOrStored(value['name']),
    source: value['source'] === undefined ? undefined : text(value['source']).slice(0, 1024),
    fields: parsed,
  };
}

function parseSettingsField(input: unknown): SettingsField {
  const value = record(input);
  const kind = SETTINGS_FIELD_KINDS.find((candidate) => candidate === value['kind']);
  if (kind === undefined) {
    throw new Error('Unknown field kind.');
  }
  const required = value['required'];
  const editable = value['editable'];
  if (typeof required !== 'boolean' || typeof editable !== 'boolean') {
    throw new Error('Expected a field’s settings.');
  }
  const description = value['description'] === undefined ? undefined : text(value['description']);
  return {
    name: parseSettingsFieldName(value['name']),
    kind,
    description: description?.slice(0, COLLECTION_SETTINGS_LIMITS.descriptionCharsMax),
    required,
    checks: parseFieldChecks(value['checks']),
    options: parseFieldOptions(value['options']),
    defaultValue: parseFieldDefault(value['defaultValue']),
    editable,
    target: optionalCollection(value['target']),
  };
}

// A collection's stored name: a name the panel already lists (`dream-team-areas`), which a
// typed name is turned into an identifier for, but a stored one is taken as it is.
function parseAstroCollectionNameOrStored(input: unknown): string {
  const name = text(input);
  if (!/^[A-Za-z_][\w.-]{0,127}$/.test(name)) {
    throw new Error('Invalid collection name.');
  }
  return name;
}

/**
 * A collection's new name as typed: kept as written when it is already a name
 * (`team`, `staffMembers`, `staff-members`); otherwise its words joined with
 * dashes in lowercase, as the content folders and data files are named.
 */
export function parseCollectionRename(input: unknown): string {
  const typed = text(input).trim();
  const name = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(typed)
    ? typed
    : typed
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 0)
        .join('-');
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) {
    throw new Error('A collection name starts with a letter and holds letters, digits, - and _.');
  }
  assert(name.length <= 64, 'A collection name is short');
  return name;
}

function parseOrder(input: unknown): readonly string[] {
  if (!Array.isArray(input) || input.length > COLLECTION_SETTINGS_LIMITS.fieldsMax) {
    throw new Error('Expected the fields in their new order.');
  }
  const items: readonly unknown[] = input;
  const order = items.map(parseSettingsFieldName);
  if (new Set(order).size !== order.length) {
    throw new Error('A field is named twice.');
  }
  assert(order.length <= COLLECTION_SETTINGS_LIMITS.fieldsMax, 'An order is bounded');
  return order;
}

function parseNewKind(input: unknown): NewFieldKind {
  const kind = NEW_KINDS.find((candidate) => candidate === input);
  if (kind === undefined) {
    throw new Error('Choose what kind of field to add.');
  }
  return kind;
}

function optionalCollection(input: unknown): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  const name = text(input);
  if (!/^[A-Za-z_][\w.-]{0,127}$/.test(name)) {
    throw new Error('Invalid collection name.');
  }
  return name;
}
