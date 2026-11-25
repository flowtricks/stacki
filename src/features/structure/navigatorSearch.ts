// The Navigator's search as values: which rows of the page tree a query keeps, by element or
// component name, tag, class, id and text, each kept row with the rows above it.
//
// Pure. The panel builds the index once per tree (each node's name, class, id and words folded to
// lowercase without accents, one string per node) and every keystroke is then one linear walk over
// the tree with `String.includes`. The result is a copy of the tree holding only the matches and
// their ancestors; the panel draws that copy fully open (a closed ancestor would hide a match), so
// what the person folded or unfolded is never touched and returns when the search clears.
//
// A query is words, or selector and markup forms the parser below reads: `.class`, `#id`,
// `[attribute]` / `[attribute=value]` (and `^=`, `$=`, `*=`, `~=`), `<tag>` / `<tag` / `</tag>`, and
// `/* comment` / `<!-- comment`. Terms are joined by AND on one row. Anything the parser cannot read
// (a lone `.`, an unclosed `[`) is a plain word, so a half-typed query never errors.
//
// A copy of the tree has different child positions than the page, and a drop lands at a position,
// so the panel never draws the copy while anything is being dragged (StructurePanel.tsx).
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { foldSearchText, holdsEveryWord, queryWords } from '../../lib/searchText';
import { labelsNode } from '../../../shared/page/leadingNote';
import { hidesChildRows } from '../../editor/treeSelection';
import type { NavigatorNode } from './structureModel';

/**
 * Rows that match on their own, at most. A page of tens of thousands of nodes searched for `d` would
 * otherwise draw a row for nearly every one of them; past this the later matches are left out and the
 * panel says so. The Navigator is not windowed, so the bound is on rows drawn.
 */
export const NAVIGATOR_MATCHES_MAX = 500;

/** What a query is held against for one node, folded once when the index is built. */
export interface NavigatorIndexEntry {
  /** Name, class, id, text, comment and content words: what plain words match. */
  readonly text: string;
  /** Only the name, class and id of the row: a word found here is a name match, not a content match. */
  readonly names: string;
  /** The row's own words as written, whitespace collapsed: direct text, string props and attributes. For snippets. */
  readonly content: string;
  /** Folded tag or component name; empty for a node that is neither. */
  readonly tag: string;
  /** Folded class tokens. */
  readonly classes: readonly string[];
  /** Folded id, or empty. */
  readonly id: string;
  /** Folded attribute name to its folded static value; a bare attribute has no value. */
  readonly attributes: ReadonlyMap<string, string | undefined>;
  /** Folded comment text, or undefined for a node that is not a comment. */
  readonly comment: string | undefined;
}

/** Each node's search entry, by node id. */
export type NavigatorSearchIndex = ReadonlyMap<string, NavigatorIndexEntry>;

/** One attribute or prop value longer than this is not searchable: it is data, not words (an inlined SVG, a long blob). */
export const NAVIGATOR_VALUE_CHARS_MAX = 500;

/** A URL-like value longer than this is not searchable. Short ones (`/about`) are. */
export const NAVIGATOR_URL_CHARS_MAX = 120;

/** A run of text with no space this long is a token or encoded data (base64), not words. */
export const NAVIGATOR_TOKEN_CHARS_MAX = 100;

/** All the words one row holds as content (its text, string props and attributes) stop growing here. */
export const NAVIGATOR_CONTENT_CHARS_MAX = 2_000;

/** Characters of context on each side of a content match in a row's snippet. */
export const NAVIGATOR_SNIPPET_CONTEXT_CHARS = 20;

/** A query longer than this is cut: the parser reads at most this many characters. */
export const NAVIGATOR_QUERY_LENGTH_MAX = 200;

/** Terms read from one query; the rest are left out. */
export const NAVIGATOR_TERMS_MAX = 8;

export interface NavigatorSearchResult {
  /** The matching rows and their ancestors, in page order. */
  readonly nodes: readonly NavigatorNode[];
  /** Rows that matched on their own, never more than NAVIGATOR_MATCHES_MAX. */
  readonly matchCount: number;
  /** True when more rows matched than the bound lets through. */
  readonly capped: boolean;
  /** For rows that matched by their content, the matched words with a little context, by node id. */
  readonly snippets: ReadonlyMap<string, string>;
}

/** The index of a tree: one walk, folding each node's text once. */
export function buildNavigatorIndex(nodes: readonly NavigatorNode[]): NavigatorSearchIndex {
  const index = new Map<string, NavigatorIndexEntry>();
  const stack: { readonly node: NavigatorNode; readonly depth: number }[] = nodes.map((node) => ({ node, depth: 0 }));
  // Every pass pops one node and pushes its children, so the walk visits each node once.
  for (let step = 0; step < LIMITS.treeNodesMax && stack.length > 0; step += 1) {
    const entry = stack.pop();
    assert(entry !== undefined, 'The stack had a node');
    assert(entry.depth <= LIMITS.treeDepthMax, 'The Navigator index walks no deeper than a page tree');
    index.set(entry.node.id, entryOf(entry.node));
    for (const child of childrenOf(entry.node)) {
      stack.push({ node: child, depth: entry.depth + 1 });
    }
  }
  assert(stack.length === 0, 'The index walk visited every node');
  return index;
}

/**
 * The tree reduced to the rows that hold every word of the query, and their ancestors. A query with
 * no word keeps nothing: the panel draws the page instead of searching.
 */
export function searchNavigator(nodes: readonly NavigatorNode[], index: NavigatorSearchIndex, query: string): NavigatorSearchResult {
  const terms = parseNavigatorQuery(query);
  const budget = new MatchBudget();
  if (terms.length === 0) {
    return { nodes: [], matchCount: 0, capped: false, snippets: new Map() };
  }
  const walk: Walk = { index, terms, budget, labelled: new Set<string>(), snippets: new Map<string, string>() };
  const kept = keepAll(nodes, walk, 0);
  assert(budget.matches <= NAVIGATOR_MATCHES_MAX, 'Matches stay within the bound');
  return { nodes: kept, matchCount: budget.matches, capped: budget.capped, snippets: walk.snippets };
}

interface Walk {
  readonly index: NavigatorSearchIndex;
  readonly terms: readonly QueryTerm[];
  readonly budget: MatchBudget;
  /** Rows a matching comment labels: they are kept so the comment folds into them as it does on the page. */
  readonly labelled: Set<string>;
  readonly snippets: Map<string, string>;
}

// The count of rows that matched on their own. A class, so the walk's parameter is never assigned to:
// the walk asks the budget to take a match and the budget owns its own counters.
class MatchBudget {
  matches = 0;
  capped = false;

  /** Spends one match; false, and the walk is marked capped, when none is left. */
  take(): boolean {
    if (this.matches >= NAVIGATOR_MATCHES_MAX) {
      this.capped = true;
      return false;
    }
    this.matches += 1;
    return true;
  }
}

function keepAll(nodes: readonly NavigatorNode[], walk: Walk, depth: number): readonly NavigatorNode[] {
  // Depth is a page tree's, which the parser bounds; the assertion makes the recursion's limit stated.
  assert(depth <= LIMITS.treeDepthMax, 'The Navigator search walks no deeper than a page tree');
  const kept: NavigatorNode[] = [];
  noteLabelled(nodes, walk);
  for (const node of nodes) {
    const keptNode = keepNode(node, walk, depth);
    if (keptNode !== undefined) {
      kept.push(keptNode);
    }
  }
  return kept;
}

function keepNode(node: NavigatorNode, walk: Walk, depth: number): NavigatorNode | undefined {
  // The recursion's limit, stated: a page tree is never deeper than this (a cond's branch is one level down).
  assert(depth <= LIMITS.treeDepthMax, 'The Navigator search walks no deeper than a page tree');
  const own = matchesOwn(node, walk);
  switch (node.kind) {
    case 'component':
    case 'element': {
      // Text and simple `{value}` children get no rows (the Content field holds them), so the row itself is
      // what matches them: its entry carries their words. Its children stay as they are, still unseen.
      if (node.children !== undefined && hidesChildRows(node, node.children)) {
        return own ? node : undefined;
      }
      const children = node.children === undefined ? [] : keepAll(node.children, walk, depth + 1);
      return own || children.length > 0 ? { ...node, children } : undefined;
    }
    case 'map': {
      const children = keepAll(node.children, walk, depth + 1);
      return own || children.length > 0 ? { ...node, children } : undefined;
    }
    case 'chunk-group': {
      const children = keepAll(node.children, walk, depth + 1);
      return own || children.length > 0 ? { ...node, children } : undefined;
    }
    case 'branch': {
      const children = keepAll(node.children, walk, depth + 1);
      return own || children.length > 0 ? { ...node, children } : undefined;
    }
    case 'cond': {
      const children = node.children.flatMap((branch) => {
        const keptBranch = keepNode(branch, walk, depth + 1);
        return keptBranch !== undefined && keptBranch.kind === 'branch' ? [keptBranch] : [];
      });
      return own || children.length > 0 ? { ...node, children } : undefined;
    }
    case 'text':
    case 'expr':
    case 'raw-line':
    case 'comment':
    case 'raw':
      return own ? node : undefined;
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

// A comment that matches also matches the row it labels, because the Navigator draws that comment
// as part of the row beneath it (leadingNote.ts) and the person looks for it there.
function noteLabelled(nodes: readonly NavigatorNode[], walk: Walk): void {
  for (let position = 0; position + 1 < nodes.length; position += 1) {
    const node = nodes[position];
    const following = nodes[position + 1];
    if (node === undefined || following === undefined || node.kind !== 'comment') {
      continue;
    }
    if (labelsNode(node.kind, following.kind)) {
      const entry = walk.index.get(node.id);
      if (entry !== undefined && termsMatch(entry, walk.terms)) {
        walk.labelled.add(following.id);
      }
    }
  }
}

// A node matches on its own entry; the bound counts these, and past it nothing more matches.
function matchesOwn(node: NavigatorNode, walk: Walk): boolean {
  const entry = walk.index.get(node.id);
  if (entry === undefined || !(walk.labelled.has(node.id) || termsMatch(entry, walk.terms))) {
    return false;
  }
  if (!walk.budget.take()) {
    return false;
  }
  const snippet = snippetOf(entry, walk.terms);
  if (snippet !== undefined) {
    walk.snippets.set(node.id, snippet);
  }
  return true;
}

function childrenOf(node: NavigatorNode): readonly NavigatorNode[] {
  switch (node.kind) {
    case 'component':
    case 'element':
      return node.children ?? [];
    case 'map':
    case 'chunk-group':
    case 'branch':
    case 'cond':
      return node.children;
    case 'text':
    case 'expr':
    case 'raw':
    case 'comment':
    case 'raw-line':
      return [];
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

// What a person can type to find a node: what it is called, its class and id, its words, its comment, and the
// words its source holds for it: direct text, string props and attributes (alt, title, label, heading="…"),
// and string literals in set:html or {"…"}. A closed component is searched by what the page holds for it, which
// is its slot text and its string props: the words of its own file are not part of this page.
function entryOf(node: NavigatorNode): NavigatorIndexEntry {
  const classes: string[] = [];
  const attributes = new Map<string, string | undefined>();
  let id = '';
  let tag = '';
  let comment: string | undefined;
  if (node.kind === 'component' || node.kind === 'element') {
    tag = foldSearchText(node.name);
    for (const [name, attribute] of Object.entries(node.props ?? {})) {
      const value = attribute.type === 'string' ? foldSearchText(attribute.value) : undefined;
      attributes.set(foldSearchText(name), value);
      if (value !== undefined && (name === 'class' || name === 'className')) {
        classes.push(...value.split(/\s+/u).filter((token) => token.length > 0));
      }
      if (value !== undefined && name === 'id') {
        id = value;
      }
    }
  }
  if (node.kind === 'comment') {
    comment = foldSearchText(node.value);
  }
  const content = contentOf(node);
  const names = foldSearchText(nodeText(node, tag)) + ' ' + classes.join(' ') + ' ' + id;
  const text = names + (comment === undefined ? '' : ' ' + comment) + ' ' + foldSearchText(content);
  return { text, names, content, tag, classes, id, attributes, comment };
}

// Props that carry no words a person would look for.
const CONTENT_SKIPPED_PROPS: ReadonlySet<string> = new Set(['class', 'classname', 'id', 'style', 'slot', 'class:list']);

function contentOf(node: NavigatorNode): string {
  if (node.kind !== 'component' && node.kind !== 'element') {
    return '';
  }
  const parts: string[] = [];
  let length = 0;
  const add = (candidate: string | undefined): void => {
    const value = candidate === undefined ? undefined : searchableValue(candidate);
    if (value !== undefined && length + value.length + 1 <= NAVIGATOR_CONTENT_CHARS_MAX) {
      parts.push(value);
      length += value.length + 1;
    }
  };
  for (const [name, attribute] of Object.entries(node.props ?? {})) {
    if (!CONTENT_SKIPPED_PROPS.has(name.toLowerCase())) {
      add(attribute.type === 'string' ? attribute.value : attribute.type === 'expr' ? literalOf(attribute.value) : undefined);
    }
  }
  // Direct children only: text split by a `{value}` or a line break still joins into one run here.
  for (const child of node.children ?? []) {
    add(child.kind === 'text' ? child.value : child.kind === 'expr' ? literalOf(child.value) : undefined);
  }
  return parts.join(' ');
}

/** A string literal's text when the expression is only that (`{"Hi"}`, `'Hi'`, a template without `${}`); never code. */
function literalOf(expression: string): string | undefined {
  const inner = expression
    .trim()
    .replace(/^\{|\}$/gu, '')
    .trim();
  const quote = inner.charAt(0);
  if (inner.length < 2 || inner.charAt(inner.length - 1) !== quote) {
    return undefined;
  }
  if (quote !== '"' && quote !== "'" && quote !== '`') {
    return undefined;
  }
  const body = inner.slice(1, inner.length - 1);
  return body.includes(quote) || body.includes('${') || body.includes('\\') ? undefined : body;
}

/** A value as words: markup stripped, whitespace collapsed; undefined for what is not words or is too big. */
function searchableValue(raw: string): string | undefined {
  if (raw.length > NAVIGATOR_VALUE_CHARS_MAX * 2) {
    return undefined;
  }
  // A tag is at most 300 characters, so this pattern cannot run away on a stray `<`.
  const value = raw
    .replace(/<[^<>]{0,300}>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (value.length === 0 || value.length > NAVIGATOR_VALUE_CHARS_MAX || !/\p{L}/u.test(value)) {
    return undefined;
  }
  if (value.startsWith('data:')) {
    return undefined;
  }
  if (value.length > NAVIGATOR_URL_CHARS_MAX && /^(?:[a-z]+:\/\/|\/|\.\.?\/)/iu.test(value)) {
    return undefined;
  }
  if (value.split(' ').some((token) => token.length > NAVIGATOR_TOKEN_CHARS_MAX)) {
    return undefined;
  }
  return value;
}

/**
 * The matched words of a row's content with a little context either side, when the row matched by what it holds
 * and not by its name. Folding drops accents, so a position found in the folded text is mapped back to the
 * character it came from before the cut.
 */
export function snippetOf(entry: NavigatorIndexEntry, terms: readonly QueryTerm[]): string | undefined {
  const words = terms.flatMap((term) => (term.kind === 'word' ? [term.word] : []));
  if (entry.content.length === 0 || words.length === 0 || words.every((word) => entry.names.includes(word))) {
    return undefined;
  }
  const characters = Array.from(entry.content);
  let folded = '';
  const owner: number[] = [];
  for (const [position, character] of characters.entries()) {
    const piece = foldSearchText(character);
    for (let step = 0; step < piece.length; step += 1) {
      owner.push(position);
    }
    folded += piece;
  }
  const hits = words.map((word) => folded.indexOf(word)).filter((at) => at >= 0);
  if (hits.length === 0) {
    return undefined;
  }
  const at = Math.min(...hits);
  const from = Math.max(0, (owner[at] ?? 0) - NAVIGATOR_SNIPPET_CONTEXT_CHARS);
  const longest = Math.max(...words.map((word) => word.length));
  const to = Math.min(characters.length, (owner[Math.min(at + longest, owner.length - 1)] ?? characters.length) + NAVIGATOR_SNIPPET_CONTEXT_CHARS);
  return `${from > 0 ? '…' : ''}${characters.slice(from, to).join('').trim()}${to < characters.length ? '…' : ''}`;
}

function nodeText(node: NavigatorNode, foldedTag: string): string {
  switch (node.kind) {
    case 'component':
    case 'element':
      return foldedTag;
    case 'raw':
    case 'chunk-group':
      return node.name;
    case 'text':
    case 'expr':
    case 'raw-line':
      return node.value;
    case 'map':
      return node.head;
    case 'cond':
      return node.test;
    case 'comment':
    case 'branch':
      return '';
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

// ---- The query parser -------------------------------------------------------------------------

export type AttributeOperator = 'exists' | '=' | '^=' | '$=' | '*=' | '~=';

/** One thing a query asks of a row. Every term of a query must hold for the same row. */
export type QueryTerm =
  | { readonly kind: 'word'; readonly word: string }
  | { readonly kind: 'class'; readonly name: string }
  | { readonly kind: 'id'; readonly name: string }
  | { readonly kind: 'tag'; readonly name: string; readonly whole: 'exact' | 'prefix' }
  | { readonly kind: 'attribute'; readonly name: string; readonly operator: AttributeOperator; readonly value: string }
  | { readonly kind: 'comment'; readonly text: string };

const NAME_BREAK = /[\s.#[\]<>/=]/u;
const ATTRIBUTE_NAME = /^[\w:@.-]+$/u;

/**
 * The terms of a query, read left to right in one pass over at most NAVIGATOR_QUERY_LENGTH_MAX
 * characters. No pattern here backtracks: each step scans forward to a delimiter and stops. Text the
 * forms do not cover comes out as plain words, never an error.
 */
export function parseNavigatorQuery(query: string): readonly QueryTerm[] {
  const text = query.slice(0, NAVIGATOR_QUERY_LENGTH_MAX);
  const terms: QueryTerm[] = [];
  let at = 0;
  // Each pass consumes at least one character, so the walk ends within the text's length.
  for (let pass = 0; pass <= text.length && at < text.length && terms.length < NAVIGATOR_TERMS_MAX; pass += 1) {
    const first = text.charAt(at);
    if (/\s/u.test(first)) {
      at += 1;
      continue;
    }
    const read = readTerm(text, at);
    assert(read.next > at, 'Every term consumes text');
    at = read.next;
    terms.push(...read.terms);
  }
  return terms;
}

interface TermRead {
  readonly terms: readonly QueryTerm[];
  readonly next: number;
}

function readTerm(text: string, at: number): TermRead {
  const rest = text.slice(at);
  if (rest.startsWith('/*') || rest.startsWith('<!--') || rest.startsWith('{/*')) {
    return readComment(text, at);
  }
  const first = text.charAt(at);
  if (first === '[') {
    const attribute = readAttribute(text, at);
    if (attribute !== undefined) {
      return attribute;
    }
  }
  if (first === '<') {
    const tag = readTag(text, at);
    if (tag !== undefined) {
      return tag;
    }
  }
  if (first === '.' || first === '#') {
    const end = nameEnd(text, at + 1);
    if (end > at + 1) {
      const name = foldSearchText(text.slice(at + 1, end));
      return { terms: [first === '.' ? { kind: 'class', name } : { kind: 'id', name }], next: end };
    }
  }
  return readWord(text, at);
}

// A comment term runs to the end of the query: its text may hold spaces, and a closing mark is optional.
function readComment(text: string, at: number): TermRead {
  let body = text
    .slice(at)
    .replace(/^\{?\/\*|^<!--/u, '')
    .trim();
  for (const closing of ['*/}', '*/', '-->']) {
    if (body.endsWith(closing)) {
      body = body.slice(0, body.length - closing.length).trim();
      break;
    }
  }
  return { terms: [{ kind: 'comment', text: foldSearchText(body) }], next: text.length };
}

function readTag(text: string, at: number): TermRead | undefined {
  const start = text.charAt(at + 1) === '/' ? at + 2 : at + 1;
  let end = start;
  while (end < text.length && !NAME_BREAK.test(text.charAt(end))) {
    end += 1;
  }
  if (end === start) {
    return undefined;
  }
  const closed = text.charAt(end) === '>';
  return { terms: [{ kind: 'tag', name: foldSearchText(text.slice(start, end)), whole: closed ? 'exact' : 'prefix' }], next: closed ? end + 1 : end };
}

function readAttribute(text: string, at: number): TermRead | undefined {
  const close = text.indexOf(']', at);
  if (close < 0) {
    return undefined;
  }
  const inner = text.slice(at + 1, close).trim();
  const operatorAt = inner.search(/[\^$*~=]/u);
  const name = (operatorAt < 0 ? inner : inner.slice(0, operatorAt)).trim();
  if (!ATTRIBUTE_NAME.test(name)) {
    return undefined;
  }
  const folded = foldSearchText(name);
  if (operatorAt < 0) {
    return { terms: [{ kind: 'attribute', name: folded, operator: 'exists', value: '' }], next: close + 1 };
  }
  const operator = inner.slice(operatorAt, inner.indexOf('=', operatorAt) + 1);
  if (operator !== '=' && operator !== '^=' && operator !== '$=' && operator !== '*=' && operator !== '~=') {
    return undefined;
  }
  let value = inner.slice(inner.indexOf('=', operatorAt) + 1).trim();
  const quote = value.charAt(0);
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
    value = value.slice(1, value.length - 1);
  }
  return { terms: [{ kind: 'attribute', name: folded, operator, value: foldSearchText(value) }], next: close + 1 };
}

function readWord(text: string, at: number): TermRead {
  let end = at;
  while (end < text.length && !/\s/u.test(text.charAt(end))) {
    end += 1;
  }
  return { terms: queryWords(text.slice(at, end)).map((word): QueryTerm => ({ kind: 'word', word })), next: Math.max(end, at + 1) };
}

function nameEnd(text: string, from: number): number {
  let end = from;
  while (end < text.length && !NAME_BREAK.test(text.charAt(end))) {
    end += 1;
  }
  return end;
}

/** True when the row holds every term of the query. */
export function termsMatch(entry: NavigatorIndexEntry, terms: readonly QueryTerm[]): boolean {
  if (terms.length === 0) {
    return false;
  }
  return terms.every((term) => termMatches(entry, term));
}

function termMatches(entry: NavigatorIndexEntry, term: QueryTerm): boolean {
  switch (term.kind) {
    case 'word':
      return holdsEveryWord(entry.text, [term.word]);
    case 'class':
      // A prefix, so `.btn` is found while `.btn-primary` is still being typed.
      return entry.classes.some((token) => token.startsWith(term.name));
    case 'id':
      return entry.id.length > 0 && entry.id.startsWith(term.name);
    case 'tag':
      return entry.tag.length > 0 && (term.whole === 'exact' ? entry.tag === term.name : entry.tag.startsWith(term.name));
    case 'comment':
      return entry.comment !== undefined && entry.comment.includes(term.text);
    case 'attribute':
      return attributeMatches(entry, term);
    default: {
      const exhaustive: never = term;
      return exhaustive;
    }
  }
}

function attributeMatches(entry: NavigatorIndexEntry, term: Extract<QueryTerm, { readonly kind: 'attribute' }>): boolean {
  if (!entry.attributes.has(term.name)) {
    return false;
  }
  const value = entry.attributes.get(term.name);
  switch (term.operator) {
    case 'exists':
      return true;
    case '=':
      return value === term.value || (value === undefined && term.value === '');
    case '^=':
      return value !== undefined && term.value.length > 0 && value.startsWith(term.value);
    case '$=':
      return value !== undefined && term.value.length > 0 && value.endsWith(term.value);
    case '*=':
      return value !== undefined && term.value.length > 0 && value.includes(term.value);
    case '~=':
      return value !== undefined && term.value.length > 0 && value.split(/\s+/u).includes(term.value);
    default: {
      const exhaustive: never = term.operator;
      return exhaustive;
    }
  }
}

/** The words the panel marks in a row's label: what each term matched on, as text. */
export function navigatorHighlightWords(query: string): readonly string[] {
  const words: string[] = [];
  for (const term of parseNavigatorQuery(query)) {
    switch (term.kind) {
      case 'word':
        words.push(term.word);
        break;
      case 'class':
      case 'id':
      case 'tag':
        words.push(term.name);
        break;
      case 'attribute':
        words.push(term.value.length > 0 ? term.value : term.name);
        break;
      case 'comment':
        words.push(...queryWords(term.text));
        break;
      default: {
        const exhaustive: never = term;
        return exhaustive;
      }
    }
  }
  return words;
}
