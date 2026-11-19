// A content collection's settings, as the CMS panel edits them: its name, and
// its fields in order, each with the parts of its zod schema a form can change
// — help text (`.describe()`), required or not (`.optional()`), and a minimum
// and maximum (`.min()`, `.max()`: characters for text, the value for numbers).
// They are read from, and written to, the project's content config itself
// (astroSchemaEdit.ts). A field whose schema holds more than that — a union, a
// transform, a message beside a check — is still edited: only the methods for
// the settings that change are rewritten, and the rest stays as written. A new
// field carries its settings, so it is written in one change.

import { record, text } from '../core/boundary';
import { assert } from '../core/assert';
import { described, type Described } from './i18n/messageRef';
import { parseFieldChecks, parseFieldDefault, parseFieldOptions, type FieldChecks, type FieldDefault } from './fieldChecks';

export const COLLECTION_SETTINGS_LIMITS = {
  fieldsMax: 200,
  /** The fields one group or repeater holds. */
  membersMax: 50,
  descriptionCharsMax: 500,
  fieldNameCharsMax: 64,
} as const;

/**
 * The kinds of field a collection's settings know, as a CMS names them. Each is
 * a zod schema in the content config (astroSchemaEdit.ts): text is a string,
 * a link a `.url()` string, an option a `z.enum`, an image `image()`, a
 * reference `reference('collection')`, and their lists `z.array(…)`; a group
 * is a nested `z.object`, a repeater a list of them (`z.array(z.object({ … }))`:
 * team members, FAQs), key–value pairs a `z.record`, a constant a
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
  'repeater',
  'group',
  'keyValue',
  'constant',
  'any',
  'other',
] as const;
export type SettingsFieldKind = (typeof SETTINGS_FIELD_KINDS)[number];

/**
 * The kinds a field inside a group or repeater may be. A reference names a
 * collection and so needs one chosen, and a group or repeater inside another
 * is written by hand: it is read, kept and removed, never made here.
 */
export const MEMBER_KINDS = [
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
  'list',
  'keyValue',
  'constant',
  'any',
] as const;
export type MemberKind = (typeof MEMBER_KINDS)[number];

/** Whether a group or repeater holds fields of its own. */
export function holdsMembers(kind: SettingsFieldKind): boolean {
  return kind === 'group' || kind === 'repeater';
}

/**
 * One field of a group or repeater. Only its name, its kind (when new) and
 * whether it is required are edited here; every other check it has is read
 * from, and left in, the content config. `from` is the name it has there now,
 * absent for one just added; `editable` is false for one written by hand.
 */
export interface SettingsMember {
  readonly name: string;
  readonly kind: SettingsFieldKind;
  readonly required: boolean;
  readonly from: string | undefined;
  readonly editable: boolean;
}

/**
 * What a list holds, as the form offers it: a plain value of one kind, or a
 * group of fields of its own (a repeater: team members, FAQs). A list whose
 * items are written some other way reads as `other` and keeps its items as written.
 */
export const ITEM_KINDS = ['text', 'number', 'link', 'email', 'switch', 'date', 'group'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** The kind a list of these items is: a list of groups is a repeater. */
export function listKindOf(item: ItemKind): 'list' | 'repeater' {
  return item === 'group' ? 'repeater' : 'list';
}

/** What a list or repeater field holds, as its form shows it. */
export function itemKindOf(field: Pick<SettingsField, 'kind' | 'itemKind'>): ItemKind | 'other' | undefined {
  if (field.kind === 'repeater') {
    return 'group';
  }
  return field.kind === 'list' ? (field.itemKind ?? 'text') : undefined;
}

/** A new group's or repeater's fields until the form says otherwise: a title, as the config is written with. */
export function newFieldMembers(kind: SettingsFieldKind): readonly SettingsMember[] | undefined {
  return holdsMembers(kind) ? [{ name: 'title', kind: 'text', required: false, from: undefined, editable: true }] : undefined;
}

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
  /**
   * Its settings can be written back. Every field written as `name: schema`
   * (or shorthand) can; one written as a method or accessor cannot.
   */
  readonly editable: boolean;
  /** The collection a reference points at; absent for every other kind. */
  readonly target?: string | undefined;
  /** A group's or repeater's own fields, in order; absent for every other kind. */
  readonly members?: readonly SettingsMember[] | undefined;
  /** What a plain list holds; a repeater's items are groups, and every other kind has none. */
  readonly itemKind?: ItemKind | 'other' | undefined;
}

export interface CollectionSettings {
  readonly name: string;
  /** Where its entries live, as its loader says (`src/content/blog`, `src/data/team.json`). */
  readonly source: string | undefined;
  readonly fields: readonly SettingsField[];
}

/** A field's settings as the form saves them, apart from its name. */
export interface FieldSettings {
  readonly description: string | undefined;
  readonly required: boolean;
  readonly checks: FieldChecks;
  readonly options: readonly string[] | undefined;
  readonly defaultValue: FieldDefault | undefined;
}

/** An existing field's settings as the form saves them. */
export interface FieldUpdate extends FieldSettings {
  readonly name: string;
  /** A group's or repeater's fields as the form leaves them; absent for every other kind. */
  readonly members?: readonly SettingsMember[] | undefined;
  /** What a list holds as the form leaves it (a change from the current item kind rewrites its items); absent for every other kind. */
  readonly itemKind?: ItemKind | undefined;
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
      /** Its settings, written with it: help text, checks, required, a default. */
      readonly settings: FieldSettings;
      /** A group's or repeater's first fields; absent for every other kind (a new one starts with a title). */
      readonly members?: readonly SettingsMember[] | undefined;
      /** What a new list holds; absent means plain text. */
      readonly itemKind?: ItemKind | undefined;
    }
  | { readonly kind: 'removeField'; readonly name: string }
  | { readonly kind: 'deleteCollection' };

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const NEW_KINDS: readonly NewFieldKind[] = SETTINGS_FIELD_KINDS.filter((kind): kind is NewFieldKind => kind !== 'other');

/** A new field's settings until the form says otherwise: optional, with nothing else set. */
export function newFieldSettings(kind: NewFieldKind): FieldSettings {
  return {
    description: undefined,
    required: false,
    // A colour is a string held to a hex pattern (astroSchemaEdit.ts newFieldText).
    checks: kind === 'color' ? { pattern: '^#[0-9a-fA-F]{6}$' } : {},
    options: kind === 'option' ? ['Option 1', 'Option 2'] : undefined,
    defaultValue: undefined,
  };
}

/** A field's key: letters, digits, `-` and `_`, starting with a letter. */
export function parseSettingsFieldName(input: unknown): string {
  const name = text(input).trim();
  const refusal = fieldNameRefusal(name);
  if (refusal !== undefined) {
    throw new Error(refusal);
  }
  assert(name.length <= COLLECTION_SETTINGS_LIMITS.fieldNameCharsMax, 'A field name is short');
  return name;
}

/** Why `name` cannot be a field's key, or nothing when it can: the English sentence and the reference the panel translates. */
export function fieldNameProblem(name: string): Described | undefined {
  if (name.length === 0) {
    return described('cmsBackend.fieldName.empty');
  }
  if (name.length > COLLECTION_SETTINGS_LIMITS.fieldNameCharsMax) {
    return described('cmsBackend.fieldName.tooLong', { count: COLLECTION_SETTINGS_LIMITS.fieldNameCharsMax });
  }
  return FIELD_NAME.test(name) ? undefined : described('cmsBackend.fieldName.invalid');
}

/** The English sentence of `fieldNameProblem`, for the boundary parser that throws it. */
export function fieldNameRefusal(name: string): string | undefined {
  return fieldNameProblem(name)?.message;
}

/** What a field's name box holds, as the form reads it. */
export type TypedFieldName = { readonly kind: 'blank' } | ({ readonly kind: 'invalid' } & Described) | { readonly kind: 'key'; readonly key: string };

/**
 * What a typed name is saved as, the way a collection's name is: kept as written
 * when it already is a key (`heroImage`, `hero_image`), otherwise its words
 * joined with dashes (`My Field` → `my-field`). Blank is not a mistake, only a
 * name not yet given, so a form can tell an unfinished row from a wrong one.
 */
export function typedFieldName(typed: string): TypedFieldName {
  const trimmed = typed.trim();
  if (trimmed.length === 0) {
    return { kind: 'blank' };
  }
  const key = FIELD_NAME.test(trimmed) ? trimmed : dashedWords(trimmed);
  // A label of no words leaves no key, which is a bad name and not a missing one.
  const refusal = fieldNameProblem(key === '' ? trimmed : key);
  return refusal === undefined ? { kind: 'key', key } : { kind: 'invalid', ...refusal };
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
        settings: parseFieldSettings(value['settings']),
        members: holdsMembers(fieldKind) ? parseMembers(value['members']) : undefined,
        itemKind: fieldKind === 'list' ? parseItemKind(value['itemKind']) : undefined,
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
  return {
    name: parseSettingsFieldName(value['name']),
    ...parseFieldSettings(input),
    members: parseMembers(value['members']),
    itemKind: parseItemKind(value['itemKind']),
  };
}

function parseStoredItemKind(input: unknown): ItemKind | 'other' | undefined {
  return input === 'other' ? 'other' : parseItemKind(input);
}

function parseItemKind(input: unknown): ItemKind | undefined {
  if (input === undefined) {
    return undefined;
  }
  const kind = ITEM_KINDS.find((candidate) => candidate === input);
  if (kind === undefined) {
    throw new Error('Unknown list item kind.');
  }
  return kind;
}

/** A group's or repeater's fields from the wire: bounded, each a key, a known kind, unique names. */
export function parseMembers(input: unknown): readonly SettingsMember[] | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!Array.isArray(input) || input.length > COLLECTION_SETTINGS_LIMITS.membersMax) {
    throw new Error('Expected the group’s fields.');
  }
  const items: readonly unknown[] = input;
  const members = items.map(parseMember);
  if (new Set(members.map((member) => member.name)).size !== members.length) {
    throw new Error('A group’s fields have different names.');
  }
  assert(members.length <= COLLECTION_SETTINGS_LIMITS.membersMax, 'A group holds bounded fields');
  return members;
}

function parseMember(input: unknown): SettingsMember {
  const value = record(input);
  const kind = SETTINGS_FIELD_KINDS.find((candidate) => candidate === value['kind']);
  const required = value['required'];
  const editable = value['editable'];
  if (kind === undefined || typeof required !== 'boolean' || typeof editable !== 'boolean') {
    throw new Error('Expected a group field’s settings.');
  }
  const from = value['from'] === undefined ? undefined : parseSettingsFieldName(value['from']);
  // A field made here is one of the kinds a form offers; any other can only have been read.
  if (from === undefined && !MEMBER_KINDS.some((candidate) => candidate === kind)) {
    throw new Error('A new group field is a kind a group can hold.');
  }
  return { name: parseSettingsFieldName(value['name']), kind, required, from, editable };
}

export function parseFieldSettings(input: unknown): FieldSettings {
  const value = record(input);
  const required = value['required'];
  if (typeof required !== 'boolean') {
    throw new Error('Say whether the field is required.');
  }
  const description = value['description'] === undefined ? undefined : text(value['description']);
  if (description !== undefined && description.length > COLLECTION_SETTINGS_LIMITS.descriptionCharsMax) {
    throw new Error('Help text is at most 500 characters.');
  }
  return {
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
    members: parseMembers(value['members']),
    itemKind: parseStoredItemKind(value['itemKind']),
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
  const name = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(typed) ? typed : dashedWords(typed);
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) {
    throw new Error('A collection name starts with a letter and holds letters, digits, - and _.');
  }
  assert(name.length <= 64, 'A collection name is short');
  return name;
}

// A label's words in lowercase, joined with dashes. An accent is dropped from its
// letter first, so `Café` keeps its last letter rather than splitting on it.
function dashedWords(label: string): string {
  return label
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0)
    .join('-');
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
