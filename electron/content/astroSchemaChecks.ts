// A field's zod chain, read as settings and written back from them: its checks
// (fieldChecks.ts), an option field's values, its default, help text and
// whether it is required. Writing changes only the methods for the settings
// that changed (writeChain), so a chain written by hand — a transform, a
// refine, a message beside a maximum, a constant for a minimum — keeps every
// part the form does not change exactly as written. An image's width and
// height range is the refine Astro's docs show
// (`image().refine((image) => image.width >= 800)`), written and read in one
// form; any other refine is kept as written.

import ts from 'typescript';

import { assert } from '../../shared/core/assert';
import type { FieldSettings, SettingsFieldKind } from '../../shared/properties/collectionSettings';
import { FIELD_CHECKS, type FieldCheckKey, type FieldChecks, type FieldDefault, type NumberSign } from '../../shared/properties/fieldChecks';

export interface ChainStep {
  readonly name: string;
  readonly text: string;
  readonly args: readonly ts.Expression[];
}

export interface Chain {
  readonly base: string;
  readonly baseNode: ts.Expression;
  readonly kind: SettingsFieldKind;
  readonly steps: readonly ChainStep[];
}

export type ChainSettings = FieldSettings;

/** Methods after which the schema is no longer its base type: checks go in before them. */
const STRUCTURAL = new Set(['transform', 'refine', 'superRefine', 'pipe', 'or', 'and', 'catch', 'array', 'brand', 'readonly', 'promise']);
const OPTIONALITY = new Set(['optional', 'nullish', 'default']);
const WRAPPERS = new Set(['describe', 'nullable', ...OPTIONALITY]);
const SIGNS: readonly NumberSign[] = ['positive', 'negative', 'nonnegative', 'nonpositive'];
const CHECK_KEYS = Object.keys(FIELD_CHECKS).filter((key): key is FieldCheckKey => Object.hasOwn(FIELD_CHECKS, key));

/** A chain's settings: what its methods state, whatever else it holds. */
export function readChain(chain: Chain): ChainSettings {
  const checks: Record<string, unknown> = {};
  const dated = chain.kind === 'date';
  for (const step of chain.steps) {
    Object.assign(checks, stepChecks(step, { dated }));
  }
  const image = chain.steps.find(isSizeRefine);
  Object.assign(checks, image === undefined ? {} : (imageChecks(image) ?? {}));
  const defaulted = chain.steps.find((step) => step.name === 'default');
  const settings = {
    description: stringOf(chain.steps.find((step) => step.name === 'describe')?.args[0]),
    required: !chain.steps.some((step) => OPTIONALITY.has(step.name)),
    checks: fromRecord(checks),
    options: chain.kind === 'option' && ts.isCallExpression(chain.baseNode) ? enumOptions(chain.baseNode) : undefined,
    defaultValue: defaulted === undefined ? undefined : literalOf(defaulted.args[0]),
  };
  assert(settings.defaultValue === undefined || !settings.required, 'A default makes a field optional');
  return settings;
}

// What one method says, as checks; a method the settings do not own says nothing.
function stepChecks(step: ChainStep, options: { readonly dated: boolean }): Record<string, unknown> {
  const first = step.args[0];
  const number = numberOf(first);
  switch (step.name) {
    case 'min':
    case 'gte':
      return options.dated ? { minDate: dateOf(first) } : { min: number };
    case 'max':
    case 'lte':
      return options.dated ? { maxDate: dateOf(first) } : { max: number };
    case 'length':
    case 'gt':
    case 'lt':
      return { [step.name]: number };
    case 'multipleOf':
    case 'step':
      return { multipleOf: number };
    case 'int':
      return { integer: true };
    case 'regex':
      return {
        pattern: first !== undefined && ts.isRegularExpressionLiteral(first) ? patternOf(first.text) : undefined,
      };
    case 'startsWith':
    case 'endsWith':
    case 'includes':
      return { [step.name]: stringOf(first) };
    case 'trim':
      return { trim: true };
    case 'toLowerCase':
    case 'toUpperCase':
      return { letterCase: step.name === 'toLowerCase' ? 'lower' : 'upper' };
    case 'nullable':
      return { nullable: true };
    default:
      return SIGNS.some((sign) => sign === step.name) ? { sign: step.name } : {};
  }
}

/**
 * The chain with only what `settings` change from what it states rewritten. A
 * changed check replaces its own method and keeps that method's other
 * arguments (a message, a pattern's flags); a new one goes in among the
 * checks, before any transform or refine; a cleared one is removed. Every
 * other step — a transform, a refine, a method the settings do not own, an
 * argument they cannot read — stays as written and where it was, so a schema
 * written by hand comes back as it was apart from what the form changed.
 */
export function writeChain(chain: Chain, settings: FieldSettings): string {
  const before = readChain(chain);
  const count = chain.steps.length;
  const texts = chain.steps.map((step) => step.text);
  const inserted: string[][] = Array.from({ length: count + 1 }, () => []);
  const at = { checks: checkPoint(chain.steps), wrappers: wrapperPoint(chain.steps) };
  assert(at.checks <= at.wrappers, 'Checks go in before the trailing optionality');
  // The first step stating a setting takes its new text; the others stating it go.
  const edit = (indexes: readonly number[], text: string | undefined, position: number) => {
    const first = indexes[0];
    if (first === undefined) {
      if (text !== undefined) {
        inserted[position]?.push(text);
      }
      return;
    }
    texts[first] = text ?? '';
    for (const index of indexes.slice(1)) {
      texts[index] = '';
    }
  };
  const dated = chain.kind === 'date';
  const changed = changedChecks(before.checks, settings.checks);
  const editCheck = (key: FieldCheckKey, position: number) => {
    const indexes = chain.steps.flatMap((step, index) => (stepKey(step, { dated }) === key ? [index] : []));
    const existing = indexes[0] === undefined ? undefined : chain.steps[indexes[0]];
    edit(indexes, checkText(key, settings.checks, existing), position);
  };
  // New methods go in the order a chain is read: checks, help text, `.nullable()`.
  for (const key of changed.filter((each) => each !== 'nullable')) {
    editCheck(key, at.checks);
  }
  if (IMAGE_BOUNDS.some(([key]) => before.checks[key] !== settings.checks[key])) {
    const indexes = chain.steps.flatMap((step, index) => (isSizeRefine(step) ? [index] : []));
    edit(indexes, imageRefine(settings.checks)[0], at.checks);
  }
  if (before.description !== settings.description) {
    const text = settings.description === undefined ? undefined : `.describe(${JSON.stringify(settings.description)})`;
    edit(stepsNamed(chain.steps, ['describe']), text, at.wrappers);
  }
  if (changed.includes('nullable')) {
    editCheck('nullable', at.wrappers);
  }
  if (before.required !== settings.required || before.defaultValue !== settings.defaultValue) {
    const optionality = optionalityEdit(chain.steps, settings);
    edit(optionality.indexes, optionality.text, count);
  }
  const base = baseText(chain, before.options, settings.options);
  const text = base + texts.map((step, index) => (inserted[index] ?? []).join('') + step).join('') + (inserted[count] ?? []).join('');
  assert(text.startsWith(base), 'A field keeps its base type');
  return text;
}

// An option field's base lists its values; any other base stays as written.
function baseText(chain: Chain, before: readonly string[] | undefined, after: readonly string[] | undefined): string {
  if (chain.kind !== 'option' || after === undefined) {
    return chain.base;
  }
  const same = before !== undefined && before.join('\n') === after.join('\n');
  return same ? chain.base : `z.enum([${after.map((option) => JSON.stringify(option)).join(', ')}])`;
}

// The steps to rewrite for the field's optionality, and the one method that says it.
function optionalityEdit(steps: readonly ChainStep[], settings: FieldSettings): { readonly indexes: readonly number[]; readonly text: string | undefined } {
  const optionality = stepsNamed(steps, [...OPTIONALITY]);
  if (settings.defaultValue !== undefined) {
    return { indexes: optionality, text: `.default(${JSON.stringify(settings.defaultValue)})` };
  }
  if (settings.required) {
    return { indexes: optionality, text: undefined };
  }
  // An `.optional()` or `.nullish()` already says it; only a default is taken away.
  const optional = stepsNamed(steps, ['optional', 'nullish']).length > 0;
  return {
    indexes: stepsNamed(steps, ['default']),
    text: optional ? undefined : '.optional()',
  };
}

// The checks whose value the settings change, in the order the settings list them.
function changedChecks(before: FieldChecks, after: FieldChecks): FieldCheckKey[] {
  const image = new Set<FieldCheckKey>(IMAGE_BOUNDS.map(([key]) => key));
  return CHECK_KEYS.filter((key) => !image.has(key) && stated(before[key]) !== stated(after[key]));
}

// A flag turned off is the same as one never set.
function stated(value: FieldChecks[FieldCheckKey]): FieldChecks[FieldCheckKey] {
  return value === false ? undefined : value;
}

// The method that states `key`, keeping what the method it replaces said beside the value.
function checkText(key: FieldCheckKey, checks: FieldChecks, existing: ChainStep | undefined): string | undefined {
  const value = stated(checks[key]);
  if (value === undefined) {
    return undefined;
  }
  const rest = (existing?.args.slice(1) ?? []).map((arg) => `, ${arg.getText()}`).join('');
  const name = existing?.name;
  const kind = FIELD_CHECKS[key];
  assert(CHECK_METHOD[key] !== 'refine', 'An image size is written as one refine, not here');
  switch (kind) {
    case 'number':
      return `.${name ?? CHECK_METHOD[key]}(${String(value)}${rest})`;
    case 'flag':
      return `.${CHECK_METHOD[key]}()`;
    case 'sign':
      return `.${String(value)}()`;
    case 'case':
      return value === 'lower' ? '.toLowerCase()' : '.toUpperCase()';
    case 'date':
      return `.${name ?? CHECK_METHOD[key]}(new Date(${JSON.stringify(value)})${rest})`;
    case 'text':
      return key === 'pattern' ? `.regex(/${String(value)}/${flagsOf(existing)}${rest})` : `.${CHECK_METHOD[key]}(${JSON.stringify(value)}${rest})`;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** The method each check is written as when no step states it yet. */
const CHECK_METHOD: Readonly<Record<FieldCheckKey, string>> = {
  min: 'min',
  max: 'max',
  length: 'length',
  gt: 'gt',
  lt: 'lt',
  multipleOf: 'multipleOf',
  integer: 'int',
  sign: 'positive',
  pattern: 'regex',
  startsWith: 'startsWith',
  endsWith: 'endsWith',
  includes: 'includes',
  trim: 'trim',
  letterCase: 'toLowerCase',
  minDate: 'min',
  maxDate: 'max',
  minWidth: 'refine',
  maxWidth: 'refine',
  minHeight: 'refine',
  maxHeight: 'refine',
  nullable: 'nullable',
};

// The check a step states, whether or not its value can be read.
function stepKey(step: ChainStep, options: { readonly dated: boolean }): FieldCheckKey | undefined {
  switch (step.name) {
    case 'min':
    case 'gte':
      return options.dated ? 'minDate' : 'min';
    case 'max':
    case 'lte':
      return options.dated ? 'maxDate' : 'max';
    case 'multipleOf':
    case 'step':
      return 'multipleOf';
    case 'int':
      return 'integer';
    case 'regex':
      return 'pattern';
    case 'toLowerCase':
    case 'toUpperCase':
      return 'letterCase';
    case 'length':
    case 'gt':
    case 'lt':
    case 'startsWith':
    case 'endsWith':
    case 'includes':
    case 'trim':
    case 'nullable':
      return step.name;
    default:
      return SIGNS.some((sign) => sign === step.name) ? 'sign' : undefined;
  }
}

// A pattern's flags as written (`/x/i` → `i`), kept when only the pattern changes.
function flagsOf(step: ChainStep | undefined): string {
  const first = step?.args[0];
  if (first === undefined || !ts.isRegularExpressionLiteral(first)) {
    return '';
  }
  return first.text.slice(first.text.lastIndexOf('/') + 1);
}

function stepsNamed(steps: readonly ChainStep[], names: readonly string[]): number[] {
  return steps.flatMap((step, index) => (names.includes(step.name) ? [index] : []));
}

// Where a new check goes: before the first step that changes what the schema
// is (a transform, a refine, a union), and before the optionality just ahead
// of it, so it still checks the base type's own value.
function checkPoint(steps: readonly ChainStep[]): number {
  const structural = steps.findIndex((step) => STRUCTURAL.has(step.name) && !isSizeRefine(step));
  let point = structural === -1 ? steps.length : structural;
  for (let guard = 0; guard < steps.length && point > 0; guard += 1) {
    if (!WRAPPERS.has(steps[point - 1]?.name ?? '')) {
      break;
    }
    point -= 1;
  }
  assert(point >= 0, 'A check goes in within the chain');
  return point;
}

// Where new help text and `.nullable()` go: before the optionality that ends the chain.
function wrapperPoint(steps: readonly ChainStep[]): number {
  let point = steps.length;
  for (let guard = 0; guard < steps.length && point > 0; guard += 1) {
    if (!OPTIONALITY.has(steps[point - 1]?.name ?? '')) {
      break;
    }
    point -= 1;
  }
  assert(point <= steps.length, 'Help text goes in within the chain');
  return point;
}

const IMAGE_BOUNDS: readonly (readonly [FieldCheckKey, 'width' | 'height', '>=' | '<='])[] = [
  ['minWidth', 'width', '>='],
  ['maxWidth', 'width', '<='],
  ['minHeight', 'height', '>='],
  ['maxHeight', 'height', '<='],
];

// An image's size range as one refine, in the form `imageChecks` reads back.
function imageRefine(checks: FieldChecks): string[] {
  const conditions = IMAGE_BOUNDS.flatMap(([key, side, operator]) => {
    const value = checks[key];
    return typeof value === 'number' ? [`image.${side} ${operator} ${value}`] : [];
  });
  if (conditions.length === 0) {
    return [];
  }
  const message = JSON.stringify('The image is outside the allowed size.');
  return [`.refine((image) => ${conditions.join(' && ')}, { message: ${message} })`];
}

// The size refine this module writes and reads; any other refine is the author's own.
function isSizeRefine(step: ChainStep): boolean {
  return isImageRefine(step) && imageChecks(step) !== undefined;
}

function isImageRefine(step: ChainStep): boolean {
  const first = step.args[0];
  return step.name === 'refine' && first !== undefined && ts.isArrowFunction(first) && /\bimage\.(width|height)\b/.test(first.getText());
}

// `(image) => image.width >= 800 && image.height <= 2000` as size checks, or
// undefined when the refine says anything else.
function imageChecks(step: ChainStep): Record<string, number> | undefined {
  const arrow = step.args[0];
  if (arrow === undefined || !ts.isArrowFunction(arrow) || ts.isBlock(arrow.body)) {
    return undefined;
  }
  const parameter = arrow.parameters[0]?.name;
  const name = parameter !== undefined && ts.isIdentifier(parameter) ? parameter.text : undefined;
  const parts: ts.Expression[] = [];
  const pending: ts.Expression[] = [arrow.body];
  for (let visited = 0; pending.length > 0 && visited < 16; visited += 1) {
    const node = pending.pop();
    if (node !== undefined && ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      pending.push(node.right, node.left);
    } else if (node !== undefined) {
      parts.push(node);
    }
  }
  const checks: Record<string, number> = {};
  for (const part of parts) {
    const bound = sizeBound(part, name);
    if (bound === undefined) {
      return undefined;
    }
    checks[bound.key] = bound.value;
  }
  return checks;
}

function sizeBound(part: ts.Expression, name: string | undefined): { readonly key: FieldCheckKey; readonly value: number } | undefined {
  if (!ts.isBinaryExpression(part) || !ts.isPropertyAccessExpression(part.left) || part.left.expression.getText() !== name) {
    return undefined;
  }
  const operator =
    part.operatorToken.kind === ts.SyntaxKind.GreaterThanEqualsToken ? '>=' : part.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken ? '<=' : undefined;
  const value = numberOf(part.right);
  const found = IMAGE_BOUNDS.find(([, side, bound]) => side === part.left.getText().split('.').pop() && bound === operator);
  return found === undefined || value === undefined ? undefined : { key: found[0], value };
}

function enumOptions(base: ts.CallExpression): readonly string[] | undefined {
  const list = base.arguments[0];
  if (list === undefined || !ts.isArrayLiteralExpression(list)) {
    return undefined;
  }
  const values = list.elements.map((element) => stringOf(element));
  return values.every((value) => value !== undefined) ? values.filter((value) => value !== undefined) : undefined;
}

function stringOf(node: ts.Expression | undefined): string | undefined {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function numberOf(node: ts.Expression | undefined): number | undefined {
  if (node === undefined) {
    return undefined;
  }
  if (ts.isNumericLiteral(node)) {
    return Number(node.text);
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
    return -Number(node.operand.text);
  }
  return undefined;
}

// `new Date("2024-01-01")` as its day.
function dateOf(node: ts.Expression | undefined): string | undefined {
  if (node === undefined || !ts.isNewExpression(node) || node.expression.getText() !== 'Date') {
    return undefined;
  }
  const value = stringOf(node.arguments?.[0]);
  return value !== undefined && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : undefined;
}

function literalOf(node: ts.Expression | undefined): FieldDefault | undefined {
  if (node === undefined) {
    return undefined;
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
    return node.kind === ts.SyntaxKind.TrueKeyword;
  }
  return stringOf(node) ?? numberOf(node);
}

// `/^[a-z]+$/i` → its source, `^[a-z]+$`; flags are not kept by the settings.
function patternOf(literal: string): string | undefined {
  const end = literal.lastIndexOf('/');
  return end > 0 ? literal.slice(1, end) : undefined;
}

// Values known to match their keys' kinds (stepChecks, imageChecks); undefined ones dropped.
function fromRecord(checks: Record<string, unknown>): FieldChecks {
  return Object.fromEntries(Object.entries(checks).filter(([, value]) => value !== undefined));
}
