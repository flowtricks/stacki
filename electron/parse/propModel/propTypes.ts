// A prop's declared type, read on the TypeScript syntax tree into the control
// a designer gets (shared/properties/propModel.ts). This is the syntactic tier
// of docs/plans/prop-controls.md §2.2: local aliases and interfaces are
// followed, `as const` lists stand for the unions they hold, and nothing is
// type-checked. A type the syntax cannot settle (a named type from a library,
// a generic) is honest code, never a guess.
//
// The rules mirror what the panels have always shown (the regex reader this
// replaced, retired in Phase 1): a union of literals is a Choice, a union led
// by `string`/`number`/`boolean` takes that primitive, arrays and tuples are
// lists, an object type is a group, functions are callbacks, and the types no
// field can fill (`any`, a promise) are code.

import ts from 'typescript';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import type { ChoiceOption, PropControl, PropMember } from '../../../shared/properties/propModel';
import { PROP_MODEL_LIMITS } from '../../../shared/properties/propModel';

/** A declaration a type may name, with the file it was read from (the component, or an imported file). */
export type TypeDeclaration =
  | { readonly kind: 'alias'; readonly node: ts.TypeAliasDeclaration; readonly file: ts.SourceFile }
  | { readonly kind: 'interface'; readonly node: ts.InterfaceDeclaration; readonly file: ts.SourceFile };

/** A frontmatter `const X = [literals]` or `{ key: literal }`, `as const` or not. */
export interface ConstList {
  readonly kind: 'array' | 'object';
  // Only an `as const` list types a prop; one without still names a default (`tone = Tone.Info`).
  readonly asConst: boolean;
  readonly entries: readonly (readonly [key: string, literal: LiteralPart])[];
}

/** Everything a type may refer to locally. */
export interface TypeScope {
  readonly declarations: ReadonlyMap<string, TypeDeclaration>;
  readonly constLists: ReadonlyMap<string, ConstList>;
}

/** A literal a union is made of, as written. */
export type LiteralPart =
  | { readonly form: 'string'; readonly value: string; readonly text: string }
  | { readonly form: 'number'; readonly text: string }
  | { readonly form: 'boolean'; readonly text: 'true' | 'false' };

/** One member of a flattened union: a type node, or a literal an `as const` list stands for. */
// `aliases` are the local aliases followed to reach a type part, so reading it
// further never follows one of them again (`type A = readonly A` ends).
export type TypePart =
  | { readonly kind: 'type'; readonly node: ts.TypeNode; readonly file: ts.SourceFile; readonly aliases: readonly string[] }
  | { readonly kind: 'literal'; readonly literal: LiteralPart };

// Props types are written by hand: a chain of aliases a dozen deep, each naming
// the next, is already past anything a component declares.
export const PROP_TYPE_LIMITS = {
  aliasDepthMax: 12,
  partsMax: LIMITS.propOptionsMax * 2,
  constListsMax: 64,
} as const;

/** The scope of the component's frontmatter, with the declarations a prelude (imported types) adds beneath it. */
export function typeScope(files: readonly ts.SourceFile[]): TypeScope {
  const declarations = new Map<string, TypeDeclaration>();
  const constLists = new Map<string, ConstList>();
  // Later files are read first so the component's own declarations, read last, win.
  for (const file of [...files].reverse()) {
    for (const statement of file.statements) {
      if (ts.isTypeAliasDeclaration(statement)) {
        declarations.set(statement.name.text, { kind: 'alias', node: statement, file });
      } else if (ts.isInterfaceDeclaration(statement)) {
        declarations.set(statement.name.text, { kind: 'interface', node: statement, file });
      } else if (ts.isVariableStatement(statement) && constLists.size < PROP_TYPE_LIMITS.constListsMax) {
        for (const declaration of statement.declarationList.declarations) {
          const list = constListOf(declaration);
          if (list !== undefined && ts.isIdentifier(declaration.name)) {
            constLists.set(declaration.name.text, list);
          }
        }
      }
    }
  }
  assert(constLists.size <= PROP_TYPE_LIMITS.constListsMax, 'typeScope: const lists are bounded');
  return { declarations, constLists };
}

/** The local alias or interface a reference names, when it names one without type arguments. */
export function referencedDeclaration(node: ts.TypeNode, scope: TypeScope): TypeDeclaration | undefined {
  if (!ts.isTypeReferenceNode(node) || !ts.isIdentifier(node.typeName) || node.typeArguments !== undefined) {
    return undefined;
  }
  const declaration = scope.declarations.get(node.typeName.text);
  if (declaration === undefined || declaration.node.typeParameters !== undefined) {
    return undefined;
  }
  return declaration;
}

/**
 * A type's union members, flattened: parentheses and nested unions opened,
 * aliases that stand for a union of values (no object braces) followed, and
 * `(typeof X)[number]`, `(typeof X)[keyof typeof X]` and `keyof typeof X` over
 * an `as const` list replaced by its literals.
 */
export function flattenParts(node: ts.TypeNode, file: ts.SourceFile, scope: TypeScope, followed: readonly string[] = []): readonly TypePart[] {
  const out: TypePart[] = [];
  const pending: { readonly node: ts.TypeNode; readonly file: ts.SourceFile; readonly aliases: readonly string[] }[] = [{ node, file, aliases: followed }];
  for (let step = 0; pending.length > 0 && step < PROP_TYPE_LIMITS.partsMax; step++) {
    const item = pending.shift();
    assert(item !== undefined, 'flattenParts: a pending part exists');
    const current = item.node;
    if (ts.isParenthesizedTypeNode(current)) {
      pending.unshift({ ...item, node: current.type });
      continue;
    }
    if (ts.isUnionTypeNode(current)) {
      pending.unshift(...current.types.map((child) => ({ ...item, node: child })));
      continue;
    }
    const listed = constListParts(current, scope);
    if (listed !== undefined) {
      out.push(...listed);
      continue;
    }
    const declaration = referencedDeclaration(current, scope);
    if (
      declaration?.kind === 'alias' &&
      !item.aliases.includes(declaration.node.name.text) &&
      item.aliases.length < PROP_TYPE_LIMITS.aliasDepthMax &&
      !/[{}]/.test(declaration.node.type.getText(declaration.file))
    ) {
      pending.unshift({ node: declaration.node.type, file: declaration.file, aliases: [...item.aliases, declaration.node.name.text] });
      continue;
    }
    out.push({ kind: 'type', node: current, file: item.file, aliases: item.aliases });
  }
  assert(out.length <= PROP_TYPE_LIMITS.partsMax, 'flattenParts: parts are bounded');
  return out;
}

/** A part's text as written. */
export function partText(part: TypePart): string {
  return part.kind === 'literal' ? part.literal.text : part.node.getText(part.file);
}

/** The literal a part is, when it is one: `'sm'`, `3`, `-1`, `true`. */
export function literalOf(part: TypePart): LiteralPart | undefined {
  if (part.kind === 'literal') {
    return part.literal;
  }
  const node = part.node;
  if (!ts.isLiteralTypeNode(node)) {
    return undefined;
  }
  const literal = node.literal;
  if (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal)) {
    return { form: 'string', value: literal.text, text: literal.getText(part.file) };
  }
  if (literal.kind === ts.SyntaxKind.TrueKeyword) {
    return { form: 'boolean', text: 'true' };
  }
  if (literal.kind === ts.SyntaxKind.FalseKeyword) {
    return { form: 'boolean', text: 'false' };
  }
  const text = literal.getText(part.file);
  return NUMBER_LITERAL_RE.test(text) ? { form: 'number', text } : undefined;
}

// Only plain decimals are choices: `1e3` and `0x10` read as their own words nowhere a designer looks.
const NUMBER_LITERAL_RE = /^-?\d+(?:\.\d+)?$/;

/** Whether a part is `undefined` or `null`, which say a prop may be absent, not what it holds. */
export function isNullish(part: TypePart): boolean {
  if (part.kind === 'literal') {
    return false;
  }
  return part.node.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isLiteralTypeNode(part.node) && part.node.literal.kind === ts.SyntaxKind.NullKeyword);
}

/** Whether a part is `null` itself. */
export function isNull(part: TypePart): boolean {
  return part.kind === 'type' && ts.isLiteralTypeNode(part.node) && part.node.literal.kind === ts.SyntaxKind.NullKeyword;
}

export function isNever(part: TypePart): boolean {
  return part.kind === 'type' && part.node.kind === ts.SyntaxKind.NeverKeyword;
}

/**
 * Where a type is read from: `depth` counts the lists and groups above it
 * (past PROP_MODEL_LIMITS.propNestingDepthMax a nested object is code), and
 * `aliases` the local aliases and interfaces being followed, so a type that
 * names itself (`type A = readonly A`) ends instead of looping.
 */
export interface TypeWalk {
  readonly depth: number;
  readonly aliases: readonly string[];
}
export const TOP_WALK: TypeWalk = { depth: 0, aliases: [] };

/** The control for a type made of these union parts. */
export function controlOfParts(parts: readonly TypePart[], scope: TypeScope, walk: TypeWalk): PropControl {
  assert(walk.depth >= 0, 'controlOfParts: depth is a count');
  assert(parts.length <= PROP_TYPE_LIMITS.partsMax, 'controlOfParts: parts are bounded');
  const values = parts.filter((part) => !isNullish(part) && !isNever(part));
  const choice = literalChoice(values);
  if (choice !== undefined) {
    return choice;
  }
  if (values.length === 0) {
    return { kind: 'code', reason: 'unrecognized' };
  }
  if (values.every((part) => part.kind === 'type' && isFunctionType(part.node, scope))) {
    return { kind: 'callback', signature: boundedText(values.map(partText).join(' | ')) };
  }
  const first = values[0];
  assert(first !== undefined, 'controlOfParts: a part exists');
  if (values.length === 1) {
    const aliases = first.kind === 'type' ? [...new Set([...walk.aliases, ...first.aliases])] : walk.aliases;
    return controlOfPart(first, scope, { depth: walk.depth, aliases });
  }
  // A union of different things takes the primitive it leads with, as it
  // always has: `string | number` edits as text (plan D9 revisits this).
  if (first.kind === 'type') {
    const primitive = primitiveControl(first.node);
    if (primitive !== undefined) {
      return primitive;
    }
  }
  return { kind: 'code', reason: 'unrecognized' };
}

/** The control for one type node, with its own unions flattened. */
export function controlOfType(node: ts.TypeNode, file: ts.SourceFile, scope: TypeScope, walk: TypeWalk): PropControl {
  return controlOfParts(flattenParts(node, file, scope, walk.aliases), scope, walk);
}

function controlOfPart(part: TypePart, scope: TypeScope, walk: TypeWalk): PropControl {
  if (part.kind === 'literal') {
    return part.literal.form === 'string' ? { kind: 'text' } : { kind: 'code', reason: 'unrecognized' };
  }
  const node = part.node;
  const file = part.file;
  const primitive = primitiveControl(node);
  if (primitive !== undefined) {
    return primitive;
  }
  if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) {
    return controlOfType(node.type, file, scope, walk);
  }
  if (ts.isLiteralTypeNode(node) || ts.isTemplateLiteralTypeNode(node)) {
    return ts.isTemplateLiteralTypeNode(node) || ts.isStringLiteral(node.literal) || ts.isNoSubstitutionTemplateLiteral(node.literal)
      ? { kind: 'text' }
      : { kind: 'code', reason: 'unrecognized' };
  }
  if (ts.isArrayTypeNode(node)) {
    return { kind: 'list', item: itemControl(node.elementType, file, scope, walk) };
  }
  if (ts.isTupleTypeNode(node)) {
    return { kind: 'list', item: { kind: 'code', reason: 'tuple' } };
  }
  if (ts.isTypeLiteralNode(node)) {
    return node.members.length === 0 ? { kind: 'code', reason: 'opaque' } : groupOf(node.members, file, scope, walk);
  }
  if (ts.isIntersectionTypeNode(node)) {
    return intersectionControl(node, file, scope, walk);
  }
  if (ts.isTypeReferenceNode(node)) {
    return referenceControl(node, file, scope, walk);
  }
  if (isOpaque(node)) {
    return { kind: 'code', reason: 'opaque' };
  }
  return { kind: 'code', reason: 'unrecognized' };
}

function primitiveControl(node: ts.TypeNode): PropControl | undefined {
  if (node.kind === ts.SyntaxKind.StringKeyword) {
    return { kind: 'text' };
  }
  if (node.kind === ts.SyntaxKind.NumberKeyword) {
    return { kind: 'number', min: undefined, max: undefined, minExclusive: false, maxExclusive: false, step: undefined, decimals: undefined };
  }
  if (node.kind === ts.SyntaxKind.BooleanKeyword) {
    return { kind: 'switch', onLabel: undefined, offLabel: undefined };
  }
  return undefined;
}

function nested(walk: TypeWalk): TypeWalk {
  return { depth: walk.depth + 1, aliases: walk.aliases };
}

function itemControl(node: ts.TypeNode, file: ts.SourceFile, scope: TypeScope, walk: TypeWalk): PropControl {
  if (walk.depth + 1 > PROP_MODEL_LIMITS.propNestingDepthMax) {
    return { kind: 'code', reason: 'nestingDepth' };
  }
  return controlOfType(node, file, scope, nested(walk));
}

// Element attributes the attribute rows can edit: Astro's HTMLAttributes, its
// astroHTML namespace and a plain Record of names to values.
function attributesTag(node: ts.TypeReferenceNode, file: ts.SourceFile): PropControl | undefined {
  const name = node.typeName;
  if (ts.isQualifiedName(name)) {
    return ts.isIdentifier(name.left) && name.left.text === 'astroHTML' ? { kind: 'attributes', tag: undefined } : undefined;
  }
  if (name.text === 'Record') {
    return { kind: 'attributes', tag: undefined };
  }
  if (name.text !== 'HTMLAttributes') {
    return undefined;
  }
  const argument = node.typeArguments?.[0];
  const tag = argument !== undefined && ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal) ? argument.literal.text : undefined;
  assert(tag === undefined || node.getText(file).includes(tag), 'attributesTag: the tag is written in the type');
  return { kind: 'attributes', tag };
}

function referenceControl(node: ts.TypeReferenceNode, file: ts.SourceFile, scope: TypeScope, walk: TypeWalk): PropControl {
  const attributes = attributesTag(node, file);
  if (attributes !== undefined) {
    return attributes;
  }
  const name = ts.isIdentifier(node.typeName) ? node.typeName.text : undefined;
  const argument = node.typeArguments?.[0];
  if ((name === 'Array' || name === 'ReadonlyArray') && argument !== undefined) {
    return { kind: 'list', item: itemControl(argument, file, scope, walk) };
  }
  if (name === 'Function') {
    return { kind: 'callback', signature: node.getText(file) };
  }
  if (name !== undefined && OPAQUE_REFERENCES.has(name) && (node.typeArguments !== undefined || name === 'Object')) {
    return { kind: 'code', reason: 'opaque' };
  }
  const declaration = referencedDeclaration(node, scope);
  if (declaration === undefined) {
    return { kind: 'code', reason: 'unrecognized' };
  }
  const followed = declaration.node.name.text;
  if (walk.aliases.includes(followed) || walk.aliases.length >= PROP_TYPE_LIMITS.aliasDepthMax) {
    return { kind: 'code', reason: 'unrecognized' };
  }
  return declarationControl(declaration, scope, { depth: walk.depth, aliases: [...walk.aliases, followed] });
}

/** The control a local alias or interface stands for. */
export function declarationControl(declaration: TypeDeclaration, scope: TypeScope, walk: TypeWalk): PropControl {
  assert(walk.aliases.length <= PROP_TYPE_LIMITS.aliasDepthMax, 'declarationControl: alias chains are bounded');
  if (declaration.kind === 'interface') {
    const members = interfaceMembers(declaration, scope, walk.aliases);
    return members.length === 0 ? { kind: 'code', reason: 'opaque' } : groupOfSignatures(members, scope, walk);
  }
  return controlOfType(declaration.node.type, declaration.file, scope, walk);
}

export interface FiledSignature {
  readonly member: ts.PropertySignature;
  readonly file: ts.SourceFile;
}

/** An interface's members with those of the local interfaces and aliases it extends, extended ones first. */
export function interfaceMembers(
  declaration: Extract<TypeDeclaration, { kind: 'interface' }>,
  scope: TypeScope,
  seen: readonly string[],
): readonly FiledSignature[] {
  const aliasDepth = seen.length;
  assert(aliasDepth <= PROP_TYPE_LIMITS.aliasDepthMax, 'interfaceMembers: extends chains are bounded');
  const out: FiledSignature[] = [];
  for (const clause of declaration.node.heritageClauses ?? []) {
    for (const heritage of clause.types) {
      const name = ts.isIdentifier(heritage.expression) ? heritage.expression.text : undefined;
      const base = name === undefined || heritage.typeArguments !== undefined ? undefined : scope.declarations.get(name);
      if (base === undefined || name === undefined || seen.includes(name) || aliasDepth >= PROP_TYPE_LIMITS.aliasDepthMax) {
        continue;
      }
      if (base.kind === 'interface') {
        out.push(...interfaceMembers(base, scope, [...seen, name]));
      } else if (ts.isTypeLiteralNode(base.node.type)) {
        out.push(...base.node.type.members.filter(ts.isPropertySignature).map((member) => ({ member, file: base.file })));
      }
    }
  }
  out.push(...declaration.node.members.filter(ts.isPropertySignature).map((member) => ({ member, file: declaration.file })));
  return out;
}

// `{ a: string } & { b: number }` is one group of both; `HTMLAttributes<"a"> & {…}` edits as attributes.
function intersectionControl(node: ts.IntersectionTypeNode, file: ts.SourceFile, scope: TypeScope, walk: TypeWalk): PropControl {
  const first = node.types[0];
  if (first !== undefined && ts.isTypeReferenceNode(first)) {
    const attributes = attributesTag(first, file);
    if (attributes !== undefined) {
      return attributes;
    }
  }
  const members: FiledSignature[] = [];
  for (const type of node.types) {
    const inner = ts.isParenthesizedTypeNode(type) ? type.type : type;
    if (ts.isTypeLiteralNode(inner)) {
      members.push(...inner.members.filter(ts.isPropertySignature).map((member) => ({ member, file })));
      continue;
    }
    const declaration = referencedDeclaration(inner, scope);
    if (declaration?.kind === 'interface' && !walk.aliases.includes(declaration.node.name.text) && walk.aliases.length < PROP_TYPE_LIMITS.aliasDepthMax) {
      members.push(...interfaceMembers(declaration, scope, [...walk.aliases, declaration.node.name.text]));
      continue;
    }
    if (declaration?.kind === 'alias' && ts.isTypeLiteralNode(declaration.node.type)) {
      const literal = declaration.node.type;
      members.push(...literal.members.filter(ts.isPropertySignature).map((member) => ({ member, file: declaration.file })));
      continue;
    }
    return { kind: 'code', reason: 'unrecognized' };
  }
  return members.length === 0 ? { kind: 'code', reason: 'opaque' } : groupOfSignatures(members, scope, walk);
}

function groupOf(members: ts.NodeArray<ts.TypeElement>, file: ts.SourceFile, scope: TypeScope, walk: TypeWalk): PropControl {
  return groupOfSignatures(
    members.filter(ts.isPropertySignature).map((member) => ({ member, file })),
    scope,
    walk,
  );
}

function groupOfSignatures(members: readonly FiledSignature[], scope: TypeScope, walk: TypeWalk): PropControl {
  if (walk.depth + 1 > PROP_MODEL_LIMITS.propNestingDepthMax) {
    return { kind: 'code', reason: 'nestingDepth' };
  }
  const fields = new Map<string, PropMember>();
  for (const { member, file } of members.slice(0, PROP_MODEL_LIMITS.propsMax)) {
    const name = memberKey(member.name);
    if (name === undefined) {
      continue;
    }
    fields.set(name, {
      name,
      typeText: member.type === undefined ? '' : boundedText(member.type.getText(file)),
      control: member.type === undefined ? { kind: 'code', reason: 'untyped' } : controlOfType(member.type, file, scope, nested(walk)),
      presence: member.questionToken === undefined ? 'required' : 'optional',
    });
  }
  assert(fields.size <= PROP_MODEL_LIMITS.propsMax, 'groupOfSignatures: fields are bounded');
  return { kind: 'group', fields: [...fields.values()] };
}

/** A member's name as a prop is called: an identifier, or a quoted name such as `'data-id'`. */
export function memberKey(name: ts.PropertyName | ts.BindingName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text === '' ? undefined : name.text;
  }
  return undefined;
}

/** A type text cut to the model's bound. */
export function boundedText(text: string): string {
  return text.length <= PROP_MODEL_LIMITS.typeTextCharsMax ? text : `${text.slice(0, PROP_MODEL_LIMITS.typeTextCharsMax - 1)}…`;
}

// A union of literals is a fixed set of choices: `'sm' | 'lg'`, `1 | 2 | 3`,
// and mixed ones — `boolean | 'auto'` is true, false or auto, and
// `'sm' | 'lg' | number` offers its two words (a number stays possible in
// code). The options that are not strings are written as expressions, so
// `flag={true}` stays a boolean. Undefined when the parts are not such a union.
function literalChoice(parts: readonly TypePart[]): PropControl | undefined {
  if (parts.length < 2) {
    return undefined;
  }
  const options: ChoiceOption[] = [];
  let strings = 0;
  let widenedToNumber = false;
  for (const part of parts) {
    const literal = literalOf(part);
    if (literal !== undefined && (literal.form === 'string' ? literal.value : literal.text).length > PROP_MODEL_LIMITS.textCharsMax) {
      // An option no field could show is not a choice; the type stays code.
      return undefined;
    }
    if (literal?.form === 'string') {
      options.push({ value: literal.value, written: 'string' });
      strings++;
    } else if (literal !== undefined) {
      options.push({ value: literal.text, written: 'expression' });
    } else if (part.kind === 'type' && part.node.kind === ts.SyntaxKind.BooleanKeyword) {
      options.push({ value: 'true', written: 'expression' }, { value: 'false', written: 'expression' });
    } else if (part.kind === 'type' && part.node.kind === ts.SyntaxKind.NumberKeyword) {
      widenedToNumber = true;
    } else {
      return undefined;
    }
  }
  const unique = new Map<string, ChoiceOption>();
  for (const option of options) {
    if (!unique.has(option.value)) {
      unique.set(option.value, option);
    }
  }
  if (unique.size < 2 || unique.size > PROP_MODEL_LIMITS.optionsMax) {
    return undefined;
  }
  // `number | 1 | 2` is any number; only words beside `number` make a choice.
  if (widenedToNumber && strings < 2) {
    return undefined;
  }
  const choices = [...unique.values()];
  if (strings === 0) {
    // `true | false` is just a boolean.
    if (choices.every((option) => option.value === 'true' || option.value === 'false')) {
      return { kind: 'switch', onLabel: undefined, offLabel: undefined };
    }
    if (choices.every((option) => NUMBER_LITERAL_RE.test(option.value))) {
      return { kind: 'choice', options: choices, numeric: true };
    }
  }
  assert(choices.length <= options.length, 'literalChoice: options never grow when made unique');
  return { kind: 'choice', options: choices, numeric: false };
}

// `(item: T) => string`, `new () => Thing`, `Function`, and a local alias of one.
function isFunctionType(node: ts.TypeNode, scope: TypeScope): boolean {
  const inner = ts.isParenthesizedTypeNode(node) ? node.type : node;
  if (ts.isFunctionTypeNode(inner) || ts.isConstructorTypeNode(inner)) {
    return true;
  }
  if (ts.isTypeReferenceNode(inner) && ts.isIdentifier(inner.typeName) && inner.typeName.text === 'Function') {
    return true;
  }
  const declaration = referencedDeclaration(inner, scope);
  if (declaration?.kind === 'alias') {
    const target = ts.isParenthesizedTypeNode(declaration.node.type) ? declaration.node.type.type : declaration.node.type;
    return ts.isFunctionTypeNode(target) || ts.isConstructorTypeNode(target);
  }
  return false;
}

// Types that say nothing a field could fill in.
const OPAQUE_KEYWORDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.AnyKeyword,
  ts.SyntaxKind.UnknownKeyword,
  ts.SyntaxKind.ObjectKeyword,
  ts.SyntaxKind.SymbolKeyword,
  ts.SyntaxKind.BigIntKeyword,
  ts.SyntaxKind.NeverKeyword,
  ts.SyntaxKind.VoidKeyword,
]);
const OPAQUE_REFERENCES: ReadonlySet<string> = new Set(['Promise', 'PromiseLike', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Object']);

function isOpaque(node: ts.TypeNode): boolean {
  if (OPAQUE_KEYWORDS.has(node.kind)) {
    return true;
  }
  return ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.UniqueKeyword;
}

// `(typeof X)[number]`, `(typeof X)[keyof typeof X]` and `keyof typeof X` over an `as const` list.
function constListParts(node: ts.TypeNode, scope: TypeScope): readonly TypePart[] | undefined {
  if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.KeyOfKeyword) {
    const list = queriedList(node.type, scope);
    if (list?.kind !== 'object') {
      return undefined;
    }
    return list.entries.map(([key]) => ({ kind: 'literal', literal: { form: 'string', value: key, text: JSON.stringify(key) } }));
  }
  if (!ts.isIndexedAccessTypeNode(node)) {
    return undefined;
  }
  const list = queriedList(node.objectType, scope);
  if (list === undefined) {
    return undefined;
  }
  const index = ts.isParenthesizedTypeNode(node.indexType) ? node.indexType.type : node.indexType;
  if (list.kind === 'array' && index.kind === ts.SyntaxKind.NumberKeyword) {
    return list.entries.map(([, literal]) => ({ kind: 'literal', literal }));
  }
  if (list.kind === 'object' && ts.isTypeOperatorNode(index) && index.operator === ts.SyntaxKind.KeyOfKeyword && sameQuery(index.type, node.objectType)) {
    return list.entries.map(([, literal]) => ({ kind: 'literal', literal }));
  }
  return undefined;
}

function queriedList(node: ts.TypeNode, scope: TypeScope): ConstList | undefined {
  const inner = ts.isParenthesizedTypeNode(node) ? node.type : node;
  if (!ts.isTypeQueryNode(inner) || !ts.isIdentifier(inner.exprName)) {
    return undefined;
  }
  const list = scope.constLists.get(inner.exprName.text);
  return list?.asConst === true ? list : undefined;
}

function sameQuery(first: ts.TypeNode, second: ts.TypeNode): boolean {
  const left = ts.isParenthesizedTypeNode(first) ? first.type : first;
  const right = ts.isParenthesizedTypeNode(second) ? second.type : second;
  return (
    ts.isTypeQueryNode(left) &&
    ts.isTypeQueryNode(right) &&
    ts.isIdentifier(left.exprName) &&
    ts.isIdentifier(right.exprName) &&
    left.exprName.text === right.exprName.text
  );
}

// `const SIZES = ['sm', 'md'] as const` and `const Tone = { Info: 'info' } as const`;
// without `as const` the list is still read, for the defaults that name its members.
export function constListOf(declaration: ts.VariableDeclaration): ConstList | undefined {
  const initializer = declaration.initializer;
  if (initializer === undefined || !(declaration.parent.flags & ts.NodeFlags.Const)) {
    return undefined;
  }
  const asserted = ts.isAsExpression(initializer) ? initializer : undefined;
  const asConst =
    asserted !== undefined && ts.isTypeReferenceNode(asserted.type) && ts.isIdentifier(asserted.type.typeName) && asserted.type.typeName.text === 'const';
  if (asserted !== undefined && !asConst) {
    return undefined;
  }
  const value = asserted?.expression ?? initializer;
  if (ts.isArrayLiteralExpression(value)) {
    const entries: (readonly [string, LiteralPart])[] = [];
    for (const [index, element] of value.elements.entries()) {
      const literal = expressionLiteral(element);
      if (literal === undefined || index >= PROP_MODEL_LIMITS.optionsMax) {
        return undefined;
      }
      entries.push([String(index), literal]);
    }
    return { kind: 'array', asConst, entries };
  }
  if (ts.isObjectLiteralExpression(value)) {
    const entries: (readonly [string, LiteralPart])[] = [];
    for (const property of value.properties) {
      if (!ts.isPropertyAssignment(property) || entries.length >= PROP_MODEL_LIMITS.optionsMax) {
        return undefined;
      }
      const key = memberKey(property.name);
      const literal = expressionLiteral(property.initializer);
      if (key === undefined || literal === undefined) {
        return undefined;
      }
      entries.push([key, literal]);
    }
    return { kind: 'object', asConst, entries };
  }
  return undefined;
}

/** The value a literal stands for: `'info'` is info, `3` is 3, `true` is true. */
export function literalPartValue(literal: LiteralPart): string | number | boolean {
  switch (literal.form) {
    case 'string':
      return literal.value;
    case 'number':
      return Number(literal.text);
    case 'boolean':
      return literal.text === 'true';
    default: {
      const exhaustive: never = literal;
      return exhaustive;
    }
  }
}

/** A literal expression (`'sm'`, `3`, `-1`, `true`) as the type literal it stands for. */
export function expressionLiteral(node: ts.Expression): LiteralPart | undefined {
  if (ts.isStringLiteral(node)) {
    return { form: 'string', value: node.text, text: node.getText() };
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) {
    return { form: 'boolean', text: 'true' };
  }
  if (node.kind === ts.SyntaxKind.FalseKeyword) {
    return { form: 'boolean', text: 'false' };
  }
  const text = node.getText();
  return (ts.isNumericLiteral(node) || ts.isPrefixUnaryExpression(node)) && NUMBER_LITERAL_RE.test(text) ? { form: 'number', text } : undefined;
}
