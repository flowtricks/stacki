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
// model can say (readConditionalExpression); anything else, a ternary nested
// in a branch, a call, `&&` mixed with `||`, stays code, so the UI never
// rewrites what it cannot draw. Reading ignores what carries no meaning
// (spacing, line breaks, quote style, redundant parentheses), so a file
// Prettier formatted still reads; writing is single-line, single-quoted and
// free of redundant parentheses, which Prettier leaves as it is.

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
 * switch that is on, a text that is set).
 */
export type Condition =
  | { readonly kind: 'compare'; readonly subject: string; readonly operator: CompareOperator; readonly values: readonly ConditionLiteral[] }
  | { readonly kind: 'test'; readonly subject: string; readonly operator: TestOperator };

/** A run of a template branch: its words, or the value a name in scope holds, written `${name}`. */
export type TemplatePart = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'reference'; readonly path: string };

/** How "no value" is spelled: kept, so code that wrote `null` reads back as it was written. */
export const NO_VALUE_WORDS = ['undefined', 'null'] as const;
export type NoValueWord = (typeof NO_VALUE_WORDS)[number];

/**
 * What a branch gives: words; the value a prop (or another name in scope)
 * holds; words with values in them (a template, `--_mw: ${maxWidth}ch;`); or
 * no value at all (`undefined`), which leaves the attribute out.
 */
export type ConditionalResult =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'reference'; readonly path: string }
  | { readonly kind: 'template'; readonly parts: readonly TemplatePart[] }
  | { readonly kind: 'none'; readonly word: NoValueWord };

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
    return err(`${where}.kind: expected compare or test`);
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
  if (record['kind'] === 'text') {
    const text = record['text'];
    if (typeof text !== 'string') {
      return err(`${where}.text: expected a string`);
    }
    if (text.length > LIMITS.attrCharsMax) {
      return err(`${where}.text: exceeds ${LIMITS.attrCharsMax} characters`);
    }
    return ok({ kind: 'text', text });
  }
  if (record['kind'] === 'reference') {
    const path = record['path'];
    if (typeof path !== 'string' || !isReferencePath(path)) {
      return err(`${where}.path: expected a name in scope`);
    }
    return ok({ kind: 'reference', path });
  }
  if (record['kind'] === 'none') {
    const word = record['word'];
    if (word !== 'undefined' && word !== 'null') {
      return err(`${where}.word: expected undefined or null`);
    }
    return ok({ kind: 'none', word });
  }
  if (record['kind'] === 'template') {
    return parseTemplate(record['parts'], `${where}.parts`);
  }
  return err(`${where}.kind: expected text, reference, template or none`);
}

// A template's parts: words a template literal holds as they are (no
// backtick, backslash or `${`, which would be code), and names in scope,
// never two runs of words side by side (they are one run).
function parseTemplate(input: unknown, where: string): Result<ConditionalResult, string> {
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
 * The expression for `model`: one ternary per group, chained through the else
 * branch, ending in the Else value. A model with no groups is its Else value.
 */
export function emitConditionalExpression(model: ConditionalValue, options: WriteOptions = SINGLE_QUOTES): string {
  assert(model.groups.length <= CONDITIONAL_LIMITS.groupsMax, 'emitConditionalExpression: the groups are bounded');
  let code = '';
  for (const group of model.groups) {
    code += `${groupCode(group, options)} ? ${resultCode(group.value, options)} : `;
  }
  code += resultCode(model.otherwise, options);
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
      return { type: 'expr', value: resultCode(otherwise, options) };
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
  return group.conditions.map((condition) => conditionCode(condition, options)).join(group.match === 'all' ? ' && ' : ' || ');
}

function conditionCode(condition: Condition, options: WriteOptions): string {
  assert(isReferencePath(condition.subject), 'conditionCode: the subject is a name in scope');
  switch (condition.kind) {
    case 'test':
      return condition.operator === 'truthy' ? condition.subject : `!${condition.subject}`;
    case 'compare': {
      const [only] = condition.values;
      assert(only !== undefined, 'conditionCode: a comparison has a value');
      if (condition.values.length === 1) {
        return `${condition.subject} ${condition.operator === 'in' ? '===' : '!=='} ${literalCode(only, options)}`;
      }
      const list = `[${condition.values.map((value) => literalCode(value, options)).join(', ')}].includes(${condition.subject})`;
      return condition.operator === 'in' ? list : `!${list}`;
    }
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

function resultCode(result: ConditionalResult, options: WriteOptions): string {
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
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
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
// Reading.
// ---------------------------------------------------------------------------

type Token =
  | { readonly kind: 'name'; readonly text: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'template'; readonly parts: readonly TemplatePart[] }
  | { readonly kind: 'punctuator'; readonly text: string };

// Longest first, so `===` is never read as `==` and `=`.
const PUNCTUATORS = ['===', '!==', '&&', '||', '?', ':', '(', ')', '[', ']', ',', '.', '!'] as const;

/**
 * The model `code` says, or undefined when it says something a model cannot:
 * no condition at all (a plain value is not conditional), or any code beyond
 * the shapes the model writes. Never throws on input; code is data here.
 */
export function readConditionalExpression(code: string): ConditionalValue | undefined {
  if (code.length > LIMITS.attrCharsMax) {
    return undefined;
  }
  const tokens = tokenize(code);
  if (tokens === undefined) {
    return undefined;
  }
  const reader = new TokenReader(tokens);
  const model = readChain(reader);
  if (model === undefined || !reader.done() || model.groups.length === 0) {
    return undefined;
  }
  // The reader builds the model from parts each check above already passed;
  // the parser proves the whole once more, as every model in the app is made.
  const checked = parseConditionalValue(model);
  assert(checked.ok, 'readConditionalExpression: what the reader builds is a valid model');
  return checked.value;
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
    tokens.push(step.token);
    index = step.end;
  }
  assert(index === code.length, 'tokenize: the whole code is read');
  return tokens;
}

function readToken(code: string, start: number): { readonly token: Token; readonly end: number } | undefined {
  const rest = code.slice(start);
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
    return readString(code, start, quote);
  }
  if (quote === '`') {
    return readTemplate(code, start);
  }
  const punctuator = PUNCTUATORS.find((candidate) => rest.startsWith(candidate));
  if (punctuator !== undefined) {
    return { token: { kind: 'punctuator', text: punctuator }, end: start + punctuator.length };
  }
  return undefined;
}

// A template literal of words and `${name}` holes, read as the model writes
// one. An escape, a nested backtick or a hole holding anything but a name in
// scope is code the model does not write, so the whole expression stays code.
function readTemplate(code: string, start: number): { readonly token: Token; readonly end: number } | undefined {
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

// A quoted string with the escapes `quoted` writes, plus `\"`; any other
// escape (`\x41`, a line continuation) is code the model does not write.
function readString(code: string, start: number, quote: string): { readonly token: Token; readonly end: number } | undefined {
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
    return { character: ' ', length: 5 };
  }
  if (after.startsWith('u2029')) {
    return { character: ' ', length: 5 };
  }
  return undefined;
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
    const token = this.peek(offset);
    return token !== undefined && token.kind === 'punctuator' && token.text === text;
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

  get position(): number {
    return this.index;
  }

  rewind(position: number): void {
    assert(position >= 0, 'TokenReader.rewind: a position is never negative');
    assert(position <= this.index, 'TokenReader.rewind: only backwards');
    this.index = position;
  }
}

// `test ? value : test ? value : … : value`, read iteratively: each group's
// test and value, then the else, which is either the next group or the end.
function readChain(reader: TokenReader): ConditionalValue | undefined {
  const groups: ConditionGroup[] = [];
  for (let round = 0; round <= CONDITIONAL_LIMITS.groupsMax; round += 1) {
    const start = reader.position;
    const value = readResult(reader);
    if (value !== undefined && reader.done()) {
      return { groups, otherwise: value };
    }
    reader.rewind(start);
    if (groups.length === CONDITIONAL_LIMITS.groupsMax) {
      return undefined;
    }
    const test = readTest(reader);
    if (test === undefined || !reader.take('?')) {
      return undefined;
    }
    const branch = readResult(reader);
    if (branch === undefined || !reader.take(':')) {
      return undefined;
    }
    groups.push({ ...test, value: branch });
  }
  return undefined;
}

// A group's test: its conditions joined by one operator, in as many
// parentheses as Prettier or a person put around it.
function readTest(reader: TokenReader): Pick<ConditionGroup, 'match' | 'conditions'> | undefined {
  return inParentheses(reader, () => {
    const conditions: Condition[] = [];
    let match: GroupMatch | undefined;
    for (let round = 0; round < CONDITIONAL_LIMITS.conditionsPerGroupMax; round += 1) {
      const condition = inParentheses(reader, () => readCondition(reader));
      if (condition === undefined) {
        return undefined;
      }
      conditions.push(condition);
      const joiner = reader.isPunctuator('&&') ? 'all' : reader.isPunctuator('||') ? 'any' : undefined;
      if (joiner === undefined) {
        return { match: match ?? 'all', conditions };
      }
      if (match !== undefined && match !== joiner) {
        return undefined; // `&&` beside `||` is precedence the model cannot draw.
      }
      match = joiner;
      reader.next();
    }
    return undefined;
  });
}

// Reads `read` inside any number of balanced parentheses, up to the bound.
function inParentheses<T>(reader: TokenReader, read: () => T | undefined): T | undefined {
  let depth = 0;
  while (depth < CONDITIONAL_LIMITS.parenthesesDepthMax && reader.isPunctuator('(')) {
    reader.next();
    depth += 1;
  }
  const value = read();
  if (value === undefined) {
    return undefined;
  }
  for (let closed = 0; closed < depth; closed += 1) {
    if (!reader.take(')')) {
      return undefined;
    }
  }
  return value;
}

function readCondition(reader: TokenReader): Condition | undefined {
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

function readResult(reader: TokenReader): ConditionalResult | undefined {
  const token = reader.peek();
  if (token?.kind === 'string') {
    reader.next();
    return token.value.length > LIMITS.attrCharsMax ? undefined : { kind: 'text', text: token.value };
  }
  if (token?.kind === 'template') {
    reader.next();
    const parsed = parseTemplate(token.parts, 'template');
    return parsed.ok ? parsed.value : undefined;
  }
  if (token?.kind === 'name' && (token.text === 'undefined' || token.text === 'null') && !reader.isPunctuator('.', 1)) {
    reader.next();
    return { kind: 'none', word: token.text };
  }
  const path = readPath(reader);
  return path === undefined ? undefined : { kind: 'reference', path };
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
// Class lists: `class:list={["heading", variant !== "inherit" && `text-style-${variant}`, className]}`.
// Each entry is a class (words, a name in scope, or a template) given always,
// or only when its conditions all hold (`cond && cond && value`). An object,
// a spread, a nested array or a call is code the list does not draw.
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
    const value = resultCode(entry.value, options);
    const conditions = entry.when.map((condition) => conditionCode(condition, options));
    if (conditions.length === 0) {
      return value;
    }
    // Any of several needs its parentheses: `||` binds looser than the `&&` before the class.
    if (entry.match === 'any' && conditions.length > 1) {
      return `(${conditions.join(' || ')}) && ${value}`;
    }
    return `${conditions.join(' && ')} && ${value}`;
  });
  const code = `[${items.join(', ')}]`;
  assert(code.startsWith('['), 'emitClassListExpression: a list is an array');
  return code;
}

/** The class list `code` says, or undefined for anything a class list cannot draw. Never throws on input. */
export function readClassListExpression(code: string): ClassListValue | undefined {
  if (code.length > LIMITS.attrCharsMax) {
    return undefined;
  }
  const tokens = tokenize(code);
  if (tokens === undefined) {
    return undefined;
  }
  const reader = new TokenReader(tokens);
  if (!reader.take('[')) {
    return undefined;
  }
  const entries: ClassEntry[] = [];
  for (let round = 0; round <= CLASS_LIST_LIMITS.entriesMax; round += 1) {
    if (reader.take(']')) {
      break;
    }
    if (entries.length === CLASS_LIST_LIMITS.entriesMax) {
      return undefined;
    }
    const entry = readClassEntry(reader);
    if (entry === undefined) {
      return undefined;
    }
    entries.push(entry);
    if (!reader.take(',') && !reader.isPunctuator(']')) {
      return undefined;
    }
  }
  if (!reader.done()) {
    return undefined;
  }
  const checked = parseClassListValue({ entries });
  return checked.ok ? checked.value : undefined;
}

// `cond && cond && value`, every operand but the last a condition and the
// last the class; or `(cond || cond) && value`, the class given when any holds.
function readClassEntry(reader: TokenReader): ClassEntry | undefined {
  const start = reader.position;
  const all = readClassEntryAll(reader);
  if (all !== undefined) {
    return all;
  }
  reader.rewind(start);
  const test = readTest(reader);
  if (test === undefined || !reader.take('&&')) {
    return undefined;
  }
  const value = readResult(reader);
  if (value === undefined || value.kind === 'none' || !(reader.isPunctuator(',') || reader.isPunctuator(']'))) {
    return undefined;
  }
  return { value, match: test.match, when: test.conditions };
}

function readClassEntryAll(reader: TokenReader): ClassEntry | undefined {
  const when: Condition[] = [];
  for (let round = 0; round <= CLASS_LIST_LIMITS.conditionsPerEntryMax; round += 1) {
    const start = reader.position;
    const value = readResult(reader);
    if (value !== undefined && value.kind !== 'none' && (reader.isPunctuator(',') || reader.isPunctuator(']'))) {
      return { value, match: 'all', when };
    }
    reader.rewind(start);
    if (when.length === CLASS_LIST_LIMITS.conditionsPerEntryMax) {
      return undefined;
    }
    const condition = inParentheses(reader, () => readCondition(reader));
    if (condition === undefined || !reader.take('&&')) {
      return undefined;
    }
    when.push(condition);
  }
  return undefined;
}
