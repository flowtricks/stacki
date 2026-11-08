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
//
// A list prop is a list of items that each hold the same fields, typed
// `readonly { title: string; text: string }[]` (or by a type the file already
// declares with those fields) and always given a default, `[]` when no items
// were given, so the markup can loop over it (listPropType.ts). An image prop
// is typed by its default: an imported file in src/ makes it `ImageMetadata`,
// read by `import placeholder from "../assets/placeholder.svg"` (both imports
// are answered to the caller to add), and a URL makes it a `string`
// (imagePropDefault.ts). An image prop always has a default, since an <img>
// with nothing to show renders a broken image.

import type { SyntaxNode } from '@lezer/common';
import { assert } from '../../shared/core/assert';
import { indentUnitOf, withIndentUnit } from '../../shared/core/indent';
import { LIMITS } from '../../shared/core/limits';
import { err, ok, type Result } from '../../shared/core/result';
import { PROPERTY_LIMITS } from '../../shared/properties/propertyEditing';
import { destructureEnd, freeLocal, propNamed, propsInterfaceBody, propsInterfaceEnd, propsPattern, readPropsDestructure } from './loopProps';
import { NUMBER_DECIMALS_MAX, type NumberSettings, type SwitchSettings } from './propDocumentation';
import { isListType, listDefaultCode, listFieldsOfType, listSettingsProblem, listTypeText, type ItemFieldDeclaration, type ListSettings } from './listPropType';
import { IMAGE_TYPE, imageDefaultOf, imageTypeText, type ImageDefault } from './imagePropDefault';

/** What a new prop holds: words, a number, a switch, one of a list of words, attributes, a list of items or an image. */
export type NewPropKind = 'string' | 'number' | 'boolean' | 'option' | 'attributes' | 'list' | 'image';

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
  /** A list prop's item fields and default items. Read only for a list. */
  readonly list: ListSettings;
  /** An image prop's default: an asset path relative to the component, a rooted path or a URL. Read only for an image. */
  readonly image: string;
  /** How the member is typed. Absent: optional, writable, and typed as its kind writes it. */
  readonly typing?: PropTyping | undefined;
  /** A default written as code in the default's code view. Absent or empty: the default the kind's own fields give. */
  readonly defaultExpression?: string | undefined;
}

/**
 * The TypeScript a prop's member is written with, as the Properties panel
 * edits it: `readonly`, no `?` when required, and a code type written in place
 * of the type the kind gives (empty for the kind's own).
 */
export interface PropTyping {
  readonly required: boolean;
  readonly readonly: boolean;
  readonly codeType: string;
}

/** An import the declared prop needs: a type to name it by, or the file its default is. */
export interface PropImport {
  readonly name: string;
  readonly path: string;
  /** A named import (`{ HTMLAttributes }`); a default import otherwise. */
  readonly named: boolean;
  readonly typeOnly: boolean;
}

/** The frontmatter with the prop declared, the name the markup reads it by, and the imports it needs. */
export interface DeclaredProp {
  readonly frontmatter: string;
  readonly local: string;
  readonly imports: readonly PropImport[];
}

/** An import the file already has, as far as reusing one reads it. */
export interface ExistingImport {
  readonly name: string;
  readonly path: string;
  readonly named?: boolean | undefined;
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
export function defaultCode(
  declaration: Pick<PropDeclaration, 'kind' | 'defaultText' | 'options' | 'number' | 'list' | 'image' | 'defaultExpression'>,
): Result<string | undefined, string> {
  // Code typed in the default's code view is the default, exactly as typed.
  const expression = declaration.defaultExpression?.trim() ?? '';
  assert(expression.length <= PROPERTY_LIMITS.textCharsMax, 'defaultCode: a default expression is bounded');
  if (expression !== '') {
    return ok(expression);
  }
  // A list and an image always have a default, whatever was typed as text.
  if (declaration.kind === 'list') {
    const problem = listSettingsProblem(declaration.list);
    return problem === undefined ? ok(listDefaultCode(declaration.list)) : err(problem);
  }
  if (declaration.kind === 'image') {
    const image = imageDefaultOf(declaration.image);
    return image.ok ? ok(imageDefaultCode(image.value, image.value.kind === 'asset' ? image.value.base : '')) : image;
  }
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

// An image default as code: the import's name, or the URL as a string.
function imageDefaultCode(image: ImageDefault, local: string): string {
  switch (image.kind) {
    case 'asset':
      assert(/^[A-Za-z_$][\w$]*$/.test(local), 'imageDefaultCode: an import is read by an identifier');
      return local;
    case 'url':
      return JSON.stringify(image.url);
    default: {
      const exhaustive: never = image;
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

/** The TypeScript type a prop is declared with; a list reuses a type `frontmatter` declares for its items. */
export function typeText(declaration: Pick<PropDeclaration, 'kind' | 'options' | 'list' | 'image'>, frontmatter = ''): Result<string, string> {
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
    case 'list': {
      const problem = listSettingsProblem(declaration.list);
      return problem === undefined ? ok(listTypeText(frontmatter, declaration.list.fields)) : err(problem);
    }
    case 'image': {
      const image = imageDefaultOf(declaration.image);
      return image.ok ? ok(imageTypeText(image.value)) : image;
    }
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
export function declaredProp(
  frontmatter: string,
  declaration: PropDeclaration,
  taken: ReadonlySet<string>,
  existing: readonly ExistingImport[] = [],
): Result<DeclaredProp, string> {
  assert(IDENTIFIER.test(declaration.key), 'declaredProp: a new prop is named by an identifier');
  assert(declaration.key.length <= PROPERTY_LIMITS.nameCharsMax, 'declaredProp: a prop name is bounded');
  const refused = declarationProblem(frontmatter, declaration);
  if (refused !== undefined) {
    return err(refused);
  }
  // A code type stated in the form is the type; the kind's own otherwise.
  const codeType = declaration.typing?.codeType.trim() ?? '';
  const type = codeType === '' ? typeText(declaration, frontmatter) : ok(codeType);
  if (!type.ok) {
    return type;
  }
  const local = taken.has(declaration.key) || RESERVED.has(declaration.key) ? freeLocal(declaration.key, taken) : declaration.key;
  const needed = neededImports(declaration, new Set([...taken, local]), existing);
  const fallback = needed.defaultCode === undefined ? defaultCode(declaration) : ok(needed.defaultCode);
  if (!fallback.ok) {
    return fallback;
  }
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
  return ok({ frontmatter: out, local, imports: needed.imports });
}

const IMPORT_SUFFIX_MAX = 100;

// The imports a declaration needs, and for an imported image the name its
// default reads the file by: the import the file already has for it, else the
// file's own name, numbered when that is taken (`placeholder2`).
function neededImports(
  declaration: PropDeclaration,
  taken: ReadonlySet<string>,
  existing: readonly ExistingImport[],
): { readonly imports: readonly PropImport[]; readonly defaultCode: string | undefined } {
  if (declaration.kind === 'attributes') {
    return { imports: [{ name: ATTRIBUTES_TYPE.name, path: ATTRIBUTES_TYPE.path, named: true, typeOnly: true }], defaultCode: undefined };
  }
  if (declaration.kind !== 'image') {
    return { imports: [], defaultCode: undefined };
  }
  const image = imageDefaultOf(declaration.image);
  if (!image.ok || image.value.kind !== 'asset') {
    return { imports: [], defaultCode: undefined };
  }
  const { specifier, base } = image.value;
  const type: PropImport = { name: IMAGE_TYPE.name, path: IMAGE_TYPE.path, named: true, typeOnly: true };
  const reused = existing.find((entry) => entry.path === specifier && entry.named !== true);
  if (reused !== undefined) {
    return { imports: [type], defaultCode: reused.name };
  }
  let name = base;
  for (let suffix = 2; taken.has(name) || RESERVED.has(name); suffix++) {
    assert(suffix <= IMPORT_SUFFIX_MAX, 'neededImports: a free import name is found within the suffix bound');
    name = `${base}${suffix}`;
  }
  assert(!taken.has(name), 'neededImports: the import name is free');
  return { imports: [type, { name, path: specifier, named: false, typeOnly: false }], defaultCode: name };
}

// Why the declaration cannot be added to this frontmatter at all.
function declarationProblem(frontmatter: string, declaration: PropDeclaration): string | undefined {
  if (frontmatter.length > PROPERTY_LIMITS.sourceCharsMax) {
    return 'This component’s frontmatter is too long to edit here.';
  }
  if (/\btype\s+Props\s*=/.test(frontmatter)) {
    return 'This component declares its props as a type. Add the property in the code.';
  }
  const codeType = declaration.typing?.codeType ?? '';
  if (codeType.length > PROPERTY_LIMITS.textCharsMax) {
    return 'The code type is too long.';
  }
  if (/[;\n]/.test(codeType)) {
    // One member's type: a semicolon or a line break would end the member and start another.
    return 'Write the code type on one line, without a semicolon.';
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
    case 'list':
      return listSettingsProblem(declaration.list);
    case 'image': {
      const image = imageDefaultOf(declaration.image);
      return image.ok ? undefined : image.error;
    }
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
  const comment = lines.length === 0 ? '' : `\t/** ${lines.join('\n\t * ')} */\n`;
  const modifier = declaration.typing?.readonly === true ? 'readonly ' : '';
  const optional = declaration.typing?.required === true ? '' : '?';
  return `${comment}\t${modifier}${declaration.key}${optional}: ${type};\n`;
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
  const unit = indentUnitOf(frontmatter);
  const end = propsInterfaceEnd(frontmatter);
  if (end !== undefined) {
    const lineBreak = frontmatter.slice(0, end).trimEnd().length === end ? '\n' : '';
    return [{ at: end, text: `${lineBreak}${withIndentUnit(member, unit)}`, order: 0 }];
  }
  // A rest binding with no interface takes any attribute; an interface that
  // left it out would turn every attribute an instance passes into a type
  // error, and no tag is known here to extend HTMLAttributes with.
  const restMember = options.restBefore ? ['\t[attribute: string]: unknown;\n'] : [];
  return [{ at: 0, text: withIndentUnit(`interface Props {\n${[...existingMembers(frontmatter), ...restMember].join('')}${member}}\n`, unit), order: 0 }];
}

// `extends HTMLAttributes<"tag">` on `interface Props`, added to an extends
// list it already has, or a new interface; the tooltip above it.
function attributesEdits(frontmatter: string, declaration: PropDeclaration): readonly TextEdit[] {
  const tooltip = tooltipText(declaration.tooltip);
  const comment = tooltip === '' ? '' : `/** @attributes ${tooltip} */\n`;
  const base = `${ATTRIBUTES_TYPE.name}<${JSON.stringify(declaration.tag)}>`;
  const head = interfaceHead(frontmatter);
  if (head === undefined) {
    const text = `${comment}interface Props extends ${base} {\n${existingMembers(frontmatter).join('')}}\n`;
    return [{ at: 0, text: withIndentUnit(text, indentUnitOf(frontmatter)), order: 0 }];
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
    return `\t${entry.key}?: ${literalType(value)};\n`;
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

/** Each member of `interface Props` and its type as written: `image → ImageMetadata`. */
export function memberTypes(frontmatter: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const body = propsInterfaceBody(frontmatter);
  let child = body?.firstChild ?? undefined;
  for (let count = 0; child !== undefined && count < LIMITS.propSchemaFieldsMax; count++) {
    const name = child.name === 'PropertyType' ? (child.getChild('PropertyDefinition') ?? undefined) : undefined;
    const type = child.getChild('TypeAnnotation')?.lastChild ?? undefined;
    if (name !== undefined && type !== undefined) {
      out.set(frontmatter.slice(name.from, name.to), frontmatter.slice(type.from, type.to).trim());
    }
    child = child.nextSibling ?? undefined;
  }
  assert(out.size <= LIMITS.propSchemaFieldsMax, 'memberTypes: the members are bounded');
  return out;
}

/** A prop that holds a list, as a loop over it reads it. */
export interface ListPropReading {
  /** The prop's name, as a page passes it. */
  readonly key: string;
  /** Its items' fields, when its type states them as plain fields. */
  readonly fields: readonly ItemFieldDeclaration[] | undefined;
}

/**
 * The list prop the frontmatter reads by `local`, or undefined when that name
 * is no prop or holds no list. Its type says so, read by the Properties panel's
 * own reader (listFieldsOfType); a prop with no type of its own is a list when
 * its default is written as one, and its items' fields are then unknown.
 */
export function listPropOf(frontmatter: string, local: string): ListPropReading | undefined {
  const entry = propNamed(frontmatter, local);
  if (entry === undefined) {
    return undefined;
  }
  const type = memberTypes(frontmatter).get(entry.key);
  if (type !== undefined) {
    return isListType(type) ? { key: entry.key, fields: listFieldsOfType(type, frontmatter) } : undefined;
  }
  const span = entry.defaultValue;
  return span !== undefined && frontmatter.slice(span.from, span.to).startsWith('[') ? { key: entry.key, fields: undefined } : undefined;
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
