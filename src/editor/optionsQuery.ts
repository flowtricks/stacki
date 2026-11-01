// Collection lists exported from a visual builder keep their settings as data:
//
//   const items1 = queryItems(collections["campus"] || [],
//     { "sort": [{ "field": "sort-order", "direction": "asc" }],
//       "filter": { "filterFor": "ALL", "fields": [{ "fieldPath": "category", "operatorName": "eq", "value": "Care" }] },
//       "limit": 6 }, collectionData);
//
// A helper (here `queryItems`) applies them at runtime. The settings are an
// object literal in the page, so they are read from it and written back into
// it, entry for entry, keeping every key this module does not own. The filter
// may instead be a prop (`"filter": propFilters`), each use of the component
// passing its own; then the prop's default holds the filters edited here.
//
// The collection is found by following the first argument through the
// frontmatter to the `getCollection` that reads it: `collections["campus"]`
// is the `campus` entry of a `collections` object whose value reads
// `getCollection("campus")` (filtered and reshaped on the way, which only
// changes how an item is shaped, not which collection it is).

import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import {
  isDateValue,
  isFieldPath,
  LOOP_QUERY_LIMITS,
  type LoopCondition,
  type LoopFieldKind,
  type LoopLiteral,
  type LoopQuery,
  type LoopSort,
  type LoopSource,
} from './loopQuery';
import { destructuredDefault, type Js, type JsEntry, type ParsedFrontmatter } from './loopSyntax';

/** Where an options query lives in the frontmatter, so an edit rewrites just that. */
export interface OptionsHome {
  readonly kind: 'options';
  /** The function that applies the options, as the page calls it. */
  readonly reader: string;
  /** The options object literal. */
  readonly options: Span;
  readonly filter:
    | { readonly kind: 'inline' }
    | { readonly kind: 'prop'; readonly name: string; readonly literal: Span }
    | { readonly kind: 'none' };
}

interface Span {
  readonly from: number;
  readonly to: number;
}

const OPTION_KEYS = new Set([
  'sort',
  'filter',
  'limit',
  'offset',
  'skip',
  'curated',
  'curatedItemIds',
]);
const COLLECTION_STEPS_MAX = 12;

type Lookup = (name: string) => Js | undefined;

/** The query an options call says, or undefined when `init` is not one. */
export function readOptionsQuery(
  init: Js,
  context: {
    readonly frontmatter: ParsedFrontmatter;
    readonly importedFrom: (local: string, spec: string) => string | undefined;
    readonly fieldKind?:
      ((source: LoopSource, path: string) => LoopFieldKind | undefined) | undefined;
  },
): { readonly query: LoopQuery; readonly home: OptionsHome } | undefined {
  const call = init.kind === 'await' ? init.value : init;
  if (call.kind !== 'call' || call.callee.kind !== 'name') {
    return undefined;
  }
  const [list, options] = call.args;
  if (
    list === undefined ||
    options?.kind !== 'object' ||
    !options.entries.some((entry) => entry.key !== undefined && OPTION_KEYS.has(entry.key))
  ) {
    return undefined;
  }
  const lookup: Lookup = (name) => context.frontmatter.declarations.get(name)?.init;
  const collection = collectionOf(list, lookup, context.importedFrom);
  if (collection === undefined) {
    return undefined;
  }
  const source: LoopSource = { kind: 'astro', collection };
  const kind = (path: string): LoopFieldKind | undefined => context.fieldKind?.(source, path);
  const filterValue = entryValue(options.entries, 'filter');
  const filter = filterOf(filterValue, context.frontmatter.source, kind);
  if (filter === undefined) {
    return undefined;
  }
  const sorts = sortsOf(entryValue(options.entries, 'sort'), kind);
  const offset =
    wholeOf(entryValue(options.entries, 'offset') ?? entryValue(options.entries, 'skip')) ?? 0;
  const limit = wholeOf(entryValue(options.entries, 'limit'));
  if (
    sorts === undefined ||
    offset > LOOP_QUERY_LIMITS.offsetMax ||
    (limit !== undefined && limit > LOOP_QUERY_LIMITS.limitMax)
  ) {
    return undefined;
  }
  const query: LoopQuery = {
    source,
    match: filter.match,
    conditions: filter.conditions,
    sorts,
    random: false,
    offset,
    limit: limit === 0 ? undefined : limit,
    projection: undefined,
    parameter: { kind: 'data' },
  };
  assert(
    query.conditions.length <= LOOP_QUERY_LIMITS.conditionsMax,
    'An options query has bounded conditions',
  );
  return {
    query,
    home: {
      kind: 'options',
      reader: call.callee.name,
      options: { from: options.from, to: options.to },
      filter: filter.home,
    },
  };
}

// `collections["campus"] || []` → `campus`, through names, object entries,
// awaits and method chains, to the getCollection call. Iterative and bounded.
function collectionOf(
  start: Js,
  lookup: Lookup,
  importedFrom: (local: string, spec: string) => string | undefined,
): string | undefined {
  return listCollectionOf(start, { lookup, importedFrom })?.collection;
}

/**
 * The collection a list expression reads, and where its items keep their
 * fields: `data` as Astro gives them, or what the last `.map` reshaped them
 * to (`({ id, fields: … })` → `fields`). Undefined when a step reshapes items
 * into anything else, or the expression is not a collection's.
 */
export function listCollectionOf(
  start: Js,
  context: {
    readonly lookup: (name: string) => Js | undefined;
    readonly importedFrom: (local: string, spec: string) => string | undefined;
  },
): { readonly collection: string; readonly itemPath: readonly string[] } | undefined {
  let current: Js | undefined = start;
  const keys: string[] = [];
  // The outermost `.map` is the last applied: it decides the shape.
  let itemPath: readonly string[] | undefined;
  for (let step = 0; current !== undefined && step < COLLECTION_STEPS_MAX; step++) {
    const node: Js = current;
    if (node.kind === 'binary' && (node.operator === '||' || node.operator === '??')) {
      current = node.left;
    } else if (node.kind === 'await') {
      current = node.value;
    } else if (node.kind === 'member') {
      keys.push(node.property);
      current = node.object;
    } else if (node.kind === 'name') {
      current = context.lookup(node.name);
    } else if (node.kind === 'object') {
      const key = keys.pop();
      current = key === undefined ? undefined : entryValue(node.entries, key);
    } else if (
      node.kind === 'call' &&
      node.callee.kind === 'name' &&
      context.importedFrom(node.callee.name, 'astro:content') === 'getCollection'
    ) {
      const first = node.args[0];
      return first?.kind === 'string'
        ? { collection: first.value, itemPath: itemPath ?? ['data'] }
        : undefined;
    } else if (node.kind === 'call' && node.callee.kind === 'member') {
      if (node.callee.property === 'map' && itemPath === undefined) {
        const shaped = shapeOf(node.args[0]);
        if (shaped === undefined) {
          return undefined;
        }
        itemPath = shaped;
      }
      current = node.callee.object; // `.filter(…)`: still the same collection.
    } else {
      return undefined;
    }
  }
  return undefined;
}

// `entry => ({ id: …, fields: … })` keeps fields under `fields`.
function shapeOf(callback: Js | undefined): readonly string[] | undefined {
  const body = callback?.kind === 'function' ? callback.body : undefined;
  if (body?.kind !== 'object') {
    return undefined;
  }
  if (body.entries.some((entry) => entry.key === 'fields')) {
    return ['fields'];
  }
  return body.entries.some((entry) => entry.key === 'data') ? ['data'] : undefined;
}

function entryValue(entries: readonly JsEntry[], key: string): Js | undefined {
  return entries.find((entry) => entry.key === key)?.value;
}

interface FilterReading {
  readonly match: 'all' | 'any';
  readonly conditions: readonly LoopCondition[];
  readonly home: OptionsHome['filter'];
}

function filterOf(
  value: Js | undefined,
  frontmatter: string,
  kind: (path: string) => LoopFieldKind | undefined,
): FilterReading | undefined {
  if (value === undefined) {
    return { match: 'all', conditions: [], home: { kind: 'none' } };
  }
  if (value.kind === 'name') {
    const fallback = destructuredDefault(frontmatter, value.name);
    if (fallback?.kind !== 'object') {
      return undefined;
    }
    const read = filterObject(fallback, frontmatter, kind);
    return read === undefined
      ? undefined
      : {
          ...read,
          home: {
            kind: 'prop',
            name: value.name,
            literal: { from: fallback.from, to: fallback.to },
          },
        };
  }
  if (value.kind !== 'object') {
    return undefined;
  }
  const read = filterObject(value, frontmatter, kind);
  return read === undefined ? undefined : { ...read, home: { kind: 'inline' } };
}

function filterObject(
  value: Extract<Js, { readonly kind: 'object' }>,
  frontmatter: string,
  kind: (path: string) => LoopFieldKind | undefined,
) {
  const filterFor = entryValue(value.entries, 'filterFor');
  const fields = entryValue(value.entries, 'fields');
  const match: 'all' | 'any' =
    filterFor?.kind === 'string' && filterFor.value.toUpperCase() === 'ANY' ? 'any' : 'all';
  if (fields !== undefined && fields.kind !== 'array') {
    return undefined;
  }
  const items = fields?.items ?? [];
  if (items.length > LOOP_QUERY_LIMITS.conditionsMax) {
    return undefined;
  }
  const conditions = items.map(
    (item) =>
      conditionOf(item, kind) ?? {
        kind: 'custom' as const,
        code: frontmatter.slice(item.from, item.to),
      },
  );
  return { match, conditions };
}

// One `{ fieldPath, operatorName, value }` as a condition, or undefined to keep it verbatim.
function conditionOf(
  item: Js,
  kind: (path: string) => LoopFieldKind | undefined,
): LoopCondition | undefined {
  if (item.kind !== 'object') {
    return undefined;
  }
  const path = entryValue(item.entries, 'fieldPath');
  const operator = entryValue(item.entries, 'operatorName');
  const value = entryValue(item.entries, 'value');
  if (path?.kind !== 'string' || operator?.kind !== 'string' || !isFieldPath(path.value)) {
    return undefined;
  }
  const field = path.value;
  const fieldKind = kind(field);
  switch (operator.value) {
    case 'exists':
      return { kind: 'test', field, operator: 'isSet' };
    case 'not-exists':
      return { kind: 'test', field, operator: 'isEmpty' };
    case 'eq':
    case 'ne':
      return equalityOf(field, operator.value, value, fieldKind);
    case 'contains': {
      const text = value?.kind === 'string' ? value.value : undefined;
      return text === undefined || text === ''
        ? undefined
        : { kind: 'test', field, operator: 'contains', value: text };
    }
    case 'idin': {
      const literal = literalOf(value, fieldKind);
      return literal === undefined
        ? undefined
        : { kind: 'test', field, operator: 'has', value: literal };
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return comparisonOf(field, operator.value, value);
    default:
      return undefined; // `in`, `nin`, `notin`, a value from the current item: kept as written.
  }
}

function equalityOf(
  field: string,
  operator: 'eq' | 'ne',
  value: Js | undefined,
  fieldKind: LoopFieldKind | undefined,
): LoopCondition | undefined {
  const switched =
    value?.kind === 'boolean'
      ? value.value
      : value?.kind === 'string' &&
          (value.value === 'true' || value.value === 'false') &&
          fieldKind === 'boolean'
        ? value.value === 'true'
        : undefined;
  if (switched !== undefined) {
    // `eq true` is "is on"; `ne true` keeps items with no value, as "is off" means.
    if (switched && operator === 'eq') {
      return { kind: 'test', field, operator: 'isTrue' };
    }
    return switched && operator === 'ne' ? { kind: 'test', field, operator: 'isFalse' } : undefined;
  }
  const literal = literalOf(value, fieldKind);
  return literal === undefined
    ? undefined
    : { kind: 'test', field, operator: operator === 'eq' ? 'is' : 'isNot', value: literal };
}

function literalOf(
  value: Js | undefined,
  fieldKind: LoopFieldKind | undefined,
): LoopLiteral | undefined {
  if (value?.kind === 'number') {
    return { kind: 'number', number: value.value };
  }
  if (value?.kind !== 'string' || value.value.length > LOOP_QUERY_LIMITS.valueCharsMax) {
    return undefined;
  }
  return fieldKind === 'number' && Number.isFinite(Number(value.value)) && value.value.trim() !== ''
    ? { kind: 'number', number: Number(value.value) }
    : { kind: 'text', text: value.value };
}

function comparisonOf(
  field: string,
  operator: 'gt' | 'gte' | 'lt' | 'lte',
  value: Js | undefined,
): LoopCondition | undefined {
  if (value?.kind === 'string' && isDateValue(value.value.slice(0, 10))) {
    if (operator === 'lt') {
      return { kind: 'test', field, operator: 'before', value: value.value.slice(0, 10) };
    }
    return operator === 'gt'
      ? { kind: 'test', field, operator: 'after', value: value.value.slice(0, 10) }
      : undefined;
  }
  const number =
    value?.kind === 'number'
      ? value.value
      : value?.kind === 'string' && value.value.trim() !== ''
        ? Number(value.value)
        : Number.NaN;
  if (!Number.isFinite(number)) {
    return undefined;
  }
  const named = { gt: 'greater', gte: 'atLeast', lt: 'less', lte: 'atMost' } as const;
  return { kind: 'test', field, operator: named[operator], value: number };
}

function sortsOf(
  value: Js | undefined,
  kind: (path: string) => LoopFieldKind | undefined,
): readonly LoopSort[] | undefined {
  if (value === undefined) {
    return [];
  }
  if (value.kind !== 'array' || value.items.length > LOOP_QUERY_LIMITS.sortsMax) {
    return undefined;
  }
  const sorts: LoopSort[] = [];
  for (const item of value.items) {
    const field = item.kind === 'object' ? entryValue(item.entries, 'field') : undefined;
    const direction = item.kind === 'object' ? entryValue(item.entries, 'direction') : undefined;
    if (field?.kind !== 'string' || !isFieldPath(field.value)) {
      return undefined;
    }
    const fieldKind = kind(field.value);
    sorts.push({
      field: field.value,
      direction:
        direction?.kind === 'string' && direction.value === 'desc' ? 'descending' : 'ascending',
      order: fieldKind === 'number' ? 'number' : fieldKind === 'date' ? 'date' : 'text',
    });
  }
  return sorts;
}

function wholeOf(value: Js | undefined): number | undefined {
  const number =
    value?.kind === 'number'
      ? value.value
      : value?.kind === 'string' && /^\d+$/.test(value.value)
        ? Number(value.value)
        : undefined;
  return number !== undefined && Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

// ---------------------------------------------------------------------------
// Writing.
// ---------------------------------------------------------------------------

/**
 * The frontmatter with the options (and, for a prop, its default) saying
 * `query`. Every entry this module does not own is kept as written; owned
 * entries are rewritten, and a limit or start is added only when set.
 */
export function rewrittenOptions(
  frontmatter: string,
  home: OptionsHome,
  original: Extract<Js, { readonly kind: 'object' }>,
  query: LoopQuery,
): string {
  assert(original.from === home.options.from, 'The options rewritten are the ones read');
  assert(query.source.kind === 'astro', 'An options query reads an Astro collection');
  const filter = filterText(query);
  const owned = new Map<string, string>([
    ['sort', sortText(query.sorts)],
    ['limit', String(query.limit ?? 0)],
    ['offset', String(query.offset)],
  ]);
  if (home.filter.kind !== 'prop') {
    owned.set('filter', filter);
  }
  const entries: string[] = [];
  const written = new Set<string>();
  for (const entry of original.entries) {
    const key = entry.key;
    const replacement = key === undefined ? undefined : owned.get(key === 'skip' ? 'offset' : key);
    const keyText = key === undefined ? undefined : JSON.stringify(key);
    if (key !== undefined && replacement !== undefined && keyText !== undefined) {
      entries.push(`${keyText}: ${replacement}`);
      written.add(key === 'skip' ? 'offset' : key);
    } else {
      entries.push(entryText(frontmatter, entry));
    }
  }
  for (const [key, value] of owned) {
    const unset =
      (key === 'limit' && query.limit === undefined) ||
      (key === 'offset' && query.offset === 0) ||
      (key === 'filter' && query.conditions.length === 0);
    if (!written.has(key) && !unset) {
      entries.push(`${JSON.stringify(key)}: ${value}`);
    }
  }
  const optionsText = `{${entries.join(', ')}}`;
  const edits: { readonly span: Span; readonly text: string }[] = [
    { span: home.options, text: optionsText },
  ];
  if (home.filter.kind === 'prop') {
    edits.push({ span: home.filter.literal, text: filter });
  }
  // From the end, so an earlier span still points at its text.
  edits.sort((left, right) => right.span.from - left.span.from);
  let out = frontmatter;
  for (const edit of edits) {
    out = `${out.slice(0, edit.span.from)}${edit.text}${out.slice(edit.span.to)}`;
  }
  assert(out.length <= LIMITS.ipcFieldCharsMax, 'Rewritten frontmatter is bounded');
  return out;
}

// An entry as written: its key, as it was quoted, and its value.
function entryText(frontmatter: string, entry: JsEntry): string {
  const value = frontmatter.slice(entry.value.from, entry.value.to);
  return entry.key === undefined ? value : `${JSON.stringify(entry.key)}: ${value}`;
}

function filterText(query: LoopQuery): string {
  const fields = query.conditions.map(conditionText);
  return `{"filterFor": ${JSON.stringify(query.match === 'any' ? 'ANY' : 'ALL')}, "fields": [${fields.join(', ')}]}`;
}

function conditionText(condition: LoopCondition): string {
  if (condition.kind === 'custom') {
    return condition.code;
  }
  const entry = (operatorName: string, value: unknown): string =>
    `{"fieldPath": ${JSON.stringify(condition.field)}, "operatorName": ${JSON.stringify(operatorName)}, "value": ${JSON.stringify(value) ?? '""'}}`;
  switch (condition.operator) {
    case 'is':
      return entry('eq', literalValue(condition.value));
    case 'isNot':
      return entry('ne', literalValue(condition.value));
    case 'contains':
      return entry('contains', condition.value);
    case 'has':
      return entry('idin', literalValue(condition.value));
    case 'isSet':
      return entry('exists', '');
    case 'isEmpty':
      return entry('not-exists', '');
    case 'isTrue':
      return entry('eq', 'true');
    case 'isFalse':
      return entry('ne', 'true');
    case 'greater':
      return entry('gt', condition.value);
    case 'atLeast':
      return entry('gte', condition.value);
    case 'less':
      return entry('lt', condition.value);
    case 'atMost':
      return entry('lte', condition.value);
    case 'before':
      return entry('lt', condition.value);
    case 'after':
      return entry('gt', condition.value);
    case 'inPast':
    case 'inFuture':
      // The panel does not offer these here; reaching this is a programmer error.
      assert(false, `An options query cannot say ${condition.operator}`);
      return '';
    default: {
      const exhaustive: never = condition;
      return exhaustive;
    }
  }
}

function literalValue(value: LoopLiteral): string | number {
  switch (value.kind) {
    case 'text':
      return value.text;
    case 'number':
      return value.number;
    case 'reference':
      return value.id;
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

function sortText(sorts: readonly LoopSort[]): string {
  return `[${sorts.map((sort) => `{"field": ${JSON.stringify(sort.field)}, "direction": ${JSON.stringify(sort.direction === 'descending' ? 'desc' : 'asc')}}`).join(', ')}]`;
}
