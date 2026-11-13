// The words and menus of the loop's list settings, apart from the React that
// draws them: what each operator and order is called for a field of each kind,
// the one-line summary a filter or sort shows when closed, and the check a
// half-made filter must pass before it is written. Pure, so it is tested
// without a DOM (test/renderer/props/loopSettings.test.js).

import { assert } from '../../../shared/core/assert';
import { ENGLISH_TRANSLATE } from '../../../shared/properties/i18n/englishTranslator';
import type { MessageKey, Translator } from '../../../shared/properties/i18n/messageRef';
import type { LoopReading } from '../../editor/loopQueryRead';
import type { LoopSection, LoopSections } from '../../editor/loopSections';
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

/** The message that names each operator: translate it where it is drawn. */
const OPERATOR_KEYS: Readonly<Record<LoopOperator, MessageKey>> = {
  is: 'props.loop.operator.is',
  isNot: 'props.loop.operator.isNot',
  contains: 'props.loop.operator.contains',
  has: 'props.loop.operator.has',
  isSet: 'props.loop.operator.isSet',
  isEmpty: 'props.loop.operator.isEmpty',
  isTrue: 'props.loop.operator.isTrue',
  isFalse: 'props.loop.operator.isFalse',
  greater: 'props.loop.operator.greater',
  less: 'props.loop.operator.less',
  atLeast: 'props.loop.operator.atLeast',
  atMost: 'props.loop.operator.atMost',
  before: 'props.loop.operator.before',
  after: 'props.loop.operator.after',
  inPast: 'props.loop.operator.inPast',
  inFuture: 'props.loop.operator.inFuture',
};

const OPERATOR_SYMBOLS: Partial<Readonly<Record<LoopOperator, string>>> = {
  is: '=',
  isNot: '≠',
  greater: '>',
  less: '<',
  atLeast: '≥',
  atMost: '≤',
};

export function operatorLabel(operator: LoopOperator, translate: Translator = ENGLISH_TRANSLATE): string {
  return translate(OPERATOR_KEYS[operator]);
}

/** The ways to order a field's values, named for what they are. */
export function orderLabels(order: LoopSortOrder, translate: Translator = ENGLISH_TRANSLATE): { readonly ascending: string; readonly descending: string } {
  switch (order) {
    case 'text':
      return { ascending: translate('props.loop.order.text.ascending'), descending: translate('props.loop.order.text.descending') };
    case 'number':
      return { ascending: translate('props.loop.order.number.ascending'), descending: translate('props.loop.order.number.descending') };
    case 'date':
      return { ascending: translate('props.loop.order.date.ascending'), descending: translate('props.loop.order.date.descending') };
    case 'boolean':
      return { ascending: translate('props.loop.order.boolean.ascending'), descending: translate('props.loop.order.boolean.descending') };
    case 'natural':
      return { ascending: translate('props.loop.order.natural.ascending'), descending: translate('props.loop.order.natural.descending') };
    case 'length':
      return { ascending: translate('props.loop.order.length.ascending'), descending: translate('props.loop.order.length.descending') };
    case 'count':
      return { ascending: translate('props.loop.order.count.ascending'), descending: translate('props.loop.order.count.descending') };
    case 'fileSize':
      return { ascending: translate('props.loop.order.fileSize.ascending'), descending: translate('props.loop.order.fileSize.descending') };
    default: {
      const exhaustive: never = order;
      return exhaustive;
    }
  }
}

/** The key the Source menu knows the current list by. */
export type SourceKey = 'empty' | 'custom' | `astro:${string}` | `sanity:${string}` | `value:${string}`;

export function sourceKey(source: LoopSource): SourceKey {
  switch (source.kind) {
    case 'astro':
      return `astro:${source.collection}`;
    case 'sanity':
      return `sanity:${source.collection}`;
    case 'list':
      // The prop as the Source menu lists it, whatever settings refine it.
      return `value:${source.collection}`;
    default: {
      const exhaustive: never = source.kind;
      return exhaustive;
    }
  }
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
  translate: Translator = ENGLISH_TRANSLATE,
  locale?: string,
): RowParts {
  if (condition.kind === 'custom') {
    return { lead: translate('props.loop.condition.custom'), rest: condition.code.replace(/\s+/g, ' ') };
  }
  const field = fieldTitle(fields, condition.field);
  const symbol = OPERATOR_SYMBOLS[condition.operator];
  const verb = symbol ?? translate(OPERATOR_KEYS[condition.operator]).toLowerCase();
  const value = 'value' in condition ? valueText(condition.value, fieldNamed(fields, condition.field), choices, locale) : '';
  assert(field.length > 0, 'A condition names its field');
  return { lead: field, rest: value === '' ? verb : `${verb} ${value}` };
}

/** The parts as one line: "Category = Get Involved". */
export function conditionSummary(
  condition: LoopCondition,
  fields: readonly CatalogField[] | undefined,
  choices: readonly { readonly title: string; readonly value: string }[],
  translate: Translator = ENGLISH_TRANSLATE,
  locale?: string,
): string {
  const parts = conditionParts(condition, fields, choices, translate, locale);
  return condition.kind === 'custom' ? `${parts.lead}: ${parts.rest}` : `${parts.lead} ${parts.rest}`;
}

function valueText(
  value: LoopLiteral | string | number,
  field: CatalogField | undefined,
  choices: readonly { readonly title: string; readonly value: string }[],
  locale: string | undefined,
): string {
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'string') {
    return isDateValue(value) ? dateText(value, locale) : value;
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

function dateText(value: string, locale: string | undefined): string {
  const date = new Date(`${value}T00:00:00Z`);
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function sortParts(sort: LoopSort, fields: readonly CatalogField[] | undefined, translate: Translator = ENGLISH_TRANSLATE): RowParts {
  return { lead: fieldTitle(fields, sort.field), rest: orderLabels(sort.order, translate)[sort.direction] };
}

export function sortSummary(sort: LoopSort, fields: readonly CatalogField[] | undefined, translate: Translator = ENGLISH_TRANSLATE): string {
  const parts = sortParts(sort, fields, translate);
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

/** What a section's empty code box suggests, in the code of the list's source. */
export function sectionPlaceholder(section: LoopSection, source: LoopSourceKind): string {
  switch (section) {
    case 'filter':
      return source === 'sanity' ? 'featured == true' : source === 'list' ? '(item) => item.number > 1' : '({ data }) => data.featured';
    case 'sort':
      return source === 'sanity' ? 'order(name asc)' : source === 'list' ? '(a, b) => a.number - b.number' : '(a, b) => a.data.order - b.data.order';
    case 'limit':
      return source === 'sanity' ? '[0...6]' : '6';
    default: {
      const exhaustive: never = section;
      return exhaustive;
    }
  }
}

/**
 * The fields a section's code can name, as its own code reads them: the item a
 * filter's function takes, and the two a comparator compares.
 */
export function sectionFieldPaths(
  section: LoopSection,
  sections: Pick<LoopSections, 'query' | 'store' | 'itemPath'>,
  fields: readonly CatalogField[] | undefined,
): readonly string[] {
  if (section === 'limit' || sections.store === 'groq') {
    return (section === 'limit' ? [] : (fields ?? [])).map((field) => field.path);
  }
  const parameter = sections.query.parameter;
  const item = parameter.kind === 'entry' ? [parameter.name, ...sections.itemPath] : ['data'];
  const names = section === 'filter' ? [item.join('.')] : ['a', 'b'].map((name) => [name, ...sections.itemPath].join('.'));
  return names.flatMap((name) => (fields ?? []).map((field) => `${name}.${field.path}`));
}

/**
 * Why a custom filter cannot be written, or undefined when it can: one
 * JavaScript expression over the item for an Astro list, one GROQ condition
 * for a Sanity type. Checked before it is written, so the page never holds
 * code that does not parse.
 */
export function customFilterProblem(code: string, source: LoopSourceKind, translate: Translator = ENGLISH_TRANSLATE): string | undefined {
  const text = code.trim();
  if (text === '') {
    return translate('props.loop.problem.filterEmpty');
  }
  if (text.length > LOOP_QUERY_LIMITS.customCodeCharsMax) {
    return translate('props.loop.problem.filterTooLong');
  }
  if (source === 'sanity') {
    // Read as a clause of the query it joins, the way the writer places it.
    const reading = readGroq(`*[_type == "item" && (${text})]`);
    return reading === undefined ? translate('props.loop.problem.filterNotGroq') : undefined;
  }
  return parseExpression(text) === undefined ? translate('props.loop.problem.notExpression') : undefined;
}

/** Why a custom sort cannot be written: it must be a comparator, `(a, b) => …`. */
export function customSortProblem(code: string, translate: Translator = ENGLISH_TRANSLATE): string | undefined {
  const text = code.trim();
  if (text === '') {
    return translate('props.loop.problem.sortEmpty');
  }
  if (text.length > LOOP_QUERY_LIMITS.customCodeCharsMax) {
    return translate('props.loop.problem.sortTooLong');
  }
  const parsed = parseExpression(text);
  if (parsed === undefined) {
    return translate('props.loop.problem.notExpression');
  }
  const expression = parsed.expression;
  if (expression.kind !== 'function' || expression.parameters.length !== 2) {
    return translate('props.loop.problem.sortNotComparator');
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// A section's reset: what its blue title's Reset menu writes (LoopRows.tsx).
// ---------------------------------------------------------------------------

/** The query with no filters, matching all again: the match mode is the filters' own. */
export function filtersReset(query: LoopQuery): LoopQuery {
  const next: LoopQuery = { ...query, conditions: [], match: 'all' };
  assert(next.conditions.length === 0, 'A filters reset leaves no condition');
  assert(next.sorts === query.sorts, 'A filters reset leaves the sort alone');
  return next;
}

/** The query in its source's own order: no sort keys, no shuffle, no comparator. */
export function sortReset(query: LoopQuery): LoopQuery {
  const next: LoopQuery = { ...query, sorts: [], random: false, customSort: undefined };
  assert(next.customSort === undefined, 'A sort reset leaves no custom sort');
  assert(next.conditions === query.conditions, 'A sort reset leaves the filters alone');
  return next;
}

/** The query showing every item from the first, as the Limit switch turned off writes it. */
export function limitReset(query: LoopQuery): LoopQuery {
  const next: LoopQuery = { ...query, limit: undefined, offset: 0 };
  assert(next.offset === 0, 'A limit reset skips nothing');
  assert(next.sorts === query.sorts, 'A limit reset leaves the sort alone');
  return next;
}
