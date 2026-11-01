// Collection lists exported from a visual builder keep their settings as data:
//
//   const items1 = queryItems(collections["campus"] || [],
//     { "sort": [{ "field": "sort-order", "direction": "asc" }],
//       "filter": { "filterFor": "ALL", "fields": [{ "fieldPath": "category", "operatorName": "eq", "value": "Care" }] },
//       "limit": 6 }, collectionData);
//
// A helper (here `queryItems`) applies them at runtime. The settings are an
// object literal in the page, so they are read from it and written back into
// it, entry for entry, keeping every key this module does not own. Any of the
// filter, sort, limit and offset may instead be a prop (`"filter":
// propFilters`), each use of the component passing its own; then the prop's
// default holds the setting edited here (loopProps.ts reads the props).
//
// The collection is found by following the first argument through the
// frontmatter to the `getCollection` that reads it: `collections["campus"]`
// is the `campus` entry of a `collections` object whose value reads
// `getCollection("campus")` (filtered and reshaped on the way, which only
// changes how an item is shaped, not which collection it is).

import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import {
  emptyQuery,
  isDateValue,
  isFieldPath,
  isItemId,
  LOOP_QUERY_LIMITS,
  type LoopCondition,
  type LoopFieldKind,
  type LoopLiteral,
  type LoopQuery,
  type LoopSort,
  type LoopSource,
} from './loopQuery';
import { destructuredDefault, parseExpression, type Js, type JsEntry, type ParsedFrontmatter } from './loopSyntax';
import { propNamed } from './loopProps';

/** The settings a component prop can hold. */
export const LOOP_SETTINGS = ['filter', 'sort', 'limit', 'offset', 'curated'] as const;
export type LoopSetting = (typeof LOOP_SETTINGS)[number];

/**
 * Where one setting is written: in the options (`inline`), in a prop's default
 * (`prop`: `key` as a page passes it, `local` as the options name it), or not
 * at all yet (`none`).
 */
export type SettingHome =
  { readonly kind: 'inline' } | { readonly kind: 'prop'; readonly key: string; readonly local: string; readonly literal: Span } | { readonly kind: 'none' };

/** Where an options query lives in the frontmatter, so an edit rewrites just that. */
export interface OptionsHome {
  readonly kind: 'options';
  /** The function that applies the options, as the page calls it. */
  readonly reader: string;
  /** The options object literal. */
  readonly options: Span;
  readonly settings: Readonly<Record<LoopSetting, SettingHome>>;
  /** Where an item keeps its fields: `fields` in a builder export's reshaped items, `data` as Astro gives them. */
  readonly itemPath: readonly string[];
}

interface Span {
  readonly from: number;
  readonly to: number;
}

const OPTION_KEYS = new Set(['sort', 'filter', 'limit', 'offset', 'skip', 'curated', 'curatedItemIds']);
const COLLECTION_STEPS_MAX = 12;

type Lookup = (name: string) => Js | undefined;

/** The query an options call says, or undefined when `init` is not one. */
export function readOptionsQuery(
  init: Js,
  context: {
    readonly frontmatter: ParsedFrontmatter;
    readonly importedFrom: (local: string, spec: string) => string | undefined;
    readonly fieldKind?: ((source: LoopSource, path: string) => LoopFieldKind | undefined) | undefined;
  },
): { readonly query: LoopQuery; readonly home: OptionsHome } | undefined {
  const call = init.kind === 'await' ? init.value : init;
  if (call.kind !== 'call' || call.callee.kind !== 'name') {
    return undefined;
  }
  const [list, options] = call.args;
  if (list === undefined || options?.kind !== 'object' || !options.entries.some((entry) => entry.key !== undefined && OPTION_KEYS.has(entry.key))) {
    return undefined;
  }
  const lookup: Lookup = (name) => context.frontmatter.declarations.get(name)?.init;
  const listed = listCollectionOf(list, { lookup, importedFrom: context.importedFrom });
  if (listed === undefined) {
    return undefined;
  }
  const source: LoopSource = { kind: 'astro', collection: listed.collection };
  const kind = (path: string): LoopFieldKind | undefined => context.fieldKind?.(source, path);
  const settings = settingsOf(options.entries, context.frontmatter.source);
  if (settings === undefined) {
    return undefined;
  }
  const filter = filterOf(settings.values.filter, context.frontmatter.source, kind);
  if (filter === undefined) {
    return undefined;
  }
  const home: OptionsHome = {
    kind: 'options',
    reader: call.callee.name,
    options: { from: options.from, to: options.to },
    settings: settings.homes,
    itemPath: listed.itemPath,
  };
  const picked = curatedOf(settings.values.curated, entryValue(options.entries, 'curatedItemIds'));
  // Picked items linked to a property stay picked items with none picked yet,
  // so the list keeps showing Selected rather than switching itself back.
  const selection = picked ?? (settings.homes.curated.kind === 'prop' ? [] : undefined);
  if (selection !== undefined) {
    // Picked items: the helper starts from them, so they are the list.
    return { query: { ...emptyQuery(source), selection }, home };
  }
  const query = dynamicQuery(settings.values, { source, filter, kind });
  return query === undefined ? undefined : { query, home };
}

/** The options key a setting is written under; a builder may say `skip` for the offset. */
export function settingEntry(entries: readonly JsEntry[], setting: LoopSetting): JsEntry | undefined {
  return entries.find((entry) => entry.key === setting) ?? (setting === 'offset' ? entries.find((entry) => entry.key === 'skip') : undefined);
}

// Each setting's value and where it is written. A setting naming a prop is
// read from that prop's default; one naming anything else, or a prop without
// a default, is outside what the list settings can show.
function settingsOf(
  entries: readonly JsEntry[],
  frontmatter: string,
): { readonly values: Readonly<Record<LoopSetting, Js | undefined>>; readonly homes: Readonly<Record<LoopSetting, SettingHome>> } | undefined {
  const values: Record<LoopSetting, Js | undefined> = { filter: undefined, sort: undefined, limit: undefined, offset: undefined, curated: undefined };
  const homes: Record<LoopSetting, SettingHome> = {
    filter: { kind: 'none' },
    sort: { kind: 'none' },
    limit: { kind: 'none' },
    offset: { kind: 'none' },
    curated: { kind: 'none' },
  };
  for (const setting of LOOP_SETTINGS) {
    const value = settingEntry(entries, setting)?.value;
    if (value === undefined) {
      continue;
    }
    if (value.kind === 'name') {
      const prop = propNamed(frontmatter, value.name);
      const fallback = destructuredDefault(frontmatter, value.name);
      if (prop === undefined || prop.defaultValue === undefined || fallback === undefined) {
        return undefined;
      }
      assert(fallback.from === prop.defaultValue.from, 'A prop default is read where the destructure says');
      values[setting] = fallback;
      homes[setting] = { kind: 'prop', key: prop.key, local: prop.local, literal: prop.defaultValue };
    } else {
      values[setting] = value;
      homes[setting] = { kind: 'inline' };
    }
  }
  assert(Object.keys(homes).length === LOOP_SETTINGS.length, 'Every setting has a home');
  return { values, homes };
}

// Filters, sort, start and limit, as the options state them; undefined when
// one of them is outside what the list settings can show.
function dynamicQuery(
  values: Readonly<Record<LoopSetting, Js | undefined>>,
  read: { readonly source: LoopSource; readonly filter: FilterReading; readonly kind: (path: string) => LoopFieldKind | undefined },
): LoopQuery | undefined {
  const sorts = sortsOf(values.sort, read.kind);
  const offset = wholeOf(values.offset) ?? 0;
  const limit = wholeOf(values.limit);
  if (sorts === undefined || offset > LOOP_QUERY_LIMITS.offsetMax || (limit !== undefined && limit > LOOP_QUERY_LIMITS.limitMax)) {
    return undefined;
  }
  const query: LoopQuery = {
    source: read.source,
    match: read.filter.match,
    conditions: read.filter.conditions,
    sorts,
    random: false,
    offset,
    limit: limit === 0 ? undefined : limit,
    projection: undefined,
    parameter: { kind: 'data' },
  };
  assert(query.conditions.length <= LOOP_QUERY_LIMITS.conditionsMax, 'An options query has bounded conditions');
  return query;
}

/**
 * The collection a list expression reads, and where its items keep their
 * fields: `data` as Astro gives them, or what the last `.map` reshaped them
 * to (`({ id, fields: … })` → `fields`). Undefined when a step reshapes items
 * into anything else, or the expression is not a collection's.
 */
export function listCollectionOf(
  start: Js,
  context: { readonly lookup: (name: string) => Js | undefined; readonly importedFrom: (local: string, spec: string) => string | undefined },
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
    } else if (node.kind === 'call' && node.callee.kind === 'name' && context.importedFrom(node.callee.name, 'astro:content') === 'getCollection') {
      const first = node.args[0];
      return first?.kind === 'string' ? { collection: first.value, itemPath: itemPath ?? ['data'] } : undefined;
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

// `"curated": {"itemIds": [...]}` or `"curatedItemIds": [...]`, when it picks any.
function curatedOf(curated: Js | undefined, flat: Js | undefined): readonly string[] | undefined {
  const list = curated?.kind === 'object' ? entryValue(curated.entries, 'itemIds') : flat;
  if (list?.kind !== 'array' || list.items.length === 0 || list.items.length > LOOP_QUERY_LIMITS.selectionMax) {
    return undefined;
  }
  const ids = list.items.flatMap((item) => (item.kind === 'string' && isItemId(item.value) ? [item.value] : []));
  return ids.length === list.items.length ? ids : undefined;
}

function entryValue(entries: readonly JsEntry[], key: string): Js | undefined {
  return entries.find((entry) => entry.key === key)?.value;
}

export interface FilterReading {
  readonly match: 'all' | 'any';
  readonly conditions: readonly LoopCondition[];
}

function filterOf(value: Js | undefined, frontmatter: string, kind: (path: string) => LoopFieldKind | undefined): FilterReading | undefined {
  if (value === undefined) {
    return { match: 'all', conditions: [] };
  }
  return value.kind === 'object' ? filterObject(value, frontmatter, kind) : undefined;
}

function filterObject(value: Extract<Js, { readonly kind: 'object' }>, frontmatter: string, kind: (path: string) => LoopFieldKind | undefined) {
  const filterFor = entryValue(value.entries, 'filterFor');
  const fields = entryValue(value.entries, 'fields');
  const match: 'all' | 'any' = filterFor?.kind === 'string' && filterFor.value.toUpperCase() === 'ANY' ? 'any' : 'all';
  if (fields !== undefined && fields.kind !== 'array') {
    return undefined;
  }
  const items = fields?.items ?? [];
  if (items.length > LOOP_QUERY_LIMITS.conditionsMax) {
    return undefined;
  }
  const conditions = items.map((item) => conditionOf(item, kind) ?? { kind: 'custom' as const, code: frontmatter.slice(item.from, item.to) });
  return { match, conditions };
}

// One `{ fieldPath, operatorName, value }` as a condition, or undefined to keep it verbatim.
function conditionOf(item: Js, kind: (path: string) => LoopFieldKind | undefined): LoopCondition | undefined {
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
      return text === undefined || text === '' ? undefined : { kind: 'test', field, operator: 'contains', value: text };
    }
    case 'idin': {
      const literal = literalOf(value, fieldKind);
      return literal === undefined ? undefined : { kind: 'test', field, operator: 'has', value: literal };
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

function equalityOf(field: string, operator: 'eq' | 'ne', value: Js | undefined, fieldKind: LoopFieldKind | undefined): LoopCondition | undefined {
  const switched =
    value?.kind === 'boolean'
      ? value.value
      : value?.kind === 'string' && (value.value === 'true' || value.value === 'false') && fieldKind === 'boolean'
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
  return literal === undefined ? undefined : { kind: 'test', field, operator: operator === 'eq' ? 'is' : 'isNot', value: literal };
}

function literalOf(value: Js | undefined, fieldKind: LoopFieldKind | undefined): LoopLiteral | undefined {
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

function comparisonOf(field: string, operator: 'gt' | 'gte' | 'lt' | 'lte', value: Js | undefined): LoopCondition | undefined {
  if (value?.kind === 'string' && isDateValue(value.value.slice(0, 10))) {
    if (operator === 'lt') {
      return { kind: 'test', field, operator: 'before', value: value.value.slice(0, 10) };
    }
    return operator === 'gt' ? { kind: 'test', field, operator: 'after', value: value.value.slice(0, 10) } : undefined;
  }
  const number = value?.kind === 'number' ? value.value : value?.kind === 'string' && value.value.trim() !== '' ? Number(value.value) : Number.NaN;
  if (!Number.isFinite(number)) {
    return undefined;
  }
  const named = { gt: 'greater', gte: 'atLeast', lt: 'less', lte: 'atMost' } as const;
  return { kind: 'test', field, operator: named[operator], value: number };
}

function sortsOf(value: Js | undefined, kind: (path: string) => LoopFieldKind | undefined): readonly LoopSort[] | undefined {
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
      direction: direction?.kind === 'string' && direction.value === 'desc' ? 'descending' : 'ascending',
      order: fieldKind === 'number' ? 'number' : fieldKind === 'date' ? 'date' : fieldKind === 'boolean' ? 'boolean' : 'text',
    });
  }
  return sorts;
}

function wholeOf(value: Js | undefined): number | undefined {
  const number = value?.kind === 'number' ? value.value : value?.kind === 'string' && /^\d+$/.test(value.value) ? Number(value.value) : undefined;
  return number !== undefined && Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

/**
 * A filter a page passes a component's prop (`filters={{"filterFor": …}}`),
 * or undefined when the value is anything the Filters editor cannot show.
 */
export function readFilterValue(text: string, kind: (path: string) => LoopFieldKind | undefined): FilterReading | undefined {
  const parsed = parseExpression(text);
  return parsed === undefined ? undefined : filterOf(parsed.expression, parsed.source, kind);
}

/** A sort a page passes a component's prop, or undefined when it is not one. */
export function readSortValue(text: string, kind: (path: string) => LoopFieldKind | undefined): readonly LoopSort[] | undefined {
  const parsed = parseExpression(text);
  return parsed === undefined ? undefined : sortsOf(parsed.expression, kind);
}

/**
 * A whole options object for `query`, as a list rewritten into the data form
 * is written (optionsBinding.ts). Filter and sort are always written, so the
 * object reads back as options even when nothing narrows the list.
 */
export function optionsLiteral(query: LoopQuery): string {
  assert(dataFormProblem(query) === undefined, 'Only a query the data can say is written as data');
  const entries = [`"filter": ${filterText(query)}`, `"sort": ${sortText(query.sorts)}`];
  if (query.limit !== undefined) {
    entries.push(`"limit": ${query.limit}`);
  }
  if (query.offset > 0) {
    entries.push(`"offset": ${query.offset}`);
  }
  if (query.selection !== undefined) {
    entries.push(`"curated": ${curatedText(query.selection)}`);
  }
  return `{${entries.join(', ')}}`;
}

/** Why a query cannot be kept as data, or undefined when it can. */
export function dataFormProblem(query: LoopQuery): string | undefined {
  if (query.source.kind !== 'astro') {
    return 'Only content collection lists can link their settings to properties.';
  }
  if (query.random) {
    return 'A shuffled list can’t link its settings to properties.';
  }
  for (const condition of query.conditions) {
    if (condition.kind === 'custom') {
      return 'A filter written as code can’t be linked to a property. Remove it first.';
    }
    if (condition.operator === 'inPast' || condition.operator === 'inFuture') {
      return 'A filter comparing with today’s date can’t be linked to a property.';
    }
  }
  return undefined;
}

/** The items a page picks through a component's prop, or undefined when the value is not a pick. */
export function readCuratedValue(text: string): readonly string[] | undefined {
  const parsed = parseExpression(text);
  const value = parsed?.expression;
  const list = value?.kind === 'object' ? entryValue(value.entries, 'itemIds') : undefined;
  if (list?.kind === 'array' && list.items.length === 0) {
    return [];
  }
  return curatedOf(value, undefined);
}

/** The filter value a prop is given, in the helper's own data form. */
export function filterValueText(query: Pick<LoopQuery, 'match' | 'conditions'>): string {
  return filterText(query);
}

/** The sort value a prop is given. */
export function sortValueText(sorts: readonly LoopSort[]): string {
  return sortText(sorts);
}

// ---------------------------------------------------------------------------
// Writing.
// ---------------------------------------------------------------------------

/**
 * The frontmatter with the options (and, for a prop, its default) saying
 * `query`. Every entry this module does not own is kept as written; owned
 * entries are rewritten, and a limit or start is added only when set.
 */
export function rewrittenOptions(frontmatter: string, home: OptionsHome, original: Extract<Js, { readonly kind: 'object' }>, query: LoopQuery): string {
  assert(original.from === home.options.from, 'The options rewritten are the ones read');
  assert(query.source.kind === 'astro', 'An options query reads an Astro collection');
  const filter = filterText(query);
  // Picked items go in `curated` (the helper keeps their order); a dynamic
  // list empties it, as a builder does when the list is switched back.
  const texts: Readonly<Record<LoopSetting, string>> = {
    filter,
    sort: sortText(query.sorts),
    limit: String(query.limit ?? 0),
    offset: String(query.offset),
    curated: curatedText(query.selection ?? []),
  };
  const owned = new Map<string, string>();
  // A setting a prop holds is written as the prop's default; its options
  // entry, which names the prop, is kept as written.
  const edits: { readonly span: Span; readonly text: string }[] = [];
  for (const setting of LOOP_SETTINGS) {
    const settingHome = home.settings[setting];
    if (settingHome.kind === 'prop') {
      edits.push({ span: settingHome.literal, text: texts[setting] });
    } else {
      owned.set(setting, texts[setting]);
    }
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
      (key === 'filter' && query.conditions.length === 0) ||
      (key === 'curated' && query.selection === undefined);
    if (!written.has(key) && !unset) {
      entries.push(`${JSON.stringify(key)}: ${value}`);
    }
  }
  const optionsText = `{${entries.join(', ')}}`;
  edits.push({ span: home.options, text: optionsText });
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

/** The picked items as a prop's value or an options entry holds them. */
export function curatedText(ids: readonly string[]): string {
  return `{"itemIds": ${JSON.stringify(ids)}}`;
}

function filterText(query: Pick<LoopQuery, 'match' | 'conditions'>): string {
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
