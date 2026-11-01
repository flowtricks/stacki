// What a loop over a collection asks for, as the Settings panel edits it: which
// collection, which of its items, in what order, and how many. Modeled on the
// collection lists of visual builders (a source, filter conditions that must
// all or any hold, sort keys, a limit and a start) so a person who has never
// read JavaScript can say all of it with menus.
//
// The query is data; this module also writes it as code. Every value written
// comes from a menu or a checked input, every field name is checked, and every
// string is escaped, so no query this module accepts can write code that fails
// to parse or throws while the page renders. Reading code back into a query is
// loopQueryRead.ts; placing it in the file is loopQueryPlan.ts.

import { assert } from '../../shared/core/assert';

export const LOOP_QUERY_LIMITS = {
  conditionsMax: 12,
  sortsMax: 3,
  limitMax: 10_000,
  offsetMax: 100_000,
  valueCharsMax: 500,
  fieldPathCharsMax: 128,
  projectionCharsMax: 20_000,
  collectionCharsMax: 128,
  selectionMax: 200,
  itemIdCharsMax: 256,
} as const;

/** Where a collection's items come from: Astro's content layer, or a Sanity dataset. */
export type LoopSourceKind = 'astro' | 'sanity';

export interface LoopSource {
  readonly kind: LoopSourceKind;
  /** The Astro collection name, or the Sanity document type. */
  readonly collection: string;
}

/** What a field holds, as far as filtering and sorting it cares. */
export type LoopFieldKind = 'text' | 'number' | 'boolean' | 'date' | 'list' | 'reference' | 'image' | 'other';

export interface LoopFieldOption {
  readonly title: string;
  readonly value: string;
}

/** A field a condition or a sort key can name. */
export interface LoopField {
  /** Its path inside one item's fields: `title`, or `slug.current` for a Sanity slug. */
  readonly path: string;
  readonly title: string;
  readonly kind: LoopFieldKind;
  /** The values a choice field allows, offered as a menu rather than free text. */
  readonly options: readonly LoopFieldOption[];
}

export type LoopOperator =
  | 'is'
  | 'isNot'
  | 'contains'
  | 'has'
  | 'isSet'
  | 'isEmpty'
  | 'isTrue'
  | 'isFalse'
  | 'greater'
  | 'less'
  | 'atLeast'
  | 'atMost'
  | 'before'
  | 'after'
  | 'inPast'
  | 'inFuture';

/** A value a field is compared with: text, a number, or a document a reference points at, by id. */
export type LoopLiteral =
  { readonly kind: 'text'; readonly text: string } | { readonly kind: 'number'; readonly number: number } | { readonly kind: 'reference'; readonly id: string };

/**
 * One condition an item must meet. The value exists only for operators that
 * compare against one, and its type is the one that operator compares.
 * A `custom` condition is code this module did not write and cannot model; it
 * is kept verbatim so editing the conditions around it does not lose it.
 */
export type LoopCondition =
  | { readonly kind: 'test'; readonly field: string; readonly operator: 'isSet' | 'isEmpty' | 'isTrue' | 'isFalse' | 'inPast' | 'inFuture' }
  | { readonly kind: 'test'; readonly field: string; readonly operator: 'is' | 'isNot'; readonly value: LoopLiteral }
  | { readonly kind: 'test'; readonly field: string; readonly operator: 'contains'; readonly value: string }
  | { readonly kind: 'test'; readonly field: string; readonly operator: 'has'; readonly value: LoopLiteral }
  | { readonly kind: 'test'; readonly field: string; readonly operator: 'greater' | 'less' | 'atLeast' | 'atMost'; readonly value: number }
  | { readonly kind: 'test'; readonly field: string; readonly operator: 'before' | 'after'; readonly value: string }
  | { readonly kind: 'custom'; readonly code: string };

export type LoopTestCondition = Extract<LoopCondition, { readonly kind: 'test' }>;

export type LoopSortOrder = 'text' | 'number' | 'date' | 'boolean';

export interface LoopSort {
  readonly field: string;
  readonly direction: 'ascending' | 'descending';
  /** How values compare: alphabetically, numerically, by time, or off before on. */
  readonly order: LoopSortOrder;
}

/**
 * How the Astro filter function names an entry: `({ data }) => data.x`, or
 * `(entry) => entry.data.x`. Kept from the code it was read from, so a custom
 * condition written against one form still reads the same name.
 */
export type AstroItemParameter = { readonly kind: 'data' } | { readonly kind: 'entry'; readonly name: string };

export interface LoopQuery {
  readonly source: LoopSource;
  readonly match: 'all' | 'any';
  readonly conditions: readonly LoopCondition[];
  readonly sorts: readonly LoopSort[];
  /** Items skipped from the start: 0 starts at the first. */
  readonly offset: number;
  /** At most this many items; undefined shows all of them. */
  readonly limit: number | undefined;
  /** Shuffled at build time, the way a "random order" sort is; any sort keys are then unused. */
  readonly random: boolean;
  /** A Sanity projection kept verbatim from hand-written code (`{ name, "photo": … }`). */
  readonly projection: string | undefined;
  readonly parameter: AstroItemParameter;
  /**
   * Items picked by hand, in the order they show, in place of filters, sort
   * and limit (a builder's "Selected" list). Absent is a dynamic list.
   */
  readonly selection?: readonly string[] | undefined;
}

const FIELD_SEGMENT = /^[A-Za-z_$][\w$-]*$/;
const DATE_VALUE = /^\d{4}-\d{2}-\d{2}$/;
const COLLECTION_NAME = /^[A-Za-z0-9_][\w.-]*$/;
const PARAMETER_NAME = /^[A-Za-z_$][\w$]*$/;

/** Operators that need no value. */
export const VALUELESS_OPERATORS = ['isSet', 'isEmpty', 'isTrue', 'isFalse', 'inPast', 'inFuture'] as const;

/** The operators a field of each kind offers, in menu order. */
export function operatorsFor(kind: LoopFieldKind): readonly LoopOperator[] {
  switch (kind) {
    case 'text':
      return ['is', 'isNot', 'contains', 'isSet', 'isEmpty'];
    case 'number':
      return ['is', 'isNot', 'greater', 'less', 'atLeast', 'atMost', 'isSet', 'isEmpty'];
    case 'boolean':
      return ['isTrue', 'isFalse'];
    case 'date':
      return ['before', 'after', 'inPast', 'inFuture', 'isSet', 'isEmpty'];
    case 'list':
      return ['has', 'isSet', 'isEmpty'];
    case 'reference':
      return ['is', 'isNot', 'isSet', 'isEmpty'];
    case 'image':
    case 'other':
      return ['isSet', 'isEmpty'];
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** How values of a kind sort, or undefined when they don't sort meaningfully. */
export function sortOrderFor(kind: LoopFieldKind): LoopSortOrder | undefined {
  switch (kind) {
    case 'text':
      return 'text';
    case 'number':
      return 'number';
    case 'date':
      return 'date';
    case 'boolean':
      return 'boolean';
    case 'list':
    case 'reference':
    case 'image':
    case 'other':
      return undefined;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** A query with nothing narrowed: every item, in the source's own order. */
export function emptyQuery(source: LoopSource): LoopQuery {
  const query: LoopQuery = {
    source,
    match: 'all',
    conditions: [],
    sorts: [],
    random: false,
    offset: 0,
    limit: undefined,
    projection: undefined,
    parameter: { kind: 'data' },
  };
  assertLoopQuery(query);
  assert(query.conditions.length === 0, 'An empty query has no conditions');
  return query;
}

/**
 * Every invariant the writers rely on to produce valid code. A query that fails
 * here is a programmer error: the panel builds queries only from checked input,
 * and the reader only from code it fully understood.
 */
export function assertLoopQuery(query: LoopQuery): void {
  assertSelection(query);
  assert(COLLECTION_NAME.test(query.source.collection), 'A loop source names a collection');
  assert(query.source.collection.length <= LOOP_QUERY_LIMITS.collectionCharsMax, 'A collection name is short');
  assert(query.conditions.length <= LOOP_QUERY_LIMITS.conditionsMax, 'A loop has a bounded number of conditions');
  assert(query.sorts.length <= LOOP_QUERY_LIMITS.sortsMax, 'A loop has a bounded number of sort keys');
  assert(Number.isSafeInteger(query.offset), 'An offset is a whole number');
  assert(query.offset >= 0, 'An offset is never negative');
  assert(query.offset <= LOOP_QUERY_LIMITS.offsetMax, 'An offset is bounded');
  if (query.limit !== undefined) {
    assert(Number.isSafeInteger(query.limit), 'A limit is a whole number');
    assert(query.limit >= 1, 'A limit shows at least one item');
    assert(query.limit <= LOOP_QUERY_LIMITS.limitMax, 'A limit is bounded');
  }
  if (query.projection !== undefined) {
    assert(query.source.kind === 'sanity', 'Only a Sanity query has a projection');
    assert(query.projection.length <= LOOP_QUERY_LIMITS.projectionCharsMax, 'A projection is bounded');
  }
  if (query.parameter.kind === 'entry') {
    assert(PARAMETER_NAME.test(query.parameter.name), 'An entry parameter is a name');
  }
  for (const condition of query.conditions) {
    assertCondition(condition);
  }
  for (const sort of query.sorts) {
    assertFieldPath(sort.field);
  }
}

// A selected list picks items instead of narrowing a collection, so it has no
// filters, sort or limit of its own; its ids are bounded text, written escaped.
function assertSelection(query: LoopQuery): void {
  const selection = query.selection;
  if (selection === undefined) {
    return;
  }
  assert(selection.length <= LOOP_QUERY_LIMITS.selectionMax, 'A selection is bounded');
  assert(query.conditions.length === 0, 'A selected list has no filters');
  assert(query.sorts.length === 0, 'A selected list has no sort');
  assert(!query.random, 'A selected list is not shuffled');
  assert(query.offset === 0, 'A selected list skips nothing');
  assert(query.limit === undefined, 'A selected list has no limit');
  for (const id of selection) {
    assert(isItemId(id), 'A selected item is named by an id');
  }
}

/** Whether a text can name a selected item: present, one line, bounded. */
export function isItemId(text: string): boolean {
  return text.length > 0 && text.length <= LOOP_QUERY_LIMITS.itemIdCharsMax && !/[\r\n]/.test(text);
}

/** A list of item ids as a JavaScript array literal. */
function idsCode(ids: readonly string[]): string {
  return `[${ids.map(jsString).join(', ')}]`;
}

function assertCondition(condition: LoopCondition): void {
  if (condition.kind === 'custom') {
    assert(condition.code.trim().length > 0, 'A custom condition holds code');
    assert(condition.code.length <= LOOP_QUERY_LIMITS.valueCharsMax * 4, 'A custom condition is bounded');
    return;
  }
  assertFieldPath(condition.field);
  switch (condition.operator) {
    case 'is':
    case 'isNot':
    case 'has':
      assertLiteral(condition.value);
      return;
    case 'contains':
      assert(condition.value.length > 0, 'A searched text is not empty');
      assert(condition.value.length <= LOOP_QUERY_LIMITS.valueCharsMax, 'A searched text is bounded');
      return;
    case 'greater':
    case 'less':
    case 'atLeast':
    case 'atMost':
      assert(Number.isFinite(condition.value), 'A compared number is finite');
      return;
    case 'before':
    case 'after':
      assert(DATE_VALUE.test(condition.value), 'A compared date is YYYY-MM-DD');
      return;
    case 'isSet':
    case 'isEmpty':
    case 'isTrue':
    case 'isFalse':
    case 'inPast':
    case 'inFuture':
      return;
    default: {
      const exhaustive: never = condition;
      return exhaustive;
    }
  }
}

const DOCUMENT_ID = /^[\w][\w.-]{0,127}$/;

function assertLiteral(value: LoopLiteral): void {
  switch (value.kind) {
    case 'number':
      assert(Number.isFinite(value.number), 'A compared number is finite');
      return;
    case 'text':
      assert(value.text.length <= LOOP_QUERY_LIMITS.valueCharsMax, 'A compared text is bounded');
      return;
    case 'reference':
      assert(DOCUMENT_ID.test(value.id), 'A referenced document is named by its id');
      return;
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

/** Whether a text can name a referenced document. */
export function isDocumentId(text: string): boolean {
  return DOCUMENT_ID.test(text);
}

function assertFieldPath(path: string): void {
  assert(path.length > 0, 'A field path names a field');
  assert(path.length <= LOOP_QUERY_LIMITS.fieldPathCharsMax, 'A field path is bounded');
  for (const segment of path.split('.')) {
    assert(FIELD_SEGMENT.test(segment), `A field path segment is a name: ${segment}`);
  }
}

/** Whether a field path can be written into code: plain names, dot-separated. */
export function isFieldPath(path: string): boolean {
  if (path.length === 0) {
    return false;
  }
  if (path.length > LOOP_QUERY_LIMITS.fieldPathCharsMax) {
    return false;
  }
  return path.split('.').every((segment) => FIELD_SEGMENT.test(segment));
}

/** Whether a text is a date the date conditions compare against. */
export function isDateValue(text: string): boolean {
  return DATE_VALUE.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`));
}

// ---------------------------------------------------------------------------
// Astro: `await getCollection('blog', filter)`, then sorted and sliced in JS.
// ---------------------------------------------------------------------------

/** The expression that reads an Astro query: what the frontmatter `const` holds. */
export function astroQueryCode(query: LoopQuery, reader = 'getCollection'): string {
  assertLoopQuery(query);
  assert(query.source.kind === 'astro', 'An Astro query reads an Astro collection');
  assert(/^[A-Za-z_$][\w$]*$/.test(reader), 'getCollection is called by its imported name');
  if (query.selection !== undefined) {
    // The picked entries, in the order picked. Read from the collection rather
    // than by getEntries, so a list with nothing picked still names it; an id
    // since deleted matches nothing and is dropped.
    const ids = idsCode(query.selection);
    const read = `await ${reader}(${jsString(query.source.collection)})`;
    return `(${read}).filter((entry) => ${ids}.includes(entry.id)).sort((a, b) => ${ids}.indexOf(a.id) - ${ids}.indexOf(b.id))`;
  }
  const filter = astroFilterCode(query);
  const read = `await ${reader}(${jsString(query.source.collection)}${filter === undefined ? '' : `, ${filter}`})`;
  const sort = query.random ? `.sort(() => Math.random() - 0.5)` : query.sorts.length > 0 ? `.sort(${astroComparatorCode(query.sorts)})` : '';
  const slice = sliceCode(query.offset, query.limit);
  const code = sort === '' && slice === '' ? read : `(${read})${sort}${slice}`;
  assert(code.startsWith('await') || code.startsWith('(await'), 'An Astro query awaits its collection');
  return code;
}

/**
 * A list kept as written (`collections["campus"]`, whose items hold their
 * fields under `itemPath`), copied so a sort cannot reorder the original,
 * then filtered, sorted and sliced the way the query says.
 */
export function chainQueryCode(query: LoopQuery, list: string, itemPath: readonly string[]): string {
  assertLoopQuery(query);
  assert(list.trim().length > 0, 'A kept list is an expression');
  assert(
    itemPath.every((segment) => /^[A-Za-z_$][\w$]*$/.test(segment)),
    'An item path is names',
  );
  if (query.selection !== undefined) {
    // Picked items in the order picked, found by the id the list gives them;
    // one no longer in the list is dropped.
    return `${idsCode(query.selection)}.map((id) => ${list.trim()}.find((entry) => entry.id === id)).filter(Boolean)`;
  }
  const name = query.parameter.kind === 'entry' ? query.parameter.name : 'entry';
  const base = [name, ...itemPath].join('.');
  const joiner = query.match === 'all' ? ' && ' : ' || ';
  const filter =
    query.conditions.length === 0 ? '' : `.filter((${name}) => ${query.conditions.map((condition) => astroConditionCode(condition, base)).join(joiner)})`;
  const sort = query.random ? '.sort(() => Math.random() - 0.5)' : query.sorts.length > 0 ? `.sort(${astroComparatorCode(query.sorts, itemPath)})` : '';
  const code = `[...${list.trim()}]${filter}${sort}${sliceCode(query.offset, query.limit)}`;
  assert(code.startsWith('[...'), 'A kept list is copied');
  return code;
}

function astroFilterCode(query: LoopQuery): string | undefined {
  if (query.conditions.length === 0) {
    return undefined;
  }
  const parameter = query.parameter;
  const head = parameter.kind === 'data' ? '({ data })' : `(${parameter.name})`;
  const base = parameter.kind === 'data' ? 'data' : `${parameter.name}.data`;
  const clauses = query.conditions.map((condition) => astroConditionCode(condition, base));
  const joiner = query.match === 'all' ? ' && ' : ' || ';
  return `${head} => ${clauses.join(joiner)}`;
}

/** One condition as JavaScript over an entry's `data`; null-safe for any entry. */
export function astroConditionCode(condition: LoopCondition, base: string): string {
  if (condition.kind === 'custom') {
    return groupedCode(condition.code);
  }
  const field = fieldAccess(base, condition.field);
  switch (condition.operator) {
    case 'is':
      return condition.value.kind === 'reference'
        ? `${referenceId(field)} === ${jsString(condition.value.id)}`
        : `${field} === ${literalCode(condition.value)}`;
    case 'isNot':
      return condition.value.kind === 'reference'
        ? `${referenceId(field)} !== ${jsString(condition.value.id)}`
        : `${field} !== ${literalCode(condition.value)}`;
    case 'contains':
      return `String(${field} ?? '').toLowerCase().includes(${jsString(condition.value.toLowerCase())})`;
    case 'has':
      return condition.value.kind === 'reference'
        ? `(${field} ?? []).some((value) => ${referenceId('value')} === ${jsString(condition.value.id)})`
        : `(${field} ?? []).includes(${literalCode(condition.value)})`;
    case 'isSet':
      return `${field} != undefined`;
    case 'isEmpty':
      return `${field} == undefined`;
    case 'isTrue':
      return `${field} === true`;
    case 'isFalse':
      return `${field} !== true`;
    case 'greater':
      return `${field} > ${numberCode(condition.value)}`;
    case 'less':
      return `${field} < ${numberCode(condition.value)}`;
    case 'atLeast':
      return `${field} >= ${numberCode(condition.value)}`;
    case 'atMost':
      return `${field} <= ${numberCode(condition.value)}`;
    case 'before':
      return `new Date(${field}) < new Date(${jsString(condition.value)})`;
    case 'after':
      return `new Date(${field}) > new Date(${jsString(condition.value)})`;
    case 'inPast':
      return `new Date(${field}) <= new Date()`;
    case 'inFuture':
      return `new Date(${field}) > new Date()`;
    default: {
      const exhaustive: never = condition;
      return exhaustive;
    }
  }
}

// Astro stores a reference as `{ collection, id }` and a choice as its text;
// a schema reports both as a choice of ids. This reads the id from either.
function referenceId(field: string): string {
  return `(${field}?.id ?? ${field})`;
}

// Custom code joined to other conditions is parenthesized when it has an
// operator of its own (`a || b`, `x ? y : z`) that the join could regroup.
function groupedCode(code: string): string {
  const trimmed = code.trim();
  assert(trimmed.length > 0, 'Grouped code is not empty');
  return /\|\||&&|\?/.test(trimmed) ? `(${trimmed})` : trimmed;
}

function astroComparatorCode(sorts: readonly LoopSort[], itemPath: readonly string[] = ['data']): string {
  assert(sorts.length > 0, 'A comparator compares by at least one key');
  const keys = sorts.map((sort) => {
    const [first, second] = sort.direction === 'ascending' ? ['a', 'b'] : ['b', 'a'];
    return comparison(sort, [first, ...itemPath].join('.'), [second, ...itemPath].join('.'));
  });
  const code = `(a, b) => ${keys.join(' || ')}`;
  assert(code.includes('=>'), 'A comparator is a function');
  return code;
}

// Each comparison is a number for any two entries: a missing value sorts as
// empty text, zero, or an invalid date (NaN, which sort() treats as equal).
function comparison(sort: LoopSort, left: string, right: string): string {
  const leftValue = fieldAccess(left, sort.field);
  const rightValue = fieldAccess(right, sort.field);
  switch (sort.order) {
    case 'text':
      return `String(${leftValue} ?? '').localeCompare(String(${rightValue} ?? ''))`;
    case 'number':
      return `(${leftValue} ?? 0) - (${rightValue} ?? 0)`;
    case 'date':
      return `new Date(${leftValue}).valueOf() - new Date(${rightValue}).valueOf()`;
    case 'boolean':
      // Off (false or unset) before on, as a builder's switch sort has it.
      return `Number(${leftValue} === true) - Number(${rightValue} === true)`;
    default: {
      const exhaustive: never = sort.order;
      return exhaustive;
    }
  }
}

function sliceCode(offset: number, limit: number | undefined): string {
  if (limit !== undefined) {
    return `.slice(${offset}, ${offset + limit})`;
  }
  return offset > 0 ? `.slice(${offset})` : '';
}

/** `data.title`, or `data["campus-name"]` for a name that is not an identifier. */
export function fieldAccess(base: string, path: string): string {
  assertFieldPath(path);
  let code = base;
  for (const segment of path.split('.')) {
    code += /^[A-Za-z_$][\w$]*$/.test(segment) ? `.${segment}` : `[${jsString(segment)}]`;
  }
  assert(code.startsWith(base), 'A field is read from its base');
  return code;
}

function literalCode(value: LoopLiteral): string {
  switch (value.kind) {
    case 'number':
      return numberCode(value.number);
    case 'text':
      return jsString(value.text);
    case 'reference':
      return jsString(value.id);
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

function numberCode(value: number): string {
  assert(Number.isFinite(value), 'Only finite numbers are written');
  // `-0` prints as `0`, and every finite number prints as a valid literal.
  return Object.is(value, -0) ? '0' : String(value);
}

/** A single-quoted JavaScript string holding exactly `text`. */
export function jsString(text: string): string {
  let out = "'";
  for (const character of text) {
    out += escapedCharacter(character);
  }
  out += "'";
  assert(out.length >= 2, 'A string literal has its quotes');
  return out;
}

function escapedCharacter(character: string): string {
  switch (character) {
    case '\\':
      return '\\\\';
    case "'":
      return "\\'";
    case '\n':
      return '\\n';
    case '\r':
      return '\\r';
    case '\t':
      return '\\t';
    case ' ':
      return '\\u2028';
    case ' ':
      return '\\u2029';
    default: {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : character;
    }
  }
}

// ---------------------------------------------------------------------------
// Sanity: one GROQ query, so the CMS filters, orders and slices on its side.
// ---------------------------------------------------------------------------

/** The GROQ text of a Sanity query. */
export function groqQueryText(query: LoopQuery, fields: readonly LoopField[]): string {
  assertLoopQuery(query);
  assert(query.source.kind === 'sanity', 'A GROQ query reads a Sanity type');
  const type = `_type == ${groqString(query.source.collection)}`;
  if (query.selection !== undefined) {
    const projected = query.projection ?? defaultProjection(fields);
    const ids = `[${query.selection.map(groqString).join(', ')}]`;
    return `*[${type} && _id in ${ids}]${projected === '' ? '' : ` ${projected}`}`;
  }
  const clauses = query.conditions.map(groqConditionCode);
  const joiner = query.match === 'all' ? ' && ' : ' || ';
  const narrowed = clauses.length === 0 ? '' : clauses.length === 1 || query.match === 'all' ? ` && ${clauses.join(joiner)}` : ` && (${clauses.join(joiner)})`;
  // A shuffle happens after the fetch (GROQ has no random order), so the
  // query returns every match and the slice is taken from the shuffled list.
  const sorted = !query.random && query.sorts.length > 0;
  const order = sorted ? ` | order(${query.sorts.map((sort) => `${sort.field} ${sort.direction === 'ascending' ? 'asc' : 'desc'}`).join(', ')})` : '';
  const slice = query.random ? '' : groqSlice(query.offset, query.limit);
  const projection = query.projection ?? defaultProjection(fields);
  const text = `*[${type}${narrowed}]${order}${slice}${projection === '' ? '' : ` ${projection}`}`;
  assert(text.startsWith('*['), 'A GROQ query starts from every document');
  return text;
}

/**
 * The expression that reads a Sanity query through `client` (an imported
 * `sanityClient`): the fetch, and in JS only what GROQ cannot do — a shuffle.
 */
export function sanityQueryCode(query: LoopQuery, fields: readonly LoopField[], client: string): string {
  assert(/^[A-Za-z_$][\w$]*$/.test(client), 'A client is named by an identifier');
  const fetch = `await ${client}.fetch(${jsString(groqQueryText(query, fields))})`;
  if (query.selection !== undefined) {
    // GROQ returns them in its own order; the picked order is restored here.
    const ids = idsCode(query.selection);
    return `(${fetch}).sort((a, b) => ${ids}.indexOf(a._id) - ${ids}.indexOf(b._id))`;
  }
  const code = query.random ? `(${fetch}).sort(() => Math.random() - 0.5)${sliceCode(query.offset, query.limit)}` : fetch;
  assert(code.includes(`${client}.fetch(`), 'A Sanity query fetches through its client');
  return code;
}

/** One condition as GROQ. Missing fields compare as null, which GROQ never throws on. */
export function groqConditionCode(condition: LoopCondition): string {
  if (condition.kind === 'custom') {
    return groupedCode(condition.code);
  }
  const field = condition.field;
  switch (condition.operator) {
    case 'is':
      return condition.value.kind === 'reference' ? `${field}._ref == ${groqString(condition.value.id)}` : `${field} == ${groqLiteral(condition.value)}`;
    case 'isNot':
      return condition.value.kind === 'reference' ? `${field}._ref != ${groqString(condition.value.id)}` : `${field} != ${groqLiteral(condition.value)}`;
    case 'contains':
      return `${field} match ${groqString(`*${condition.value}*`)}`;
    case 'has':
      return condition.value.kind === 'reference' ? `${groqString(condition.value.id)} in ${field}[]._ref` : `${groqLiteral(condition.value)} in ${field}`;
    case 'isSet':
      return `defined(${field})`;
    case 'isEmpty':
      return `!defined(${field})`;
    case 'isTrue':
      return `${field} == true`;
    case 'isFalse':
      return `${field} != true`;
    case 'greater':
      return `${field} > ${numberCode(condition.value)}`;
    case 'less':
      return `${field} < ${numberCode(condition.value)}`;
    case 'atLeast':
      return `${field} >= ${numberCode(condition.value)}`;
    case 'atMost':
      return `${field} <= ${numberCode(condition.value)}`;
    case 'before':
      return `${field} < ${groqString(condition.value)}`;
    case 'after':
      return `${field} > ${groqString(condition.value)}`;
    case 'inPast':
      return `${field} <= now()`;
    case 'inFuture':
      return `${field} > now()`;
    default: {
      const exhaustive: never = condition;
      return exhaustive;
    }
  }
}

function groqSlice(offset: number, limit: number | undefined): string {
  if (limit !== undefined) {
    return ` [${offset}...${offset + limit}]`;
  }
  // GROQ has no open-ended slice; a start alone runs to the bound on offsets.
  return offset > 0 ? ` [${offset}...${LOOP_QUERY_LIMITS.offsetMax + LOOP_QUERY_LIMITS.limitMax}]` : '';
}

function groqLiteral(value: LoopLiteral): string {
  switch (value.kind) {
    case 'number':
      return numberCode(value.number);
    case 'text':
      return groqString(value.text);
    case 'reference':
      return groqString(value.id);
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

/** A GROQ string: JSON's syntax, which GROQ shares. */
export function groqString(text: string): string {
  const out = JSON.stringify(text);
  assert(out.startsWith('"'), 'A GROQ string is double-quoted');
  return out;
}

/**
 * What a new Sanity query returns for each document: everything, with images
 * read as their address and references followed to the document they name, so
 * `item.photo` is a URL and `item.campus.name` a name, the way a page uses them.
 */
export function defaultProjection(fields: readonly LoopField[]): string {
  const resolved: string[] = [];
  for (const field of fields) {
    if (field.path.includes('.')) {
      continue;
    }
    const name = groqString(field.path);
    if (field.kind === 'image') {
      resolved.push(`${name}: ${field.path}.asset->url`);
    } else if (field.kind === 'reference') {
      resolved.push(`${name}: ${field.path}->`);
    }
  }
  assert(resolved.length <= fields.length, 'One projection entry per field at most');
  return resolved.length === 0 ? '' : `{ ..., ${resolved.join(', ')} }`;
}
