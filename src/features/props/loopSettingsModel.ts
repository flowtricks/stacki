// The words and menus of the loop's list settings, apart from the React that
// draws them: what each operator and order is called for a field of each kind,
// the one-line summary a filter or sort shows when closed, and the check a
// half-made filter must pass before it is written. Pure, so it is tested
// without a DOM (test/renderer/props/loopSettings.test.js).

import { assert } from '../../../shared/core/assert';
import type { LoopReading } from '../../editor/loopQueryRead';
import { parseExpression } from '../../editor/loopSyntax';
import { readGroq } from '../../editor/groqSyntax';
import {
  emptyQuery,
  isDateValue,
  isDocumentId,
  LOOP_QUERY_LIMITS,
  operatorsFor,
  type LoopQuery,
  type LoopCondition,
  type LoopFieldKind,
  type LoopLiteral,
  type LoopOperator,
  type LoopSort,
  type LoopSortOrder,
  type LoopSource,
  type LoopSourceKind,
} from '../../editor/loopQuery';
import type { CatalogField } from './loopCatalog';
import { titled } from './loopCatalog';

const OPERATOR_LABELS: Readonly<Record<LoopOperator, string>> = {
  is: 'Equals',
  isNot: 'Does not equal',
  contains: 'Contains',
  has: 'Includes',
  isSet: 'Is set',
  isEmpty: 'Is not set',
  isTrue: 'Is on',
  isFalse: 'Is off',
  greater: 'Greater than',
  less: 'Less than',
  atLeast: 'At least',
  atMost: 'At most',
  before: 'Is before',
  after: 'Is after',
  inPast: 'Is in the past',
  inFuture: 'Is in the future',
};

const OPERATOR_SYMBOLS: Partial<Readonly<Record<LoopOperator, string>>> = {
  is: '=',
  isNot: '≠',
  greater: '>',
  less: '<',
  atLeast: '≥',
  atMost: '≤',
};

export function operatorLabel(operator: LoopOperator): string {
  return OPERATOR_LABELS[operator];
}

/** The ways to order a field's values, named for what they are. */
export function orderLabels(order: LoopSortOrder): { readonly ascending: string; readonly descending: string } {
  switch (order) {
    case 'text':
      return { ascending: 'A to Z', descending: 'Z to A' };
    case 'number':
      return { ascending: 'Smallest to largest', descending: 'Largest to smallest' };
    case 'date':
      return { ascending: 'Oldest to newest', descending: 'Newest to oldest' };
    case 'boolean':
      return { ascending: 'Is Off First', descending: 'Is On First' };
    case 'natural':
      return { ascending: 'A to Z, numbers in order', descending: 'Z to A, numbers in order' };
    case 'length':
      return { ascending: 'Shortest first', descending: 'Longest first' };
    case 'count':
      return { ascending: 'Fewest items first', descending: 'Most items first' };
    case 'fileSize':
      return { ascending: 'Smallest file first', descending: 'Largest file first' };
    default: {
      const exhaustive: never = order;
      return exhaustive;
    }
  }
}

/** The key the Source menu knows the current list by. */
export type SourceKey = 'empty' | 'custom' | `astro:${string}` | `sanity:${string}` | `value:${string}`;

export function sourceKey(source: LoopSource): SourceKey {
  return source.kind === 'astro' ? `astro:${source.collection}` : `sanity:${source.collection}`;
}

/** What the Source menu shows as chosen for a reading. */
export function readingKey(reading: LoopReading, data: string): SourceKey {
  switch (reading.kind) {
    case 'empty':
      return 'empty';
    case 'query':
      return sourceKey(reading.query.source);
    case 'partial':
      return sourceKey(reading.source);
    case 'value':
      return `value:${data.trim()}`;
    case 'code':
      return 'custom';
    default: {
      const exhaustive: never = reading;
      return exhaustive;
    }
  }
}

/** A Source menu key back as what it names. */
export function parseSourceKey(
  key: string,
): { readonly kind: 'empty' } | { readonly kind: 'collection'; readonly source: LoopSource } | { readonly kind: 'value'; readonly data: string } | undefined {
  if (key === 'empty') {
    return { kind: 'empty' };
  }
  const at = key.indexOf(':');
  const prefix = key.slice(0, at);
  const rest = key.slice(at + 1);
  if (at < 0 || rest === '') {
    return undefined;
  }
  if (prefix === 'astro' || prefix === 'sanity') {
    return { kind: 'collection', source: { kind: prefix, collection: rest } };
  }
  return prefix === 'value' ? { kind: 'value', data: rest } : undefined;
}

export function fieldNamed(fields: readonly CatalogField[] | undefined, path: string): CatalogField | undefined {
  return fields?.find((field) => field.path === path);
}

/** The field's title, or its name made readable when the schema is not loaded. */
export function fieldTitle(fields: readonly CatalogField[] | undefined, path: string): string {
  return fieldNamed(fields, path)?.title ?? titled(path.split('.')[0] ?? path);
}

/** A closed row's two parts: the field, drawn quieter, and what is asked of it. */
export interface RowParts {
  readonly lead: string;
  readonly rest: string;
}

/** "Category" + "= Get Involved", "Featured" + "is on", "Date" + "is before 1 Jan 2024". */
export function conditionParts(
  condition: LoopCondition,
  fields: readonly CatalogField[] | undefined,
  choices: readonly { readonly title: string; readonly value: string }[],
): RowParts {
  if (condition.kind === 'custom') {
    return { lead: 'Custom', rest: condition.code.replace(/\s+/g, ' ') };
  }
  const field = fieldTitle(fields, condition.field);
  const symbol = OPERATOR_SYMBOLS[condition.operator];
  const verb = symbol ?? OPERATOR_LABELS[condition.operator].toLowerCase();
  const value = 'value' in condition ? valueText(condition.value, fieldNamed(fields, condition.field), choices) : '';
  assert(field.length > 0, 'A condition names its field');
  return { lead: field, rest: value === '' ? verb : `${verb} ${value}` };
}

/** The parts as one line: "Category = Get Involved". */
export function conditionSummary(
  condition: LoopCondition,
  fields: readonly CatalogField[] | undefined,
  choices: readonly { readonly title: string; readonly value: string }[],
): string {
  const parts = conditionParts(condition, fields, choices);
  return condition.kind === 'custom' ? `${parts.lead}: ${parts.rest}` : `${parts.lead} ${parts.rest}`;
}

function valueText(
  value: LoopLiteral | string | number,
  field: CatalogField | undefined,
  choices: readonly { readonly title: string; readonly value: string }[],
): string {
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'string') {
    return isDateValue(value) ? dateText(value) : value;
  }
  switch (value.kind) {
    case 'number':
      return String(value.number);
    case 'text':
      return field?.options.find((option) => option.value === value.text)?.title ?? choices.find((choice) => choice.value === value.text)?.title ?? value.text;
    case 'reference':
      return field?.options.find((option) => option.value === value.id)?.title ?? choices.find((choice) => choice.value === value.id)?.title ?? value.id;
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

function dateText(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function sortParts(sort: LoopSort, fields: readonly CatalogField[] | undefined): RowParts {
  return { lead: fieldTitle(fields, sort.field), rest: orderLabels(sort.order)[sort.direction] };
}

export function sortSummary(sort: LoopSort, fields: readonly CatalogField[] | undefined): string {
  const parts = sortParts(sort, fields);
  return `${parts.lead} · ${parts.rest}`;
}

// ---------------------------------------------------------------------------
// A filter while it is being made.
// ---------------------------------------------------------------------------

/** A filter as the editor holds it: any value typed so far, as text. */
export interface ConditionDraft {
  readonly field: string;
  readonly operator: LoopOperator;
  readonly value: string;
}

/** A fresh filter on `field`, at its first operator. */
export function draftFor(field: CatalogField): ConditionDraft {
  const operator = operatorsFor(field.kind)[0];
  assert(operator !== undefined, 'Every field kind offers an operator');
  return { field: field.path, operator, value: field.options[0]?.value ?? '' };
}

/** A condition as the editor shows it. */
export function draftOf(condition: Extract<LoopCondition, { readonly kind: 'test' }>): ConditionDraft {
  if (!('value' in condition)) {
    return { field: condition.field, operator: condition.operator, value: '' };
  }
  const value = condition.value;
  if (typeof value === 'number') {
    return { field: condition.field, operator: condition.operator, value: String(value) };
  }
  if (typeof value === 'string') {
    return { field: condition.field, operator: condition.operator, value };
  }
  const text = value.kind === 'number' ? String(value.number) : value.kind === 'text' ? value.text : value.id;
  return { field: condition.field, operator: condition.operator, value: text };
}

/**
 * The draft as a condition, or undefined while it is not one yet: a number
 * that is not a number, a date that is not a date, a search for nothing. The
 * editor writes nothing until this returns a condition, so a half-typed value
 * never reaches the page.
 */
export function conditionOf(draft: ConditionDraft, kind: LoopFieldKind): LoopCondition | undefined {
  const field = draft.field;
  const text = draft.value;
  if (text.length > LOOP_QUERY_LIMITS.valueCharsMax) {
    return undefined;
  }
  switch (draft.operator) {
    case 'isSet':
    case 'isEmpty':
    case 'isTrue':
    case 'isFalse':
    case 'inPast':
    case 'inFuture':
      return { kind: 'test', field, operator: draft.operator };
    case 'is':
    case 'isNot':
    case 'has': {
      const value = literalOf(text, kind);
      return value === undefined ? undefined : { kind: 'test', field, operator: draft.operator, value };
    }
    case 'contains':
      return text.trim() === '' ? undefined : { kind: 'test', field, operator: 'contains', value: text };
    case 'greater':
    case 'less':
    case 'atLeast':
    case 'atMost': {
      const number = numberOf(text);
      return number === undefined ? undefined : { kind: 'test', field, operator: draft.operator, value: number };
    }
    case 'before':
    case 'after':
      return isDateValue(text) ? { kind: 'test', field, operator: draft.operator, value: text } : undefined;
    default: {
      const exhaustive: never = draft.operator;
      return exhaustive;
    }
  }
}

function literalOf(text: string, kind: LoopFieldKind): LoopLiteral | undefined {
  if (kind === 'number') {
    const number = numberOf(text);
    return number === undefined ? undefined : { kind: 'number', number };
  }
  if (kind === 'reference') {
    // A choice whose value cannot be an id (`Get Involved`) is plain text.
    if (text === '') {
      return undefined;
    }
    return isDocumentId(text) ? { kind: 'reference', id: text } : { kind: 'text', text };
  }
  return text === '' ? undefined : { kind: 'text', text };
}

function numberOf(text: string): number | undefined {
  if (text.trim() === '') {
    return undefined;
  }
  const number = Number(text);
  return Number.isFinite(number) ? number : undefined;
}

/** A whole number typed into Show or Skip, held to the bounds a query allows. */
export function wholeNumberOf(text: string, bounds: { readonly min: number; readonly max: number }): number | undefined {
  if (!/^\s*\d+\s*$/.test(text)) {
    return undefined;
  }
  const number = Number(text);
  assert(bounds.min <= bounds.max, 'Bounds are ordered');
  return Number.isSafeInteger(number) ? Math.min(bounds.max, Math.max(bounds.min, number)) : undefined;
}

/**
 * The query a collection list's Items switch writes, or undefined when it is
 * already in that mode. Each mode is code: Selected is a list with nothing
 * picked yet (it still names its collection, and renders no items until some
 * are picked), so the switch is one undo step and Undo puts Dynamic back.
 * Either way the other mode's settings go, as a builder clears them; the
 * projection and the entry's name are how the code reads, and stay.
 */
export function itemsModeQuery(query: LoopQuery, mode: 'dynamic' | 'selected'): LoopQuery | undefined {
  const base: LoopQuery = { ...emptyQuery(query.source), projection: query.projection, parameter: query.parameter };
  assert(base.selection === undefined, 'A dynamic list picks nothing');
  if (mode === 'selected') {
    return query.selection === undefined ? { ...base, selection: [] } : undefined;
  }
  return query.selection === undefined ? undefined : base;
}

/**
 * Why a custom filter cannot be written, or undefined when it can: one
 * JavaScript expression over the item for an Astro list, one GROQ condition
 * for a Sanity type. Checked before it is written, so the page never holds
 * code that does not parse.
 */
export function customFilterProblem(code: string, source: LoopSourceKind): string | undefined {
  const text = code.trim();
  if (text === '') {
    return 'Type a condition.';
  }
  if (text.length > LOOP_QUERY_LIMITS.customCodeCharsMax) {
    return 'This condition is too long.';
  }
  if (source === 'sanity') {
    // Read as a clause of the query it joins, the way the writer places it.
    const reading = readGroq(`*[_type == "item" && (${text})]`);
    return reading === undefined ? 'This is not a GROQ condition.' : undefined;
  }
  return parseExpression(text) === undefined ? 'This is not one JavaScript expression.' : undefined;
}

/** Why a custom sort cannot be written: it must be a comparator, `(a, b) => …`. */
export function customSortProblem(code: string): string | undefined {
  const text = code.trim();
  if (text === '') {
    return 'Type a comparator, such as (a, b) => a.data.order - b.data.order.';
  }
  if (text.length > LOOP_QUERY_LIMITS.customCodeCharsMax) {
    return 'This sort is too long.';
  }
  const parsed = parseExpression(text);
  if (parsed === undefined) {
    return 'This is not one JavaScript expression.';
  }
  const expression = parsed.expression;
  if (expression.kind !== 'function' || expression.parameters.length !== 2) {
    return 'A sort compares two items: write (a, b) => …';
  }
  return undefined;
}
