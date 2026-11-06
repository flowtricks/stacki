// What a loop is looping over, read from whatever code says it — by hand, by an
// AI assistant, or by Stacki. The data expression is followed through the
// frontmatter's declarations to where the list comes from, and the steps taken
// on the way (`getCollection`'s filter, `.filter`, `.sort`, `.toSorted`,
// `.slice`, `.reverse`, a GROQ query's own filter, order and slice) are read as
// one query, whatever syntax they were written in.
//
// The reading is honest about how far it got:
//   query    every step is a condition, a sort key, a start or a limit (a
//            condition it could not model is kept as a custom one), over a
//            collection or a List prop of the open component;
//   partial  the collection is known but some step is not a query step (a
//            `.map`, a filter after a slice): the panel shows the source and
//            keeps that code rather than guessing at it;
//   value    a list from anywhere else — a constant, an imported function's
//            result, an outer loop's item — named for where it is;
//   empty    `[]`, the loop with nothing chosen yet;
//   code     an expression that does not parse.

import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import { readGroq } from './groqSyntax';
import { listCollectionOf, readOptionsQuery, type OptionsHome } from './optionsQuery';
import { chainOf, conditionOf } from './loopConditionRead';
import { curatedSelection, entriesSelection, pickedIds } from './loopSelectionRead';
import { readComparator } from './loopSortRead';
import { LOOP_QUERY_LIMITS, assertLoopQuery, emptyQuery } from './loopQuery';
import type { AstroItemParameter, LoopCondition, LoopFieldKind, LoopQuery, LoopSort, LoopSortOrder, LoopSource } from './loopQuery';
import { namePath, parseExpression, parseFrontmatter, textOf, type Js, type ParsedFrontmatter } from './loopSyntax';
import { listPropOf } from './propDeclaration';

export interface LoopImport {
  readonly name: string;
  readonly path: string;
  readonly imported?: string | undefined;
}

export interface LoopReadInput {
  /** The frontmatter's code without its imports. */
  readonly frontmatter: string;
  readonly imports: readonly LoopImport[];
  /** The loop's data expression: `posts`, `posts.slice(0, 3)`. */
  readonly data: string;
  /** What a field holds, when the collection's schema is known. */
  readonly fieldKind?: ((source: LoopSource, path: string) => LoopFieldKind | undefined) | undefined;
}

export type LoopValueOrigin =
  | { readonly kind: 'frontmatter' }
  | { readonly kind: 'call'; readonly exportName: string; readonly spec: string }
  | { readonly kind: 'import'; readonly spec: string }
  | { readonly kind: 'scope' };

export type LoopReading =
  | { readonly kind: 'empty' }
  | {
      readonly kind: 'query';
      readonly query: LoopQuery;
      readonly chain: readonly string[];
      readonly client: string | undefined;
      /** Where its settings live when they are not a query Stacki writes itself. */
      readonly home?: QueryHome | undefined;
    }
  | { readonly kind: 'partial'; readonly source: LoopSource; readonly chain: readonly string[]; readonly reason: string }
  | { readonly kind: 'value'; readonly root: string; readonly origin: LoopValueOrigin; readonly chain: readonly string[] }
  | { readonly kind: 'code' };

/**
 * Settings kept where the code keeps them: an options object a helper applies,
 * or refinements chained on a list expression that stays as written.
 */
export type QueryHome = OptionsHome | { readonly kind: 'chain'; readonly list: string; readonly itemPath: readonly string[] };

/** The declarations a reading followed, head first: where its list is held. */
export function readingChain(reading: LoopReading): readonly string[] {
  return reading.kind === 'query' || reading.kind === 'partial' || reading.kind === 'value' ? reading.chain : [];
}

// Declarations followed from the loop to its source: a page never chains more
// than a few (`QUERY` → `pastors` → `featured`), and a cycle would be endless.
const CHAIN_STEPS_MAX = 8;
const STEPS_MAX = 16;

export function readLoop(input: LoopReadInput): LoopReading {
  const data = input.data.trim();
  if (data === '' || data === '[]') {
    return { kind: 'empty' };
  }
  const parsed = parseExpression(data);
  if (!parsed) {
    return { kind: 'code' };
  }
  const frontmatter = parseFrontmatter(input.frontmatter);
  const context: Context = { input, frontmatter };
  const pipeline = pipelineOf({ source: parsed.source, node: parsed.expression }, context, []);
  if (pipeline.kind === 'value') {
    return listPropReading(pipeline, context) ?? { kind: 'value', root: pipeline.root, origin: originOf(pipeline.root, context), chain: pipeline.chain };
  }
  if (pipeline.kind === 'unknown') {
    return { kind: 'code' };
  }
  if (pipeline.kind === 'options') {
    return { kind: 'query', query: pipeline.query, chain: pipeline.chain, client: undefined, home: pipeline.home };
  }
  const reading = queryOf(pipeline, context);
  assert(reading.kind === 'query' || reading.kind === 'partial', 'A collection pipeline reads as a query or partly');
  return reading;
}

/** Where an item keeps its fields: `data` (an Astro entry), `fields` (a builder export), or on itself. */
type ItemPath = readonly string[];

interface Context {
  readonly input: LoopReadInput;
  readonly frontmatter: ParsedFrontmatter;
}

/** A node and the text its spans index (the head, or the frontmatter). */
interface Located {
  readonly source: string;
  readonly node: Js;
}

type Step =
  | { readonly kind: 'filter'; readonly function: Located }
  | { readonly kind: 'sort'; readonly function: Located | undefined }
  | { readonly kind: 'slice'; readonly start: number; readonly end: number | undefined }
  | { readonly kind: 'reverse' }
  | { readonly kind: 'other'; readonly name: string };

type Base =
  | {
      readonly kind: 'astro';
      readonly collection: string;
      readonly filter: Located | undefined;
      /** A list expression kept as written (`[...collections["campus"]]`), and where its items hold fields. */
      readonly list?: { readonly text: string; readonly itemPath: ItemPath };
      /** Items picked by id, in order, in place of a filter (`getEntries`, a curated list). */
      readonly selection?: readonly string[];
    }
  | { readonly kind: 'sanity'; readonly groq: string; readonly client: string };

type Pipeline =
  | { readonly kind: 'collection'; readonly base: Base; readonly steps: readonly Step[]; readonly chain: readonly string[] }
  | {
      readonly kind: 'value';
      readonly root: string;
      readonly chain: readonly string[];
      /** The steps taken on `root` itself, when the expression ended at that bare name. */
      readonly steps?: readonly Step[];
    }
  | { readonly kind: 'options'; readonly query: LoopQuery; readonly home: OptionsHome; readonly chain: readonly string[] }
  | { readonly kind: 'unknown' };

const COLLECTION_NAME = /^[A-Za-z0-9_][\w.-]*$/;
const METHOD_STEPS = new Set(['filter', 'sort', 'toSorted', 'slice', 'reverse', 'toReversed']);

// Iterative over the method chain (each pass peels one call off the end) and
// over declarations (each pass follows one name), both bounded.
function pipelineOf(start: Located, context: Context, chainStart: readonly string[]): Pipeline {
  const steps: Step[] = [];
  const chain = [...chainStart];
  let current = start;
  for (let pass = 0; pass < STEPS_MAX + CHAIN_STEPS_MAX; pass++) {
    const node = unwrapAwait(current.node);
    const base = baseOf({ source: current.source, node }, context) ?? (steps.length === 0 ? curatedOf(node, context, current.source) : undefined);
    if (base) {
      return { kind: 'collection', base, steps: steps.reverse(), chain };
    }
    if (node.kind === 'name') {
      const declaration = context.frontmatter.declarations.get(node.name);
      if (!declaration?.init || chain.includes(node.name) || chain.length >= CHAIN_STEPS_MAX) {
        return { kind: 'value', root: node.name, chain, steps: [...steps].reverse() };
      }
      chain.push(node.name);
      // A builder's collection list: its settings are an options object here.
      const options = steps.length === 0 ? readOptionsQuery(declaration.init, { ...optionsContext(context) }) : undefined;
      if (options !== undefined) {
        return { kind: 'options', query: options.query, home: options.home, chain };
      }
      current = { source: context.frontmatter.source, node: declaration.init };
      continue;
    }
    const step = stepOf({ source: current.source, node });
    if (step) {
      steps.push(step.step);
      current = step.from;
      continue;
    }
    // A list some code builds from a collection (an export's `collections`
    // object): the collection, with the expression kept as its base.
    const listed = listCollectionOf(node, {
      lookup: (name) => context.frontmatter.declarations.get(name)?.init,
      importedFrom: (local, spec) => importedFrom(context, local, spec),
    });
    if (listed !== undefined) {
      const list = { text: textOf(current, node), itemPath: listed.itemPath };
      return { kind: 'collection', base: { kind: 'astro', collection: listed.collection, filter: undefined, list }, steps: steps.reverse(), chain };
    }
    const path = namePath(node);
    if (path?.[0] !== undefined) {
      return { kind: 'value', root: path[0], chain };
    }
    // A declaration holding anything else (`await getCampusPastors()`, a
    // literal list) is a value named for that declaration.
    const held = chain[chain.length - 1];
    return held === undefined ? { kind: 'unknown' } : { kind: 'value', root: held, chain };
  }
  return { kind: 'unknown' };
}

function optionsContext(context: Context) {
  return {
    frontmatter: context.frontmatter,
    importedFrom: (local: string, spec: string) => importedFrom(context, local, spec),
    fieldKind: context.input.fieldKind,
  };
}

function unwrapAwait(node: Js): Js {
  return node.kind === 'await' ? node.value : node;
}

function stepOf(located: Located): { readonly step: Step; readonly from: Located } | undefined {
  const node = located.node;
  if (node.kind !== 'call' || node.callee.kind !== 'member') {
    return undefined;
  }
  const method = node.callee.property;
  const from = { source: located.source, node: node.callee.object };
  if (!METHOD_STEPS.has(method)) {
    // `.map(…)` and the like reshape items; the list is no longer the collection's.
    return namePath(node.callee) === undefined ? { step: { kind: 'other', name: method }, from } : undefined;
  }
  const argument = node.args[0];
  switch (method) {
    case 'filter':
      return argument?.kind === 'function' && node.args.length === 1
        ? { step: { kind: 'filter', function: { source: located.source, node: argument } }, from }
        : { step: { kind: 'other', name: method }, from };
    case 'sort':
    case 'toSorted':
      if (node.args.length === 0) {
        return { step: { kind: 'sort', function: undefined }, from };
      }
      return argument?.kind === 'function' && node.args.length === 1
        ? { step: { kind: 'sort', function: { source: located.source, node: argument } }, from }
        : { step: { kind: 'other', name: method }, from };
    case 'slice':
      return { step: sliceStep(node.args), from };
    case 'reverse':
    case 'toReversed':
      return { step: { kind: 'reverse' }, from };
    default:
      return { step: { kind: 'other', name: method }, from };
  }
}

function sliceStep(args: readonly Js[]): Step {
  const [first, second] = args;
  const start = first === undefined ? 0 : wholeNumber(first);
  const end = second === undefined ? undefined : wholeNumber(second);
  if (start === undefined || args.length > 2 || (second !== undefined && end === undefined)) {
    return { kind: 'other', name: 'slice' };
  }
  return { kind: 'slice', start, end };
}

function wholeNumber(node: Js): number | undefined {
  return node.kind === 'number' && Number.isSafeInteger(node.value) && node.value >= 0 ? node.value : undefined;
}

// `getCollection('blog'[, filter])` through whatever name astro:content's
// export was imported as, or `client.fetch(<GROQ>)` with no parameters.
function baseOf(located: Located, context: Context): Base | undefined {
  const node = located.node;
  if (node.kind !== 'call') {
    return undefined;
  }
  if (node.callee.kind === 'name' && importedFrom(context, node.callee.name, 'astro:content') === 'getCollection') {
    const [name, filter] = node.args;
    if (name?.kind !== 'string' || node.args.length > 2) {
      return undefined;
    }
    if (filter !== undefined && filter.kind !== 'function') {
      return undefined;
    }
    return { kind: 'astro', collection: name.value, filter: filter ? { source: located.source, node: filter } : undefined };
  }
  if (node.callee.kind === 'name' && importedFrom(context, node.callee.name, 'astro:content') === 'getEntries') {
    const entries = entriesSelection(node.args);
    return entries === undefined ? undefined : { kind: 'astro', collection: entries.collection, filter: undefined, selection: entries.ids };
  }
  if (node.callee.kind === 'member' && node.callee.property === 'fetch' && node.callee.object.kind === 'name' && node.args.length === 1) {
    const argument = node.args[0];
    const groq = argument === undefined ? undefined : groqText(argument, context, 0);
    return groq === undefined ? undefined : { kind: 'sanity', groq, client: node.callee.object.name };
  }
  return undefined;
}

// A builder export's picked items, as a base that keeps their list.
function curatedOf(node: Js, context: Context, source: string): Base | undefined {
  const lookup = (name: string): Js | undefined => context.frontmatter.declarations.get(name)?.init;
  const curated = curatedSelection(node, { lookup, importedFrom: (local, spec) => importedFrom(context, local, spec) }, source);
  return curated === undefined ? undefined : { kind: 'astro', collection: curated.collection, filter: undefined, list: curated.list, selection: curated.ids };
}

// A filter by id and, optionally, the sort restoring that order.
function pickedSteps(steps: readonly Step[]): readonly string[] | undefined {
  const [filter, sort] = steps;
  if (filter?.kind !== 'filter' || steps.length > 2 || (sort !== undefined && sort.kind !== 'sort')) {
    return undefined;
  }
  return pickedIds(filter.function.node, sort?.kind === 'sort' ? sort.function?.node : undefined);
}

// The query a fetch is given: a string, `defineQuery(…)`/`groq` of one, or a
// frontmatter constant holding either.
function groqText(node: Js, context: Context, depth: number): string | undefined {
  if (depth > CHAIN_STEPS_MAX || depth > LIMITS.treeDepthMax) {
    return undefined;
  }
  if (node.kind === 'string') {
    return node.value.trim().startsWith('*') ? node.value : undefined;
  }
  if (node.kind === 'call' && node.callee.kind === 'name' && node.args.length === 1 && node.args[0]) {
    return groqText(node.args[0], context, depth + 1);
  }
  if (node.kind === 'name') {
    const init = context.frontmatter.declarations.get(node.name)?.init;
    return init === undefined ? undefined : groqText(init, context, depth + 1);
  }
  return undefined;
}

function importedFrom(context: Context, local: string, spec: string): string | undefined {
  const entry = context.input.imports.find((candidate) => candidate.name === local && candidate.path === spec);
  return entry === undefined ? undefined : (entry.imported ?? entry.name);
}

function originOf(root: string, context: Context): LoopValueOrigin {
  const declaration = context.frontmatter.declarations.get(root);
  if (declaration) {
    const init = declaration.init === undefined ? undefined : unwrapAwait(declaration.init);
    if (init?.kind === 'call' && init.callee.kind === 'name') {
      const exportName = init.callee.name;
      const spec = context.input.imports.find((entry) => entry.name === exportName)?.path;
      if (spec !== undefined) {
        return { kind: 'call', exportName, spec };
      }
    }
    return { kind: 'frontmatter' };
  }
  const imported = context.input.imports.find((entry) => entry.name === root);
  return imported ? { kind: 'import', spec: imported.path } : { kind: 'scope' };
}

// A List prop read where the loop reads it (`features`, `features.slice(0, 3)`),
// whose steps are list settings too. One held in a constant first stays a value:
// its steps could be spread over declarations that other code also reads.
function listPropReading(pipeline: Extract<Pipeline, { readonly kind: 'value' }>, context: Context): LoopReading | undefined {
  const steps = pipeline.steps;
  if (steps === undefined || pipeline.chain.length > 0 || !COLLECTION_NAME.test(pipeline.root)) {
    return undefined;
  }
  if (listPropOf(context.input.frontmatter, pipeline.root) === undefined) {
    return undefined;
  }
  const reading = stepsReading({ source: { kind: 'list', collection: pipeline.root }, steps, chain: [], filter: undefined, itemPath: [] }, context);
  assert(reading.kind === 'query' || reading.kind === 'partial', 'A list prop’s steps read as a query or partly');
  return reading;
}

// ---------------------------------------------------------------------------
// A collection pipeline as a query.
// ---------------------------------------------------------------------------

function queryOf(pipeline: Extract<Pipeline, { readonly kind: 'collection' }>, context: Context): LoopReading {
  const base = pipeline.base;
  const source: LoopSource = base.kind === 'astro' ? { kind: 'astro', collection: base.collection } : { kind: 'sanity', collection: '' };
  if (base.kind === 'sanity') {
    return sanityQueryOf(base, pipeline, context);
  }
  if (!COLLECTION_NAME.test(source.collection)) {
    return partial(source, pipeline, 'The collection is named by code.');
  }
  if (base.selection !== undefined) {
    return selectedOf(base, pipeline);
  }
  const picked = base.filter === undefined && base.list === undefined ? pickedSteps(pipeline.steps) : undefined;
  if (picked !== undefined) {
    return selectedOf({ ...base, selection: picked }, { ...pipeline, steps: [] });
  }
  const itemPath = base.list?.itemPath ?? ['data'];
  const read = stepsReading({ source, steps: pipeline.steps, chain: pipeline.chain, filter: base.filter, itemPath }, context);
  if (read.kind === 'query' && base.list !== undefined) {
    return { ...read, home: { kind: 'chain', list: base.list.text, itemPath: base.list.itemPath } };
  }
  return read;
}

// A list's JavaScript steps as a query, or partly when one is not a setting:
// the same for a collection and a List prop, apart from where items hold fields.
function stepsReading(
  list: {
    readonly source: LoopSource;
    readonly steps: readonly Step[];
    readonly chain: readonly string[];
    /** A filter given where the list is read: `getCollection`'s second argument. */
    readonly filter: Located | undefined;
    readonly itemPath: ItemPath;
  },
  context: Context,
): LoopReading {
  const { source, itemPath } = list;
  const pipeline = { chain: list.chain };
  const order = stepOrder(list.steps);
  if (order === undefined) {
    return partial(source, pipeline, 'Its items are changed by code the list settings cannot show.');
  }
  const filters = [...(list.filter ? [list.filter] : []), ...order.filters];
  const conditions = astroConditions(filters, source, context, itemPath);
  if (conditions === undefined) {
    return partial(source, pipeline, 'Its filter is written in a way the list settings cannot show.');
  }
  const sorting = order.sort === undefined ? { sorts: [], random: false } : readComparator(order.sort, itemPath);
  // A comparator no sort key can say is kept as code: a custom sort.
  const customSort = sorting === undefined && order.sort !== undefined ? customSortOf(order.sort) : undefined;
  if (sorting === undefined && customSort === undefined) {
    return partial(source, pipeline, 'Its sort order is computed by code.');
  }
  if (order.reversed && customSort !== undefined) {
    return partial(source, pipeline, 'Its sort order is computed by code, then reversed.');
  }
  // The schema knows better than the syntax: `+b.data.date` is a date read as a number.
  const typed = (sorting?.sorts ?? []).map((sort) => withOrder(sort, source, context.input.fieldKind));
  const sorts = order.reversed ? typed.map(flipped) : typed;
  const random = sorting?.random === true;
  if (order.reversed && sorts.length === 0 && !random) {
    return partial(
      source,
      pipeline,
      source.kind === 'list' ? 'It is shown in reverse of the list’s own order.' : 'It is shown in reverse of the collection’s own order.',
    );
  }
  const query: LoopQuery = {
    source,
    ...conditions,
    sorts,
    random,
    offset: order.offset,
    limit: order.limit,
    projection: undefined,
    ...(customSort === undefined ? {} : { customSort }),
  };
  return checked(query, pipeline, undefined) ?? partial(source, pipeline, 'Its settings are outside what the list settings can show.');
}

// Picked items. Filters after them only drop ids no longer found (getEntries
// gives undefined for those); anything else done to them is code.
function selectedOf(base: Extract<Base, { readonly kind: 'astro' }>, pipeline: Extract<Pipeline, { readonly kind: 'collection' }>): LoopReading {
  const source: LoopSource = { kind: 'astro', collection: base.collection };
  if (pipeline.steps.some((step) => step.kind !== 'filter')) {
    return partial(source, pipeline, 'Its picked items are changed by code.');
  }
  const query: LoopQuery = { ...emptyQuery(source), selection: base.selection };
  const read = checked(query, pipeline, undefined);
  assert(read?.kind === 'query', 'A selection within its bounds reads as a query');
  return base.list === undefined ? read : { ...read, home: { kind: 'chain', list: base.list.text, itemPath: base.list.itemPath } };
}

function sanityQueryOf(
  base: Extract<Base, { readonly kind: 'sanity' }>,
  pipeline: Extract<Pipeline, { readonly kind: 'collection' }>,
  context: Context,
): LoopReading {
  const groq = readGroq(base.groq);
  if (groq === undefined || !COLLECTION_NAME.test(groq.type)) {
    // Not one type's list: only the code can say what it is.
    return { kind: 'value', root: pipeline.chain[0] ?? base.client, origin: { kind: 'frontmatter' }, chain: pipeline.chain };
  }
  const source: LoopSource = { kind: 'sanity', collection: groq.type };
  if (groq.selection !== undefined) {
    // GROQ returns picked documents in its own order; one sort restores the picked one.
    const reordered = pipeline.steps.length === 0 || (pipeline.steps.length === 1 && pipeline.steps[0]?.kind === 'sort');
    const picked: LoopQuery = { ...emptyQuery(source), selection: groq.selection, projection: groq.projection };
    return reordered
      ? (checked(picked, pipeline, base.client) ?? partial(source, pipeline, 'Its picked items are outside the list settings.'))
      : partial(source, pipeline, 'Its picked documents are changed by code after they are fetched.');
  }
  const order = stepOrder(pipeline.steps);
  if (order === undefined || order.filters.length > 0 || order.reversed) {
    return partial(source, pipeline, 'Its items are changed by code after they are fetched.');
  }
  const random = order.sort === undefined ? false : readComparator(order.sort, [])?.random === true;
  // A sort after the fetch that is not a shuffle is a custom sort: GROQ's own
  // order and a slice before it would both be undone by it.
  const customSort = order.sort !== undefined && !random ? customSortOf(order.sort) : undefined;
  if (order.sort !== undefined && !random && customSort === undefined) {
    return partial(source, pipeline, 'It is sorted by code after it is fetched.');
  }
  const sliced = order.offset > 0 || order.limit !== undefined;
  const groqSliced = groq.offset > 0 || groq.limit !== undefined;
  if (sliced && groqSliced) {
    return partial(source, pipeline, 'It is sliced twice.');
  }
  if (customSort !== undefined && (groq.sorts.length > 0 || groqSliced)) {
    return partial(source, pipeline, 'It is ordered by GROQ, then again by code.');
  }
  const fieldKinds = context.input.fieldKind;
  const conditions = groq.conditions;
  const query: LoopQuery = {
    source,
    match: groq.match,
    conditions,
    sorts: random ? [] : groq.sorts.map((sort) => withOrder(sort, source, fieldKinds)),
    random,
    offset: sliced ? order.offset : groq.offset,
    limit: sliced ? order.limit : groq.limit,
    projection: groq.projection,
    parameter: { kind: 'data' },
    ...(customSort === undefined ? {} : { customSort }),
  };
  return checked(query, pipeline, base.client) ?? partial(source, pipeline, 'Its settings are outside what the list settings can show.');
}

function checked(query: LoopQuery, pipeline: { readonly chain: readonly string[] }, client: string | undefined): LoopReading | undefined {
  if (!withinLimits(query)) {
    return undefined;
  }
  assertLoopQuery(query);
  return { kind: 'query', query, chain: pipeline.chain, client };
}

function withinLimits(query: LoopQuery): boolean {
  if (query.conditions.length > LOOP_QUERY_LIMITS.conditionsMax || query.sorts.length > LOOP_QUERY_LIMITS.sortsMax) {
    return false;
  }
  if (query.offset > LOOP_QUERY_LIMITS.offsetMax) {
    return false;
  }
  return query.limit === undefined || (query.limit >= 1 && query.limit <= LOOP_QUERY_LIMITS.limitMax);
}

function partial(source: LoopSource, pipeline: { readonly chain: readonly string[] }, reason: string): LoopReading {
  return { kind: 'partial', source, chain: pipeline.chain, reason };
}

interface StepOrder {
  readonly filters: readonly Located[];
  readonly sort: Located | undefined;
  readonly reversed: boolean;
  readonly offset: number;
  readonly limit: number | undefined;
}

// Filters, then at most one sort (and a reverse), then at most one slice: the
// order in which they mean what the settings say. Anything else is code.
function stepOrder(steps: readonly Step[]): StepOrder | undefined {
  const filters: Located[] = [];
  let sort: Located | undefined;
  let sorted = false;
  let reversed = false;
  let slice: Extract<Step, { readonly kind: 'slice' }> | undefined;
  for (const step of steps) {
    if (slice !== undefined) {
      return undefined;
    }
    switch (step.kind) {
      case 'filter':
        if (sorted || reversed) {
          return undefined;
        }
        filters.push(step.function);
        break;
      case 'sort':
        if (sorted || reversed || step.function === undefined) {
          return undefined;
        }
        sorted = true;
        sort = step.function;
        break;
      case 'reverse':
        if (reversed) {
          return undefined;
        }
        reversed = true;
        break;
      case 'slice':
        slice = step;
        break;
      case 'other':
        return undefined;
      default: {
        const exhaustive: never = step;
        return exhaustive;
      }
    }
  }
  if (slice?.end !== undefined && slice.end <= slice.start) {
    return undefined;
  }
  const offset = slice?.start ?? 0;
  const limit = slice?.end === undefined ? undefined : slice.end - offset;
  return { filters, sort, reversed, offset, limit };
}

// The comparator's own text, when it fits a custom sort's bound.
function customSortOf(located: { readonly source: string; readonly node: Js }): string | undefined {
  const text = located.source.slice(located.node.from, located.node.to).trim();
  if (text === '' || text.length > LOOP_QUERY_LIMITS.customCodeCharsMax) {
    return undefined;
  }
  return text;
}

function flipped(sort: LoopSort): LoopSort {
  return { ...sort, direction: sort.direction === 'ascending' ? 'descending' : 'ascending' };
}

// A comparator says how it compares a value, but a subtraction cannot say a
// number from a time: the field's kind settles the four value orders. An
// order that measures the value (numbers in order, length, count, file size)
// is what the code said, and stays.
function withOrder(sort: LoopSort, source: LoopSource, fieldKind: LoopReadInput['fieldKind']): LoopSort {
  if (!['text', 'number', 'date', 'boolean'].includes(sort.order)) {
    return sort;
  }
  const kind = fieldKind?.(source, sort.field);
  const order: LoopSortOrder | undefined =
    kind === 'number' ? 'number' : kind === 'date' ? 'date' : kind === 'text' ? 'text' : kind === 'boolean' ? 'boolean' : undefined;
  return order === undefined ? sort : { ...sort, order };
}

// ---------------------------------------------------------------------------
// Astro filter functions.
// ---------------------------------------------------------------------------

interface AstroConditions {
  readonly match: 'all' | 'any';
  readonly conditions: readonly LoopCondition[];
  readonly parameter: AstroItemParameter;
}

function astroConditions(filters: readonly Located[], source: LoopSource, context: Context, itemPath: ItemPath): AstroConditions | undefined {
  if (filters.length === 0) {
    return { match: 'all', conditions: [], parameter: emptyQuery(source).parameter };
  }
  let parameter: AstroItemParameter | undefined;
  let match: 'all' | 'any' = 'all';
  const conditions: LoopCondition[] = [];
  for (const filter of filters) {
    const read = filterFunction(filter, source, context, itemPath);
    if (read === undefined) {
      return undefined;
    }
    // Custom conditions are written against their function's parameter, so
    // every function has to name the entry the same way to share one.
    if (parameter !== undefined && !sameParameter(parameter, read.parameter) && read.conditions.some((condition) => condition.kind === 'custom')) {
      return undefined;
    }
    parameter = parameter ?? read.parameter;
    if (read.match === 'any' && read.conditions.length > 1) {
      if (filters.length > 1) {
        return undefined;
      }
      match = 'any';
    }
    conditions.push(...read.conditions);
  }
  assert(parameter !== undefined, 'Every filter function names its entry');
  return { match, conditions, parameter };
}

function sameParameter(left: AstroItemParameter, right: AstroItemParameter): boolean {
  if (left.kind === 'data') {
    return right.kind === 'data';
  }
  return right.kind === 'entry' && right.name === left.name;
}

function filterFunction(filter: Located, source: LoopSource, context: Context, itemPath: ItemPath): AstroConditions | undefined {
  const node = filter.node;
  if (node.kind !== 'function' || node.body === undefined || node.parameters.length !== 1) {
    return undefined;
  }
  const parameter = node.parameters[0];
  let base: readonly string[];
  let itemParameter: AstroItemParameter;
  const field = itemPath[0];
  if (parameter?.kind === 'object' && field !== undefined && parameter.names.length === 1 && parameter.names[0] === field && itemPath.length === 1) {
    base = [field];
    itemParameter = { kind: 'data' };
  } else if (parameter?.kind === 'name') {
    base = [parameter.name, ...itemPath];
    itemParameter = { kind: 'entry', name: parameter.name };
  } else {
    return undefined;
  }
  const located = { source: filter.source, base, collection: source, fieldKind: context.input.fieldKind };
  const or = chainOf(node.body, '||');
  const and = chainOf(node.body, '&&');
  const read: AstroConditions =
    or.length > 1
      ? { match: 'any', conditions: or.map((clause) => conditionOf(clause, located)), parameter: itemParameter }
      : { match: 'all', conditions: and.map((clause) => conditionOf(clause, located)), parameter: itemParameter };
  if (read.conditions.length > LOOP_QUERY_LIMITS.conditionsMax) {
    return undefined;
  }
  // A clause read through the block's own constants names things only that
  // block declares; kept as code on its own, it would not compile.
  if (node.substituted && read.conditions.some((condition) => condition.kind === 'custom')) {
    return undefined;
  }
  return read;
}
