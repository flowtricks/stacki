// A field's zod chain, read as settings and written back from them: its checks
// (fieldChecks.ts), an option field's values, its default, help text and
// whether it is required. The methods it owns are rewritten in a fixed order;
// every other method on the chain (`.email()`, `.url()`) is kept as written,
// right after the base type. An image's width and height range is the refine
// Astro's docs show (`image().refine((image) => image.width >= 800)`), written
// and read in one form; any other refine or transform leaves the field as it
// is written, read-only to the form.

import ts from 'typescript';

import { assert } from '../../shared/core/assert';
import type { FieldUpdate, SettingsFieldKind } from '../../shared/properties/collectionSettings';
import type {
  FieldCheckKey,
  FieldChecks,
  FieldDefault,
  LetterCase,
  NumberSign,
} from '../../shared/properties/fieldChecks';

export interface ChainStep {
  readonly name: string;
  readonly text: string;
  readonly args: readonly ts.Expression[];
}

export interface Chain {
  readonly base: string;
  readonly baseNode: ts.CallExpression;
  readonly kind: SettingsFieldKind;
  readonly steps: readonly ChainStep[];
}

export interface ChainSettings {
  readonly description: string | undefined;
  readonly required: boolean;
  readonly checks: FieldChecks;
  readonly options: readonly string[] | undefined;
  readonly defaultValue: FieldDefault | undefined;
  readonly editable: boolean;
}

/** The methods the settings own, rewritten from them; any other is kept as written. */
const OWNED = new Set([
  'min',
  'max',
  'length',
  'gt',
  'lt',
  'gte',
  'lte',
  'multipleOf',
  'step',
  'int',
  'positive',
  'negative',
  'nonnegative',
  'nonpositive',
  'regex',
  'startsWith',
  'endsWith',
  'includes',
  'trim',
  'toLowerCase',
  'toUpperCase',
  'nullable',
  'describe',
  'optional',
  'nullish',
  'default',
]);
const UNREADABLE = new Set(['transform', 'refine', 'superRefine', 'pipe', 'or', 'and', 'catch']);
const OPTIONALITY = new Set(['optional', 'nullish', 'default']);
const SIGNS: readonly NumberSign[] = ['positive', 'negative', 'nonnegative', 'nonpositive'];

/** A chain's settings, and whether every method on it is one a form can rewrite. */
export function readChain(chain: Chain): ChainSettings {
  const checks: Record<string, unknown> = {};
  const dated = chain.kind === 'date';
  for (const step of chain.steps) {
    Object.assign(checks, stepChecks(step, { dated }));
  }
  const image = chain.steps.find(isImageRefine);
  Object.assign(checks, image === undefined ? {} : (imageChecks(image) ?? {}));
  const editable = !chain.steps.some(
    (step) =>
      UNREADABLE.has(step.name) && !(isImageRefine(step) && imageChecks(step) !== undefined),
  );
  const defaulted = chain.steps.find((step) => step.name === 'default');
  return {
    description: stringOf(chain.steps.find((step) => step.name === 'describe')?.args[0]),
    required: !chain.steps.some((step) => OPTIONALITY.has(step.name)),
    checks: fromRecord(checks),
    options: chain.kind === 'option' ? enumOptions(chain.baseNode) : undefined,
    defaultValue: defaulted === undefined ? undefined : literalOf(defaulted.args[0]),
    editable,
  };
}

// What one method says, as checks; a method the settings do not own says nothing.
function stepChecks(
  step: ChainStep,
  options: { readonly dated: boolean },
): Record<string, unknown> {
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
        pattern:
          first !== undefined && ts.isRegularExpressionLiteral(first)
            ? patternOf(first.text)
            : undefined,
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

/** The chain written from `update`: its base, kept methods, then the settings in order. */
export function writeChain(chain: Chain, update: FieldUpdate): string {
  const base =
    chain.kind === 'option' && update.options !== undefined
      ? `z.enum([${update.options.map((option) => JSON.stringify(option)).join(', ')}])`
      : chain.base;
  const kept = chain.steps
    .filter((step) => !OWNED.has(step.name) && !isImageRefine(step))
    .map((step) => step.text);
  const optionality =
    update.defaultValue !== undefined
      ? [`.default(${JSON.stringify(update.defaultValue)})`]
      : update.required
        ? []
        : ['.optional()'];
  const text = [
    base,
    ...kept,
    ...checkMethods(update.checks, { dated: chain.kind === 'date' }),
    ...imageRefine(update.checks),
    ...(update.description === undefined
      ? []
      : [`.describe(${JSON.stringify(update.description)})`]),
    ...(update.checks.nullable === true ? ['.nullable()'] : []),
    ...optionality,
  ].join('');
  assert(text.startsWith(base), 'A field keeps its base type');
  return text;
}

// The settings' own methods, in one order: ranges, then number rules, then text rules.
function checkMethods(checks: FieldChecks, options: { readonly dated: boolean }): string[] {
  const call = (name: string, value: string | number | undefined) =>
    value === undefined ? [] : [`.${name}(${typeof value === 'number' ? value : value})`];
  const date = (value: string | undefined) =>
    value === undefined ? undefined : `new Date(${JSON.stringify(value)})`;
  const quoted = (value: string | undefined) =>
    value === undefined ? undefined : JSON.stringify(value);
  return [
    ...(options.dated ? call('min', date(checks.minDate)) : call('min', checks.min)),
    ...(options.dated ? call('max', date(checks.maxDate)) : call('max', checks.max)),
    ...call('length', checks.length),
    ...call('gt', checks.gt),
    ...call('lt', checks.lt),
    ...(checks.integer === true ? ['.int()'] : []),
    ...(checks.sign === undefined ? [] : [`.${checks.sign}()`]),
    ...call('multipleOf', checks.multipleOf),
    ...(checks.pattern === undefined ? [] : [`.regex(/${checks.pattern}/)`]),
    ...call('startsWith', quoted(checks.startsWith)),
    ...call('endsWith', quoted(checks.endsWith)),
    ...call('includes', quoted(checks.includes)),
    ...(checks.trim === true ? ['.trim()'] : []),
    ...(checks.letterCase === undefined ? [] : [letterCaseMethod(checks.letterCase)]),
  ];
}

function letterCaseMethod(letterCase: LetterCase): string {
  return letterCase === 'lower' ? '.toLowerCase()' : '.toUpperCase()';
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

function isImageRefine(step: ChainStep): boolean {
  const first = step.args[0];
  return (
    step.name === 'refine' &&
    first !== undefined &&
    ts.isArrowFunction(first) &&
    /\bimage\.(width|height)\b/.test(first.getText())
  );
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
    if (
      node !== undefined &&
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
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

function sizeBound(
  part: ts.Expression,
  name: string | undefined,
): { readonly key: FieldCheckKey; readonly value: number } | undefined {
  if (
    !ts.isBinaryExpression(part) ||
    !ts.isPropertyAccessExpression(part.left) ||
    part.left.expression.getText() !== name
  ) {
    return undefined;
  }
  const operator =
    part.operatorToken.kind === ts.SyntaxKind.GreaterThanEqualsToken
      ? '>='
      : part.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken
        ? '<='
        : undefined;
  const value = numberOf(part.right);
  const found = IMAGE_BOUNDS.find(
    ([, side, bound]) => side === part.left.getText().split('.').pop() && bound === operator,
  );
  return found === undefined || value === undefined ? undefined : { key: found[0], value };
}

function enumOptions(base: ts.CallExpression): readonly string[] | undefined {
  const list = base.arguments[0];
  if (list === undefined || !ts.isArrayLiteralExpression(list)) {
    return undefined;
  }
  const values = list.elements.map((element) => stringOf(element));
  return values.every((value) => value !== undefined)
    ? values.filter((value) => value !== undefined)
    : undefined;
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
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
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
