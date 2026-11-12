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
// Each field has a kind the form offers (itemFields.ts). Most are `string` in
// TypeScript, told apart by a `@format` document tag on the member, or by a name
// that already says it (`heroImage`, `ctaHref`). Number is `number`, Switch is
// `boolean`, Option is a union of string literals, a List is `readonly { … }[]`
// and a Group is `{ … }`, each with fields of its own down to
// LIMITS.listFieldDepthMax levels. An item lives in one array literal, which
// can hold a URL or a path in public/ but not an imported asset.
//
// Reading is strict, so a type the form could not write back unchanged stays
// code: anything but plain members with the types above (a method, an index
// signature, a generic, `Date`, an intersection, a list of lists of strings)
// reads as undefined, and the Properties panel then edits it as code only.
// Pure, so the writing is pinned by tests without a renderer.

import { parser } from '@lezer/javascript';
import type { SyntaxNode } from '@lezer/common';
import { assert } from '../../shared/core/assert';
import { PROP_TAG_LIMITS, readPropTags } from '../../shared/properties/propTags';
import { LOOP_SYNTAX_LIMITS } from './loopSyntax';
import {
  fieldsProblem,
  fieldNameProblem,
  impliedKind,
  ITEM_FIELD_LIMITS,
  kindOfFormat,
  objectTypeText,
  sameFields,
  type ItemFieldDeclaration,
  type ListItemValues,
  type StringFieldKind,
} from './itemFields';

/** A List property's item fields and its default items. */
export interface ListSettings {
  readonly fields: readonly ItemFieldDeclaration[];
  readonly items: readonly ListItemValues[];
}

export const LIST_LIMITS = {
  fieldsMax: ITEM_FIELD_LIMITS.fieldsPerLevelMax,
  itemsMax: 100,
  fieldNameCharsMax: ITEM_FIELD_LIMITS.nameCharsMax,
  valueCharsMax: 2000,
  // A nested list or group is a whole array or object in one value.
  nestedValueCharsMax: 20_000,
} as const satisfies Record<string, number>;

const NUMBER = /^-?\d+(?:\.\d+)?$/;
const typescript = parser.configure({ dialect: 'ts' });

/** Why a list's fields and items cannot be written, or undefined when they can. */
export function listSettingsProblem(settings: ListSettings): string | undefined {
  const { fields, items } = settings;
  const problem = fieldsProblem(fields);
  if (problem !== undefined) {
    return problem;
  }
  if (items.length > LIST_LIMITS.itemsMax) {
    return 'That is too many items.';
  }
  for (const [index, item] of items.entries()) {
    const itemIssue = itemProblem(fields, item, index);
    if (itemIssue !== undefined) {
      return itemIssue;
    }
  }
  return undefined;
}

function itemProblem(fields: readonly ItemFieldDeclaration[], item: ListItemValues, index: number): string | undefined {
  for (const field of fields) {
    const value = item[field.name] ?? '';
    const where = `The ${field.name} of item ${index + 1}`;
    if (field.kind === 'list' || field.kind === 'group') {
      const problem = nestedValueProblem(field.kind, value);
      if (problem !== undefined) {
        return `${where} ${problem}`;
      }
      continue;
    }
    if (value.length > LIST_LIMITS.valueCharsMax) {
      return `${where} is too long.`;
    }
    if (field.kind === 'number' && value.trim() !== '' && !NUMBER.test(value.trim())) {
      return `${where} has to be a number.`;
    }
    if (field.kind === 'switch' && value !== '' && value !== 'true' && value !== 'false') {
      return `${where} is on or off.`;
    }
    if (field.kind === 'option' && value !== '' && !field.options.includes(value)) {
      return `${where} has to be one of its options.`;
    }
  }
  return undefined;
}

// A nested list is an array literal and a nested group an object literal; a blank value is the empty one.
function nestedValueProblem(kind: 'list' | 'group', value: string): string | undefined {
  const text = value.trim();
  if (text === '') {
    return undefined;
  }
  if (text.length > LIST_LIMITS.nestedValueCharsMax) {
    return 'is too long.';
  }
  const tree = typescript.parse(`(${text}\n);`);
  const statement = tree.topNode.firstChild;
  const expression = statement?.name === 'ExpressionStatement' ? statement.firstChild?.nextSibling : undefined;
  const wanted = kind === 'list' ? 'ArrayExpression' : 'ObjectExpression';
  if (hasSyntaxError(tree.topNode) || expression?.name !== wanted) {
    return kind === 'list' ? 'has to be a list.' : 'has to be an object.';
  }
  return undefined;
}

// Whether a parse tree holds an error node: lezer recovers from anything, so a clean parse is a check of its own.
function hasSyntaxError(root: SyntaxNode): boolean {
  let found = false;
  root.tree?.iterate({
    enter(node) {
      if (node.type.isError) {
        found = true;
      }
      return !found;
    },
  });
  return found;
}

/** The fields a new list's items start with, wherever the list is made: a title and a line of text, as a list of values, features or steps most often is. */
export const LIST_STARTER_FIELDS: readonly ItemFieldDeclaration[] = [
  { name: 'title', kind: 'text' },
  { name: 'text', kind: 'text' },
];

/** One item's type, inline: `{ title: string; text: string }`. */
export function itemTypeText(fields: readonly ItemFieldDeclaration[]): string {
  return objectTypeText(fields);
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
 * true or false (false when left empty), an option as one of its choices, a
 * nested list or group as the array or object it holds (empty when left
 * blank). `[]` for a list with no items.
 */
export function listDefaultCode(settings: ListSettings): string {
  assert(settings.items.length <= LIST_LIMITS.itemsMax, 'listDefaultCode: the items are bounded');
  const items = settings.items.map(
    (item) => `{ ${settings.fields.map((field) => `${field.name}: ${fieldLiteral(field, item[field.name] ?? '', 1)}`).join(', ')} }`,
  );
  const out = `[${items.join(', ')}]`;
  assert(out.startsWith('['), 'listDefaultCode: the default is an array literal');
  return out;
}

/** A field with nothing in it yet, as code: `""`, `0`, `false`, its first option, `[]`, or an object of blank fields. */
export function blankFieldCode(field: ItemFieldDeclaration): string {
  return fieldLiteral(field, '', 1);
}

function fieldLiteral(field: ItemFieldDeclaration, value: string, depth: number): string {
  assert(depth <= ITEM_FIELD_LIMITS.walkDepthMax, 'fieldLiteral: the levels are bounded');
  switch (field.kind) {
    case 'number': {
      const trimmed = value.trim();
      return trimmed === '' ? '0' : String(Number(trimmed));
    }
    case 'switch':
      return value === 'true' ? 'true' : 'false';
    case 'option': {
      const first = field.options[0];
      assert(first !== undefined, 'fieldLiteral: an option field has options');
      return JSON.stringify(field.options.includes(value) ? value : first);
    }
    case 'list':
      return value.trim() === '' ? '[]' : value.trim();
    case 'group':
      return value.trim() === '' ? `{ ${field.fields.map((inner) => `${inner.name}: ${fieldLiteral(inner, '', depth + 1)}`).join(', ')} }` : value.trim();
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
      return JSON.stringify(value);
    default: {
      const exhaustive: never = field;
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
  const tree = typescript.parse(frontmatter);
  for (
    let statement = tree.topNode.firstChild, count = 0;
    statement !== null && count < LOOP_SYNTAX_LIMITS.declarationsMax;
    statement = statement.nextSibling, count++
  ) {
    const declaration = statement.name === 'ExportDeclaration' ? (statement.firstChild?.nextSibling ?? undefined) : statement;
    const named = declaration === undefined ? undefined : objectTypeOf(declaration, frontmatter);
    if (named === undefined || named.name === 'Props') {
      continue;
    }
    const found = objectFields(named.body, frontmatter, 1);
    if (found !== undefined && sameFields(found, fields)) {
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

/**
 * The item fields a list type declares, read back the way listTypeText writes
 * them: `readonly { title: string; on: boolean }[]`, `Array<{ … }>`, or
 * `readonly Value[]` naming a type `frontmatter` declares. A string field's
 * kind comes from its `@format` tag, else from its name (an image, a link,
 * else text), as the instance panel tells them apart. Undefined for a type
 * that is not a list of plain fields: the Properties panel then edits it as
 * code only.
 */
export function listFieldsOfType(type: string, frontmatter: string): readonly ItemFieldDeclaration[] | undefined {
  if (type.length > LOOP_SYNTAX_LIMITS.sourceCharsMax || frontmatter.length > LOOP_SYNTAX_LIMITS.sourceCharsMax) {
    return undefined;
  }
  const parsed = parsedType(type.trim());
  const item = parsed === undefined ? undefined : arrayItemNode(parsed.node, parsed.source);
  if (parsed === undefined || item === undefined) {
    return undefined;
  }
  const fields = ((): readonly ItemFieldDeclaration[] | undefined => {
    if (item.name === 'ObjectType') {
      return objectFields(item, parsed.source, 1);
    }
    const reference = item.name === 'TypeName' ? parsed.source.slice(item.from, item.to) : undefined;
    const declared = reference === undefined ? undefined : namedBody(reference, frontmatter);
    return declared === undefined ? undefined : objectFields(declared, frontmatter, 1);
  })();
  // The same check the form runs before it writes, so what is read can be written back.
  return fields === undefined || fieldsProblem(fields) !== undefined ? undefined : fields;
}

/** Whether a type is a list of something, whatever its items hold: what a loop can go over. */
export function isListType(type: string): boolean {
  if (type.length > LOOP_SYNTAX_LIMITS.sourceCharsMax) {
    return false;
  }
  const parsed = parsedType(type.trim());
  const item = parsed === undefined ? undefined : arrayItemNode(parsed.node, parsed.source);
  // `(A | B)[]` and `X[][]` hold more than plain items.
  return item !== undefined && item.name !== 'ArrayType' && item.name !== 'ParenthesizedType';
}

// The type as the right side of an alias, parsed whole: undefined when it is not one clean type.
function parsedType(type: string): { readonly source: string; readonly node: SyntaxNode } | undefined {
  if (type === '') {
    return undefined;
  }
  const source = `type Item = ${type};`;
  const tree = typescript.parse(source);
  const declaration = tree.topNode.firstChild ?? undefined;
  if (declaration?.name !== 'TypeAliasDeclaration' || declaration.nextSibling !== null || hasSyntaxError(tree.topNode)) {
    return undefined;
  }
  const equals = declaration.getChild('Equals') ?? undefined;
  const node = equals?.nextSibling ?? undefined;
  return node === undefined || node.to + 1 !== source.length ? undefined : { source, node };
}

// `readonly X[]`, `X[]`, `Array<X>` or `ReadonlyArray<X>`: the node of X.
function arrayItemNode(node: SyntaxNode, source: string): SyntaxNode | undefined {
  // `readonly X[]` is a ReadonlyType around the ArrayType, which is read the same way.
  const array = node.name === 'ReadonlyType' ? (node.lastChild ?? undefined) : node;
  if (array?.name === 'ArrayType') {
    const element = array.firstChild ?? undefined;
    return element !== undefined && element.nextSibling?.name === '[' && array.lastChild?.name === ']' ? element : undefined;
  }
  if (array !== node) {
    return undefined;
  }
  if (node.name === 'ParameterizedType') {
    const name = node.firstChild ?? undefined;
    const args = node.getChild('TypeArgList') ?? undefined;
    const element = args?.firstChild?.nextSibling ?? undefined;
    const written = name === undefined ? '' : source.slice(name.from, name.to);
    return name?.name === 'TypeName' && element !== undefined && element.nextSibling?.name === '>' && (written === 'Array' || written === 'ReadonlyArray')
      ? element
      : undefined;
  }
  return undefined;
}

// The body of the type `name` the frontmatter declares.
function namedBody(name: string, frontmatter: string): SyntaxNode | undefined {
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
      return named.body;
    }
  }
  return undefined;
}

// The fields of an object type: one per `name: type` member, with the document tag in front of it. Undefined when a
// member is anything else (a method, an index signature) or a type no kind writes, so nothing is half-read.
function objectFields(body: SyntaxNode, source: string, depth: number): readonly ItemFieldDeclaration[] | undefined {
  if (depth > ITEM_FIELD_LIMITS.depthMax) {
    return undefined;
  }
  const fields: ItemFieldDeclaration[] = [];
  let document: string | undefined;
  let child = body.firstChild ?? undefined;
  for (let count = 0; child !== undefined && count <= ITEM_FIELD_LIMITS.fieldsPerLevelMax * 4 + 2; count++) {
    if (child.name === 'BlockComment') {
      document = source.slice(child.from, child.to);
    } else if (child.name === 'PropertyType') {
      const field = memberField(child, source, document, depth);
      if (field === undefined) {
        return undefined;
      }
      fields.push(field);
      document = undefined;
    } else if (child.name !== '{' && child.name !== '}' && child.name !== ';' && child.name !== ',' && child.name !== 'LineComment') {
      return undefined;
    }
    child = child.nextSibling ?? undefined;
  }
  return fields.length === 0 || fields.length > ITEM_FIELD_LIMITS.fieldsPerLevelMax ? undefined : fields;
}

function memberField(member: SyntaxNode, source: string, document: string | undefined, depth: number): ItemFieldDeclaration | undefined {
  const nameNode = member.getChild('PropertyDefinition') ?? undefined;
  const type = member.getChild('TypeAnnotation')?.lastChild ?? undefined;
  if (nameNode === undefined || type === undefined) {
    return undefined;
  }
  const name = source.slice(nameNode.from, nameNode.to);
  if (fieldNameProblem(name) !== undefined) {
    return undefined;
  }
  switch (type.name) {
    case 'TypeName':
      return primitiveField(name, source.slice(type.from, type.to), document);
    case 'UnionType': {
      const options = optionsOf(type, source);
      return options === undefined ? undefined : { name, kind: 'option', options };
    }
    case 'ObjectType': {
      const fields = objectFields(type, source, depth + 1);
      return fields === undefined ? undefined : { name, kind: 'group', fields };
    }
    case 'ReadonlyType':
    case 'ArrayType':
    case 'ParameterizedType': {
      const item = arrayItemNode(type, source);
      const fields = item?.name === 'ObjectType' ? objectFields(item, source, depth + 1) : undefined;
      return fields === undefined ? undefined : { name, kind: 'list', fields };
    }
    default:
      return undefined;
  }
}

function primitiveField(name: string, written: string, document: string | undefined): ItemFieldDeclaration | undefined {
  switch (written) {
    case 'number':
      return { name, kind: 'number' };
    case 'boolean':
      return { name, kind: 'switch' };
    case 'string':
      return { name, kind: stringKind(name, document) };
    default:
      return undefined;
  }
}

// A string field's kind: its tag, else what its name says.
function stringKind(name: string, document: string | undefined): StringFieldKind {
  const tagged = document === undefined || document.length > PROP_TAG_LIMITS.docCharsMax ? undefined : kindOfFormat(readPropTags(document).format);
  return tagged ?? impliedKind(name);
}

// `"a" | "b"`: the strings of a union of string literals, or undefined for anything else in it.
function optionsOf(union: SyntaxNode, source: string): readonly string[] | undefined {
  const options: string[] = [];
  let child = union.firstChild ?? undefined;
  for (let count = 0; child !== undefined && count <= ITEM_FIELD_LIMITS.optionsMax * 2 + 2; count++) {
    if (child.name === 'LiteralType') {
      const word = stringLiteral(source.slice(child.from, child.to));
      if (word === undefined) {
        return undefined;
      }
      options.push(word);
    } else if (child.name !== 'LogicOp') {
      return undefined;
    }
    child = child.nextSibling ?? undefined;
  }
  return options.length >= 2 ? options : undefined;
}

// The value of a quoted string literal, or undefined when it is not one a plain read gives back unchanged.
function stringLiteral(text: string): string | undefined {
  const quote = text.charAt(0);
  if (text.length < 2 || text.charAt(text.length - 1) !== quote) {
    return undefined;
  }
  if (quote === '"') {
    try {
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === 'string' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  const body = text.slice(1, -1);
  return quote === "'" && !body.includes('\\') && !body.includes("'") ? body : undefined;
}
