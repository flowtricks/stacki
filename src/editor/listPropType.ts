// A List property: a prop whose value is a list of items that each hold the
// same fields, declared the way a person writes one in Astro:
//
//   interface Props {
//     items?: readonly { title: string; text: string }[];
//   }
//   const { items = [{ title: "Commit", text: "to a genuine relationship" }] } = Astro.props;
//
// The item type is written inline, or by the name of a type the file already
// declares with exactly those fields (`readonly Value[]`), so nothing is
// declared twice. The list always gets a default, `[]` when no items were
// given, because a component loops over it (`items.map(…)`) and `undefined`
// cannot be looped over.
//
// Each field has a kind the form offers. Text, Image and Link are all `string`
// in TypeScript: an item lives in one array literal, which can hold a URL or a
// path in public/ but not an imported asset, and the instance panel tells an
// image or a link field from a text one by its name (fieldNames.ts), the
// signal it already reads for every other prop. Number is `number`, Switch is
// `boolean`. Pure, so the writing is pinned by tests without a renderer.

import { parser } from '@lezer/javascript';
import type { SyntaxNode } from '@lezer/common';
import { assert } from '../../shared/core/assert';
import { LOOP_SYNTAX_LIMITS } from './loopSyntax';
import { isLinkName, isMediaName } from './fieldNames';

/** What one field of an item holds, as the form offers it. */
export const ITEM_FIELD_KINDS = ['text', 'number', 'switch', 'image', 'link'] as const;
export type ItemFieldKind = (typeof ITEM_FIELD_KINDS)[number];

/** One field every item of a list has: `title`, a text. */
export interface ItemFieldDeclaration {
  readonly name: string;
  readonly kind: ItemFieldKind;
}

/** One default item: each field's value as typed (`"3"` for a number, `"true"` for a switch). */
export type ListItemValues = Readonly<Record<string, string>>;

/** A List property's item fields and its default items. */
export interface ListSettings {
  readonly fields: readonly ItemFieldDeclaration[];
  readonly items: readonly ListItemValues[];
}

export const LIST_LIMITS = {
  fieldsMax: 24,
  itemsMax: 100,
  fieldNameCharsMax: 64,
  valueCharsMax: 2000,
} as const satisfies Record<string, number>;

/** What each kind is called in the form. */
export const ITEM_FIELD_TITLES: Readonly<Record<ItemFieldKind, string>> = {
  text: 'Text',
  number: 'Number',
  switch: 'Switch',
  image: 'Image',
  link: 'Link',
};

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const NUMBER = /^-?\d+(?:\.\d+)?$/;
const typescript = parser.configure({ dialect: 'ts' });

/** The TypeScript type a field of `kind` is declared with. */
export function itemFieldType(kind: ItemFieldKind): 'string' | 'number' | 'boolean' {
  switch (kind) {
    case 'text':
    case 'image':
    case 'link':
      return 'string';
    case 'number':
      return 'number';
    case 'switch':
      return 'boolean';
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** Why a list's fields and items cannot be written, or undefined when they can. */
export function listSettingsProblem(settings: ListSettings): string | undefined {
  const { fields, items } = settings;
  if (fields.length === 0) {
    return 'Add at least one field to each item.';
  }
  if (fields.length > LIST_LIMITS.fieldsMax) {
    return 'That is too many fields.';
  }
  for (const field of fields) {
    const problem = fieldNameProblem(field.name);
    if (problem !== undefined) {
      return problem;
    }
  }
  const names = fields.map((field) => field.name);
  if (new Set(names).size !== names.length) {
    return 'Each field has to have its own name.';
  }
  if (items.length > LIST_LIMITS.itemsMax) {
    return 'That is too many items.';
  }
  for (const [index, item] of items.entries()) {
    const problem = itemProblem(fields, item, index);
    if (problem !== undefined) {
      return problem;
    }
  }
  return undefined;
}

/** Why `name` cannot name an item field, or undefined when it can. */
export function fieldNameProblem(name: string): string | undefined {
  if (name === '') {
    return 'Each field needs a name.';
  }
  if (name.length > LIST_LIMITS.fieldNameCharsMax) {
    return 'A field name is too long.';
  }
  return IDENTIFIER.test(name) ? undefined : `${name} is not a field name: use letters and numbers, starting with a letter.`;
}

function itemProblem(fields: readonly ItemFieldDeclaration[], item: ListItemValues, index: number): string | undefined {
  for (const field of fields) {
    const value = item[field.name] ?? '';
    if (value.length > LIST_LIMITS.valueCharsMax) {
      return `The ${field.name} of item ${index + 1} is too long.`;
    }
    if (field.kind === 'number' && value.trim() !== '' && !NUMBER.test(value.trim())) {
      return `The ${field.name} of item ${index + 1} has to be a number.`;
    }
    if (field.kind === 'switch' && value !== '' && value !== 'true' && value !== 'false') {
      return `The ${field.name} of item ${index + 1} is on or off.`;
    }
  }
  return undefined;
}

/** The fields a new list's items start with, wherever the list is made: a title and a line of text, as a list of values, features or steps most often is. */
export const LIST_STARTER_FIELDS: readonly ItemFieldDeclaration[] = [
  { name: 'title', kind: 'text' },
  { name: 'text', kind: 'text' },
];

/** One item's type, inline: `{ title: string; text: string }`. */
export function itemTypeText(fields: readonly ItemFieldDeclaration[]): string {
  assert(fields.length > 0, 'itemTypeText: an item has a field');
  assert(fields.length <= LIST_LIMITS.fieldsMax, 'itemTypeText: the fields are bounded');
  return `{ ${fields.map((field) => `${field.name}: ${itemFieldType(field.kind)}`).join('; ')} }`;
}

/**
 * The list's type: `readonly Value[]` when the frontmatter declares a type
 * `Value` with exactly these fields, else the item type written inline.
 */
export function listTypeText(frontmatter: string, fields: readonly ItemFieldDeclaration[]): string {
  const named = namedItemType(frontmatter, fields);
  const out = `readonly ${named ?? itemTypeText(fields)}[]`;
  assert(out.endsWith('[]'), 'listTypeText: a list type is an array');
  return out;
}

/**
 * The default as an array literal, each item's fields in the declared order:
 * text as a string, a number as a number (0 when left empty), a switch as
 * true or false (false when left empty). `[]` for a list with no items.
 */
export function listDefaultCode(settings: ListSettings): string {
  assert(settings.items.length <= LIST_LIMITS.itemsMax, 'listDefaultCode: the items are bounded');
  const items = settings.items.map(
    (item) => `{ ${settings.fields.map((field) => `${field.name}: ${fieldLiteral(field.kind, item[field.name] ?? '')}`).join(', ')} }`,
  );
  const out = `[${items.join(', ')}]`;
  assert(out.startsWith('['), 'listDefaultCode: the default is an array literal');
  return out;
}

function fieldLiteral(kind: ItemFieldKind, value: string): string {
  switch (kind) {
    case 'text':
    case 'image':
    case 'link':
      return JSON.stringify(value);
    case 'number': {
      const trimmed = value.trim();
      return trimmed === '' ? '0' : String(Number(trimmed));
    }
    case 'switch':
      return value === 'true' ? 'true' : 'false';
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/**
 * The name of a type the frontmatter declares whose members are exactly
 * `fields`, with the types they are written with: `interface Value { title:
 * string; text: string }` or `type Value = { … }`. Undefined when none is.
 * `Props` itself never is, and a generic or extending type is not read.
 */
export function namedItemType(frontmatter: string, fields: readonly ItemFieldDeclaration[]): string | undefined {
  if (frontmatter.length > LOOP_SYNTAX_LIMITS.sourceCharsMax || fields.length === 0) {
    return undefined;
  }
  const wanted = new Map(fields.map((field) => [field.name, itemFieldType(field.kind)]));
  const tree = typescript.parse(frontmatter);
  for (
    let statement = tree.topNode.firstChild, count = 0;
    statement !== null && count < LOOP_SYNTAX_LIMITS.declarationsMax;
    statement = statement.nextSibling, count++
  ) {
    const declaration = statement.name === 'ExportDeclaration' ? (statement.firstChild?.nextSibling ?? undefined) : statement;
    const named = declaration === undefined ? undefined : objectTypeOf(declaration, frontmatter);
    if (named !== undefined && named.name !== 'Props' && sameMembers(members(named.body, frontmatter), wanted)) {
      return named.name;
    }
  }
  return undefined;
}

// `interface X { … }` or `type X = { … }`: its name and its body.
function objectTypeOf(declaration: SyntaxNode, source: string): { readonly name: string; readonly body: SyntaxNode } | undefined {
  if (declaration.name !== 'InterfaceDeclaration' && declaration.name !== 'TypeAliasDeclaration') {
    return undefined;
  }
  const name = declaration.getChild('TypeDefinition') ?? undefined;
  const body = declaration.getChild('ObjectType') ?? undefined;
  if (name === undefined || body === undefined) {
    return undefined;
  }
  // `interface X extends Y` or `interface X<T>` holds more than its body says.
  const head = source.slice(name.to, body.from).trim();
  if (declaration.name === 'InterfaceDeclaration' && head !== '') {
    return undefined;
  }
  if (declaration.name === 'TypeAliasDeclaration' && head !== '=') {
    return undefined;
  }
  return { name: source.slice(name.from, name.to), body };
}

// `name → type text` for each member of an object type; undefined when one is
// not a plain `name: type` (a method, an index signature).
function members(body: SyntaxNode, source: string): ReadonlyMap<string, string> | undefined {
  const out = new Map<string, string>();
  let child = body.firstChild ?? undefined;
  for (let count = 0; child !== undefined && count <= LIST_LIMITS.fieldsMax * 2 + 2; count++) {
    if (child.name === 'PropertyType') {
      const name = child.getChild('PropertyDefinition') ?? undefined;
      const type = child.getChild('TypeAnnotation')?.lastChild ?? undefined;
      if (name === undefined || type === undefined) {
        return undefined;
      }
      out.set(source.slice(name.from, name.to), source.slice(type.from, type.to).trim());
    } else if (
      child.name !== '{' &&
      child.name !== '}' &&
      child.name !== ';' &&
      child.name !== ',' &&
      child.name !== 'LineComment' &&
      child.name !== 'BlockComment'
    ) {
      return undefined;
    }
    child = child.nextSibling ?? undefined;
  }
  return out;
}

function sameMembers(found: ReadonlyMap<string, string> | undefined, wanted: ReadonlyMap<string, string>): boolean {
  if (found === undefined) {
    return false;
  }
  if (found.size !== wanted.size) {
    return false;
  }
  return [...wanted].every(([name, type]) => found.get(name) === type);
}

/**
 * The item fields a list type declares, read back the way listTypeText writes
 * them: `readonly { title: string; on: boolean }[]`, `Array<{ … }>`, or
 * `readonly Value[]` naming a type `frontmatter` declares. A string field's
 * kind comes from its name (an image, a link, else text), as the instance
 * panel tells them apart. Undefined for a type that is not a list of plain
 * fields: the Properties panel then edits it as code only.
 */
export function listFieldsOfType(type: string, frontmatter: string): readonly ItemFieldDeclaration[] | undefined {
  if (type.length > LOOP_SYNTAX_LIMITS.sourceCharsMax || frontmatter.length > LOOP_SYNTAX_LIMITS.sourceCharsMax) {
    return undefined;
  }
  const item = arrayItemType(type.trim());
  if (item === undefined) {
    return undefined;
  }
  const found = item.startsWith('{') ? inlineMembers(item) : namedMembers(item, frontmatter);
  if (found === undefined || found.size === 0 || found.size > LIST_LIMITS.fieldsMax) {
    return undefined;
  }
  const fields: ItemFieldDeclaration[] = [];
  for (const [name, memberType] of found) {
    const kind = memberKind(name, memberType.replace(/\s+/g, ''));
    if (kind === undefined || fieldNameProblem(name) !== undefined) {
      return undefined;
    }
    fields.push({ name, kind });
  }
  assert(fields.length === found.size, 'listFieldsOfType: every member is a field');
  return fields;
}

// `readonly X[]`, `X[]`, `Array<X>` or `ReadonlyArray<X>`: X.
function arrayItemType(type: string): string | undefined {
  const bare = type.replace(/^readonly\s+/, '').trim();
  const generic = /^(?:Readonly)?Array<([\s\S]*)>$/.exec(bare);
  if (generic?.[1] !== undefined) {
    return generic[1].trim();
  }
  const suffix = /^([\s\S]*)\[\]$/.exec(bare);
  const inner = suffix?.[1]?.trim();
  if (inner === undefined || inner === '') {
    return undefined;
  }
  // `(A | B)[]` and `X[][]` hold more than plain items.
  return inner.endsWith(']') || inner.startsWith('(') ? undefined : inner;
}

// The members of an object type written inline.
function inlineMembers(item: string): ReadonlyMap<string, string> | undefined {
  const source = `type Item = ${item};`;
  const tree = typescript.parse(source);
  const declaration = tree.topNode.firstChild ?? undefined;
  const named = declaration === undefined ? undefined : objectTypeOf(declaration, source);
  return named === undefined ? undefined : members(named.body, source);
}

// The members of the type `name` the frontmatter declares.
function namedMembers(name: string, frontmatter: string): ReadonlyMap<string, string> | undefined {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
    return undefined;
  }
  const tree = typescript.parse(frontmatter);
  for (
    let statement = tree.topNode.firstChild, count = 0;
    statement !== null && count < LOOP_SYNTAX_LIMITS.declarationsMax;
    statement = statement.nextSibling, count++
  ) {
    const declaration = statement.name === 'ExportDeclaration' ? (statement.firstChild?.nextSibling ?? undefined) : statement;
    const named = declaration === undefined ? undefined : objectTypeOf(declaration, frontmatter);
    if (named !== undefined && named.name === name) {
      return members(named.body, frontmatter);
    }
  }
  return undefined;
}

function memberKind(name: string, type: string): ItemFieldKind | undefined {
  switch (type) {
    case 'number':
      return 'number';
    case 'boolean':
      return 'switch';
    case 'string':
      if (isMediaName(name)) {
        return 'image';
      }
      return isLinkName(name) ? 'link' : 'text';
    default:
      return undefined;
  }
}
