// A conditional value: a field that takes one of several values depending on
// the component's props, written into the .astro file as the plain expression
// the site runs, with no runtime helper:
//
//   theme === 'dark' && paddingTop !== 'small' ? 'value1' : theme === 'light' ? 'value2' : 'value3'
//
// The model is groups of conditions, each group with the value it gives, and
// the value given when no group holds (`otherwise`, the Else). A group's
// conditions are all joined by `&&` (match `all`) or all by `||` (`any`);
// groups are tried in order, which is a chain of ternaries, nested only in
// the else branch. A condition compares a prop with literal values
// (`theme === 'dark'`, `['dark', 'light'].includes(theme)`, and their
// negations) or tests it on its own (`shown`, `!shown`).
//
// The expression is read back into the model only when it says exactly what a
// model can say (readConditionalExpression). Reading ignores what carries no
// meaning (spacing, line breaks, quote style, redundant parentheses), so a
// file Prettier formatted still reads; writing is single-line, single-quoted
// and parenthesised as Prettier parenthesises, so Prettier leaves it as it is.
//
// Two readings, one reader. The plain reading (Default value, Visibility,
// inline style branches) takes only what those writers can write back: a
// chain of prop tests giving words, a name in scope, a template or nothing.
// The rich reading (an attribute's value) takes every ternary chain an author
// writes, and keeps the parts it cannot draw as locked code, byte for byte,
// rather than turning the whole attribute back into code:
//
//   aria-label={isWritten ? undefined : (label ?? named[variant])}
//
// is one group (If Is Written is set ↳ left out) and an Else that is the first
// set of `label` and the `named` entry for `variant`. A test the condition
// rows cannot show (`index >= PAGE_SIZE`, `a && b` inside an `||`) is a code
// condition; a branch the value field cannot show (`0`, `slug(label)`) is
// computed code; a ternary in a branch is flattened into groups. Code the
// reader cannot delimit (a regular expression, an escape it does not know)
// stays code: the field shows it under Computed (isConditionalShaped).

import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import { toArray, toRecord } from '../../shared/core/record';
import { err, ok, type Result } from '../../shared/core/result';
import type { Attr } from '../../shared/page/pageNode';

/** The bounds of a conditional value, checked where a model is made and where code is read. */
export const CONDITIONAL_LIMITS = {
  groupsMax: 16,
  conditionsPerGroupMax: 16,
  valuesPerConditionMax: 32,
  referenceCharsMax: 200,
  // Every token of the longest expression the bounds above allow fits well inside this.
  tokensMax: 4_096,
  // Parentheses around one test or clause: more than this is code no person wrote for the UI.
  parenthesesDepthMax: 8,
  templatePartsMax: 64,
  // `a ?? b ?? c`: more than this is code no person wrote for one field.
  fallbackOperandsMax: 8,
  // A ternary in a branch of a ternary, flattened into groups: deeper is code.
  nestingDepthMax: 8,
} as const satisfies Record<string, number>;

export const GROUP_MATCHES = ['all', 'any'] as const;
export type GroupMatch = (typeof GROUP_MATCHES)[number];

export const COMPARE_OPERATORS = ['in', 'notIn'] as const;
export type CompareOperator = (typeof COMPARE_OPERATORS)[number];

export const TEST_OPERATORS = ['truthy', 'falsy'] as const;
export type TestOperator = (typeof TEST_OPERATORS)[number];

/** A literal a prop is compared with. */
export type ConditionLiteral = { readonly kind: 'string'; readonly value: string } | { readonly kind: 'number'; readonly value: number };

/**
 * One condition on a prop. `in` holds when the prop equals any of `values`,
 * `notIn` when it equals none; `truthy` and `falsy` test the prop itself (a
 * switch that is on, a text that is set). `code` is a test the rows cannot
 * show (`index >= PAGE_SIZE`), kept as written and shown locked.
 */
export type Condition =
  | { readonly kind: 'compare'; readonly subject: string; readonly operator: CompareOperator; readonly values: readonly ConditionLiteral[] }
  | { readonly kind: 'test'; readonly subject: string; readonly operator: TestOperator }
  | { readonly kind: 'code'; readonly code: string };

/** A condition on a prop the rows can draw: every condition but locked code. */
export type PropCondition = Exclude<Condition, { readonly kind: 'code' }>;

/** A run of a template branch: its words, or the value a name in scope holds, written `${name}`. */
export type TemplatePart = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'reference'; readonly path: string };

/** How "no value" is spelled: kept, so code that wrote `null` reads back as it was written. */
export const NO_VALUE_WORDS = ['undefined', 'null'] as const;
export type NoValueWord = (typeof NO_VALUE_WORDS)[number];

export const FALLBACK_OPERATORS = ['??', '||'] as const;
export type FallbackOperator = (typeof FALLBACK_OPERATORS)[number];

/**
 * One value a branch can give: words; the value a prop (or another name in
 * scope) holds; words with values in them (a template, `--_mw: ${maxWidth}ch;`);
 * no value at all (`undefined`), which leaves the attribute out; the entry of
 * a table a prop picks (`named[variant]`); or code the field shows locked
 * (`0`, `slug(label)`), written back exactly as it was read.
 */
export type ValueResult =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'reference'; readonly path: string }
  | { readonly kind: 'template'; readonly parts: readonly TemplatePart[] }
  | { readonly kind: 'none'; readonly word: NoValueWord }
  | { readonly kind: 'lookup'; readonly table: string; readonly key: string }
  | { readonly kind: 'computed'; readonly code: string };

/** What a branch gives: one value, or the first of several that is set (`label ?? named[variant]`). */
export type ConditionalResult = ValueResult | { readonly kind: 'fallback'; readonly operator: FallbackOperator; readonly operands: readonly ValueResult[] };

/** The results the plain reading holds: the ones every writer of a model can write back. */
export type PlainResult = Extract<ConditionalResult, { readonly kind: 'text' | 'reference' | 'template' | 'none' }>;

/** Whether `result` is one the plain reading holds. */
export function isPlainResult(result: ConditionalResult): result is PlainResult {
  return result.kind === 'text' || result.kind === 'reference' || result.kind === 'template' || result.kind === 'none';
}

/** Whether every part of `model` is one the plain reading holds: no locked code, no lookup, no fallback. */
export function isPlainModel(model: ConditionalValue): boolean {
  if (!isPlainResult(model.otherwise)) {
    return false;
  }
  return model.groups.every((group) => isPlainResult(group.value) && group.conditions.every((condition) => condition.kind !== 'code'));
}

export interface ConditionGroup {
  readonly match: GroupMatch;
  readonly conditions: readonly Condition[];
  readonly value: ConditionalResult;
}

export interface ConditionalValue {
  readonly groups: readonly ConditionGroup[];
  readonly otherwise: ConditionalResult;
}

// ---------------------------------------------------------------------------
// The model's parser: the one way a model is made from data, so every model
// in the app holds the bounds and invariants below.
// ---------------------------------------------------------------------------

/** A conditional value from `input`, or why it is not one. */
export function parseConditionalValue(input: unknown): Result<ConditionalValue, string> {
  const record = toRecord(input);
  if (record === undefined) {
    return err('Conditional: expected an object');
  }
  const groupsInput = toArray(record['groups']);
  if (groupsInput === undefined) {
    return err('Conditional.groups: expected an array');
  }
  if (groupsInput.length > CONDITIONAL_LIMITS.groupsMax) {
    return err(`Conditional.groups: more than ${CONDITIONAL_LIMITS.groupsMax}`);
  }
  const groups: ConditionGroup[] = [];
  for (const [index, entry] of groupsInput.entries()) {
    const group = parseGroup(entry, `Conditional.groups[${index}]`);
    if (!group.ok) {
      return group;
    }
    groups.push(group.value);
  }
  const otherwise = parseResult(record['otherwise'], 'Conditional.otherwise');
  if (!otherwise.ok) {
    return otherwise;
  }
  assert(groups.length === groupsInput.length, 'parseConditionalValue: every group is kept');
  return ok({ groups, otherwise: otherwise.value });
}

function parseGroup(input: unknown, where: string): Result<ConditionGroup, string> {
  const record = toRecord(input);
  if (record === undefined) {
    return err(`${where}: expected an object`);
  }
  const match = record['match'];
  if (match !== 'all' && match !== 'any') {
    return err(`${where}.match: expected all or any`);
  }
  const conditionsInput = toArray(record['conditions']);
  if (conditionsInput === undefined) {
    return err(`${where}.conditions: expected an array`);
  }
  if (conditionsInput.length === 0) {
    return err(`${where}.conditions: a group has at least one condition`);
  }
  if (conditionsInput.length > CONDITIONAL_LIMITS.conditionsPerGroupMax) {
    return err(`${where}.conditions: more than ${CONDITIONAL_LIMITS.conditionsPerGroupMax}`);
  }
  const conditions: Condition[] = [];
  for (const [index, entry] of conditionsInput.entries()) {
    const condition = parseCondition(entry, `${where}.conditions[${index}]`);
    if (!condition.ok) {
      return condition;
    }
    conditions.push(condition.value);
  }
  const value = parseResult(record['value'], `${where}.value`);
  if (!value.ok) {
    return value;
  }
  return ok({ match, conditions, value: value.value });
}

function parseCondition(input: unknown, where: string): Result<Condition, string> {
  const record = toRecord(input);
  if (record === undefined) {
    return err(`${where}: expected an object`);
  }
  if (record['kind'] === 'code') {
    const code = record['code'];
    if (typeof code !== 'string' || !isCodeText(code)) {
      return err(`${where}.code: expected one expression`);
    }
    return ok({ kind: 'code', code });
  }
  const subject = record['subject'];
  if (typeof subject !== 'string' || !isReferencePath(subject)) {
    return err(`${where}.subject: expected a name in scope`);
  }
  const operator = record['operator'];
  if (record['kind'] === 'test') {
    if (operator !== 'truthy' && operator !== 'falsy') {
      return err(`${where}.operator: expected truthy or falsy`);
    }
    return ok({ kind: 'test', subject, operator });
  }
  if (record['kind'] !== 'compare') {
    return err(`${where}.kind: expected compare, test or code`);
  }
  if (operator !== 'in' && operator !== 'notIn') {
    return err(`${where}.operator: expected in or notIn`);
  }
  const valuesInput = toArray(record['values']);
  if (valuesInput === undefined) {
    return err(`${where}.values: expected an array`);
  }
  if (valuesInput.length === 0) {
    return err(`${where}.values: a comparison has at least one value`);
  }
  if (valuesInput.length > CONDITIONAL_LIMITS.valuesPerConditionMax) {
    return err(`${where}.values: more than ${CONDITIONAL_LIMITS.valuesPerConditionMax}`);
  }
  const values: ConditionLiteral[] = [];
  for (const [index, entry] of valuesInput.entries()) {
    const literal = parseLiteral(entry, `${where}.values[${index}]`);
    if (!literal.ok) {
      return literal;
    }
    if (values.some((value) => sameLiteral(value, literal.value))) {
      return err(`${where}.values[${index}]: listed twice`);
    }
    values.push(literal.value);
  }
  return ok({ kind: 'compare', subject, operator, values });
}

function parseLiteral(input: unknown, where: string): Result<ConditionLiteral, string> {
  const record = toRecord(input);
  if (record === undefined) {
    return err(`${where}: expected an object`);
  }
  const value = record['value'];
  if (record['kind'] === 'string') {
    if (typeof value !== 'string') {
      return err(`${where}.value: expected a string`);
    }
    if (value.length > LIMITS.attrCharsMax) {
      return err(`${where}.value: exceeds ${LIMITS.attrCharsMax} characters`);
    }
    return ok({ kind: 'string', value });
  }
  if (record['kind'] === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return err(`${where}.value: expected a finite number`);
    }
    return ok({ kind: 'number', value });
  }
  return err(`${where}.kind: expected string or number`);
}

function parseResult(input: unknown, where: string): Result<ConditionalResult, string> {
  const record = toRecord(input);
  if (record === undefined) {
    return err(`${where}: expected an object`);
  }
  if (record['kind'] !== 'fallback') {
    return parseValueResult(record, where);
  }
  const operator = record['operator'];
  if (operator !== '??' && operator !== '||') {
    return err(`${where}.operator: expected ?? or ||`);
  }
  const operandsInput = toArray(record['operands']);
  if (operandsInput === undefined) {
    return err(`${where}.operands: expected an array`);
  }
  if (operandsInput.length < 2) {
    return err(`${where}.operands: a fallback has at least two values`);
  }
  if (operandsInput.length > CONDITIONAL_LIMITS.fallbackOperandsMax) {
    return err(`${where}.operands: more than ${CONDITIONAL_LIMITS.fallbackOperandsMax}`);
  }
  const operands: ValueResult[] = [];
  for (const [index, entry] of operandsInput.entries()) {
    const operandRecord = toRecord(entry);
    if (operandRecord === undefined) {
      return err(`${where}.operands[${index}]: expected an object`);
    }
    const operand = parseValueResult(operandRecord, `${where}.operands[${index}]`);
    if (!operand.ok) {
      return operand;
    }
    operands.push(operand.value);
  }
  assert(operands.length === operandsInput.length, 'parseResult: every operand is kept');
  return ok({ kind: 'fallback', operator, operands });
}

function parseValueResult(record: Readonly<Record<string, unknown>>, where: string): Result<ValueResult, string> {
  switch (record['kind']) {
    case 'text': {
      const text = record['text'];
      if (typeof text !== 'string') {
        return err(`${where}.text: expected a string`);
      }
      if (text.length > LIMITS.attrCharsMax) {
        return err(`${where}.text: exceeds ${LIMITS.attrCharsMax} characters`);
      }
      return ok({ kind: 'text', text });
    }
    case 'reference': {
      const path = record['path'];
      if (typeof path !== 'string' || !isReferencePath(path)) {
        return err(`${where}.path: expected a name in scope`);
      }
      return ok({ kind: 'reference', path });
    }
    case 'none': {
      const word = record['word'];
      if (word !== 'undefined' && word !== 'null') {
        return err(`${where}.word: expected undefined or null`);
      }
      return ok({ kind: 'none', word });
    }
    case 'template':
      return parseTemplate(record['parts'], `${where}.parts`);
    case 'lookup': {
      const table = record['table'];
      const key = record['key'];
      if (typeof table !== 'string' || !isReferencePath(table)) {
        return err(`${where}.table: expected a name in scope`);
      }
      if (typeof key !== 'string' || !isReferencePath(key)) {
        return err(`${where}.key: expected a name in scope`);
      }
      return ok({ kind: 'lookup', table, key });
    }
    case 'computed': {
      const code = record['code'];
      if (typeof code !== 'string' || !isCodeText(code)) {
        return err(`${where}.code: expected one expression`);
      }
      return ok({ kind: 'computed', code });
    }
    default:
      return err(`${where}.kind: expected text, reference, template, none, lookup, computed or fallback`);
  }
}

// A template's parts: words a template literal holds as they are (no
// backtick, backslash or `${`, which would be code), and names in scope,
// never two runs of words side by side (they are one run).
function parseTemplate(input: unknown, where: string): Result<ValueResult, string> {
  const partsInput = toArray(input);
  if (partsInput === undefined) {
    return err(`${where}: expected an array`);
  }
  if (partsInput.length > CONDITIONAL_LIMITS.templatePartsMax) {
    return err(`${where}: more than ${CONDITIONAL_LIMITS.templatePartsMax}`);
  }
  const parts: TemplatePart[] = [];
  let length = 0;
  for (const [index, entry] of partsInput.entries()) {
    const record = toRecord(entry);
    const at = `${where}[${index}]`;
    if (record === undefined) {
      return err(`${at}: expected an object`);
    }
    if (record['kind'] === 'reference') {
      const path = record['path'];
      if (typeof path !== 'string' || !isReferencePath(path)) {
        return err(`${at}.path: expected a name in scope`);
      }
      parts.push({ kind: 'reference', path });
      length += path.length + 3;
      continue;
    }
    if (record['kind'] !== 'text') {
      return err(`${at}.kind: expected text or reference`);
    }
    const text = record['text'];
    if (typeof text !== 'string' || text === '') {
      return err(`${at}.text: expected words`);
    }
    if (!isTemplateText(text)) {
      return err(`${at}.text: a backtick, a backslash or \${ is code`);
    }
    if (parts.at(-1)?.kind === 'text') {
      return err(`${at}: two runs of words side by side are one`);
    }
    parts.push({ kind: 'text', text });
    length += text.length;
  }
  if (length > LIMITS.attrCharsMax) {
    return err(`${where}: exceeds ${LIMITS.attrCharsMax} characters`);
  }
  return ok({ kind: 'template', parts });
}

/** Whether `text` can stand in a template literal as it is, with no escape. */
export function isTemplateText(text: string): boolean {
  return !text.includes('`') && !text.includes('\\') && !text.includes('${');
}

/**
 * Whether `code` is one expression the model can keep as locked code: not
 * empty, no space around it, balanced, and no top-level comma (which would
 * split the place it is written into).
 */
export function isCodeText(code: string): boolean {
  if (code.length === 0 || code.length > LIMITS.attrCharsMax || code.trim() !== code) {
    return false;
  }
  const source = codeSource(code);
  if (source === undefined || source.tokens.length === 0) {
    return false;
  }
  return !hasBase(source, 0, source.tokens.length, [',', ';']);
}

/** Whether two literals are the same value of the same kind. */
export function sameLiteral(left: ConditionLiteral, right: ConditionLiteral): boolean {
  return left.kind === right.kind && left.value === right.value;
}

// Words JavaScript gives a meaning of its own: `true` in a branch is a
// boolean, not a prop called true, so code naming one stays code.
const RESERVED_WORDS: ReadonlySet<string> = new Set([
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
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'Infinity',
  'let',
  'NaN',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'undefined',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Whether `path` names a value in scope as the model writes one: `theme`, `post.data.title`. */
export function isReferencePath(path: string): boolean {
  if (path.length === 0 || path.length > CONDITIONAL_LIMITS.referenceCharsMax) {
    return false;
  }
  const segments = path.split('.');
  const [first] = segments;
  if (first === undefined || RESERVED_WORDS.has(first)) {
    return false;
  }
  return segments.every((segment) => IDENTIFIER.test(segment));
}

// ---------------------------------------------------------------------------
// Writing.
// ---------------------------------------------------------------------------

/** The quote a file writes strings with, which the code written into it follows (Prettier's `singleQuote`). */
export type Quote = "'" | '"';

/** How code is written: in the quote the file around it already uses. */
export interface WriteOptions {
  readonly quote: Quote;
}

const SINGLE_QUOTES: WriteOptions = { quote: "'" };

/** The quote `code` writes its strings with, or undefined when it holds none. */
export function quoteOf(code: string): Quote | undefined {
  for (const character of code.slice(0, LIMITS.attrCharsMax)) {
    if (character === "'" || character === '"') {
      return character;
    }
  }
  return undefined;
}

/**
 * Where a value is written, which decides its parentheses: the whole
 * attribute, a ternary's branch, an operand of a fallback, or the class after
 * a class-list entry's conditions. Parentheses are written where JavaScript
 * needs them or Prettier writes them, so Prettier leaves the code alone.
 */
type Place = 'whole' | 'branch' | 'operand' | 'classValue';

/**
 * The expression for `model`: one ternary per group, chained through the else
 * branch, ending in the Else value. A model with no groups is its Else value.
 */
export function emitConditionalExpression(model: ConditionalValue, options: WriteOptions = SINGLE_QUOTES): string {
  assert(model.groups.length <= CONDITIONAL_LIMITS.groupsMax, 'emitConditionalExpression: the groups are bounded');
  let code = '';
  for (const group of model.groups) {
    code += `${groupCode(group, options)} ? ${resultCode(group.value, options, 'branch')} : `;
  }
  code += resultCode(model.otherwise, options, model.groups.length === 0 ? 'whole' : 'branch');
  assert(code.length > 0, 'emitConditionalExpression: an expression is never empty');
  return code;
}

/**
 * The attribute a conditional value is written as: the expression, or, with
 * no group left, the Else value on its own, as the field would have held it
 * before it was made conditional; undefined (the attribute left out) when
 * that value is No value.
 */
export function conditionalAttr(model: ConditionalValue, options: WriteOptions = SINGLE_QUOTES): Attr | undefined {
  if (model.groups.length > 0) {
    return { type: 'expr', value: emitConditionalExpression(model, options) };
  }
  const otherwise = model.otherwise;
  switch (otherwise.kind) {
    case 'text':
      return otherwise.text === '' ? { type: 'bare' } : { type: 'string', value: otherwise.text };
    case 'reference':
      return { type: 'expr', value: otherwise.path };
    case 'template':
    case 'lookup':
    case 'computed':
    case 'fallback':
      return { type: 'expr', value: resultCode(otherwise, options, 'whole') };
    case 'none':
      return undefined; // No value: the attribute is left out.
    default: {
      const exhaustive: never = otherwise;
      return exhaustive;
    }
  }
}

function groupCode(group: ConditionGroup, options: WriteOptions): string {
  assert(group.conditions.length > 0, 'groupCode: a group has a condition');
  assert(group.conditions.length <= CONDITIONAL_LIMITS.conditionsPerGroupMax, 'groupCode: the conditions are bounded');
  return conditionsCode(group.conditions, group.match, options);
}

// Conditions joined by `&&` or `||`; a code condition is parenthesised where
// it would otherwise bind to its neighbours, or where Prettier would add them.
function conditionsCode(conditions: readonly Condition[], match: GroupMatch, options: WriteOptions): string {
  const single = conditions.length === 1;
  const unsafe: readonly string[] = single ? ['?', '??', '=>'] : match === 'all' ? ['?', '??', '||', '=>'] : ['?', '??', '&&', '=>'];
  return conditions.map((condition) => conditionCode(condition, options, unsafe)).join(match === 'all' ? ' && ' : ' || ');
}

function conditionCode(condition: Condition, options: WriteOptions, unsafe: readonly string[]): string {
  switch (condition.kind) {
    case 'test':
      assert(isReferencePath(condition.subject), 'conditionCode: the subject is a name in scope');
      return condition.operator === 'truthy' ? condition.subject : `!${condition.subject}`;
    case 'compare': {
      assert(isReferencePath(condition.subject), 'conditionCode: the subject is a name in scope');
      const [only] = condition.values;
      assert(only !== undefined, 'conditionCode: a comparison has a value');
      if (condition.values.length === 1) {
        return `${condition.subject} ${condition.operator === 'in' ? '===' : '!=='} ${literalCode(only, options)}`;
      }
      const list = `[${condition.values.map((value) => literalCode(value, options)).join(', ')}].includes(${condition.subject})`;
      return condition.operator === 'in' ? list : `!${list}`;
    }
    case 'code':
      assert(isCodeText(condition.code), 'conditionCode: code is one expression');
      return guarded(condition.code, unsafe);
    default: {
      const exhaustive: never = condition;
      return exhaustive;
    }
  }
}

function literalCode(literal: ConditionLiteral, options: WriteOptions): string {
  switch (literal.kind) {
    case 'string':
      return quoted(literal.value, options.quote);
    case 'number':
      assert(Number.isFinite(literal.value), 'literalCode: a number literal is finite');
      // `-0` prints as `0`; every other finite number prints as a valid literal.
      return Object.is(literal.value, -0) ? '0' : String(literal.value);
    default: {
      const exhaustive: never = literal;
      return exhaustive;
    }
  }
}

function resultCode(result: ConditionalResult, options: WriteOptions, place: Place): string {
  if (result.kind !== 'fallback') {
    return valueCode(result, options, place);
  }
  assert(result.operands.length >= 2, 'resultCode: a fallback has two values');
  assert(result.operands.length <= CONDITIONAL_LIMITS.fallbackOperandsMax, 'resultCode: the operands are bounded');
  const code = result.operands.map((operand) => valueCode(operand, options, 'operand')).join(` ${result.operator} `);
  // `??` in a branch is parenthesised by Prettier; after `cond &&` either one needs them.
  const wrap = place === 'classValue' || (place === 'branch' && result.operator === '??');
  return wrap ? `(${code})` : code;
}

function valueCode(result: ValueResult, options: WriteOptions, place: Place): string {
  switch (result.kind) {
    case 'text':
      return quoted(result.text, options.quote);
    case 'reference':
      assert(isReferencePath(result.path), 'resultCode: a reference is a name in scope');
      return result.path;
    case 'template':
      return templateCode(result.parts);
    case 'none':
      return result.word;
    case 'lookup':
      assert(isReferencePath(result.table), 'valueCode: a table is a name in scope');
      assert(isReferencePath(result.key), 'valueCode: a key is a name in scope');
      return `${result.table}[${result.key}]`;
    case 'computed':
      assert(isCodeText(result.code), 'valueCode: computed code is one expression');
      return place === 'operand' || place === 'classValue' ? guarded(result.code, ['?', '??', '||', '&&', '=>']) : result.code;
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

// `code` in parentheses when an operator in `unsafe` stands at its top level,
// unless the parentheses are already there.
function guarded(code: string, unsafe: readonly string[]): string {
  const source = codeSource(code);
  assert(source !== undefined, 'guarded: locked code is balanced');
  const count = source.tokens.length;
  if (count === 0 || wrappedWhole(source)) {
    return code;
  }
  return hasBase(source, 0, count, unsafe) ? `(${code})` : code;
}

function templateCode(parts: readonly TemplatePart[]): string {
  assert(parts.length <= CONDITIONAL_LIMITS.templatePartsMax, 'templateCode: the parts are bounded');
  let out = '`';
  for (const part of parts) {
    if (part.kind === 'text') {
      assert(isTemplateText(part.text), 'templateCode: words need no escape');
      out += part.text;
    } else {
      assert(isReferencePath(part.path), 'templateCode: a value is a name in scope');
      out += `\${${part.path}}`;
    }
  }
  return `${out}\``;
}

// A string literal holding exactly `text`, quoted as Prettier quotes one: in
// the file's quote, unless the text holds more of those than of the other,
// when the other needs fewer escapes.
function quoted(text: string, preferred: Quote): string {
  const other: Quote = preferred === "'" ? '"' : "'";
  const preferredCount = text.split(preferred).length - 1;
  const otherCount = text.split(other).length - 1;
  const quote = preferredCount > otherCount ? other : preferred;
  let out = quote;
  for (const character of text) {
    out += character === quote ? `\\${quote}` : escaped(character);
  }
  out += quote;
  assert(out.length >= 2, 'quoted: a string literal has its quotes');
  return out;
}

// The escapes a string literal needs whichever quote it is in.
function escaped(character: string): string {
  switch (character) {
    case '\\':
      return '\\\\';
    case '\n':
      return '\\n';
    case '\r':
      return '\\r';
    case '\t':
      return '\\t';
    case '\u2028':
      return '\\u2028';
    case '\u2029':
      return '\\u2029';
    default:
      return character;
  }
}

// ---------------------------------------------------------------------------
// Tokens: the code cut into names, literals and punctuators, each with its
// place in the code, and the brackets matched, so any part can be sliced out
// exactly as it was written.
// ---------------------------------------------------------------------------

type TokenBody =
  | { readonly kind: 'name'; readonly text: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'template'; readonly parts: readonly TemplatePart[] }
  // A string or template the model does not write (an escape it does not know, a hole holding code): kept whole, as code.
  | { readonly kind: 'opaque'; readonly text: string }
  | { readonly kind: 'punctuator'; readonly text: string };

type Token = TokenBody & { readonly start: number; readonly end: number };

// Longest first, so `===` is never read as `==` and `=`.
const PUNCTUATORS = [
  '...',
  '===',
  '!==',
  '=>',
  '??',
  '?.',
  '&&',
  '||',
  '==',
  '!=',
  '<=',
  '>=',
  '**',
  '?',
  ':',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  ',',
  ';',
  '.',
  '!',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '=',
  '~',
  '&',
  '|',
  '^',
] as const;

const OPENERS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS: ReadonlySet<string> = new Set([')', ']', '}']);

/** The code, its tokens, the bracket depth before each token, and each opening bracket's closer. */
interface CodeSource {
  readonly code: string;
  readonly tokens: readonly Token[];
  readonly depths: readonly number[];
  readonly closers: ReadonlyMap<number, number>;
}

function codeSource(code: string): CodeSource | undefined {
  if (code.length > LIMITS.attrCharsMax) {
    return undefined;
  }
  const tokens = tokenize(code);
  if (tokens === undefined) {
    return undefined;
  }
  const depths: number[] = [];
  const closers = new Map<number, number>();
  const open: number[] = [];
  for (const [index, token] of tokens.entries()) {
    depths.push(open.length);
    if (token.kind !== 'punctuator') {
      continue;
    }
    if (OPENERS[token.text] !== undefined) {
      open.push(index);
    } else if (CLOSERS.has(token.text)) {
      const opener = open.pop();
      const openToken = opener === undefined ? undefined : tokens[opener];
      if (opener === undefined || openToken?.kind !== 'punctuator' || OPENERS[openToken.text] !== token.text) {
        return undefined;
      }
      closers.set(opener, index);
    }
  }
  if (open.length > 0) {
    return undefined;
  }
  assert(depths.length === tokens.length, 'codeSource: one depth per token');
  return { code, tokens, depths, closers };
}

function tokenize(code: string): readonly Token[] | undefined {
  const tokens: Token[] = [];
  let index = 0;
  while (index < code.length) {
    if (tokens.length >= CONDITIONAL_LIMITS.tokensMax) {
      return undefined;
    }
    const character = code.charAt(index);
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    const step = readToken(code, index);
    if (step === undefined) {
      return undefined;
    }
    assert(step.end > index, 'tokenize: every token moves forward');
    tokens.push({ ...step.token, start: index, end: step.end });
    index = step.end;
  }
  assert(index === code.length, 'tokenize: the whole code is read');
  return tokens;
}

function readToken(code: string, start: number): { readonly token: TokenBody; readonly end: number } | undefined {
  const rest = code.slice(start, start + 512);
  const name = /^[A-Za-z_$][\w$]*/.exec(rest);
  if (name !== null) {
    return { token: { kind: 'name', text: name[0] }, end: start + name[0].length };
  }
  const number = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?![\w$.])/.exec(rest);
  if (number !== null) {
    const value = Number(number[0]);
    return Number.isFinite(value) ? { token: { kind: 'number', value }, end: start + number[0].length } : undefined;
  }
  const quote = code.charAt(start);
  if (quote === "'" || quote === '"') {
    return readString(code, start, quote) ?? opaque(code, start, stringEnd(code, start, quote));
  }
  if (quote === '`') {
    return readTemplate(code, start) ?? opaque(code, start, templateEnd(code, start));
  }
  // `a?.5:1` is a ternary on `.5`, not an optional chain.
  if (rest.startsWith('?.') && /^\d$/.test(rest.charAt(2))) {
    return { token: { kind: 'punctuator', text: '?' }, end: start + 1 };
  }
  const punctuator = PUNCTUATORS.find((candidate) => rest.startsWith(candidate));
  if (punctuator !== undefined) {
    return { token: { kind: 'punctuator', text: punctuator }, end: start + punctuator.length };
  }
  return undefined;
}

function opaque(code: string, start: number, end: number | undefined): { readonly token: TokenBody; readonly end: number } | undefined {
  return end === undefined ? undefined : { token: { kind: 'opaque', text: code.slice(start, end) }, end };
}

// A template literal of words and `${name}` holes, read as the model writes
// one. An escape, a nested backtick or a hole holding anything but a name in
// scope is code the model does not write: the token is then kept whole.
function readTemplate(code: string, start: number): { readonly token: TokenBody; readonly end: number } | undefined {
  const parts: TemplatePart[] = [];
  let text = '';
  for (let index = start + 1; index < code.length; index += 1) {
    if (parts.length >= CONDITIONAL_LIMITS.templatePartsMax) {
      return undefined;
    }
    const character = code.charAt(index);
    if (character === '\\') {
      return undefined;
    }
    if (character === '`') {
      if (text !== '') {
        parts.push({ kind: 'text', text });
      }
      return { token: { kind: 'template', parts }, end: index + 1 };
    }
    if (character === '$' && code.charAt(index + 1) === '{') {
      const close = code.indexOf('}', index + 2);
      const path = close === -1 ? '' : code.slice(index + 2, close).trim();
      if (!isReferencePath(path)) {
        return undefined;
      }
      if (text !== '') {
        parts.push({ kind: 'text', text });
        text = '';
      }
      parts.push({ kind: 'reference', path });
      index = close;
      continue;
    }
    text += character;
  }
  return undefined;
}

// Where a template literal holding anything ends: past its closing backtick,
// stepping over escapes and over holes, whose code may hold strings, braces
// and templates of its own. Undefined when it never ends or nests too deep.
function templateEnd(code: string, start: number): number | undefined {
  const open: ('template' | 'code')[] = ['template'];
  let index = start + 1;
  while (index < code.length) {
    const top = open.at(-1);
    const character = code.charAt(index);
    if (top === 'template') {
      if (character === '\\') {
        index += 2;
      } else if (character === '`') {
        open.pop();
        index += 1;
        if (open.length === 0) {
          return index;
        }
      } else if (character === '$' && code.charAt(index + 1) === '{') {
        open.push('code');
        index += 2;
      } else {
        index += 1;
      }
    } else if (character === "'" || character === '"') {
      const end = stringEnd(code, index, character);
      if (end === undefined) {
        return undefined;
      }
      index = end;
    } else if (character === '`' || character === '{') {
      open.push(character === '`' ? 'template' : 'code');
      index += 1;
    } else if (character === '}') {
      open.pop();
      index += 1;
    } else {
      index += 1;
    }
    if (open.length > CONDITIONAL_LIMITS.parenthesesDepthMax) {
      return undefined;
    }
  }
  return undefined;
}

// Where a quoted string ends, any escape stepped over; undefined at a line break.
function stringEnd(code: string, start: number, quote: string): number | undefined {
  for (let index = start + 1; index < code.length; index += 1) {
    const character = code.charAt(index);
    if (character === quote) {
      return index + 1;
    }
    if (character === '\n' || character === '\r') {
      return undefined;
    }
    if (character === '\\') {
      index += 1;
    }
  }
  return undefined;
}

// A quoted string with the escapes `quoted` writes, plus `\"`; any other
// escape (`\x41`, a line continuation) is code the model does not write.
function readString(code: string, start: number, quote: string): { readonly token: TokenBody; readonly end: number } | undefined {
  let value = '';
  for (let index = start + 1; index < code.length; index += 1) {
    const character = code.charAt(index);
    if (character === quote) {
      return { token: { kind: 'string', value }, end: index + 1 };
    }
    if (character === '\n' || character === '\r') {
      return undefined;
    }
    if (character === '\\') {
      const decoded = unescaped(code.slice(index + 1, index + 7));
      if (decoded === undefined) {
        return undefined;
      }
      value += decoded.character;
      index += decoded.length;
      continue;
    }
    value += character;
  }
  return undefined;
}

function unescaped(after: string): { readonly character: string; readonly length: number } | undefined {
  const simple: Readonly<Record<string, string>> = { "'": "'", '"': '"', '\\': '\\', n: '\n', r: '\r', t: '\t' };
  const first = after.charAt(0);
  const known = simple[first];
  if (known !== undefined) {
    return { character: known, length: 1 };
  }
  if (after.startsWith('u2028')) {
    return { character: '\u2028', length: 5 };
  }
  if (after.startsWith('u2029')) {
    return { character: '\u2029', length: 5 };
  }
  return undefined;
}

function isPunctuatorToken(token: Token | undefined, text: string): boolean {
  return token !== undefined && token.kind === 'punctuator' && token.text === text;
}

// The tokens of [from, to) at the range's own depth that are one of `texts`.
function baseIndices(source: CodeSource, from: number, to: number, texts: readonly string[]): readonly number[] {
  assert(from <= to, 'baseIndices: a range runs forwards');
  const base = source.depths[from];
  const out: number[] = [];
  for (let index = from; index < to; index += 1) {
    const token = source.tokens[index];
    if (source.depths[index] === base && token?.kind === 'punctuator' && texts.includes(token.text)) {
      out.push(index);
    }
  }
  return out;
}

function hasBase(source: CodeSource, from: number, to: number, texts: readonly string[]): boolean {
  return baseIndices(source, from, to, texts).length > 0;
}

// [from, to) cut at each top-level `text`, the pieces in order.
function splitAt(source: CodeSource, from: number, to: number, text: string): readonly (readonly [number, number])[] {
  const cuts = baseIndices(source, from, to, [text]);
  const pieces: (readonly [number, number])[] = [];
  let start = from;
  for (const cut of cuts) {
    pieces.push([start, cut]);
    start = cut + 1;
  }
  pieces.push([start, to]);
  assert(pieces.length === cuts.length + 1, 'splitAt: one piece more than cuts');
  return pieces;
}

// [from, to) without the parentheses wrapped round all of it; undefined when deeper than the bound.
function stripped(source: CodeSource, from: number, to: number): readonly [number, number] | undefined {
  let start = from;
  let end = to;
  for (let depth = 0; end - start >= 2; depth += 1) {
    if (!isPunctuatorToken(source.tokens[start], '(') || source.closers.get(start) !== end - 1) {
      return [start, end];
    }
    if (depth === CONDITIONAL_LIMITS.parenthesesDepthMax) {
      return undefined;
    }
    start += 1;
    end -= 1;
  }
  return [start, end];
}

function wrappedWhole(source: CodeSource): boolean {
  const last = source.tokens.length - 1;
  return isPunctuatorToken(source.tokens[0], '(') && source.closers.get(0) === last;
}

// The code of [from, to) exactly as written.
function sliceCode(source: CodeSource, from: number, to: number): string {
  assert(from < to, 'sliceCode: a slice holds a token');
  const first = source.tokens[from];
  const last = source.tokens[to - 1];
  assert(first !== undefined, 'sliceCode: the slice starts inside the code');
  assert(last !== undefined, 'sliceCode: the slice ends inside the code');
  return source.code.slice(first.start, last.end);
}

class TokenReader {
  private index = 0;

  constructor(private readonly tokens: readonly Token[]) {
    assert(tokens.length <= CONDITIONAL_LIMITS.tokensMax, 'TokenReader: the tokens are bounded');
  }

  done(): boolean {
    return this.index === this.tokens.length;
  }

  peek(offset = 0): Token | undefined {
    return this.tokens[this.index + offset];
  }

  isPunctuator(text: string, offset = 0): boolean {
    return isPunctuatorToken(this.peek(offset), text);
  }

  /** Takes the punctuator `text` when it is next; answers whether it was. */
  take(text: string): boolean {
    if (this.isPunctuator(text)) {
      this.index += 1;
      return true;
    }
    return false;
  }

  next(): Token | undefined {
    const token = this.tokens[this.index];
    if (token !== undefined) {
      this.index += 1;
    }
    return token;
  }
}

// ---------------------------------------------------------------------------
// Reading.
// ---------------------------------------------------------------------------

/** Which shapes a reading takes: `plain` only what every writer writes back, `rich` every chain an author writes. */
export type ReadShapes = 'plain' | 'rich';

export interface ReadOptions {
  readonly shapes: ReadShapes;
}

const PLAIN_READING: ReadOptions = { shapes: 'plain' };

// What one reading carries: the code, and whether a ternary in a branch was flattened (which the plain reading refuses).
interface ReadContext {
  readonly source: CodeSource;
  flattened: boolean;
}

/**
 * The model `code` says, or undefined when it says something a model cannot:
 * no condition at all (a plain value is not conditional, though a fallback,
 * `a ?? b`, is), or code the reading does not take. Never throws on input;
 * code is data here.
 */
export function readConditionalExpression(code: string, options: ReadOptions = PLAIN_READING): ConditionalValue | undefined {
  const source = codeSource(code);
  if (source === undefined || source.tokens.length === 0) {
    return undefined;
  }
  const context: ReadContext = { source, flattened: false };
  const model = readChain(context, 0, source.tokens.length, 0);
  if (model === undefined) {
    return undefined;
  }
  if (model.groups.length === 0 && model.otherwise.kind !== 'fallback') {
    return undefined;
  }
  return checkedReading(model, context, options);
}

/**
 * The model `code` says as the rich reading takes it, a plain value included
 * (no groups, the value its Else): what an evaluator weighs, where a table
 * entry is as often `"Close"` as `pressed ? "Pause" : "Play"`. Never throws on input.
 */
export function readValueExpression(code: string): ConditionalValue | undefined {
  const source = codeSource(code);
  if (source === undefined || source.tokens.length === 0) {
    return undefined;
  }
  const context: ReadContext = { source, flattened: false };
  const model = readChain(context, 0, source.tokens.length, 0);
  if (model === undefined) {
    return undefined;
  }
  return checkedReading(model, context, { shapes: 'rich' });
}

function checkedReading(model: ConditionalValue, context: ReadContext, options: ReadOptions): ConditionalValue | undefined {
  if (options.shapes === 'plain' && (context.flattened || !isPlainModel(model))) {
    return undefined;
  }
  // The reader builds the model from parts each check above already passed;
  // the parser proves the whole once more, as every model in the app is made.
  const checked = parseConditionalValue(model);
  assert(checked.ok, `readConditionalExpression: what the reader builds is a valid model (${checked.ok ? '' : checked.error})`);
  return checked.value;
}

/**
 * The conditions `code` tests, when every one is a condition on a name the
 * rows can draw (`variant === "main" || variant === "link"`): a frontmatter
 * value computed from props reads as what it means. Undefined for any other
 * code, a test kept as code included. Never throws on input.
 */
export function readConditionTest(code: string): { readonly match: GroupMatch; readonly conditions: readonly PropCondition[] } | undefined {
  const source = codeSource(code);
  if (source === undefined || source.tokens.length === 0) {
    return undefined;
  }
  const test = readTest({ source, flattened: false }, 0, source.tokens.length);
  if (test === undefined) {
    return undefined;
  }
  const conditions: PropCondition[] = [];
  for (const condition of test.conditions) {
    if (condition.kind === 'code') {
      return undefined;
    }
    conditions.push(condition);
  }
  assert(conditions.length === test.conditions.length, 'readConditionTest: every condition is a prop condition');
  return { match: test.match, conditions };
}

const SHAPE_OPERATORS: readonly string[] = ['?', '??', '&&', '||'];
const SHAPE_TEXT = /\?(?!\.)|&&|\|\|/;
const STRING_TEXT = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g;

/**
 * Whether `code` chooses between values (a ternary, `&&`, `||`, `??` at its
 * top level, or in a template's holes): such code a field shows under the
 * Conditional pill, or under Computed when the reading cannot take it, never
 * as bare code. A call or a name on its own is not.
 */
export function isConditionalShaped(code: string): boolean {
  if (code.length > LIMITS.attrCharsMax) {
    return false;
  }
  const source = codeSource(code);
  if (source === undefined) {
    // Code the tokens cannot cut (a regular expression): its operators outside strings decide.
    return SHAPE_TEXT.test(code.replace(STRING_TEXT, "''"));
  }
  return source.tokens.some((token, index) => {
    if (token.kind === 'opaque') {
      return token.text.startsWith('`') && SHAPE_TEXT.test(token.text.replace(STRING_TEXT, "''"));
    }
    return source.depths[index] === 0 && token.kind === 'punctuator' && SHAPE_OPERATORS.includes(token.text);
  });
}

// `test ? value : test ? value : … : value`: each round reads one group's
// test and value, then goes on with the else, until the else is a value.
// A ternary in a value is read (recursively, to a bound) and flattened.
function readChain(context: ReadContext, from: number, to: number, depth: number): ConditionalValue | undefined {
  assert(depth <= CONDITIONAL_LIMITS.nestingDepthMax, 'readChain: the nesting is bounded');
  const { source } = context;
  const groups: ConditionGroup[] = [];
  let start = from;
  let stop = to;
  for (let round = 0; round <= CONDITIONAL_LIMITS.groupsMax; round += 1) {
    const range = stripped(source, start, stop);
    if (range === undefined || range[0] >= range[1]) {
      return undefined;
    }
    const [first, end] = range;
    stop = end; // The else runs to the end of what the parentheses held.
    const [question] = baseIndices(source, first, end, ['?']);
    if (question === undefined || hasBase(source, first, end, ['=>'])) {
      const value = readValue(context, first, end);
      return value === undefined ? undefined : { groups, otherwise: value };
    }
    const colon = matchingColon(source, question, end);
    const test = readTest(context, first, question);
    if (colon === undefined || test === undefined || depth >= CONDITIONAL_LIMITS.nestingDepthMax) {
      return undefined;
    }
    const branch = readChain(context, question + 1, colon, depth + 1);
    if (branch === undefined) {
      return undefined;
    }
    if (branch.groups.length === 0) {
      groups.push({ ...test, value: branch.otherwise });
    } else {
      context.flattened = true;
      const flat = flattened(test, branch);
      if (flat === undefined) {
        return undefined;
      }
      groups.push(...flat);
    }
    if (groups.length > CONDITIONAL_LIMITS.groupsMax) {
      return undefined;
    }
    start = colon + 1;
  }
  return undefined;
}

// The `:` that closes the `?` at `question`, nested ternaries counted.
function matchingColon(source: CodeSource, question: number, end: number): number | undefined {
  let open = 0;
  for (const index of baseIndices(source, question + 1, end, ['?', ':'])) {
    if (isPunctuatorToken(source.tokens[index], '?')) {
      open += 1;
    } else if (open === 0) {
      return index;
    } else {
      open -= 1;
    }
  }
  return undefined;
}

// `test ? (inner) : …` as groups: each inner group under the test, then the
// test giving the inner Else. Exactly what the nested ternary means, as the
// first group that holds gives the value.
function flattened(test: Pick<ConditionGroup, 'match' | 'conditions'>, inner: ConditionalValue): readonly ConditionGroup[] | undefined {
  const outer = termsOf(test);
  const groups: ConditionGroup[] = [];
  for (const group of inner.groups) {
    for (const term of termsOf(group)) {
      for (const prefix of outer) {
        if (groups.length === CONDITIONAL_LIMITS.groupsMax || prefix.length + term.length > CONDITIONAL_LIMITS.conditionsPerGroupMax) {
          return undefined;
        }
        groups.push({ match: 'all', conditions: [...prefix, ...term], value: group.value });
      }
    }
  }
  groups.push({ ...test, value: inner.otherwise });
  assert(groups.length > inner.groups.length, 'flattened: every inner group and the Else are kept');
  return groups;
}

// A group's test as alternatives each of which holds all its conditions.
function termsOf(group: Pick<ConditionGroup, 'match' | 'conditions'>): readonly (readonly Condition[])[] {
  return group.match === 'all' ? [group.conditions] : group.conditions.map((condition) => [condition]);
}

// A group's test: conditions joined by one operator. A condition the rows
// cannot draw, `&&` inside an `||` or the other way round included, is code.
function readTest(context: ReadContext, from: number, to: number): Pick<ConditionGroup, 'match' | 'conditions'> | undefined {
  const { source } = context;
  const range = stripped(source, from, to);
  if (range === undefined || range[0] >= range[1]) {
    return undefined;
  }
  const [start, end] = range;
  if (hasBase(source, start, end, ['?', '??', '=>', '=', ','])) {
    const code = codeCondition(source, start, end);
    return code === undefined ? undefined : { match: 'all', conditions: [code] };
  }
  const ors = splitAt(source, start, end, '||');
  const match: GroupMatch = ors.length > 1 ? 'any' : 'all';
  const pieces = match === 'any' ? ors : splitAt(source, start, end, '&&');
  if (pieces.length > CONDITIONAL_LIMITS.conditionsPerGroupMax) {
    return undefined;
  }
  const conditions: Condition[] = [];
  for (const [pieceFrom, pieceTo] of pieces) {
    const condition = readCondition(source, pieceFrom, pieceTo);
    if (condition === undefined) {
      return undefined;
    }
    conditions.push(condition);
  }
  assert(conditions.length === pieces.length, 'readTest: one condition per piece');
  return { match, conditions };
}

function readCondition(source: CodeSource, from: number, to: number): Condition | undefined {
  const range = stripped(source, from, to);
  if (range === undefined || range[0] >= range[1]) {
    return undefined;
  }
  const [start, end] = range;
  const reader = new TokenReader(source.tokens.slice(start, end));
  const condition = readPropCondition(reader);
  if (condition !== undefined && reader.done()) {
    return condition;
  }
  return codeCondition(source, start, end);
}

function codeCondition(source: CodeSource, from: number, to: number): Condition | undefined {
  const code = sliceCode(source, from, to);
  return isCodeText(code) ? { kind: 'code', code } : undefined;
}

function readPropCondition(reader: TokenReader): PropCondition | undefined {
  const negated = reader.take('!');
  if (reader.isPunctuator('[')) {
    const list = readIncludes(reader);
    return list === undefined ? undefined : { kind: 'compare', subject: list.subject, operator: negated ? 'notIn' : 'in', values: list.values };
  }
  const subject = readPath(reader);
  if (subject === undefined) {
    return undefined;
  }
  if (negated) {
    return { kind: 'test', subject, operator: 'falsy' };
  }
  const equal = reader.take('===');
  const unequal = equal ? false : reader.take('!==');
  if (!equal && !unequal) {
    return { kind: 'test', subject, operator: 'truthy' };
  }
  const literal = readLiteral(reader);
  return literal === undefined ? undefined : { kind: 'compare', subject, operator: equal ? 'in' : 'notIn', values: [literal] };
}

// `['a', 'b'].includes(subject)`, a trailing comma allowed as Prettier allows one.
function readIncludes(reader: TokenReader): { readonly subject: string; readonly values: readonly ConditionLiteral[] } | undefined {
  assert(reader.take('['), 'readIncludes: a list starts with a bracket');
  const values: ConditionLiteral[] = [];
  for (let round = 0; round <= CONDITIONAL_LIMITS.valuesPerConditionMax; round += 1) {
    if (reader.take(']')) {
      break;
    }
    if (values.length === CONDITIONAL_LIMITS.valuesPerConditionMax) {
      return undefined;
    }
    const literal = readLiteral(reader);
    if (literal === undefined || values.some((value) => sameLiteral(value, literal))) {
      return undefined;
    }
    values.push(literal);
    if (!reader.take(',') && !reader.isPunctuator(']')) {
      return undefined;
    }
  }
  if (values.length === 0 || !reader.take('.')) {
    return undefined;
  }
  const method = reader.next();
  if (method?.kind !== 'name' || method.text !== 'includes' || !reader.take('(')) {
    return undefined;
  }
  const subject = readPath(reader);
  if (subject === undefined || !reader.take(')')) {
    return undefined;
  }
  return { subject, values };
}

function readLiteral(reader: TokenReader): ConditionLiteral | undefined {
  const token = reader.next();
  if (token?.kind === 'string') {
    return { kind: 'string', value: token.value };
  }
  if (token?.kind === 'number') {
    return { kind: 'number', value: token.value };
  }
  return undefined;
}

// A branch's value: a fallback (`a ?? b`, `a || b`), or one value.
function readValue(context: ReadContext, from: number, to: number): ConditionalResult | undefined {
  const { source } = context;
  const range = stripped(source, from, to);
  if (range === undefined || range[0] >= range[1]) {
    return undefined;
  }
  const [start, end] = range;
  if (hasBase(source, start, end, ['?', '=>'])) {
    return computed(source, start, end);
  }
  if (hasBase(source, start, end, [':', ',', ';'])) {
    return undefined;
  }
  for (const operator of FALLBACK_OPERATORS) {
    const pieces = splitAt(source, start, end, operator);
    if (pieces.length === 1) {
      continue;
    }
    if (pieces.length > CONDITIONAL_LIMITS.fallbackOperandsMax) {
      return computed(source, start, end);
    }
    const operands: ValueResult[] = [];
    for (const [pieceFrom, pieceTo] of pieces) {
      const operand = readAtom(source, pieceFrom, pieceTo);
      if (operand === undefined) {
        return undefined;
      }
      // Locked code keeps its own parentheses: `a ?? (b || c)` needs them.
      operands.push(operand.kind === 'computed' && pieceFrom < pieceTo ? { kind: 'computed', code: sliceCode(source, pieceFrom, pieceTo) } : operand);
    }
    return { kind: 'fallback', operator, operands };
  }
  return readAtom(source, start, end);
}

// One value: words, a template, no value, a name in scope, a table's entry
// for a prop (`named[variant]`), or any other expression as locked code.
function readAtom(source: CodeSource, from: number, to: number): ValueResult | undefined {
  const range = stripped(source, from, to);
  if (range === undefined || range[0] >= range[1]) {
    return undefined;
  }
  const [start, end] = range;
  const token = source.tokens[start];
  if (end - start === 1 && token !== undefined) {
    if (token.kind === 'string' && token.value.length <= LIMITS.attrCharsMax) {
      return { kind: 'text', text: token.value };
    }
    if (token.kind === 'template') {
      const parsed = parseTemplate(token.parts, 'template');
      return parsed.ok ? parsed.value : computed(source, start, end);
    }
    if (token.kind === 'name' && (token.text === 'undefined' || token.text === 'null')) {
      return { kind: 'none', word: token.text };
    }
  }
  const reader = new TokenReader(source.tokens.slice(start, end));
  const path = readPath(reader);
  if (path !== undefined && reader.done()) {
    return { kind: 'reference', path };
  }
  if (path !== undefined && reader.take('[')) {
    const key = readPath(reader);
    if (key !== undefined && reader.take(']') && reader.done()) {
      return { kind: 'lookup', table: path, key };
    }
  }
  return computed(source, start, end);
}

function computed(source: CodeSource, from: number, to: number): ValueResult | undefined {
  const code = sliceCode(source, from, to);
  return isCodeText(code) ? { kind: 'computed', code } : undefined;
}

// `name(.name)*`, a name in scope; a call, an index or a keyword is not one.
function readPath(reader: TokenReader): string | undefined {
  const first = reader.next();
  if (first?.kind !== 'name') {
    return undefined;
  }
  let path = first.text;
  for (let round = 0; round < CONDITIONAL_LIMITS.referenceCharsMax && reader.isPunctuator('.'); round += 1) {
    const segment = reader.peek(1);
    if (segment?.kind !== 'name' || reader.isPunctuator('(', 2)) {
      break;
    }
    reader.next();
    reader.next();
    path += `.${segment.text}`;
  }
  return isReferencePath(path) ? path : undefined;
}

// ---------------------------------------------------------------------------
// Evaluation: what a model gives for known values of the names it reads, the
// way the site would run it, without running any code. A name, a test or a
// value only the running site could tell (locked code, a call, a name the
// scope does not hold) makes the whole answer `unknown`, never a guess: an
// answer is shown as fact (an instance's placeholder), so a wrong one is
// worse than none.
// ---------------------------------------------------------------------------

/** A plain value a name holds or a model gives. */
export type EvaluatedPlain = string | number | boolean;

/** What evaluating gives: a value, no value at all (`undefined`), or what only running the code could tell. */
export type Evaluated = { readonly kind: 'value'; readonly value: EvaluatedPlain } | { readonly kind: 'absent' } | { readonly kind: 'unknown' };

/** The entry a table holds for one option: its model, no entry (`absent`), or an entry no model can say (`unknown`). */
export type EvaluatedEntry = { readonly kind: 'model'; readonly model: ConditionalValue } | { readonly kind: 'absent' } | { readonly kind: 'unknown' };

/** What the names of a model hold: each name's value, and each lookup table's entry for an option. */
export interface EvaluationScope {
  readonly name: (name: string) => Evaluated;
  readonly entry: (table: string, option: string) => EvaluatedEntry;
}

const UNKNOWN: Evaluated = { kind: 'unknown' };
const ABSENT: Evaluated = { kind: 'absent' };

/** What `model` gives for the values `scope` holds; `unknown` when only running the code could tell. */
export function evaluateConditionalValue(model: ConditionalValue, scope: EvaluationScope): Evaluated {
  return evaluateModel(model, scope, 0);
}

// One model, at `depth` lookups below the first: a table entry that indexes
// another table (or itself) recurses, bounded by the nesting the reader allows.
function evaluateModel(model: ConditionalValue, scope: EvaluationScope, depth: number): Evaluated {
  assert(depth >= 0, 'evaluateModel: the depth counts lookups taken');
  assert(model.groups.length <= CONDITIONAL_LIMITS.groupsMax, 'evaluateModel: the groups are bounded');
  if (depth > CONDITIONAL_LIMITS.nestingDepthMax) {
    return UNKNOWN;
  }
  for (const group of model.groups) {
    const holds = evaluateGroup(group, scope);
    if (holds === 'unknown') {
      return UNKNOWN;
    }
    if (holds === 'true') {
      return evaluateResult(group.value, scope, depth);
    }
  }
  return evaluateResult(model.otherwise, scope, depth);
}

// Three-valued: a group of `all` is false when any condition is false, even if another is unknown.
type Truth = 'true' | 'false' | 'unknown';

function evaluateGroup(group: ConditionGroup, scope: EvaluationScope): Truth {
  assert(group.conditions.length > 0, 'evaluateGroup: a group tests something');
  assert(group.conditions.length <= CONDITIONAL_LIMITS.conditionsPerGroupMax, 'evaluateGroup: the conditions are bounded');
  const truths = group.conditions.map((condition) => evaluateCondition(condition, scope));
  const decisive: Truth = group.match === 'all' ? 'false' : 'true';
  if (truths.includes(decisive)) {
    return decisive;
  }
  if (truths.includes('unknown')) {
    return 'unknown';
  }
  return group.match === 'all' ? 'true' : 'false';
}

function evaluateCondition(condition: Condition, scope: EvaluationScope): Truth {
  if (condition.kind === 'code') {
    return 'unknown';
  }
  const subject = scope.name(condition.subject);
  if (subject.kind === 'unknown') {
    return 'unknown';
  }
  switch (condition.kind) {
    case 'test': {
      const truthy = subject.kind === 'value' && Boolean(subject.value);
      return truthy === (condition.operator === 'truthy') ? 'true' : 'false';
    }
    case 'compare': {
      assert(condition.values.length > 0, 'evaluateCondition: a comparison names values');
      const equal = subject.kind === 'value' && condition.values.some((literal) => literal.value === subject.value);
      return equal === (condition.operator === 'in') ? 'true' : 'false';
    }
    default: {
      const exhaustive: never = condition;
      return exhaustive;
    }
  }
}

function evaluateResult(result: ConditionalResult, scope: EvaluationScope, depth: number): Evaluated {
  if (result.kind !== 'fallback') {
    return evaluateValue(result, scope, depth);
  }
  assert(result.operands.length <= CONDITIONAL_LIMITS.fallbackOperandsMax, 'evaluateResult: the operands are bounded');
  // `a ?? b` gives the first operand that is set; `a || b` the first truthy one, else the last.
  let last: Evaluated = ABSENT;
  for (const operand of result.operands) {
    const value = evaluateValue(operand, scope, depth);
    if (value.kind === 'unknown') {
      return UNKNOWN;
    }
    if (value.kind === 'value') {
      if (result.operator === '??') {
        return value;
      }
      if (value.value) {
        return value;
      }
    }
    last = value;
  }
  return result.operator === '??' ? ABSENT : last;
}

function evaluateValue(value: ValueResult, scope: EvaluationScope, depth: number): Evaluated {
  switch (value.kind) {
    case 'text':
      return { kind: 'value', value: value.text };
    case 'none':
      return ABSENT;
    case 'reference':
      // `item.title` reads into data the scope does not hold; only a name on its own is a prop.
      return value.path.includes('.') ? UNKNOWN : scope.name(value.path);
    case 'template':
      return evaluateTemplate(value.parts, scope);
    case 'lookup':
      return evaluateLookup(value, scope, depth);
    case 'computed':
      return literalOfCode(value.code);
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

function evaluateTemplate(parts: readonly TemplatePart[], scope: EvaluationScope): Evaluated {
  assert(parts.length <= CONDITIONAL_LIMITS.templatePartsMax, 'evaluateTemplate: the parts are bounded');
  let text = '';
  for (const part of parts) {
    if (part.kind === 'text') {
      text += part.text;
      continue;
    }
    const held = part.path.includes('.') ? UNKNOWN : scope.name(part.path);
    // `${label}` with no label prints "undefined": not something to show as a value.
    if (held.kind !== 'value') {
      return UNKNOWN;
    }
    text += String(held.value);
  }
  return { kind: 'value', value: text };
}

function evaluateLookup(value: Extract<ValueResult, { readonly kind: 'lookup' }>, scope: EvaluationScope, depth: number): Evaluated {
  const key = scope.name(value.key);
  if (key.kind !== 'value') {
    // `named[undefined]` is undefined; an unknown key is an unknown entry.
    return key;
  }
  const entry = scope.entry(value.table, String(key.value));
  switch (entry.kind) {
    case 'model':
      return evaluateModel(entry.model, scope, depth + 1);
    case 'absent':
      return ABSENT;
    case 'unknown':
      return UNKNOWN;
    default: {
      const exhaustive: never = entry;
      return exhaustive;
    }
  }
}

// Locked code a value can still be read from: a number, `true` or `false`.
function literalOfCode(code: string): Evaluated {
  const text = code.trim();
  assert(text.length <= LIMITS.attrCharsMax, 'literalOfCode: the code is bounded');
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(text)) {
    return { kind: 'value', value: Number(text) };
  }
  if (text === 'true' || text === 'false') {
    return { kind: 'value', value: text === 'true' };
  }
  return UNKNOWN;
}

// ---------------------------------------------------------------------------
// Class lists: `class:list={["heading", variant !== "inherit" && `text-style-${variant}`, className]}`.
// Each entry is a class (words, a name in scope, a template, a fallback or
// locked code) given always, or only when its conditions all hold (`cond &&
// cond && value`) or any holds (`(a || b) && value`). A spread is code the
// list does not draw.
// ---------------------------------------------------------------------------

export const CLASS_LIST_LIMITS = {
  entriesMax: 32,
  conditionsPerEntryMax: 16,
} as const satisfies Record<string, number>;

/** What a class-list entry gives: never "no value", which is what leaving the entry out says. */
export type ClassValue = Exclude<ConditionalResult, { readonly kind: 'none' }>;

export interface ClassEntry {
  readonly value: ClassValue;
  /** Whether all of `when` must hold for the class to be given, or any one. */
  readonly match: GroupMatch;
  /** The conditions the class is given under; empty for always. */
  readonly when: readonly Condition[];
}

export interface ClassListValue {
  readonly entries: readonly ClassEntry[];
}

/** A class list from `input`, or why it is not one. */
export function parseClassListValue(input: unknown): Result<ClassListValue, string> {
  const record = toRecord(input);
  if (record === undefined) {
    return err('ClassList: expected an object');
  }
  const entriesInput = toArray(record['entries']);
  if (entriesInput === undefined) {
    return err('ClassList.entries: expected an array');
  }
  if (entriesInput.length > CLASS_LIST_LIMITS.entriesMax) {
    return err(`ClassList.entries: more than ${CLASS_LIST_LIMITS.entriesMax}`);
  }
  const entries: ClassEntry[] = [];
  for (const [index, entry] of entriesInput.entries()) {
    const where = `ClassList.entries[${index}]`;
    const entryRecord = toRecord(entry);
    if (entryRecord === undefined) {
      return err(`${where}: expected an object`);
    }
    const value = parseResult(entryRecord['value'], `${where}.value`);
    if (!value.ok) {
      return value;
    }
    if (value.value.kind === 'none') {
      return err(`${where}.value: a class is given, never no value`);
    }
    const whenInput = toArray(entryRecord['when']);
    if (whenInput === undefined) {
      return err(`${where}.when: expected an array`);
    }
    if (whenInput.length > CLASS_LIST_LIMITS.conditionsPerEntryMax) {
      return err(`${where}.when: more than ${CLASS_LIST_LIMITS.conditionsPerEntryMax}`);
    }
    const when: Condition[] = [];
    for (const [at, condition] of whenInput.entries()) {
      const parsed = parseCondition(condition, `${where}.when[${at}]`);
      if (!parsed.ok) {
        return parsed;
      }
      when.push(parsed.value);
    }
    const match = entryRecord['match'];
    if (match !== 'all' && match !== 'any') {
      return err(`${where}.match: expected all or any`);
    }
    entries.push({ value: value.value, match, when });
  }
  assert(entries.length === entriesInput.length, 'parseClassListValue: every entry is kept');
  return ok({ entries });
}

/** The array for `model`, on one line as Prettier leaves a short one: `["a", b && "c"]`. */
export function emitClassListExpression(model: ClassListValue, options: WriteOptions = SINGLE_QUOTES): string {
  assert(model.entries.length <= CLASS_LIST_LIMITS.entriesMax, 'emitClassListExpression: the entries are bounded');
  const items = model.entries.map((entry) => {
    if (entry.when.length === 0) {
      return resultCode(entry.value, options, 'whole');
    }
    const value = resultCode(entry.value, options, 'classValue');
    // Any of several needs its parentheses: `||` binds looser than the `&&` before the class.
    if (entry.match === 'any' && entry.when.length > 1) {
      return `(${conditionsCode(entry.when, 'any', options)}) && ${value}`;
    }
    return `${conditionsCode(entry.when, 'all', options)} && ${value}`;
  });
  const code = `[${items.join(', ')}]`;
  assert(code.startsWith('['), 'emitClassListExpression: a list is an array');
  return code;
}

/** The class list `code` says, or undefined for anything a class list cannot draw. Never throws on input. */
export function readClassListExpression(code: string): ClassListValue | undefined {
  const source = codeSource(code);
  if (source === undefined) {
    return undefined;
  }
  const last = source.tokens.length - 1;
  if (last < 1 || !isPunctuatorToken(source.tokens[0], '[') || source.closers.get(0) !== last) {
    return undefined;
  }
  const pieces = last === 1 ? [] : splitAt(source, 1, last, ',');
  const entries: ClassEntry[] = [];
  for (const [index, [from, to]] of pieces.entries()) {
    if (from === to && index === pieces.length - 1 && index > 0) {
      break; // A trailing comma, as Prettier writes one in a long list.
    }
    if (entries.length === CLASS_LIST_LIMITS.entriesMax) {
      return undefined;
    }
    const entry = readClassEntry(source, from, to);
    if (entry === undefined) {
      return undefined;
    }
    entries.push(entry);
  }
  const checked = parseClassListValue({ entries });
  return checked.ok ? checked.value : undefined;
}

// `cond && cond && value`, every operand but the last a condition and the
// last the class; `(cond || cond) && value`, the class given when any holds;
// anything else whose top level is not `&&` is the class itself.
function readClassEntry(source: CodeSource, from: number, to: number): ClassEntry | undefined {
  const context: ReadContext = { source, flattened: false };
  const range = stripped(source, from, to);
  if (range === undefined || range[0] >= range[1] || isPunctuatorToken(source.tokens[range[0]], '...')) {
    return undefined;
  }
  const [start, end] = range;
  const pieces = splitAt(source, start, end, '&&');
  // `a && b ? x : y` and `a && b || c` bind looser than `&&`: the whole is the class.
  const whole = pieces.length === 1 || hasBase(source, start, end, ['?', '=>', '||', '??']);
  if (whole) {
    const value = classValue(context, start, end);
    return value === undefined ? undefined : { value, match: 'all', when: [] };
  }
  const tail = pieces.at(-1);
  assert(tail !== undefined, 'readClassEntry: a split has a last piece');
  const value = classValue(context, tail[0], tail[1]);
  const heads = pieces.slice(0, -1);
  if (value === undefined || heads.length > CLASS_LIST_LIMITS.conditionsPerEntryMax) {
    return undefined;
  }
  const [only] = heads;
  if (heads.length === 1 && only !== undefined) {
    const test = readTest(context, only[0], only[1]);
    return test === undefined ? undefined : { value, match: test.match, when: test.conditions };
  }
  const when: Condition[] = [];
  for (const [headFrom, headTo] of heads) {
    const condition = readCondition(source, headFrom, headTo);
    if (condition === undefined) {
      return undefined;
    }
    when.push(condition);
  }
  return { value, match: 'all', when };
}

// A class: never no value; locked code keeps its parentheses, which it needs after `cond &&`.
function classValue(context: ReadContext, from: number, to: number): ClassValue | undefined {
  if (from >= to) {
    return undefined;
  }
  const value = readValue(context, from, to);
  if (value === undefined || value.kind === 'none') {
    return undefined;
  }
  return value.kind === 'computed' ? { kind: 'computed', code: sliceCode(context.source, from, to) } : value;
}
