// Placing a loop's new source in the file. One plan says everything the change
// touches, so it lands as one edit and one undo step:
//
//   - the query, as a `const` in the frontmatter (marked as Stacki's, so the
//     timed clean-up in appShortcuts.ts can take it back once nothing uses it),
//     in the slot of the declaration it replaces when this loop was that
//     declaration's only reader, or at the end otherwise;
//   - the declarations the old source needed and nothing else reads any more —
//     the query, a GROQ constant it fetched, a value an import computed — and
//     the imports only they used;
//   - the imports the new query needs (`getCollection`, a Sanity client);
//   - the loop head, reading the new `const`;
//   - the loop's children, re-pointed at the new item's fields (loopRebind.ts).
//
// Anything someone else reads is left alone: a declaration another loop or
// binding uses stays, and so does an import used anywhere else. Reads are
// counted over the whole page as text, which over-counts rather than
// under-counts — the wrong answer here is deleting something still in use.

import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import type { ImportDecl } from '../../shared/page/pageNode';
import { astroQueryCode, assertLoopQuery, chainQueryCode, listQueryCode, sanityQueryCode, type LoopField, type LoopQuery, type LoopSource } from './loopQuery';
import { readingChain, readLoop, type LoopReading } from './loopQueryRead';
import { reboundItem, type ItemShape } from './loopRebind';
import { appliedEdits, sectionCodeProblem, sectionEdits, type LoopSection } from './loopSections';
import { parseExpression, parseFrontmatter, type ParsedFrontmatter } from './loopSyntax';
import { dataFormProblem, optionsLiteral, rewrittenOptions } from './optionsQuery';
import { LIST_ITEMS_HELPER, LIST_ITEMS_NAME, listItemsNeed } from './listItemsHelper';
import { reboundOptions, type BindingChange } from './optionsBinding';
import { fieldListCode, type FieldList } from './loopFieldList';
import { splitMapHead, type LoopHead } from './loopBindings';
import { autoQueryName, QUERY_MARK } from './dataScope';
import type { EditorModel, EditorNode } from './pageView';

/** What a loop is changed to loop over. */
export type LoopTarget =
  | {
      readonly kind: 'query';
      readonly query: LoopQuery;
      readonly fields: readonly LoopField[];
      /** `data` writes the settings as data a prop can hold (listItemsHelper.ts); code otherwise. */
      readonly form?: 'code' | 'data' | undefined;
    }
  | { readonly kind: 'value'; readonly data: string }
  | { readonly kind: 'empty' }
  /** One of the list's settings linked to a component prop, or unlinked. */
  | { readonly kind: 'binding'; readonly change: BindingChange }
  /** A list field inside a content collection's items, across all of them. */
  | { readonly kind: 'field'; readonly list: FieldList }
  /** One of the list's sections as code, rewritten where its steps are (loopSections.ts). */
  | { readonly kind: 'section'; readonly section: LoopSection; readonly code: string };

export interface LoopPlanInput {
  readonly model: Pick<EditorModel, 'extraFrontmatter' | 'imports' | 'nodes'>;
  readonly loop: Extract<EditorNode, { readonly kind: 'map' }>;
  readonly target: LoopTarget;
  /** Whether `sanity:client` resolves in this project (the @sanity/astro integration). */
  readonly sanityClient: 'available' | 'unavailable';
  /**
   * The children as they were the last time the loop read this target, when
   * nothing has changed them since the switch away: switching back puts them
   * back, bindings and all, instead of re-pointing what was left unlinked.
   */
  readonly restore?: readonly EditorNode[] | undefined;
}

export interface LoopPlan {
  readonly extraFrontmatter: string;
  readonly imports: readonly ImportDecl[];
  readonly loop: Extract<EditorNode, { readonly kind: 'map' }>;
  /** Bindings inside the loop that had no field to point at in the new collection. */
  readonly unbound: number;
  /** The fields those bindings named. */
  readonly lost: readonly string[];
  /** What the loop read before, by key (`astro:blog`): where restored children belong. */
  readonly previous: string | undefined;
  /** Whether the children were put back as they were for this target. */
  readonly restored: boolean;
}

export type LoopPlanResult = { readonly ok: true; readonly plan: LoopPlan } | { readonly ok: false; readonly message: string };

const DEFAULT_SANITY_CLIENT = 'sanityClient';
const CLEANUP_PASSES_MAX = 16;

export function planLoop(input: LoopPlanInput): LoopPlanResult {
  const head = splitMapHead(input.loop.head);
  if (head === undefined) {
    return { ok: false, message: 'This loop is written as custom code. Edit it in the Code field.' };
  }
  const before = parseFrontmatter(input.model.extraFrontmatter);
  const reading = readLoop({ frontmatter: input.model.extraFrontmatter, imports: input.model.imports, data: head.data });
  if (input.target.kind === 'binding') {
    return bindingEdit(input, input.target.change, { reading, frontmatter: before, data: head.data });
  }
  if (input.target.kind === 'section') {
    return sectionEdit(input, input.target, { head, reading, frontmatter: before });
  }
  if (input.target.kind === 'query' && input.target.query.source.kind === 'list') {
    return { ok: true, plan: listEdit(input, input.target.query, head) };
  }
  const inPlace = optionsEdit(input, reading, before);
  if (inPlace !== undefined) {
    return inPlace;
  }
  const markup = markupWithout(input.model.nodes, input.loop.id);
  // The declaration this loop names directly, when only this loop reads it:
  // its slot is where the new query goes, so the file reads in the same order.
  const holder = ownedHolder(head.data, reading, before, markup);
  const written = writtenTarget(input, holder, before);
  if (!written.ok) {
    return written;
  }
  const loopHead = `${written.data}.map((${head.item}${head.index ? `, ${head.index}` : ''}) => (`;
  const markupAfter = `${markup}\n${loopHead}`;
  const removable = new Set(readingChain(reading).filter((name) => name !== written.name));
  // The holder was replaced in place: what it read is now possibly unread.
  const replaced = holder === undefined ? '' : input.model.extraFrontmatter.slice(holder.from, holder.to);
  for (const use of before.uses) {
    if (holder !== undefined && use.from >= holder.from && use.from < holder.to) {
      removable.add(use.name);
    }
  }
  const cleaned = cleanedUp({ frontmatter: written.frontmatter, imports: written.imports, removed: replaced }, removable, markupAfter);
  const restoring = input.restore !== undefined && readingKeyOf(reading, head.data) !== targetKey(input.target);
  const rebound = reboundChildren(input, { reading, item: head.item, restoring });
  const loop = { ...input.loop, head: loopHead, children: rebound.nodes };
  assert(loop.id === input.loop.id, 'A planned loop keeps its id');
  assert(splitMapHead(loop.head) !== undefined, 'A planned head is one the loop editor reads back');
  return {
    ok: true,
    plan: {
      extraFrontmatter: cleaned.frontmatter,
      imports: cleaned.imports,
      loop,
      unbound: rebound.unbound,
      lost: rebound.lost,
      previous: readingKeyOf(reading, head.data),
      restored: restoring,
    },
  };
}

// A List prop's settings live in the loop's own head, where the prop is read:
// the frontmatter, the imports and the children stay as they are, since a
// filter, a sort and a limit leave each item as it was.
function listEdit(input: LoopPlanInput, query: LoopQuery, head: LoopHead): LoopPlan {
  const loopHead = `${listQueryCode(query)}.map((${head.item}${head.index ? `, ${head.index}` : ''}) => (`;
  const loop = { ...input.loop, head: loopHead };
  assert(splitMapHead(loop.head)?.item === head.item, 'A list prop’s head is one the loop editor reads back');
  return { ...inPlacePlan(input, input.model.extraFrontmatter, sourceKeyOf(query.source)), loop };
}

// A section as code: only its bytes change, in the head or the declaration its
// steps are written in. The rest of the head, the other sections, the imports
// and the children stay as they are, so there is nothing to clean up after it.
function sectionEdit(
  input: LoopPlanInput,
  target: Extract<LoopTarget, { readonly kind: 'section' }>,
  read: { readonly head: LoopHead; readonly reading: LoopReading; readonly frontmatter: ParsedFrontmatter },
): LoopPlanResult {
  const { head, frontmatter } = read;
  const problem = sectionCodeProblem(target.section, target.code);
  if (problem !== undefined) {
    return { ok: false, message: problem };
  }
  const code = { frontmatter: input.model.extraFrontmatter, imports: input.model.imports, data: head.data };
  const shared = sharedAt(frontmatter, readingChain(read.reading), markupWithout(input.model.nodes, input.loop.id));
  const written = sectionEdits(code, target.section, target.code, shared);
  if (!written.ok) {
    return written;
  }
  const data = appliedEdits(
    head.data,
    written.edits.filter((edit) => edit.place === 'head'),
  );
  const extraFrontmatter = appliedEdits(
    input.model.extraFrontmatter,
    written.edits.filter((edit) => edit.place === 'frontmatter'),
  );
  const at = input.loop.head.indexOf(head.data);
  assert(at >= 0, 'A loop’s head holds its data expression');
  const loopHead = `${input.loop.head.slice(0, at)}${data}${input.loop.head.slice(at + head.data.length)}`;
  // Checked once more as the whole it lands in: nothing that would not read back is written.
  if (
    splitMapHead(loopHead)?.data !== data.trim() ||
    parseExpression(data) === undefined ||
    parseFrontmatter(extraFrontmatter).declarations.size !== frontmatter.declarations.size
  ) {
    return { ok: false, message: 'This code would break the loop, so it was not written.' };
  }
  const loop = { ...input.loop, head: loopHead };
  assert(loop.id === input.loop.id, 'A planned loop keeps its id');
  return { ok: true, plan: { ...inPlacePlan(input, extraFrontmatter, ''), loop, previous: readingKeyOf(read.reading, head.data) } };
}

// Whether a frontmatter position is in a declaration something besides this
// loop reads. The declarations the loop's list passes through read each other,
// which is still this loop's own reading.
function sharedAt(frontmatter: ParsedFrontmatter, chain: readonly string[], markup: string): (position: number) => boolean {
  const spans = chain.flatMap((name) => {
    const declaration = frontmatter.declarations.get(name);
    return declaration === undefined ? [] : [{ name, statement: declaration.statement }];
  });
  const own = (position: number): boolean => spans.some(({ statement }) => position >= statement.from && position < statement.to);
  return (position) => {
    const holder = spans.find(({ statement }) => position >= statement.from && position <= statement.to);
    if (holder === undefined) {
      return true;
    }
    const readElsewhere = frontmatter.uses.some((use) => use.name === holder.name && !own(use.from));
    return readElsewhere || exported(frontmatter, holder.statement.from) || mentions(markup, holder.name);
  };
}

// The loop's children for the new source: put back as they were for it, re-pointed
// at its fields when items take another shape, or left as they are.
function reboundChildren(
  input: LoopPlanInput,
  read: { readonly reading: LoopReading; readonly item: string; readonly restoring: boolean },
): { readonly nodes: readonly EditorNode[]; readonly unbound: number; readonly lost: readonly string[] } {
  const children = input.loop.children ?? [];
  const shape = itemShape(input.target);
  if (read.restoring && input.restore !== undefined) {
    return { nodes: withoutSourceSpans(input.restore, 0), unbound: 0, lost: [] };
  }
  if (shape === undefined || !shapeChanged(read.reading, input.target)) {
    return { nodes: children, unbound: 0, lost: [] };
  }
  return reboundItem(children, read.item, shape);
}

// A builder's options object read from this file, edited with the same
// collection: the settings are rewritten where they are, and the loop, its
// children and the rest of the file stay exactly as they were.
function optionsEdit(input: LoopPlanInput, reading: LoopReading, frontmatter: ParsedFrontmatter): LoopPlanResult | undefined {
  const target = input.target;
  if (reading.kind !== 'query' || reading.home === undefined || target.kind !== 'query') {
    return undefined;
  }
  if (targetKey(target) !== sourceKeyOf(reading.query.source)) {
    return undefined;
  }
  const holder = reading.chain[reading.chain.length - 1];
  const declaration = holder === undefined ? undefined : frontmatter.declarations.get(holder);
  const init = declaration?.init;
  const query = target.query;
  const home = reading.home;
  if (init === undefined) {
    return { ok: false, message: 'The list settings changed in the code since they were read. Select the loop again.' };
  }
  if (home.kind === 'chain') {
    return {
      ok: true,
      plan: inPlacePlan(input, chainEdit(input.model.extraFrontmatter, init, chainQueryCode(query, home.list, home.itemPath)), targetKey(target)),
    };
  }

  const call = init.kind === 'await' ? init.value : init;
  const options = call.kind === 'call' ? call.args[1] : undefined;
  if (options?.kind !== 'object' || options.from !== home.options.from) {
    return { ok: false, message: 'The list settings changed in the code since they were read. Select the loop again.' };
  }
  const unsupported =
    query.random || query.conditions.some((condition) => condition.kind === 'test' && (condition.operator === 'inPast' || condition.operator === 'inFuture'));
  if (unsupported) {
    return { ok: false, message: 'This list’s settings can’t shuffle or compare with today’s date.' };
  }
  const extraFrontmatter = rewrittenOptions(input.model.extraFrontmatter, home, options, query);
  assert(extraFrontmatter !== '', 'Rewritten settings leave a frontmatter');
  return { ok: true, plan: inPlacePlan(input, extraFrontmatter, targetKey(target)) };
}

// A setting linked to a prop or unlinked: only the options, the props
// destructure and `interface Props` change; the loop and its children stay.
function bindingEdit(
  input: LoopPlanInput,
  change: BindingChange,
  read: { readonly reading: LoopReading; readonly frontmatter: ParsedFrontmatter; readonly data: string },
): LoopPlanResult {
  const { reading, frontmatter } = read;
  if (reading.kind === 'query' && reading.home === undefined && reading.query.source.kind !== 'list' && change.kind !== 'unbind') {
    return convertedBinding(input, reading.query, change);
  }
  if (reading.kind !== 'query' || reading.home?.kind !== 'options') {
    return { ok: false, message: 'Only a list whose settings are kept as data can link them to properties.' };
  }
  const holder = reading.chain[reading.chain.length - 1];
  const declaration = holder === undefined ? undefined : frontmatter.declarations.get(holder);
  const init = declaration?.init;
  const call = init?.kind === 'await' ? init.value : init;
  const options = call?.kind === 'call' ? call.args[1] : undefined;
  if (declaration === undefined || options?.kind !== 'object' || options.from !== reading.home.options.from) {
    return { ok: false, message: 'The list settings changed in the code since they were read. Select the loop again.' };
  }
  const result = reboundOptions(
    input.model.extraFrontmatter,
    { home: reading.home, options, statementFrom: declaration.statement.from, taken: frontmatter.bound },
    change,
  );
  if (!result.ok) {
    return result;
  }
  const key = readingKeyOf(reading, read.data);
  assert(key !== undefined, 'A list with settings has a key');
  return { ok: true, plan: inPlacePlan(input, result.frontmatter, key) };
}

// A list written as code is first rewritten as data, in its place and with
// the helper that reads it; then the setting is linked as on any data list.
// Both land as one plan, so one undo puts the code back.
function convertedBinding(input: LoopPlanInput, query: LoopQuery, change: BindingChange): LoopPlanResult {
  const problem = dataFormProblem(query);
  if (problem !== undefined) {
    return { ok: false, message: problem };
  }
  const converted = planLoop({ ...input, target: { kind: 'query', query, fields: [], form: 'data' }, restore: undefined });
  if (!converted.ok) {
    return converted;
  }
  const model = { ...input.model, extraFrontmatter: converted.plan.extraFrontmatter, imports: converted.plan.imports };
  const bound = planLoop({ ...input, model, loop: converted.plan.loop, target: { kind: 'binding', change }, restore: undefined });
  if (!bound.ok) {
    return bound;
  }
  assert(bound.plan.loop === converted.plan.loop, 'Linking leaves the converted loop as it is');
  assert(converted.plan.unbound === 0, 'Rewriting a list as data keeps its items as they were');
  return { ok: true, plan: { ...converted.plan, extraFrontmatter: bound.plan.extraFrontmatter } };
}

// The holder's value is the kept list with its refinements: rewrite the value only.
function chainEdit(frontmatter: string, init: { readonly from: number; readonly to: number }, code: string): string {
  assert(init.from < init.to, 'A holder has a value to rewrite');
  assert(init.to <= frontmatter.length, 'A holder is inside the frontmatter');
  return `${frontmatter.slice(0, init.from)}${code}${frontmatter.slice(init.to)}`;
}

// Settings rewritten where they are: the loop, its children and the imports stay.
function inPlacePlan(input: LoopPlanInput, extraFrontmatter: string, previous: string): LoopPlan {
  return { extraFrontmatter, imports: input.model.imports, loop: input.loop, unbound: 0, lost: [], previous, restored: false };
}

// ---------------------------------------------------------------------------
// The new source.
// ---------------------------------------------------------------------------

interface Written {
  readonly ok: true;
  readonly frontmatter: string;
  readonly imports: readonly ImportDecl[];
  /** What the loop head reads. */
  readonly data: string;
  /** The declaration written, when one was. */
  readonly name: string | undefined;
}

function writtenTarget(
  input: LoopPlanInput,
  holder: Holder | undefined,
  before: ParsedFrontmatter,
): Written | { readonly ok: false; readonly message: string } {
  const target = input.target;
  const frontmatter = input.model.extraFrontmatter;
  switch (target.kind) {
    case 'empty':
      return { ok: true, frontmatter: holder ? spliced(frontmatter, holder, '') : frontmatter, imports: input.model.imports, data: '[]', name: undefined };
    case 'value':
      return {
        ok: true,
        frontmatter: holder ? spliced(frontmatter, holder, '') : frontmatter,
        imports: input.model.imports,
        data: target.data,
        name: undefined,
      };
    case 'query':
      return writtenQuery(input, target, holder, before);
    case 'field':
      return writtenFieldList(input, target.list, holder, before);
    case 'binding':
      // Linking a setting edits the options in place (bindingEdit); it never
      // writes a new source.
      assert(false, 'A binding change is planned in place');
      return { ok: false, message: 'A binding change is planned in place.' };
    case 'section':
      // A section is rewritten in place too (sectionEdit).
      assert(false, 'A section is planned in place');
      return { ok: false, message: 'A section is planned in place.' };
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

function writtenQuery(
  input: LoopPlanInput,
  target: Extract<LoopTarget, { readonly kind: 'query' }>,
  holder: Holder | undefined,
  before: ParsedFrontmatter,
): Written | { readonly ok: false; readonly message: string } {
  const query = target.query;
  assertLoopQuery(query);
  assert(query.source.kind !== 'list', 'A list prop’s settings are written in the loop’s head');
  let imports = input.model.imports;
  let code: string;
  if (query.source.kind === 'astro') {
    const reader = importedName(imports, 'astro:content', 'getCollection');
    if (reader === undefined) {
      imports = [...imports, newImport('getCollection', 'astro:content')];
    }
    code =
      target.form === 'data'
        ? `${LIST_ITEMS_NAME}(await ${reader ?? 'getCollection'}(${JSON.stringify(query.source.collection)}), ${optionsLiteral(query)})`
        : astroQueryCode(query, reader ?? 'getCollection');
  } else {
    const client = importedName(imports, 'sanity:client', 'sanityClient');
    if (client === undefined && input.sanityClient === 'unavailable') {
      return { ok: false, message: 'Add the @sanity/astro integration to this project to loop over Sanity content.' };
    }
    if (client === undefined) {
      imports = [...imports, newImport(DEFAULT_SANITY_CLIENT, 'sanity:client')];
    }
    code = sanityQueryCode(query, target.fields, client ?? DEFAULT_SANITY_CLIENT);
  }
  // The holder's name is kept while it still describes the list; another
  // collection gets a name of its own, the way a first query would.
  const taken = new Set(before.bound);
  if (holder !== undefined) {
    taken.delete(holder.name);
  }
  for (const entry of imports) {
    taken.add(entry.name);
  }
  const keep = holder !== undefined && holder.collection === query.source.collection;
  const name = keep ? holder.name : autoQueryName(query.source.collection, taken);
  const statement = `const ${name} = ${code}; // ${QUERY_MARK}`;
  assert(!statement.includes('\n'), 'A query is written on one line');
  // A list kept as data is read through the helper, written once, above it.
  const need = target.form === 'data' ? listItemsNeed(before) : { kind: 'present' as const };
  if (need.kind === 'taken') {
    return { ok: false, message: `This file already has its own ${LIST_ITEMS_NAME}. Rename it to link list settings to properties.` };
  }
  const written = need.kind === 'add' ? `${LIST_ITEMS_HELPER}\n${statement}` : statement;
  const frontmatter = holder ? spliced(input.model.extraFrontmatter, holder, `${written}\n`) : appended(input.model.extraFrontmatter, written);
  return { ok: true, frontmatter, imports, data: name, name };
}

// A list inside every item of a collection, as a marked query in the holder's
// slot (or at the end), named for the field: `campusPastors`.
function writtenFieldList(
  input: LoopPlanInput,
  list: FieldList,
  holder: Holder | undefined,
  before: ParsedFrontmatter,
): Written | { readonly ok: false; readonly message: string } {
  const astro = list.source.kind === 'astro';
  const [path, exported, fallback] = astro
    ? (['astro:content', 'getCollection', 'getCollection'] as const)
    : (['sanity:client', 'sanityClient', DEFAULT_SANITY_CLIENT] as const);
  const reader = importedName(input.model.imports, path, exported);
  if (reader === undefined && !astro && input.sanityClient === 'unavailable') {
    return { ok: false, message: 'Add the @sanity/astro integration to this project to loop over Sanity content.' };
  }
  const imports = reader === undefined ? [...input.model.imports, newImport(fallback, path)] : input.model.imports;
  const taken = new Set(before.bound);
  if (holder !== undefined) {
    taken.delete(holder.name);
  }
  for (const entry of imports) {
    taken.add(entry.name);
  }
  const field = list.path[list.path.length - 1];
  assert(field !== undefined, 'A field list names a field');
  const name = fieldListName(`${list.source.collection}-${field}`, taken);
  assert(!taken.has(name), 'A field list gets a name of its own');
  const statement = `const ${name} = ${fieldListCode(list, reader ?? fallback)}; // ${QUERY_MARK}`;
  assert(!statement.includes('\n'), 'A field list is written on one line');
  const frontmatter = holder ? spliced(input.model.extraFrontmatter, holder, `${statement}\n`) : appended(input.model.extraFrontmatter, statement);
  return { ok: true, frontmatter, imports, data: name, name };
}

// `campus-pastors` → `campusPastors`, or `campusPastors2` past a name in use.
const FIELD_LIST_NAMES_MAX = 100;
function fieldListName(words: string, taken: ReadonlySet<string>): string {
  const camel = words.replace(/[^A-Za-z0-9]+(.)?/g, (_whole: string, letter?: string) => (letter ? letter.toUpperCase() : '')).replace(/^[0-9]+/, '');
  const base = camel === '' ? 'items' : camel;
  for (let suffix = 1; suffix <= FIELD_LIST_NAMES_MAX; suffix++) {
    const name = suffix === 1 ? base : `${base}${suffix}`;
    if (!taken.has(name)) {
      return name;
    }
  }
  assert(false, 'A free name is found within the suffix bound');
  return base;
}

function importedName(imports: readonly ImportDecl[], path: string, exported: string): string | undefined {
  const entry = imports.find((candidate) => candidate.path === path && (candidate.imported ?? candidate.name) === exported && candidate.typeOnly !== true);
  return entry?.name;
}

function newImport(name: string, path: string): ImportDecl {
  return { name, imported: name, path, quote: "'", named: true };
}

function appended(frontmatter: string, statement: string): string {
  const gap = frontmatter !== '' && !frontmatter.endsWith('\n') ? '\n' : '';
  return `${frontmatter}${gap}${statement}`;
}

// ---------------------------------------------------------------------------
// The old source.
// ---------------------------------------------------------------------------

interface Holder {
  readonly name: string;
  readonly from: number;
  readonly to: number;
  /** The collection it reads, when it is a collection query. */
  readonly collection: string | undefined;
}

function ownedHolder(data: string, reading: LoopReading, frontmatter: ParsedFrontmatter, markup: string): Holder | undefined {
  const name = readingChain(reading)[0];
  if (name === undefined || data.trim() !== name) {
    return undefined;
  }
  const declaration = frontmatter.declarations.get(name);
  if (declaration === undefined || !declaration.alone || exported(frontmatter, declaration.statement.from)) {
    return undefined;
  }
  if (readsOutside(frontmatter, name, declaration.statement) > 0 || mentions(markup, name)) {
    return undefined;
  }
  const collection = reading.kind === 'query' ? reading.query.source.collection : reading.kind === 'partial' ? reading.source.collection : undefined;
  return { name, from: declaration.statement.from, to: declaration.statement.to, collection };
}

function spliced(frontmatter: string, holder: Pick<Holder, 'from' | 'to'>, text: string): string {
  assert(holder.from <= holder.to, 'A replaced span is ordered');
  assert(holder.to <= frontmatter.length, 'A replaced span is inside the frontmatter');
  const next = `${frontmatter.slice(0, holder.from)}${text}${frontmatter.slice(holder.to)}`;
  // The last statement leaves no trailing break; the printer ends the block.
  return text === '' || holder.to < frontmatter.length ? next : next.replace(/\n$/, '');
}

// Declarations the old source followed (and those they in turn read) that
// nothing reads any more, and then the imports only they read. Each pass
// removes at least one statement or stops; the passes are bounded.
function cleanedUp(
  start: { readonly frontmatter: string; readonly imports: readonly ImportDecl[]; readonly removed: string },
  candidates: ReadonlySet<string>,
  markup: string,
): { readonly frontmatter: string; readonly imports: readonly ImportDecl[] } {
  let code = start.frontmatter;
  const imports = start.imports;
  const pending = new Set(candidates);
  const removedText: string[] = [start.removed];
  for (let pass = 0; pass < CLEANUP_PASSES_MAX && pending.size > 0; pass++) {
    const parsed = parseFrontmatter(code);
    const dead = [...pending].find((name) => {
      const declaration = parsed.declarations.get(name);
      return (
        declaration !== undefined &&
        declaration.alone &&
        !exported(parsed, declaration.statement.from) &&
        readsOutside(parsed, name, declaration.statement) === 0 &&
        !mentions(markup, name)
      );
    });
    if (dead === undefined) {
      break;
    }
    const declaration = parsed.declarations.get(dead);
    assert(declaration !== undefined, 'A dead declaration was found by name');
    const text = code.slice(declaration.statement.from, declaration.statement.to);
    removedText.push(text);
    // What it read may now be unread too: a GROQ constant, an earlier step.
    for (const use of parsed.uses) {
      if (use.from >= declaration.statement.from && use.from < declaration.statement.to) {
        pending.add(use.name);
      }
    }
    pending.delete(dead);
    code = spliced(code, declaration.statement, '');
  }
  const after = parseFrontmatter(code);
  const readNames = new Set(after.uses.map((use) => use.name));
  const removed = removedText.join('\n');
  const kept = imports.filter((entry) => {
    const wasRead = mentions(removed, entry.name);
    return !wasRead || readNames.has(entry.name) || mentions(markup, entry.name);
  });
  assert(kept.length <= imports.length, 'Clean-up never adds an import');
  return { frontmatter: code, imports: kept };
}

function readsOutside(frontmatter: ParsedFrontmatter, name: string, span: { readonly from: number; readonly to: number }): number {
  let count = 0;
  for (const use of frontmatter.uses) {
    if (use.name === name && (use.from < span.from || use.from >= span.to)) {
      count++;
    }
  }
  return count;
}

function exported(frontmatter: ParsedFrontmatter, from: number): boolean {
  return /^\s*export\b/.test(frontmatter.source.slice(from, from + 16));
}

function mentions(text: string, name: string): boolean {
  const escaped = name.replace(/[$]/g, '\\$');
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(text);
}

// The page's markup as text, with this loop's own head left out: what the
// rest of the page reads.
function markupWithout(nodes: readonly EditorNode[], loopId: string): string {
  const text = JSON.stringify(nodes);
  assert(text.length <= LIMITS.ipcFieldCharsMax, 'The page markup is bounded');
  const loop = findLoop(nodes, loopId);
  if (loop === undefined) {
    return text;
  }
  const head = JSON.stringify(loop.head);
  const at = text.indexOf(`"head":${head}`);
  return at < 0 ? text : `${text.slice(0, at)}${text.slice(at + head.length + 7)}`;
}

function findLoop(nodes: readonly EditorNode[], id: string): Extract<EditorNode, { readonly kind: 'map' }> | undefined {
  const pending = [...nodes];
  for (let count = 0; pending.length > 0 && count < LIMITS.treeNodesMax; count++) {
    const node = pending.pop();
    if (node?.id === id && node.kind === 'map') {
      return node;
    }
    pending.push(...(node?.children ?? []));
  }
  return undefined;
}

// Keys a re-parse after saving gives new values without anything changing:
// what identifies a node to the app, and where its bytes are.
const SOURCE_KEYS = new Set(['id', 'start', 'end', 'at', 'attrSpans', 'headSource']);

/**
 * The children as text, without ids or source positions: equal when the
 * markup and bindings are, however often the file was saved and read since.
 */
export function childrenFingerprint(nodes: readonly EditorNode[]): string {
  const text = JSON.stringify(nodes, (key: string, value: unknown) => (SOURCE_KEYS.has(key) ? undefined : value));
  assert(text.length <= LIMITS.ipcFieldCharsMax, 'A loop body is bounded');
  return text;
}

// Children kept from before a switch, without the attribute spans that
// described bytes since rewritten (a node is written from its props).
function withoutSourceSpans(nodes: readonly EditorNode[], depth: number): readonly EditorNode[] {
  assert(depth <= LIMITS.treeDepthMax, `withoutSourceSpans: depth ${depth} exceeds the tree cap`);
  return nodes.map((node) => {
    const { attrSpans: staleSpans, ...rest } = node;
    void staleSpans;
    const children = rest.children === undefined ? undefined : withoutSourceSpans(rest.children, depth + 1);
    return Object.assign({}, rest, children === undefined ? {} : { children });
  });
}

// A List prop is keyed as the value it is, whatever its settings say, so a
// switch away from it and back finds the same remembered children.
function sourceKeyOf(source: LoopSource): string {
  return source.kind === 'list' ? `value:${source.collection}` : `${source.kind}:${source.collection}`;
}

/** What a loop reads, by key: `astro:blog`, `sanity:pastor`, `value:items`. */
export function targetKey(target: LoopTarget): string {
  switch (target.kind) {
    case 'query':
      return sourceKeyOf(target.query.source);
    case 'value':
      return `value:${target.data.trim()}`;
    case 'empty':
      return 'empty';
    case 'binding':
      // Not a source: no children are kept or restored under it.
      return `binding:${target.change.setting}`;
    case 'section':
      // Nor is a section: the loop still reads the same list.
      return `section:${target.section}`;
    case 'field':
      return `field:${target.list.source.kind}:${target.list.source.collection}:${target.list.path.join('.')}`;
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

function readingKeyOf(reading: LoopReading, data: string): string | undefined {
  switch (reading.kind) {
    case 'query':
      return sourceKeyOf(reading.query.source);
    case 'partial':
      return sourceKeyOf(reading.source);
    case 'value':
      return `value:${data.trim()}`;
    case 'empty':
      return 'empty';
    case 'code':
      return undefined;
    default: {
      const exhaustive: never = reading;
      return exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// The item's shape.
// ---------------------------------------------------------------------------

function itemShape(target: LoopTarget): ItemShape | undefined {
  if (target.kind !== 'query' || target.fields.length === 0) {
    return undefined;
  }
  const fields = new Set(target.fields.map((field) => field.path.split('.')[0] ?? field.path));
  return { kind: target.query.source.kind, fields };
}

// Filters, sort and limit leave each item as it was; only another collection
// (or a list from elsewhere becoming a collection) changes what an item holds.
function shapeChanged(reading: LoopReading, target: LoopTarget): boolean {
  if (target.kind !== 'query') {
    return false;
  }
  const source = reading.kind === 'query' ? reading.query.source : reading.kind === 'partial' ? reading.source : undefined;
  if (source === undefined) {
    return reading.kind !== 'empty';
  }
  return source.kind !== target.query.source.kind || source.collection !== target.query.source.collection;
}
