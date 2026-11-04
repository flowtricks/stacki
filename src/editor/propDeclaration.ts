// Declaring a new component prop from the binding picker, as text edits on the
// component's frontmatter that keep every other line as written. A text prop
// named label with a tooltip and a default becomes a member of `interface
// Props` with its tooltip as a JSDoc comment, `label?: string;`, and an entry
// `label = "Click me"` in `const { … } = Astro.props`.
//
// The tooltip is the member's JSDoc description: that is what Astro's and
// TypeScript's tooling show on hover, and what Stacki already reads back as a
// prop's documentation (PropTip). A prop's settings are JSDoc tags on the same
// comment, so they round-trip through the file and the editor reads them back
// (propDocumentation.ts): `@min`, `@max` and `@decimals` for a number, `@onLabel` and
// `@offLabel` for a switch. A file with no `interface Props` gets one, and a
// file with no destructure gets one.
//
// An attributes prop is Astro's rest props: `...rest` at the end of the
// destructure, spread onto elements. It is typed by making the interface
// extend `HTMLAttributes<"div">` (astro/types) for the tag of the element it
// is connected to, so an instance is offered, and checked against, that tag's
// attributes. HTMLAttributes takes one tag, and an interface cannot extend two
// of them when their attributes conflict, so the first element's tag is kept.
// Its tooltip is an `@attributes` tag on the comment above the interface,
// since the extends clause has no comment of its own. A rest binding cannot
// have a default in JavaScript, so its defaults are attributes written on the
// element before the spread (attributesBinding.ts).

import type { SyntaxNode } from '@lezer/common';
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import { err, ok, type Result } from '../../shared/core/result';
import { PROPERTY_LIMITS } from '../../shared/properties/propertyEditing';
import { destructureEnd, freeLocal, propsInterfaceBody, propsInterfaceEnd, propsPattern, readPropsDestructure } from './loopProps';
import { NUMBER_DECIMALS_MAX, type NumberSettings, type SwitchSettings } from './propDocumentation';

/** What a new prop holds: words, a number, a switch, one of a list of words, or attributes. */
export type NewPropKind = 'string' | 'number' | 'boolean' | 'option' | 'attributes';

/** One `name = value` default of an attributes prop. */
export interface AttributeDefault {
  readonly name: string;
  readonly value: string;
}

/** A prop to declare, as the property settings form states it. */
export interface PropDeclaration {
  readonly key: string;
  readonly tooltip: string;
  readonly kind: NewPropKind;
  /** The default as typed: words, a number, `true`/`false` or an option. Empty for none. */
  readonly defaultText: string;
  /** The words an option prop can be, in order. Empty for every other kind. */
  readonly options: readonly string[];
  /** A number prop's range and precision. */
  readonly number: NumberSettings;
  /** A switch prop's labels. */
  readonly switch: SwitchSettings;
  /** An attributes prop's defaults, written on the element. Empty for every other kind. */
  readonly attributes: readonly AttributeDefault[];
  /** The tag of the element an attributes prop is first connected to. Empty for every other kind. */
  readonly tag: string;
}

/** The frontmatter with the prop declared, and the name the markup reads it by. */
export interface DeclaredProp {
  readonly frontmatter: string;
  readonly local: string;
}

/** The rest binding of the props destructure: `...rest`. */
export interface RestBinding {
  readonly local: string;
  readonly span: { readonly from: number; readonly to: number };
}

export const DECLARATION_LIMITS = {
  tooltipCharsMax: 500,
  optionsMax: 64,
  optionCharsMax: 256,
  labelCharsMax: 40,
  attributesMax: LIMITS.attrsPerNodeMax,
} as const satisfies Record<string, number>;

/** The type an attributes prop is declared with, and where it is imported from. */
export const ATTRIBUTES_TYPE = { name: 'HTMLAttributes', path: 'astro/types' } as const;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const TAG_NAME = /^[a-z][a-z0-9-]*$/;
const ATTRIBUTE_NAME = /^[A-Za-z_:@][\w:.@-]*$/;
// Words a destructure cannot bind as a local; a prop named one is read by an alias (`class: propClass`).
const RESERVED = new Set([
  'Astro',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

/** The rest binding of `const { … } = Astro.props`, if the destructure has one. */
export function readRestBinding(frontmatter: string): RestBinding | undefined {
  const pattern = propsPattern(frontmatter);
  let child = pattern?.firstChild ?? undefined;
  for (let count = 0; child !== undefined && count < LIMITS.propSchemaFieldsMax; count++) {
    const local = child.name === 'PatternProperty' && child.getChild('Spread') !== null ? (child.getChild('VariableDefinition') ?? undefined) : undefined;
    if (local !== undefined) {
      return { local: frontmatter.slice(local.from, local.to), span: { from: child.from, to: child.to } };
    }
    child = child.nextSibling ?? undefined;
  }
  return undefined;
}

/** The tag `interface Props` takes its attributes from: `div` for `extends HTMLAttributes<"div">`. */
export function attributesTag(frontmatter: string): string | undefined {
  const head = interfaceHead(frontmatter);
  const match = head === undefined ? undefined : (/\bHTMLAttributes\s*<\s*["']([a-z][a-z0-9-]*)["']\s*>/.exec(head.text) ?? undefined);
  return match?.[1];
}

/** The attributes prop's tooltip: the `@attributes` tag above `interface Props`. */
export function restTooltip(frontmatter: string): string {
  const comment = interfaceComment(frontmatter);
  const tagged = comment === undefined ? undefined : (/@attributes[ \t]+(.*?)\s*(?:\*\/|\n|$)/.exec(comment.text) ?? undefined);
  return (tagged?.[1] ?? '').trim();
}

/** The frontmatter with the attributes prop's tooltip replaced, or removed when empty. */
export function withRestTooltip(frontmatter: string, tooltip: string): Result<string, string> {
  const head = interfaceHead(frontmatter);
  if (head === undefined) {
    return err('This component has no interface Props to describe its attributes on.');
  }
  const text = tooltipText(tooltip);
  const comment = interfaceComment(frontmatter);
  let out: string;
  if (comment !== undefined && /@attributes\b/.test(comment.text)) {
    const replaced = text === '' ? '' : `/** @attributes ${text} */`;
    const tail = text === '' ? lineEnd(frontmatter, comment.to) : comment.to;
    out = `${frontmatter.slice(0, comment.from)}${replaced}${frontmatter.slice(tail)}`;
  } else if (text !== '') {
    out = `${frontmatter.slice(0, head.statement)}/** @attributes ${text} */\n${frontmatter.slice(head.statement)}`;
  } else {
    out = frontmatter;
  }
  assert(restTooltip(out) === text, 'withRestTooltip: the tooltip reads back');
  return ok(out);
}

/**
 * The default written for a prop from what was typed, as code, or undefined
 * for no default; an error says why the text cannot be one. A number default
 * has to sit inside the number settings, at their precision.
 */
export function defaultCode(declaration: Pick<PropDeclaration, 'kind' | 'defaultText' | 'options' | 'number'>): Result<string | undefined, string> {
  const text = declaration.defaultText.trim();
  assert(text.length <= PROPERTY_LIMITS.textCharsMax, 'defaultCode: default text is bounded');
  if (text === '') {
    return ok(undefined);
  }
  switch (declaration.kind) {
    case 'string':
      return ok(JSON.stringify(declaration.defaultText));
    case 'number':
      return numberDefault(text, declaration.number);
    case 'boolean':
      if (text === 'true') {
        return ok('true');
      }
      if (text === 'false') {
        return ok('false');
      }
      return err('The default is on or off.');
    case 'option':
      if (declaration.options.includes(declaration.defaultText)) {
        return ok(JSON.stringify(declaration.defaultText));
      }
      return err('The default has to be one of the options.');
    case 'attributes':
      return ok(undefined);
    default: {
      const exhaustive: never = declaration.kind;
      return exhaustive;
    }
  }
}

function numberDefault(text: string, settings: NumberSettings): Result<string, string> {
  const value = Number(text);
  if (!Number.isFinite(value)) {
    return err('The default has to be a number.');
  }
  const { min, max, decimals } = settings;
  if (min !== undefined && value < min) {
    return err(`The default has to be at least ${min}.`);
  }
  if (max !== undefined && value > max) {
    return err(`The default has to be at most ${max}.`);
  }
  if (decimals !== undefined && Number(value.toFixed(decimals)) !== value) {
    return err(decimals === 0 ? 'The default has to be a whole number.' : `The default has at most ${decimals} decimals.`);
  }
  return ok(String(value));
}

/** The TypeScript type a prop is declared with. */
export function typeText(declaration: Pick<PropDeclaration, 'kind' | 'options'>): Result<string, string> {
  switch (declaration.kind) {
    case 'string':
    case 'number':
    case 'boolean':
      return ok(declaration.kind);
    case 'option': {
      const problem = optionsProblem(declaration.options);
      return problem === undefined ? ok(declaration.options.map((option) => JSON.stringify(option)).join(' | ')) : err(problem);
    }
    case 'attributes':
      return ok(ATTRIBUTES_TYPE.name);
    default: {
      const exhaustive: never = declaration.kind;
      return exhaustive;
    }
  }
}

/** Why an option list cannot type a prop, or undefined when it can. */
export function optionsProblem(options: readonly string[]): string | undefined {
  if (options.length === 0) {
    return 'Add at least one option.';
  }
  if (options.length > DECLARATION_LIMITS.optionsMax) {
    return 'That is too many options.';
  }
  if (options.some((option) => option.trim() === '')) {
    return 'An option needs some words.';
  }
  if (options.some((option) => option.length > DECLARATION_LIMITS.optionCharsMax)) {
    return 'An option is too long.';
  }
  return new Set(options).size === options.length ? undefined : 'Each option has to be different.';
}

/** Why number settings cannot be written, or undefined when they can. */
export function numberSettingsProblem(settings: NumberSettings): string | undefined {
  const { min, max, decimals } = settings;
  if (min !== undefined && !Number.isFinite(min)) {
    return 'Min has to be a number.';
  }
  if (max !== undefined && !Number.isFinite(max)) {
    return 'Max has to be a number.';
  }
  if (min !== undefined && max !== undefined && min > max) {
    return 'Min has to be no more than Max.';
  }
  if (decimals !== undefined) {
    if (!Number.isSafeInteger(decimals)) {
      return 'Decimals has to be a whole number.';
    }
    if (decimals < 0 || decimals > NUMBER_DECIMALS_MAX) {
      return `Decimals goes from 0 to ${NUMBER_DECIMALS_MAX}.`;
    }
  }
  return undefined;
}

/** Why switch labels cannot be written, or undefined when they can. */
export function switchSettingsProblem(settings: SwitchSettings): string | undefined {
  for (const label of [settings.onLabel, settings.offLabel]) {
    if (label.length > DECLARATION_LIMITS.labelCharsMax) {
      return 'A label is too long.';
    }
    if (/[\n@*]/.test(label)) {
      return 'A label is one line of words.';
    }
  }
  return undefined;
}

/** Why an attribute default cannot be written on an element, or undefined when every one can. */
export function attributeDefaultsProblem(defaults: readonly AttributeDefault[]): string | undefined {
  if (defaults.length > DECLARATION_LIMITS.attributesMax) {
    return 'That is too many attributes.';
  }
  for (const entry of defaults) {
    if (!ATTRIBUTE_NAME.test(entry.name)) {
      return entry.name === '' ? 'Each default attribute needs a name.' : `${entry.name} is not an attribute name.`;
    }
    if (entry.value.length > LIMITS.attrCharsMax) {
      return `The value of ${entry.name} is too long.`;
    }
  }
  const names = defaults.map((entry) => entry.name);
  return new Set(names).size === names.length ? undefined : 'Each default attribute has to have its own name.';
}

/**
 * The frontmatter with `declaration` added to `interface Props` (with its
 * tooltip and settings as JSDoc) and to the props destructure (with its
 * default), creating either when the file has none. `taken` is every name the
 * frontmatter binds, so the prop is read by its own name when that is free and
 * by an alias (`propLabel`) when it is not. An attributes prop also needs
 * ATTRIBUTES_TYPE imported, which the caller adds to the imports.
 */
export function declaredProp(frontmatter: string, declaration: PropDeclaration, taken: ReadonlySet<string>): Result<DeclaredProp, string> {
  assert(IDENTIFIER.test(declaration.key), 'declaredProp: a new prop is named by an identifier');
  assert(declaration.key.length <= PROPERTY_LIMITS.nameCharsMax, 'declaredProp: a prop name is bounded');
  const refused = declarationProblem(frontmatter, declaration);
  if (refused !== undefined) {
    return err(refused);
  }
  const type = typeText(declaration);
  if (!type.ok) {
    return type;
  }
  const fallback = defaultCode(declaration);
  if (!fallback.ok) {
    return fallback;
  }
  const local = taken.has(declaration.key) || RESERVED.has(declaration.key) ? freeLocal(declaration.key, taken) : declaration.key;
  const entry = entryText(declaration, local, fallback.value);
  const restBefore = readRestBinding(frontmatter) !== undefined;
  const typing =
    declaration.kind === 'attributes'
      ? attributesEdits(frontmatter, declaration)
      : interfaceEdits(frontmatter, memberText(declaration, type.value), { restBefore });
  const edits = [...destructureEdits(frontmatter, entry, declaration.kind), ...typing];
  // From the end, so an earlier position still points at its text; at one
  // position the interface goes before the destructure written after it.
  const ordered = [...edits].sort((left, right) => right.at - left.at || right.order - left.order);
  let out = frontmatter;
  for (const edit of ordered) {
    out = `${out.slice(0, edit.at)}${edit.text}${out.slice(edit.at)}`;
  }
  assertDeclared(out, declaration, local);
  return ok({ frontmatter: out, local });
}

// Why the declaration cannot be added to this frontmatter at all.
function declarationProblem(frontmatter: string, declaration: PropDeclaration): string | undefined {
  if (frontmatter.length > PROPERTY_LIMITS.sourceCharsMax) {
    return 'This component’s frontmatter is too long to edit here.';
  }
  if (/\btype\s+Props\s*=/.test(frontmatter)) {
    return 'This component declares its props as a type. Add the property in the code.';
  }
  const rest = readRestBinding(frontmatter);
  const kindProblem = kindSettingsProblem(declaration, rest);
  if (kindProblem !== undefined) {
    return kindProblem;
  }
  const destructured = readPropsDestructure(frontmatter)?.entries.some((entry) => entry.key === declaration.key) ?? false;
  if (destructured || hasMember(frontmatter, declaration.key) || rest?.local === declaration.key) {
    return `This component already has a ${declaration.key} property.`;
  }
  return undefined;
}

function kindSettingsProblem(declaration: PropDeclaration, rest: RestBinding | undefined): string | undefined {
  switch (declaration.kind) {
    case 'attributes':
      if (rest !== undefined) {
        return `This component already passes its other attributes on as ${rest.local}.`;
      }
      if (!TAG_NAME.test(declaration.tag)) {
        return 'Only an HTML element can take an attributes property.';
      }
      return attributeDefaultsProblem(declaration.attributes);
    case 'number':
      return numberSettingsProblem(declaration.number);
    case 'boolean':
      return switchSettingsProblem(declaration.switch);
    case 'string':
    case 'option':
      return undefined;
    default: {
      const exhaustive: never = declaration.kind;
      return exhaustive;
    }
  }
}

interface TextEdit {
  readonly at: number;
  readonly text: string;
  /** Which of two edits at one position lands first in the text: the lower. */
  readonly order: number;
}

// `label = "Hi"`, `label`, `class: propClass = "x"` or `...rest`.
function entryText(declaration: PropDeclaration, local: string, fallback: string | undefined): string {
  if (declaration.kind === 'attributes') {
    return `...${local}`;
  }
  const named = local === declaration.key ? local : `${declaration.key}: ${local}`;
  return fallback === undefined ? named : `${named} = ${fallback}`;
}

// The member and its doc comment, indented as a member of `interface Props`.
function memberText(declaration: PropDeclaration, type: string): string {
  const lines = [tooltipText(declaration.tooltip), ...settingTags(declaration)].filter((line) => line !== '');
  const comment = lines.length === 0 ? '' : `  /** ${lines.join('\n   * ')} */\n`;
  return `${comment}  ${declaration.key}?: ${type};\n`;
}

// A prop's settings as JSDoc tags; a setting left at its default is not written.
function settingTags(declaration: PropDeclaration): readonly string[] {
  if (declaration.kind === 'number') {
    const { min, max, decimals } = declaration.number;
    return [min === undefined ? '' : `@min ${min}`, max === undefined ? '' : `@max ${max}`, decimals === undefined ? '' : `@decimals ${decimals}`];
  }
  if (declaration.kind === 'boolean') {
    const onLabel = declaration.switch.onLabel.trim();
    const offLabel = declaration.switch.offLabel.trim();
    return [onLabel === '' || onLabel === 'On' ? '' : `@onLabel ${onLabel}`, offLabel === '' || offLabel === 'Off' ? '' : `@offLabel ${offLabel}`];
  }
  return [];
}

// The new entry: after the last one (before a rest binding, which has to stay
// last), or a new destructure after `interface Props`, or at the top when the
// file has neither.
function destructureEdits(frontmatter: string, entry: string, kind: NewPropKind): readonly TextEdit[] {
  const destructure = readPropsDestructure(frontmatter);
  const pattern = propsPattern(frontmatter);
  if (destructure === undefined || pattern === undefined) {
    const body = propsInterfaceBody(frontmatter);
    const at = body === undefined ? 0 : lineEnd(frontmatter, body.to);
    const lead = at > 0 && frontmatter.charAt(at - 1) !== '\n' ? '\n' : '';
    return [{ at, text: `${lead}const { ${entry} } = Astro.props;\n`, order: 1 }];
  }
  const inside = frontmatter.slice(pattern.from, pattern.to);
  const oneLine = !inside.includes('\n');
  const rest = readRestBinding(frontmatter);
  if (rest !== undefined) {
    assert(kind !== 'attributes', 'A destructure takes one rest binding');
    return [{ at: rest.span.from, text: oneLine ? `${entry}, ` : `${entry},\n  `, order: 1 }];
  }
  if (inside.slice(1, -1).trim() === '') {
    return [{ at: pattern.from + 1, text: ` ${entry} `, order: 1 }];
  }
  return [{ at: destructureEnd(frontmatter, destructure), text: oneLine ? `, ${entry}` : `,\n  ${entry}`, order: 1 }];
}

// The member above `interface Props`' closing brace, or a new interface at the
// top declaring every prop the destructure already reads, so adding it types
// nothing that was untyped as an error.
function interfaceEdits(frontmatter: string, member: string, options: { readonly restBefore: boolean }): readonly TextEdit[] {
  const end = propsInterfaceEnd(frontmatter);
  if (end !== undefined) {
    const lineBreak = frontmatter.slice(0, end).trimEnd().length === end ? '\n' : '';
    return [{ at: end, text: `${lineBreak}${member}`, order: 0 }];
  }
  // A rest binding with no interface takes any attribute; an interface that
  // left it out would turn every attribute an instance passes into a type
  // error, and no tag is known here to extend HTMLAttributes with.
  const restMember = options.restBefore ? ['  [attribute: string]: unknown;\n'] : [];
  return [{ at: 0, text: `interface Props {\n${[...existingMembers(frontmatter), ...restMember].join('')}${member}}\n`, order: 0 }];
}

// `extends HTMLAttributes<"tag">` on `interface Props`, added to an extends
// list it already has, or a new interface; the tooltip above it.
function attributesEdits(frontmatter: string, declaration: PropDeclaration): readonly TextEdit[] {
  const tooltip = tooltipText(declaration.tooltip);
  const comment = tooltip === '' ? '' : `/** @attributes ${tooltip} */\n`;
  const base = `${ATTRIBUTES_TYPE.name}<${JSON.stringify(declaration.tag)}>`;
  const head = interfaceHead(frontmatter);
  if (head === undefined) {
    return [{ at: 0, text: `${comment}interface Props extends ${base} {\n${existingMembers(frontmatter).join('')}}\n`, order: 0 }];
  }
  const edits: TextEdit[] = comment === '' ? [] : [{ at: head.statement, text: comment, order: 0 }];
  if (/\bHTMLAttributes\s*</.test(head.text)) {
    return edits;
  }
  const extended = /\bextends\b/.test(head.text);
  const at = head.from + head.text.trimEnd().length;
  return [...edits, { at, text: extended ? `, ${base}` : ` extends ${base}`, order: 0 }];
}

// The members a new interface declares for the props already destructured,
// typed by what their default literal says (or `unknown`, as the Properties
// panel declares a prop it cannot read the type of).
function existingMembers(frontmatter: string): readonly string[] {
  return (readPropsDestructure(frontmatter)?.entries ?? []).map((entry) => {
    const value = entry.defaultValue === undefined ? '' : frontmatter.slice(entry.defaultValue.from, entry.defaultValue.to);
    return `  ${entry.key}?: ${literalType(value)};\n`;
  });
}

function literalType(value: string): string {
  const trimmed = value.trim();
  if (/^(["'`]).*\1$/s.test(trimmed)) {
    return 'string';
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return 'number';
  }
  if (trimmed === 'true' || trimmed === 'false') {
    return 'boolean';
  }
  return 'unknown';
}

// A tooltip as a one-line doc comment: `*/` would end the comment early, and
// a line opening with `@` would read as a tag.
function tooltipText(tooltip: string): string {
  return tooltip.replace(/\*\//g, '* /').replace(/\s+/g, ' ').trim().replace(/^@+/, '').slice(0, DECLARATION_LIMITS.tooltipCharsMax);
}

function hasMember(frontmatter: string, key: string): boolean {
  const body = propsInterfaceBody(frontmatter);
  let child = body?.firstChild ?? undefined;
  for (let count = 0; child !== undefined && count < LIMITS.propSchemaFieldsMax; count++) {
    const name = child.name === 'PropertyType' ? (child.getChild('PropertyDefinition') ?? undefined) : undefined;
    if (name !== undefined && frontmatter.slice(name.from, name.to) === key) {
      return true;
    }
    child = child.nextSibling ?? undefined;
  }
  return false;
}

// `interface Props extends A, B ` up to its body: where the statement starts
// (before any `export`), and the head's text and offset.
function interfaceHead(frontmatter: string): { readonly statement: number; readonly from: number; readonly text: string } | undefined {
  const body = propsInterfaceBody(frontmatter);
  const declaration = body?.parent ?? undefined;
  const name = declaration?.getChild('TypeDefinition') ?? undefined;
  if (body === undefined || declaration === undefined || name === undefined) {
    return undefined;
  }
  return { statement: statementOf(declaration).from, from: name.to, text: frontmatter.slice(name.to, body.from) };
}

// The doc comment directly above the `interface Props` statement.
function interfaceComment(frontmatter: string): { readonly from: number; readonly to: number; readonly text: string } | undefined {
  const body = propsInterfaceBody(frontmatter);
  const declaration = body?.parent ?? undefined;
  if (declaration === undefined) {
    return undefined;
  }
  const statement = statementOf(declaration);
  const previous = statement.prevSibling ?? undefined;
  if (previous?.name !== 'BlockComment') {
    return undefined;
  }
  const between = frontmatter.slice(previous.to, statement.from);
  return between.trim() === '' ? { from: previous.from, to: previous.to, text: frontmatter.slice(previous.from, previous.to) } : undefined;
}

function statementOf(declaration: SyntaxNode): SyntaxNode {
  const parent = declaration.parent ?? undefined;
  return parent?.name === 'ExportDeclaration' ? parent : declaration;
}

function lineEnd(text: string, from: number): number {
  const newline = text.indexOf('\n', from);
  return newline === -1 ? text.length : newline + 1;
}

function assertDeclared(out: string, declaration: PropDeclaration, local: string): void {
  if (declaration.kind === 'attributes') {
    assert(readRestBinding(out)?.local === local, 'declaredProp: the rest binding reads back');
    assert(attributesTag(out) !== undefined, 'declaredProp: the interface extends HTMLAttributes');
    return;
  }
  const entries = readPropsDestructure(out)?.entries ?? [];
  assert(
    entries.some((entry) => entry.key === declaration.key && entry.local === local),
    'declaredProp: the entry reads back',
  );
  assert(hasMember(out, declaration.key), 'declaredProp: the member reads back');
}
