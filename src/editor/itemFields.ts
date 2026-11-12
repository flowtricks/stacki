// The fields a List property's items have, and what each one holds. This is the
// model behind the Property settings pop-up's "Item fields" and the default
// items editor: pure, so what a kind means, how deep a list may nest and which
// names are refused are pinned by tests without a renderer. The text that
// writes these fields into a component's types, and reads them back, is in
// listPropType.ts.
//
// A kind is one of the sixteen below. Thirteen of them hold a single value (a
// string, a number or a switch) and two are structure: a LIST is an array of
// objects that have fields of their own, and a GROUP is one object with fields
// of its own. Both nest: an item can hold a list whose items hold a list, down
// to LIMITS.listFieldDepthMax levels of fields. OPTION is a union of the string
// literals a person types in, shown as a dropdown.
//
// Most string kinds are all `string` in TypeScript, so the type alone cannot
// say which one a field is. A field says so with a doc tag on its member,
// `/** @format color */ accent: string`, the very tag a top-level prop uses
// (shared/properties/propTags.ts). A name that already says what the field is
// (`heroImage` holds an image, `ctaHref` a link) needs no tag, which is how
// lists written before these kinds existed still read: a tag is written only
// when the chosen kind differs from what the name implies.

import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import { isLinkName, isMediaName } from './fieldNames';

/** What one field of an item holds, in the order the menu lists them. */
export const ITEM_FIELD_KINDS = [
  'text',
  'longText',
  'richText',
  'number',
  'switch',
  'image',
  'video',
  'file',
  'link',
  'email',
  'phone',
  'color',
  'date',
  'option',
  'list',
  'group',
] as const;
export type ItemFieldKind = (typeof ITEM_FIELD_KINDS)[number];

/** The kinds that are one string, told apart by their `@format` word. */
export const STRING_FIELD_KINDS = ['text', 'longText', 'richText', 'image', 'video', 'file', 'link', 'email', 'phone', 'color', 'date'] as const;
export type StringFieldKind = (typeof STRING_FIELD_KINDS)[number];

/** The kinds that hold a single value, as written: a string, a number or a switch. */
export type PlainFieldKind = StringFieldKind | 'number' | 'switch';

/** The kinds with fields of their own. */
export type StructureFieldKind = 'list' | 'group';

interface FieldBase {
  readonly name: string;
}

/** One field every item of a list has: a `title`, a text. */
export type ItemFieldDeclaration =
  | (FieldBase & { readonly kind: PlainFieldKind })
  | (FieldBase & { readonly kind: 'option'; readonly options: readonly string[] })
  | (FieldBase & { readonly kind: StructureFieldKind; readonly fields: readonly ItemFieldDeclaration[] });

/** One default item: each field's value as typed (`"3"` for a number, `"true"` for a switch, array or object code for a list or a group). */
export type ListItemValues = Readonly<Record<string, string>>;

/** What each kind is called in the form. */
export const ITEM_FIELD_TITLES: Readonly<Record<ItemFieldKind, string>> = {
  text: 'Text',
  longText: 'Long text',
  richText: 'Rich text',
  number: 'Number',
  switch: 'Switch',
  image: 'Image',
  video: 'Video link',
  file: 'File',
  link: 'Link',
  email: 'Email',
  phone: 'Phone',
  color: 'Color',
  date: 'Date',
  option: 'Option',
  list: 'List',
  group: 'Group',
};

/** The `@format` word that tells each string kind. */
export const FORMAT_WORDS: Readonly<Record<StringFieldKind, string>> = {
  text: 'text',
  longText: 'longtext',
  richText: 'richtext',
  image: 'image',
  video: 'video',
  file: 'file',
  link: 'link',
  email: 'email',
  phone: 'phone',
  color: 'color',
  date: 'date',
};

export const ITEM_FIELD_LIMITS = {
  fieldsPerLevelMax: LIMITS.listFieldsPerLevelMax,
  fieldsTotalMax: LIMITS.listFieldsTotalMax,
  depthMax: LIMITS.listFieldDepthMax,
  optionsMax: LIMITS.listOptionsMax,
  optionCharsMax: 64,
  nameCharsMax: 64,
  // One more than depthMax: a walk over fields that are not yet checked stops one level past the bound.
  walkDepthMax: LIMITS.listFieldDepthMax + 1,
} as const satisfies Record<string, number>;

/** Names an object literal or a prototype chain gives a meaning of its own: `{ __proto__: "x" }` sets a prototype, it holds no field. */
const RESERVED_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Why `name` cannot name an item field, or undefined when it can. */
export function fieldNameProblem(name: string): string | undefined {
  if (name === '') {
    return 'Each field needs a name.';
  }
  if (name.length > ITEM_FIELD_LIMITS.nameCharsMax) {
    return 'A field name is too long.';
  }
  if (!IDENTIFIER.test(name)) {
    return `${name} is not a field name: use letters and numbers, starting with a letter.`;
  }
  return RESERVED_NAMES.has(name) ? `${name} is reserved: JavaScript gives it a meaning of its own.` : undefined;
}

/** Whether a kind is a string, a number or a switch: one value, no fields of its own. */
export function isPlainKind(kind: ItemFieldKind): kind is PlainFieldKind {
  return kind !== 'option' && kind !== 'list' && kind !== 'group';
}

/** Whether a kind is a string, one of the eleven told apart by their `@format`. */
export function isStringKind(kind: ItemFieldKind): kind is StringFieldKind {
  return STRING_FIELD_KINDS.some((candidate) => candidate === kind);
}

/** The fields of a list or a group; none for any other field. */
export function fieldsOf(field: ItemFieldDeclaration): readonly ItemFieldDeclaration[] {
  return field.kind === 'list' || field.kind === 'group' ? field.fields : [];
}

/** What a name says its string holds, when no tag says otherwise: an image, a link, else text. */
export function impliedKind(name: string): 'text' | 'image' | 'link' {
  if (isMediaName(name)) {
    return 'image';
  }
  return isLinkName(name) ? 'link' : 'text';
}

/** The string kind a `@format` word names, or undefined for a word that is none. */
export function kindOfFormat(word: string | undefined): StringFieldKind | undefined {
  return STRING_FIELD_KINDS.find((kind) => FORMAT_WORDS[kind] === word);
}

/**
 * The TypeScript type a field is written with: `string`, `number`, `boolean`,
 * `"a" | "b"`, `readonly { … }[]` or `{ … }`. The structure kinds recurse.
 */
export function fieldTypeText(field: ItemFieldDeclaration): string {
  switch (field.kind) {
    case 'number':
      return 'number';
    case 'switch':
      return 'boolean';
    case 'option':
      return field.options.map((option) => JSON.stringify(option)).join(' | ');
    case 'list':
      return `readonly ${objectTypeText(field.fields)}[]`;
    case 'group':
      return objectTypeText(field.fields);
    case 'text':
    case 'longText':
    case 'richText':
    case 'image':
    case 'video':
    case 'file':
    case 'link':
    case 'email':
    case 'phone':
    case 'color':
    case 'date':
      return 'string';
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

/** One item's type, inline: `{ title: string; /** @format color *\/ tint: string }`. */
export function objectTypeText(fields: readonly ItemFieldDeclaration[]): string {
  assert(fields.length > 0, 'objectTypeText: an object has a field');
  assert(fields.length <= ITEM_FIELD_LIMITS.fieldsPerLevelMax, 'objectTypeText: the fields are bounded');
  return `{ ${fields.map(memberText).join('; ')} }`;
}

// A member, with the tag its kind needs when its name does not already say it.
function memberText(field: ItemFieldDeclaration): string {
  const tag = isStringKind(field.kind) && impliedKind(field.name) !== field.kind ? `/** @format ${FORMAT_WORDS[field.kind]} */ ` : '';
  return `${tag}${field.name}: ${fieldTypeText(field)}`;
}

/** Whether two declarations are the same fields, in the same order, all the way down. */
export function sameFields(left: readonly ItemFieldDeclaration[], right: readonly ItemFieldDeclaration[], depth = 1): boolean {
  assert(depth <= ITEM_FIELD_LIMITS.walkDepthMax, 'sameFields: the levels are bounded');
  if (left.length !== right.length) {
    return false;
  }
  return left.every((field, at) => {
    const other = right[at];
    if (other === undefined || field.name !== other.name || field.kind !== other.kind) {
      return false;
    }
    if (field.kind === 'option' && other.kind === 'option') {
      return field.options.length === other.options.length && field.options.every((option, index) => option === other.options[index]);
    }
    return sameFields(fieldsOf(field), fieldsOf(other), depth + 1);
  });
}

/** How many fields there are on every level of these. */
export function fieldCount(fields: readonly ItemFieldDeclaration[], depth = 1): number {
  assert(depth <= ITEM_FIELD_LIMITS.walkDepthMax, 'fieldCount: the levels are bounded');
  let count = fields.length;
  for (const field of fields) {
    count += fieldCount(fieldsOf(field), depth + 1);
  }
  return count;
}

/** The levels of fields there are: 1 for fields that hold only values, 2 when one is a list or a group. */
export function fieldDepth(fields: readonly ItemFieldDeclaration[], depth = 1): number {
  assert(depth <= ITEM_FIELD_LIMITS.walkDepthMax, 'fieldDepth: the levels are bounded');
  let deepest = depth;
  for (const field of fields) {
    const inner = fieldsOf(field);
    if (inner.length > 0) {
      deepest = Math.max(deepest, fieldDepth(inner, depth + 1));
    }
  }
  return deepest;
}

/**
 * Why these fields cannot be written as the fields of an item, or undefined
 * when they can. `depth` is the level the fields sit on: the item's own are 1,
 * and a list or group on the last level has no room for fields of its own.
 */
export function fieldsProblem(fields: readonly ItemFieldDeclaration[], depth = 1): string | undefined {
  assert(depth >= 1, 'fieldsProblem: levels count from 1');
  if (depth > ITEM_FIELD_LIMITS.depthMax) {
    return `A list can hold lists ${ITEM_FIELD_LIMITS.depthMax} levels deep, no more.`;
  }
  if (fields.length === 0) {
    return 'Add at least one field to each item.';
  }
  if (fields.length > ITEM_FIELD_LIMITS.fieldsPerLevelMax) {
    return 'That is too many fields.';
  }
  const names = fields.map((field) => field.name);
  for (const name of names) {
    const problem = fieldNameProblem(name);
    if (problem !== undefined) {
      return problem;
    }
  }
  if (new Set(names).size !== names.length) {
    return 'Each field has to have its own name.';
  }
  for (const field of fields) {
    const problem = fieldProblem(field, depth);
    if (problem !== undefined) {
      return problem;
    }
  }
  if (depth === 1 && fieldCount(fields) > ITEM_FIELD_LIMITS.fieldsTotalMax) {
    return 'That is too many fields in all.';
  }
  return undefined;
}

// What is wrong with one field's own settings: its choices, or the fields beneath it.
function fieldProblem(field: ItemFieldDeclaration, depth: number): string | undefined {
  switch (field.kind) {
    case 'option':
      return optionsProblem(field);
    case 'list':
    case 'group':
      return fieldsProblem(field.fields, depth + 1);
    case 'text':
    case 'longText':
    case 'richText':
    case 'number':
    case 'switch':
    case 'image':
    case 'video':
    case 'file':
    case 'link':
    case 'email':
    case 'phone':
    case 'color':
    case 'date':
      return undefined;
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

function optionsProblem(field: Extract<ItemFieldDeclaration, { kind: 'option' }>): string | undefined {
  const { options } = field;
  if (options.length < 2) {
    return `${field.name} needs at least two options.`;
  }
  if (options.length > ITEM_FIELD_LIMITS.optionsMax) {
    return `${field.name} has too many options.`;
  }
  if (options.some((option) => option.trim() === '')) {
    return `An option of ${field.name} is empty.`;
  }
  if (options.some((option) => option.length > ITEM_FIELD_LIMITS.optionCharsMax)) {
    return `An option of ${field.name} is too long.`;
  }
  return new Set(options).size === options.length ? undefined : `${field.name} has an option twice.`;
}

/** The nested fields a list or group starts with: one text, as a new list does. */
export const NESTED_STARTER_FIELDS: readonly ItemFieldDeclaration[] = [{ name: 'title', kind: 'text' }];

/** The choices a new Option starts with. */
export const OPTION_STARTER_OPTIONS: readonly string[] = ['Option 1', 'Option 2'];

/**
 * The field with its name and a new kind. Choices and nested fields are
 * kept across the kinds that share them (a list becomes a group of the same
 * fields) and start from a default otherwise.
 */
export function retypedField(field: ItemFieldDeclaration, kind: ItemFieldKind): ItemFieldDeclaration {
  if (kind === 'option') {
    return { name: field.name, kind, options: field.kind === 'option' ? field.options : OPTION_STARTER_OPTIONS };
  }
  if (kind === 'list' || kind === 'group') {
    const kept = fieldsOf(field);
    return { name: field.name, kind, fields: kept.length > 0 ? kept : NESTED_STARTER_FIELDS };
  }
  assert(isPlainKind(kind), 'retypedField: the remaining kinds hold one value');
  return { name: field.name, kind };
}

/** The field with its nested fields replaced, for a list or a group; any other field comes back as it was. */
export function withNestedFields(field: ItemFieldDeclaration, fields: readonly ItemFieldDeclaration[]): ItemFieldDeclaration {
  return field.kind === 'list' || field.kind === 'group' ? { ...field, fields } : field;
}
