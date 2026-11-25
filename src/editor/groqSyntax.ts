// A GROQ query read back into the loop query it says: `*[_type == "pastor" &&
// featured == true] | order(name asc) [0...6] { … }`. Only the outer shape is
// required — one type, then optional order, slice and projection. Inside the
// filter, every clause the panel can show becomes a condition and every other
// one is kept verbatim as a custom condition, so a hand-written query is read
// as far as it can be and never loses a clause it was not understood in.

import { assert } from '../../shared/core/assert';
import { isDateValue, isDocumentId, isFieldPath, isItemId, LOOP_QUERY_LIMITS, type LoopCondition, type LoopLiteral, type LoopSort } from './loopQuery';

export interface GroqReading {
  readonly type: string;
  /** Documents picked by id (`_id in ["a", "b"]`), when the query picks rather than filters. */
  readonly selection?: readonly string[];
  readonly match: 'all' | 'any';
  readonly conditions: readonly LoopCondition[];
  readonly sorts: readonly LoopSort[];
  readonly offset: number;
  readonly limit: number | undefined;
  readonly projection: string | undefined;
}

const GROQ_CHARS_MAX = 50_000;

/** The query's parts, or undefined when its outer shape is not a list of one type. */
export function readGroq(text: string): GroqReading | undefined {
  if (text.length > GROQ_CHARS_MAX) {
    return undefined;
  }
  // Parameters (`$slug`) need values the fetch passes; those queries stay custom.
  if (/\$[A-Za-z_]/.test(stripStrings(text))) {
    return undefined;
  }
  const source = stripComments(text).trim();
  if (!source.startsWith('*[')) {
    return undefined;
  }
  const close = matching(source, 1);
  if (close === undefined) {
    return undefined;
  }
  const filter = readFilter(source.slice(2, close));
  if (filter === undefined) {
    return undefined;
  }
  const tail = readTail(source.slice(close + 1));
  if (tail === undefined) {
    return undefined;
  }
  assert(filter.type.length > 0, 'A read query names its type');
  return { ...filter, ...tail };
}

interface FilterReading {
  readonly type: string;
  readonly selection?: readonly string[];
  readonly match: 'all' | 'any';
  readonly conditions: readonly LoopCondition[];
}

function readFilter(text: string): FilterReading | undefined {
  if (splitTop(text, '||').length > 1) {
    return undefined; // The type itself would be optional.
  }
  const clauses = splitTop(text, '&&');
  let type: string | undefined;
  const rest: string[] = [];
  for (const clause of clauses) {
    const named = /^_type\s*==\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/.exec(clause);
    const value = named?.[1] === undefined ? undefined : groqStringValue(named[1]);
    if (value !== undefined && type === undefined) {
      type = value;
    } else {
      rest.push(clause);
    }
  }
  if (type === undefined || rest.length > LOOP_QUERY_LIMITS.conditionsMax) {
    return undefined;
  }
  // `_type == "x" && _id in ["a", "b"]`: picked documents, nothing else asked.
  const picked = rest.length === 1 && rest[0] !== undefined ? pickedIds(rest[0]) : undefined;
  if (picked !== undefined) {
    return { type, match: 'all', conditions: [], selection: picked };
  }
  // `_type == "x" && (a || b)`: the conditions any of which may hold.
  const only = rest[0];
  const inner = only === undefined || rest.length !== 1 ? undefined : unwrapped(only);
  const alternatives = inner === undefined ? [] : splitTop(inner, '||');
  if (alternatives.length > 1 && alternatives.length <= LOOP_QUERY_LIMITS.conditionsMax) {
    return { type, match: 'any', conditions: alternatives.map(readCondition) };
  }
  return { type, match: 'all', conditions: rest.map(readCondition) };
}

interface TailReading {
  readonly sorts: readonly LoopSort[];
  readonly offset: number;
  readonly limit: number | undefined;
  readonly projection: string | undefined;
}

// What follows the filter: ` | order(a desc)`, then ` [0...3]`, then `{ … }`.
function readTail(text: string): TailReading | undefined {
  let rest = text.trim();
  let sorts: readonly LoopSort[] = [];
  const order = /^\|\s*order\s*\(/.exec(rest);
  if (order) {
    const close = matching(rest, order[0].length - 1);
    const read = close === undefined ? undefined : readOrder(rest.slice(order[0].length, close));
    if (close === undefined || read === undefined) {
      return undefined;
    }
    sorts = read;
    rest = rest.slice(close + 1).trim();
  }
  let offset = 0;
  let limit: number | undefined;
  const slice = /^\[\s*(\d+)\s*(\.\.\.?)\s*(\d+)\s*\]/.exec(rest);
  if (slice) {
    const start = Number(slice[1]);
    const end = Number(slice[3]) + (slice[2] === '..' ? 1 : 0);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start || start > LOOP_QUERY_LIMITS.offsetMax) {
      return undefined;
    }
    offset = start;
    limit = end - start > LOOP_QUERY_LIMITS.limitMax ? undefined : end - start;
    rest = rest.slice(slice[0].length).trim();
  }
  if (rest === '') {
    return { sorts, offset, limit, projection: undefined };
  }
  if (!rest.startsWith('{') || matching(rest, 0) !== rest.length - 1 || rest.length > LOOP_QUERY_LIMITS.projectionCharsMax) {
    return undefined; // A projection before the order, a pipe after it, or a single document.
  }
  return { sorts, offset, limit, projection: rest };
}

function readOrder(text: string): readonly LoopSort[] | undefined {
  const keys = splitTop(text, ',');
  if (keys.length > LOOP_QUERY_LIMITS.sortsMax) {
    return undefined;
  }
  const sorts: LoopSort[] = [];
  for (const key of keys) {
    const match = /^([A-Za-z_][\w.]*)(?:\s+(asc|desc))?$/i.exec(key);
    const field = match?.[1];
    if (field === undefined || !isFieldPath(field)) {
      return undefined;
    }
    const direction = match?.[2]?.toLowerCase() === 'desc' ? 'descending' : 'ascending';
    // GROQ orders by each value's own type; `order` only matters to JS sorting.
    sorts.push({ field, direction, order: /At$|[Dd]ate/.test(field) ? 'date' : 'text' });
  }
  return sorts;
}

const FIELD = '([A-Za-z_][\\w]*(?:\\.[A-Za-z_][\\w]*)*)';
const STRING = `("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`;
const NUMBER = '(-?\\d+(?:\\.\\d+)?)';
const COMPARE = '(==|!=|<=|>=|<|>)';

/** One clause as a condition; anything it does not recognise is kept as written. */
export function readCondition(clause: string): LoopCondition {
  const text = clause.trim();
  const custom: LoopCondition = { kind: 'custom', code: text };
  const set = new RegExp(`^(!)?\\s*defined\\(\\s*${FIELD}\\s*\\)$`).exec(text);
  if (set?.[2] !== undefined && isFieldPath(set[2])) {
    return { kind: 'test', field: set[2], operator: set[1] ? 'isEmpty' : 'isSet' };
  }
  const counted = new RegExp(`^count\\(\\s*${FIELD}\\s*\\)\\s*>\\s*0$`).exec(text);
  if (counted?.[1] !== undefined && isFieldPath(counted[1])) {
    return { kind: 'test', field: counted[1], operator: 'isSet' };
  }
  const matched = new RegExp(`^${FIELD}\\s+match\\s+${STRING}$`).exec(text);
  const pattern = matched?.[2] === undefined ? undefined : groqStringValue(matched[2]);
  if (matched?.[1] !== undefined && pattern !== undefined && /^\*[^*]+\*$/.test(pattern)) {
    return { kind: 'test', field: matched[1], operator: 'contains', value: pattern.slice(1, -1) };
  }
  const contained = new RegExp(`^(?:${STRING}|${NUMBER})\\s+in\\s+${FIELD}$`).exec(text);
  if (contained?.[3] !== undefined) {
    return containsCondition(contained[3], contained[1], contained[2]) ?? custom;
  }
  const now = new RegExp(`^${FIELD}\\s*(<=|<|>|>=)\\s*now\\(\\)$`).exec(text);
  if (now?.[1] !== undefined && isFieldPath(now[1])) {
    return { kind: 'test', field: now[1], operator: now[2]?.startsWith('<') ? 'inPast' : 'inFuture' };
  }
  const compared = new RegExp(`^${FIELD}\\s*${COMPARE}\\s*(?:${STRING}|${NUMBER}|(true|false))$`).exec(text);
  if (compared?.[1] !== undefined && compared[2] !== undefined) {
    return comparedCondition(compared[1], compared[2], compared[3], compared[4], compared[5]) ?? custom;
  }
  return custom;
}

// `"id" in tags[]._ref` (a list of references) or `"news" in tags` (of text).
function containsCondition(field: string, quoted: string | undefined, number: string | undefined): LoopCondition | undefined {
  const reference = field.endsWith('[]._ref') ? field.slice(0, -'[]._ref'.length) : undefined;
  const text = quoted === undefined ? undefined : groqStringValue(quoted);
  if (reference !== undefined) {
    return text !== undefined && isDocumentId(text) && isFieldPath(reference)
      ? { kind: 'test', field: reference, operator: 'has', value: { kind: 'reference', id: text } }
      : undefined;
  }
  if (!isFieldPath(field)) {
    return undefined;
  }
  if (text !== undefined) {
    return { kind: 'test', field, operator: 'has', value: { kind: 'text', text } };
  }
  return number === undefined ? undefined : { kind: 'test', field, operator: 'has', value: { kind: 'number', number: Number(number) } };
}

function comparedCondition(
  path: string,
  operator: string,
  quoted: string | undefined,
  number: string | undefined,
  boolean: string | undefined,
): LoopCondition | undefined {
  const reference = path.endsWith('._ref');
  const field = reference ? path.slice(0, -'._ref'.length) : path;
  if (!isFieldPath(field)) {
    return undefined;
  }
  if (boolean !== undefined) {
    // `!= true` keeps items with no value too, as "is false" means; `== false` does not.
    if (boolean === 'true' && operator === '==') {
      return { kind: 'test', field, operator: 'isTrue' };
    }
    return boolean === 'true' && operator === '!=' ? { kind: 'test', field, operator: 'isFalse' } : undefined;
  }
  const text = quoted === undefined ? undefined : groqStringValue(quoted);
  if (operator === '==' || operator === '!=') {
    const literal = literalOf(reference ? 'reference' : 'value', text, number);
    return literal === undefined ? undefined : { kind: 'test', field, operator: operator === '==' ? 'is' : 'isNot', value: literal };
  }
  if (reference) {
    return undefined;
  }
  if (text !== undefined) {
    if (!isDateValue(text)) {
      return undefined;
    }
    return operator === '<'
      ? { kind: 'test', field, operator: 'before', value: text }
      : operator === '>'
        ? { kind: 'test', field, operator: 'after', value: text }
        : undefined;
  }
  const value = Number(number);
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const operators = { '>': 'greater', '<': 'less', '>=': 'atLeast', '<=': 'atMost' } as const;
  const named = operator === '>' || operator === '<' || operator === '>=' || operator === '<=' ? operators[operator] : undefined;
  return named === undefined ? undefined : { kind: 'test', field, operator: named, value };
}

function literalOf(form: 'reference' | 'value', text: string | undefined, number: string | undefined): LoopLiteral | undefined {
  if (form === 'reference') {
    return text !== undefined && isDocumentId(text) ? { kind: 'reference', id: text } : undefined;
  }
  if (text !== undefined) {
    return text.length <= LOOP_QUERY_LIMITS.valueCharsMax ? { kind: 'text', text } : undefined;
  }
  const value = Number(number);
  return Number.isFinite(value) ? { kind: 'number', number: value } : undefined;
}

/** The text a GROQ string literal holds (JSON escapes, either quote). */
export function groqStringValue(literal: string): string | undefined {
  const quote = literal.charAt(0);
  if (quote === "'") {
    const body = literal.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"');
    return parseJSONString(`"${body}"`);
  }
  return quote === '"' ? parseJSONString(literal) : undefined;
}

function parseJSONString(text: string): string | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

// `_id in ["a", "b"]` as its ids, or undefined when the clause is anything else.
function pickedIds(clause: string): readonly string[] | undefined {
  const list = /^_id\s+in\s+\[([\s\S]*)\]$/.exec(clause.trim())?.[1];
  if (list === undefined) {
    return undefined;
  }
  const items = splitTop(list, ',');
  if (items.length > LOOP_QUERY_LIMITS.selectionMax) {
    return undefined;
  }
  const ids: string[] = [];
  for (const item of items) {
    const id = groqStringValue(item);
    if (id === undefined || !isItemId(id)) {
      return undefined;
    }
    ids.push(id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Scanning: positions outside strings, at bracket depth zero.
// ---------------------------------------------------------------------------

const OPENERS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };

/** Where the bracket at `open` closes, skipping strings and nested brackets. */
function matching(text: string, open: number): number | undefined {
  const stack: string[] = [];
  for (let index = open; index < text.length; index++) {
    const character = text.charAt(index);
    if (character === '"' || character === "'") {
      index = stringEnd(text, index);
      continue;
    }
    const closer = OPENERS[character];
    if (closer !== undefined) {
      stack.push(closer);
    } else if (character === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) {
        return index;
      }
    }
  }
  return undefined;
}

function stringEnd(text: string, start: number): number {
  const quote = text.charAt(start);
  let index = start + 1;
  while (index < text.length && text.charAt(index) !== quote) {
    index += text.charAt(index) === '\\' ? 2 : 1;
  }
  return index;
}

/** The text split at each top-level `separator`, each part trimmed. */
function splitTop(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text.charAt(index);
    if (character === '"' || character === "'") {
      index = stringEnd(text, index);
    } else if (OPENERS[character] !== undefined) {
      depth++;
    } else if (character === ')' || character === ']' || character === '}') {
      depth--;
    } else if (depth === 0 && text.startsWith(separator, index)) {
      parts.push(text.slice(start, index).trim());
      start = index + separator.length;
      index = start - 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter((part) => part !== '');
}

// `(a || b)` → `a || b`, only when the parentheses enclose the whole clause.
function unwrapped(clause: string): string | undefined {
  return clause.startsWith('(') && matching(clause, 0) === clause.length - 1 ? clause.slice(1, -1).trim() : undefined;
}

function stripComments(text: string): string {
  let out = '';
  for (let index = 0; index < text.length; index++) {
    const character = text.charAt(index);
    if (character === '"' || character === "'") {
      const end = stringEnd(text, index);
      out += text.slice(index, end + 1);
      index = end;
    } else if (character === '/' && text.charAt(index + 1) === '/') {
      const end = text.indexOf('\n', index);
      index = end < 0 ? text.length : end - 1;
    } else {
      out += character;
    }
  }
  return out;
}

function stripStrings(text: string): string {
  let out = '';
  for (let index = 0; index < text.length; index++) {
    const character = text.charAt(index);
    if (character === '"' || character === "'") {
      index = stringEnd(text, index);
      out += '""';
    } else {
      out += character;
    }
  }
  return out;
}
