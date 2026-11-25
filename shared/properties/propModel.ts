// One cross-process description of a component's props
// (docs/plans/prop-controls.md §2). The main process builds it once from the
// component's source with the TypeScript compiler (electron/properties/propModel/),
// and every panel derives what it shows from it through an adapter
// (propModelSchema.ts), so the instance Settings panel, the Properties panel
// and the bind-dot reader cannot disagree about what a prop is.
//
// A prop's control is a discriminated union (AGENTS.md §1): data exists only
// on the kinds that have it. Phase 1 builds the kinds the panels already draw;
// later phases add kinds to the union, and the compiler then names every
// switch that has to handle them.
//
// parsePropModel is the boundary parser: the producer runs its own output
// through it before handing it on (the pair of a producer-side and a
// consumer-side check, AGENTS.md §9), and anything that receives a model from
// elsewhere parses it the same way.

import { assert } from '../core/assert';
import { LIMITS } from '../core/limits';
import { toArray, toRecord } from '../core/record';
import { PROP_TAG_LIMITS } from './propTags';
import { PROP_FIELD_USAGES, type DefaultRule, type PropDefault, type PropFieldUsage, type PropUnion, type UnionBranch } from './propSchema';

// Bounds of a prop model. They live here, next to the parser that enforces
// them (AGENTS.md §5); `propNestingDepthMax` and `propVariantsMax` were
// requested for shared/core/limits.ts (plan D14) and may move there once a
// human approves the change to that gate file.
export const PROP_MODEL_LIMITS = {
  // How deep groups and lists of groups nest: `items: { cta: { link: {…} } }[]` is three. A List prop's
  // item fields nest LIMITS.listFieldDepthMax levels, and each level of a list is a list and a group.
  propNestingDepthMax: LIMITS.listFieldDepthMax * 2,
  // Branches of one union of prop shapes; past this the union is not modelled.
  propVariantsMax: 32,
  propsMax: LIMITS.propSchemaFieldsMax,
  optionsMax: LIMITS.propOptionsMax,
  // Union tables one component declares (each `A | B` of shapes is one).
  unionsMax: 64,
  // Type text as written; longer types are cut by the producer.
  typeTextCharsMax: LIMITS.attrCharsMax,
  textCharsMax: LIMITS.attrCharsMax,
  docCharsMax: PROP_TAG_LIMITS.docCharsMax,
} as const;

/** One option of a Choice; `expression` options are written `flag={true}`, `cols={3}`. */
export interface ChoiceOption {
  readonly value: string;
  readonly written: 'string' | 'expression';
}

/** Why a prop's value can only be given in code. */
export const CODE_REASONS = ['untyped', 'unrecognized', 'opaque', 'tuple', 'nestingDepth'] as const;
export type CodeReason = (typeof CODE_REASONS)[number];

export type PropControl =
  // `format` is the `@format` word a member of a group states: `color`, `date`, `longtext`.
  | { readonly kind: 'text'; readonly format?: string }
  | {
      readonly kind: 'number';
      readonly min: number | undefined;
      readonly max: number | undefined;
      readonly minExclusive: boolean;
      readonly maxExclusive: boolean;
      readonly step: number | undefined;
      readonly decimals: number | undefined;
    }
  | { readonly kind: 'switch' }
  | { readonly kind: 'choice'; readonly options: readonly ChoiceOption[]; readonly numeric: boolean }
  // Element attributes: `HTMLAttributes<"a">`, `astroHTML.*`, a `Record`, or an untyped `{…}` default.
  | { readonly kind: 'attributes'; readonly tag: string | undefined }
  | { readonly kind: 'list'; readonly item: PropControl }
  | { readonly kind: 'group'; readonly fields: readonly PropMember[] }
  // A function: an action the component calls, set in code; `signature` is its type as written.
  | { readonly kind: 'callback'; readonly signature: string }
  | { readonly kind: 'code'; readonly reason: CodeReason };
export type PropControlKind = PropControl['kind'];
export const PROP_CONTROL_KINDS = [
  'text',
  'number',
  'switch',
  'choice',
  'attributes',
  'list',
  'group',
  'callback',
  'code',
] as const satisfies readonly PropControlKind[];

/** A member of a group: the part of a prop that nests. */
export interface PropMember {
  readonly name: string;
  // The type expression as read, local aliases expanded; '' when nothing declares one.
  readonly typeText: string;
  readonly control: PropControl;
  readonly presence: 'required' | 'optional';
}

/** What a prop is when an instance leaves it unset. */
export type PropFallback =
  | { readonly kind: 'none' }
  // `source` says where the value is stated: the destructure default, a `?? literal`, or the doc's prose.
  | { readonly kind: 'literal'; readonly value: PropDefault; readonly source: 'destructure' | 'nullish' | 'doc' }
  | { readonly kind: 'expression'; readonly code: string }
  // No one value: "Defaults to `Play`, or `Pause` while pressed", "inferred".
  | { readonly kind: 'hint'; readonly hint: string };

/** Why a prop has its control (plan §4: strong usage, medium type, weak name). */
export type Recognition =
  | { readonly source: 'type' }
  | { readonly source: 'usage'; readonly evidence: string }
  | { readonly source: 'name'; readonly evidence: string }
  | { readonly source: 'tag'; readonly tag: string }
  | { readonly source: 'fallback' };

/** Whether the component reads the prop: `unknown` when the props object escapes whole. */
export const PROP_USAGES = PROP_FIELD_USAGES;
export type PropUsage = PropFieldUsage;

export interface PropModel extends PropMember {
  // Whether the props type declares it; an undeclared prop is one the code
  // reads (a destructure, `Astro.props.x`), shown as "No type" (plan §8).
  readonly declared: boolean;
  // `| null` in the type, or `| undefined` on a required member.
  readonly nullable: boolean;
  readonly fallback: PropFallback;
  // The doc comment as written, tags kept (what the schema's `doc` has always carried).
  readonly documentation: string;
  // The doc without its tags.
  readonly tooltip: string;
  readonly group: string | undefined;
  readonly deprecated: string | undefined;
  readonly format: string | undefined;
  readonly recognition: Recognition;
  readonly usage: PropUsage;
}

/** How a component types its props. */
export const PROPS_DECLARATIONS = ['interface', 'type', 'annotation', 'assertion', 'none'] as const;
export type PropsDeclaration = (typeof PROPS_DECLARATIONS)[number];

export interface ComponentPropModel {
  readonly declaration: PropsDeclaration;
  readonly props: readonly PropModel[];
  // The unions of prop shapes the component declares, as the instance panel weighs them per branch.
  readonly unions: readonly PropUnion[];
}

/** A component's prop model, parsed: every bound and every variant checked. */
export function parsePropModel(input: unknown): ComponentPropModel {
  const value = modelRecord(input, 'root');
  const props = modelArray(value['props'], 'props', PROP_MODEL_LIMITS.propsMax).map((prop, index) => parseProp(prop, `props[${index}]`));
  const names = new Set(props.map((prop) => prop.name));
  if (names.size !== props.length) {
    fail('props', 'prop names must be unique');
  }
  const unions = modelArray(value['unions'], 'unions', PROP_MODEL_LIMITS.unionsMax).map((union, index) => parseUnion(union, `unions[${index}]`));
  const model: ComponentPropModel = { declaration: oneOf(value['declaration'], 'declaration', PROPS_DECLARATIONS), props, unions };
  assert(model.props.length <= PROP_MODEL_LIMITS.propsMax, 'parsePropModel: props are bounded');
  return model;
}

function parseProp(input: unknown, where: string): PropModel {
  const value = modelRecord(input, where);
  const member = parseMember(value, where, 0);
  return {
    ...member,
    declared: modelBoolean(value['declared'], `${where}.declared`),
    nullable: modelBoolean(value['nullable'], `${where}.nullable`),
    fallback: parseFallback(value['fallback'], `${where}.fallback`),
    documentation: modelText(value['documentation'], `${where}.documentation`, PROP_MODEL_LIMITS.docCharsMax),
    tooltip: modelText(value['tooltip'], `${where}.tooltip`, PROP_MODEL_LIMITS.docCharsMax),
    group: optionalText(value['group'], `${where}.group`),
    deprecated: optionalText(value['deprecated'], `${where}.deprecated`),
    format: optionalText(value['format'], `${where}.format`),
    recognition: parseRecognition(value['recognition'], `${where}.recognition`),
    usage: oneOf(value['usage'], `${where}.usage`, PROP_USAGES),
  };
}

function parseMember(value: Readonly<Record<string, unknown>>, where: string, depth: number): PropMember {
  const name = modelText(value['name'], `${where}.name`, PROP_MODEL_LIMITS.textCharsMax);
  if (name.length === 0) {
    fail(`${where}.name`, 'expected non-empty string');
  }
  return {
    name,
    typeText: modelText(value['typeText'], `${where}.typeText`, PROP_MODEL_LIMITS.typeTextCharsMax),
    control: parseControl(value['control'], `${where}.control`, depth),
    presence: oneOf(value['presence'], `${where}.presence`, ['required', 'optional'] as const),
  };
}

// Groups and lists nest; `depth` counts the groups above this control, and a
// model nested deeper than the bound is refused rather than walked.
function parseControl(input: unknown, where: string, depth: number): PropControl {
  const value = modelRecord(input, where);
  const kind = oneOf(value['kind'], `${where}.kind`, PROP_CONTROL_KINDS);
  // The producer stops a list or group at the bound by making what is inside it code, which is one level past.
  const stoppedAtBound = depth === PROP_MODEL_LIMITS.propNestingDepthMax + 1 && kind === 'code' && value['reason'] === 'nestingDepth';
  if (depth > PROP_MODEL_LIMITS.propNestingDepthMax && !stoppedAtBound) {
    fail(where, `nesting exceeds ${PROP_MODEL_LIMITS.propNestingDepthMax}`);
  }
  switch (kind) {
    case 'text': {
      const format = optionalText(value['format'], `${where}.format`);
      return format === undefined ? { kind } : { kind, format };
    }
    case 'number':
      return parseNumberControl(value, where);
    case 'switch':
      // A switch shows True and False; an old model's labels are ignored.
      return { kind };
    case 'choice': {
      const options = modelArray(value['options'], `${where}.options`, PROP_MODEL_LIMITS.optionsMax).map((option, index) =>
        parseOption(option, `${where}.options[${index}]`),
      );
      if (options.length < 2) {
        fail(`${where}.options`, 'a choice has at least two options');
      }
      if (new Set(options.map((option) => option.value)).size !== options.length) {
        fail(`${where}.options`, 'options must be unique');
      }
      return { kind, options, numeric: modelBoolean(value['numeric'], `${where}.numeric`) };
    }
    case 'attributes':
      return { kind, tag: optionalText(value['tag'], `${where}.tag`) };
    case 'list':
      return { kind, item: parseControl(value['item'], `${where}.item`, depth + 1) };
    case 'group': {
      const fields = modelArray(value['fields'], `${where}.fields`, PROP_MODEL_LIMITS.propsMax).map((field, index) =>
        parseMember(modelRecord(field, `${where}.fields[${index}]`), `${where}.fields[${index}]`, depth + 1),
      );
      if (new Set(fields.map((field) => field.name)).size !== fields.length) {
        fail(`${where}.fields`, 'field names must be unique');
      }
      return { kind, fields };
    }
    case 'callback':
      return { kind, signature: modelText(value['signature'], `${where}.signature`, PROP_MODEL_LIMITS.typeTextCharsMax) };
    case 'code':
      return { kind, reason: oneOf(value['reason'], `${where}.reason`, CODE_REASONS) };
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function parseNumberControl(value: Readonly<Record<string, unknown>>, where: string): PropControl {
  const min = optionalNumber(value['min'], `${where}.min`);
  const max = optionalNumber(value['max'], `${where}.max`);
  if (min !== undefined && max !== undefined && max < min) {
    fail(where, 'max is below min');
  }
  const step = optionalNumber(value['step'], `${where}.step`);
  if (step !== undefined && step <= 0) {
    fail(`${where}.step`, 'expected a positive step');
  }
  const decimals = optionalNumber(value['decimals'], `${where}.decimals`);
  if (decimals !== undefined && (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > PROP_TAG_LIMITS.decimalsMax)) {
    fail(`${where}.decimals`, `expected a whole number from 0 to ${PROP_TAG_LIMITS.decimalsMax}`);
  }
  return {
    kind: 'number',
    min,
    max,
    minExclusive: modelBoolean(value['minExclusive'], `${where}.minExclusive`),
    maxExclusive: modelBoolean(value['maxExclusive'], `${where}.maxExclusive`),
    step,
    decimals,
  };
}

function parseOption(input: unknown, where: string): ChoiceOption {
  const value = modelRecord(input, where);
  return {
    value: modelText(value['value'], `${where}.value`, PROP_MODEL_LIMITS.textCharsMax),
    written: oneOf(value['written'], `${where}.written`, ['string', 'expression'] as const),
  };
}

function parseFallback(input: unknown, where: string): PropFallback {
  const value = modelRecord(input, where);
  const kind = oneOf(value['kind'], `${where}.kind`, ['none', 'literal', 'expression', 'hint'] as const);
  switch (kind) {
    case 'none':
      return { kind };
    case 'literal':
      return {
        kind,
        value: parseDefault(value['value'], `${where}.value`),
        source: oneOf(value['source'], `${where}.source`, ['destructure', 'nullish', 'doc'] as const),
      };
    case 'expression': {
      const code = modelText(value['code'], `${where}.code`, PROP_MODEL_LIMITS.textCharsMax);
      if (code.trim() === '') {
        fail(`${where}.code`, 'expected an expression');
      }
      return { kind, code };
    }
    case 'hint': {
      const hint = modelText(value['hint'], `${where}.hint`, PROP_MODEL_LIMITS.textCharsMax);
      if (hint.trim() === '') {
        fail(`${where}.hint`, 'expected a hint');
      }
      return { kind, hint };
    }
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function parseRecognition(input: unknown, where: string): Recognition {
  const value = modelRecord(input, where);
  const source = oneOf(value['source'], `${where}.source`, ['type', 'usage', 'name', 'tag', 'fallback'] as const);
  switch (source) {
    case 'type':
    case 'fallback':
      return { source };
    case 'usage':
    case 'name':
      return { source, evidence: modelText(value['evidence'], `${where}.evidence`, PROP_MODEL_LIMITS.textCharsMax) };
    case 'tag':
      return { source, tag: modelText(value['tag'], `${where}.tag`, PROP_MODEL_LIMITS.textCharsMax) };
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

function parseUnion(input: unknown, where: string): PropUnion {
  const value = modelRecord(input, where);
  const branches = modelArray(value['branches'], `${where}.branches`, PROP_MODEL_LIMITS.propVariantsMax).map((branch, index) =>
    parseBranch(branch, `${where}.branches[${index}]`),
  );
  if (branches.length < 2) {
    fail(`${where}.branches`, 'a union has at least two branches');
  }
  return { names: modelStrings(value['names'], `${where}.names`, PROP_MODEL_LIMITS.propsMax), branches };
}

function parseBranch(input: unknown, where: string): UnionBranch {
  const value = modelRecord(input, where);
  return {
    forbids: modelStrings(value['forbids'], `${where}.forbids`, PROP_MODEL_LIMITS.propsMax),
    pins: modelDictionary(value['pins'], `${where}.pins`, (item, at) => modelStrings(item, at, PROP_MODEL_LIMITS.optionsMax)),
    defaults: modelDictionary(value['defaults'], `${where}.defaults`, (item, at) => {
      if (typeof item === 'number') {
        return finite(item, at);
      }
      return modelText(item, at, PROP_MODEL_LIMITS.textCharsMax);
    }),
    rules: modelDictionary(value['rules'], `${where}.rules`, parseRule),
    docs: modelDictionary(value['docs'], `${where}.docs`, (item, at) => modelText(item, at, PROP_MODEL_LIMITS.docCharsMax)),
  };
}

function parseRule(input: unknown, where: string): DefaultRule {
  const value = modelRecord(input, where);
  return {
    prop: modelText(value['prop'], `${where}.prop`, PROP_MODEL_LIMITS.textCharsMax),
    is: modelText(value['is'], `${where}.is`, PROP_MODEL_LIMITS.textCharsMax),
    then: modelText(value['then'], `${where}.then`, PROP_MODEL_LIMITS.textCharsMax),
    otherwise: modelText(value['otherwise'], `${where}.otherwise`, PROP_MODEL_LIMITS.textCharsMax),
  };
}

function parseDefault(input: unknown, where: string): PropDefault {
  if (typeof input === 'string') {
    return modelText(input, where, PROP_MODEL_LIMITS.textCharsMax);
  }
  if (typeof input === 'boolean') {
    return input;
  }
  if (typeof input === 'number') {
    return finite(input, where);
  }
  fail(where, 'expected string, number or boolean');
}

function fail(where: string, what: string): never {
  throw new Error(`PropModel.${where}: ${what}`);
}
function modelRecord(input: unknown, where: string): Readonly<Record<string, unknown>> {
  const value = toRecord(input);
  if (value === undefined) {
    fail(where, 'expected object');
  }
  return value;
}
function modelArray(input: unknown, where: string, maximum: number): readonly unknown[] {
  const value = toArray(input);
  if (value === undefined) {
    fail(where, 'expected array');
  }
  if (value.length > maximum) {
    fail(where, `exceeds ${maximum} entries`);
  }
  return value;
}
function modelStrings(input: unknown, where: string, maximum: number): readonly string[] {
  return modelArray(input, where, maximum).map((item, index) => modelText(item, `${where}[${index}]`, PROP_MODEL_LIMITS.textCharsMax));
}
function modelText(input: unknown, where: string, maximum: number): string {
  if (typeof input !== 'string') {
    fail(where, 'expected string');
  }
  if (input.length > maximum) {
    fail(where, `exceeds ${maximum} characters`);
  }
  return input;
}
function optionalText(input: unknown, where: string): string | undefined {
  return input === undefined ? undefined : modelText(input, where, PROP_MODEL_LIMITS.textCharsMax);
}
function modelBoolean(input: unknown, where: string): boolean {
  if (typeof input !== 'boolean') {
    fail(where, 'expected boolean');
  }
  return input;
}
function finite(input: number, where: string): number {
  if (!Number.isFinite(input)) {
    fail(where, 'expected finite number');
  }
  return input;
}
function optionalNumber(input: unknown, where: string): number | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (typeof input !== 'number') {
    fail(where, 'expected number');
  }
  return finite(input, where);
}
function oneOf<const T extends readonly string[]>(input: unknown, where: string, values: T): T[number] {
  const found = values.find((value) => value === input);
  if (found === undefined) {
    fail(where, `expected one of ${values.join(', ')}`);
  }
  return found;
}
function modelDictionary<T>(input: unknown, where: string, parse: (value: unknown, where: string) => T): Readonly<Record<string, T>> {
  const record = modelRecord(input, where);
  const entries = Object.entries(record);
  if (entries.length > PROP_MODEL_LIMITS.propsMax) {
    fail(where, `exceeds ${PROP_MODEL_LIMITS.propsMax} entries`);
  }
  return Object.fromEntries(entries.map(([key, item]) => [key, parse(item, `${where}.${key}`)]));
}
