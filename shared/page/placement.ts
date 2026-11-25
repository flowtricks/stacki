// Where a node may be placed: the one rule every way of putting a node on a page asks (the
// Navigator and canvas drags, the insert palette, paste, duplicate, move, wrap, and the
// planner that writes the file).
//
// Why one model: a doctype dragged into a component compiled to nothing, and the preview
// died with "Unexpected token". The same mistake can be made by a drop, a paste, a stale
// editor or a script, so the rule is a pure function of the place, and each entry point only
// describes its place (the renderer from its tree, `shared/engine` from the file's bytes).
//
// Two verdicts, by evidence rather than taste (test/shared/page/placement.test.ts checks
// each rule against the installed Astro compilers and a spec-conforming HTML parser):
//   - refused: Astro's compiler rejects the structure (`<!doctype>` anywhere but the top of
//     the document, under compiler-rs), or the browser parses it into a different tree
//     (`<div>` in `<p>`, `<td>` in `<div>`, a second `<form>` in a form), or the content
//     model forbids it outright (a child of a void tag, a `<tr>` among list items).
//   - warned: allowed, because Stacki cannot see enough to be sure. A component's
//     rendered tag is often unknown, so a `<li>` inside `<List>` may well be right; `<meta>`
//     in a `<div>` is legal only with attributes the model cannot see. Conservative means a
//     wrong refusal is worse than a wrong warning: unknown stays allowed.
//
// Total: any query has a verdict, never a throw for user input. Pure: no I/O, no globals.

import { assert } from '../core/assert';
import { HTML_PHRASING_TAGS, HTML_TEXT_ONLY_PARENTS, HTML_VOID_TAGS } from './htmlTags';

/** What is being placed. A loop, a condition and an expression are `code`: markup the model cannot read. */
export type PlacementNode =
  | { readonly kind: 'doctype' }
  | { readonly kind: 'text'; readonly blank: boolean }
  | { readonly kind: 'comment' }
  | { readonly kind: 'code' }
  | { readonly kind: 'fragment' }
  | { readonly kind: 'slot' }
  | { readonly kind: 'element'; readonly tag: string; readonly descendants?: readonly string[] }
  | { readonly kind: 'component'; readonly tag: string | undefined; readonly descendants?: readonly string[] };

/** One level of the place, outermost first. A loop body and a condition branch are `transparent`: they add no element. */
export type PlacementFrame =
  | { readonly kind: 'element'; readonly tag: string }
  | { readonly kind: 'component'; readonly tag: string | undefined }
  | { readonly kind: 'fragment' }
  | { readonly kind: 'transparent' }
  | { readonly kind: 'frontmatter' };

/** The file the node lands in, when the caller knows: a `<slot>` means something only in a component or layout. */
export type PlacementDocument = 'page' | 'component' | 'unknown';

export interface PlacementQuery {
  readonly node: PlacementNode;
  /** Empty for the document's root list. */
  readonly frames: readonly PlacementFrame[];
  /** The siblings already ahead of the place, in the list it lands in, the node itself excluded. */
  readonly before: readonly PlacementNode[];
  /** The siblings already behind the place. */
  readonly after: readonly PlacementNode[];
  readonly document: PlacementDocument;
}

export const PLACEMENT_REFUSALS = [
  'frontmatter',
  'doctype-position',
  'doctype-duplicate',
  'html-position',
  'html-duplicate',
  'html-content',
  'head-position',
  'head-duplicate',
  'head-content',
  'body-position',
  'body-duplicate',
  'body-order',
  'metadata-position',
  'void-parent',
  'content-model',
  'needs-parent',
  'first-child',
  'nested-interactive',
  'nested-form',
  'slot-in-page',
  'text-position',
  'self-drop',
] as const;
export type PlacementRefusal = (typeof PLACEMENT_REFUSALS)[number];

export const PLACEMENT_WARNINGS = [
  'unknown-component-parent',
  'unknown-component-child',
  'metadata-in-body',
  'head-in-component',
  'body-in-component',
  'text-in-list',
] as const;
export type PlacementWarning = (typeof PLACEMENT_WARNINGS)[number];

export type PlacementReason = PlacementRefusal | PlacementWarning;

/** The words a refusal or warning is shown in: a catalog key and the values it names. */
export interface PlacementMessage {
  readonly reason: PlacementReason;
  readonly messageKey: PlacementMessageKey;
  readonly params: Readonly<Record<string, string>>;
}

export type PlacementVerdict = { readonly ok: true; readonly warning?: PlacementMessage } | ({ readonly ok: false } & PlacementMessage);

export const PLACEMENT_MESSAGE_KEYS = {
  frontmatter: 'structure.placement.frontmatter',
  'doctype-position': 'structure.placement.doctypePosition',
  'doctype-duplicate': 'structure.placement.doctypeDuplicate',
  'html-position': 'structure.placement.htmlPosition',
  'html-duplicate': 'structure.placement.htmlDuplicate',
  'html-content': 'structure.placement.htmlContent',
  'head-position': 'structure.placement.headPosition',
  'head-duplicate': 'structure.placement.headDuplicate',
  'head-content': 'structure.placement.headContent',
  'body-position': 'structure.placement.bodyPosition',
  'body-duplicate': 'structure.placement.bodyDuplicate',
  'body-order': 'structure.placement.bodyOrder',
  'metadata-position': 'structure.placement.metadataPosition',
  'void-parent': 'structure.placement.voidParent',
  'content-model': 'structure.placement.contentModel',
  'needs-parent': 'structure.placement.needsParent',
  'first-child': 'structure.placement.firstChild',
  'nested-interactive': 'structure.placement.nestedInteractive',
  'nested-form': 'structure.placement.nestedForm',
  'slot-in-page': 'structure.placement.slotInPage',
  'text-position': 'structure.placement.textPosition',
  'self-drop': 'structure.placement.selfDrop',
  'unknown-component-parent': 'structure.placement.unknownComponentParent',
  'unknown-component-child': 'structure.placement.unknownComponentChild',
  'metadata-in-body': 'structure.placement.metadataInBody',
  'head-in-component': 'structure.placement.headInComponent',
  'body-in-component': 'structure.placement.bodyInComponent',
  'text-in-list': 'structure.placement.textInList',
} as const satisfies Record<PlacementReason, string>;
export type PlacementMessageKey = (typeof PLACEMENT_MESSAGE_KEYS)[PlacementReason];

export const PLACEMENT_LIMITS = {
  /** Frames in one place: the page tree's depth bound. */
  framesMax: 64,
  /** Siblings read on either side of a place; a longer list is cut before the call. */
  siblingsMax: 4096,
  /** Distinct descendant tags a moved node reports. */
  descendantsMax: 256,
} as const satisfies Record<string, number>;

export const ACCEPTED: PlacementVerdict = { ok: true };

/** The refusal a drop on the frontmatter gets: the fence is code, not a place for markup. */
export function frontmatterRefusal(): PlacementVerdict {
  return refusal('frontmatter', {});
}

/** The refusal for a node dropped into itself or into its own subtree. */
export function selfDropRefusal(): PlacementVerdict {
  return refusal('self-drop', {});
}

/** The verdict for placing `query.node` at the place the query describes. */
export function checkPlacement(query: PlacementQuery): PlacementVerdict {
  assert(query.frames.length <= PLACEMENT_LIMITS.framesMax, 'A place is no deeper than the page tree');
  assert(query.before.length + query.after.length <= PLACEMENT_LIMITS.siblingsMax, 'A place is read among a bounded number of siblings');
  const facts = factsOf(query);
  let warning: PlacementMessage | undefined = undefined;
  for (const rule of RULES) {
    const verdict = rule(query, facts);
    if (verdict === undefined) {
      continue;
    }
    if (!verdict.ok) {
      return verdict;
    }
    warning ??= verdict.warning;
  }
  return warning === undefined ? ACCEPTED : { ok: true, warning };
}

/** Whether a verdict lets the node land. */
export function placementAllowed(verdict: PlacementVerdict): boolean {
  return verdict.ok;
}

// What the rules share, computed once per query.
interface Facts {
  /** The tag of the nearest level that renders one (an element, or a component whose tag is known); undefined at the root and in foreign content. */
  readonly hostTag: string | undefined;
  /** The nearest level that is not transparent or a fragment: what actually holds the node's output. */
  readonly host: PlacementFrame | undefined;
  /** Every tag from the root to the host, nearest last; empty in foreign content. */
  readonly ancestorTags: readonly string[];
  /** Whether the place is inside `<svg>` or `<math>`, where HTML's content model does not apply. */
  readonly foreign: boolean;
}

type Rule = (query: PlacementQuery, facts: Facts) => PlacementVerdict | undefined;

const FOREIGN_ROOTS: ReadonlySet<string> = new Set(['svg', 'math']);

function factsOf(query: PlacementQuery): Facts {
  const tags: string[] = [];
  let host: PlacementFrame | undefined = undefined;
  for (const frame of query.frames) {
    switch (frame.kind) {
      case 'element':
        tags.push(frame.tag.toLowerCase());
        host = frame;
        break;
      case 'component':
        if (frame.tag !== undefined) {
          tags.push(frame.tag.toLowerCase());
        }
        host = frame;
        break;
      case 'fragment':
      case 'transparent':
        break;
      case 'frontmatter':
        host = frame;
        break;
      default: {
        const exhaustive: never = frame;
        return exhaustive;
      }
    }
  }
  const foreign = tags.some((tag) => FOREIGN_ROOTS.has(tag));
  const hostTag = host !== undefined && (host.kind === 'element' || host.kind === 'component') && !foreign ? host.tag?.toLowerCase() : undefined;
  return { hostTag, host, ancestorTags: foreign ? [] : tags, foreign };
}

function refusal(reason: PlacementRefusal, params: Readonly<Record<string, string>>): PlacementVerdict {
  return { ok: false, reason, messageKey: PLACEMENT_MESSAGE_KEYS[reason], params };
}

function warned(reason: PlacementWarning, params: Readonly<Record<string, string>>): PlacementVerdict {
  return { ok: true, warning: { reason, messageKey: PLACEMENT_MESSAGE_KEYS[reason], params } };
}

function tagOf(node: PlacementNode): string | undefined {
  switch (node.kind) {
    case 'element':
      return node.tag.toLowerCase();
    case 'component':
      return node.tag?.toLowerCase();
    case 'doctype':
    case 'text':
    case 'comment':
    case 'code':
    case 'fragment':
    case 'slot':
      return undefined;
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

function isElementTag(node: PlacementNode, tag: string): boolean {
  return node.kind === 'element' && node.tag.toLowerCase() === tag;
}

function hasElement(list: readonly PlacementNode[], tag: string): boolean {
  return list.some((sibling) => isElementTag(sibling, tag));
}

/** Content that may stand before the doctype or the root element: it renders nothing. */
function rendersNothing(node: PlacementNode): boolean {
  return node.kind === 'comment' || (node.kind === 'text' && node.blank);
}

// --- Rules, in the order they speak -----------------------------------------------------

const frontmatterRule: Rule = (_query, facts) => (facts.host?.kind === 'frontmatter' ? refusal('frontmatter', {}) : undefined);

const doctypeRule: Rule = (query) => {
  if (query.node.kind !== 'doctype') {
    return undefined;
  }
  // A second doctype is named as one wherever it lands: "only one" is the more useful word than "only first".
  if (query.before.some((sibling) => sibling.kind === 'doctype') || query.after.some((sibling) => sibling.kind === 'doctype')) {
    return refusal('doctype-duplicate', {});
  }
  if (query.frames.length > 0) {
    return refusal('doctype-position', {});
  }
  if (!query.before.every(rendersNothing)) {
    return refusal('doctype-position', {});
  }
  return undefined;
};

const htmlRule: Rule = (query) => {
  if (!isElementTag(query.node, 'html')) {
    return undefined;
  }
  if (hasElement(query.before, 'html') || hasElement(query.after, 'html')) {
    return refusal('html-duplicate', {});
  }
  if (query.frames.length > 0 || !query.before.every((sibling) => rendersNothing(sibling) || sibling.kind === 'doctype')) {
    return refusal('html-position', {});
  }
  if (query.after.some((sibling) => sibling.kind === 'doctype')) {
    return refusal('html-position', {});
  }
  return undefined;
};

const headRule: Rule = (query, facts) => {
  if (!isElementTag(query.node, 'head')) {
    return undefined;
  }
  if (hasElement(query.before, 'head') || hasElement(query.after, 'head')) {
    return refusal('head-duplicate', {});
  }
  if (hasElement(query.before, 'body')) {
    return refusal('body-order', {});
  }
  return documentPartHost('head', facts);
};

const bodyRule: Rule = (query, facts) => {
  if (!isElementTag(query.node, 'body')) {
    return undefined;
  }
  if (hasElement(query.before, 'body') || hasElement(query.after, 'body')) {
    return refusal('body-duplicate', {});
  }
  if (hasElement(query.after, 'head')) {
    return refusal('body-order', {});
  }
  return documentPartHost('body', facts);
};

// `<head>` and `<body>` belong directly in `<html>`; at the top of a page that has no `<html>` of its own they are
// the document's, and inside a component the layout owns the shell, which Stacki cannot read.
function documentPartHost(tag: 'head' | 'body', facts: Facts): PlacementVerdict | undefined {
  const host = facts.host;
  if (host === undefined || host.kind === 'fragment') {
    return undefined;
  }
  if (host.kind === 'element') {
    return host.tag.toLowerCase() === 'html' ? undefined : refusal(tag === 'head' ? 'head-position' : 'body-position', {});
  }
  return warned(tag === 'head' ? 'head-in-component' : 'body-in-component', {});
}

const HTML_CHILDREN: ReadonlySet<string> = new Set(['head', 'body', 'script', 'style', 'noscript', 'template']);
const HEAD_CHILDREN: ReadonlySet<string> = new Set(['title', 'meta', 'link', 'base', 'script', 'style', 'noscript', 'template']);

// What the browser would move out of `<html>` or `<head>`: anything else closes the head or opens an implied body.
const documentContentRule: Rule = (query, facts) => {
  if (facts.hostTag !== 'html' && facts.hostTag !== 'head') {
    return undefined;
  }
  if (facts.host?.kind !== 'element') {
    return undefined; // A component named `html` is no element.
  }
  const node = query.node;
  const allowed = facts.hostTag === 'html' ? HTML_CHILDREN : HEAD_CHILDREN;
  const reason = facts.hostTag === 'html' ? 'html-content' : 'head-content';
  switch (node.kind) {
    case 'element':
      return allowed.has(node.tag.toLowerCase()) ? undefined : refusal(reason, { child: node.tag });
    case 'text':
      return node.blank ? undefined : refusal(reason, { child: '#text' });
    case 'doctype':
      return undefined; // The doctype rule has spoken.
    case 'comment':
    case 'code':
    case 'fragment':
    case 'slot':
    case 'component':
      return undefined;
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
};

const metadataRule: Rule = (query, facts) => {
  const node = query.node;
  if (node.kind !== 'element' || facts.foreign || facts.host?.kind !== 'element' || facts.hostTag === undefined) {
    return undefined;
  }
  const tag = node.tag.toLowerCase();
  if (facts.hostTag === 'head' || facts.hostTag === 'html') {
    return undefined;
  }
  if (tag === 'title' || tag === 'base') {
    return refusal('metadata-position', { child: tag, parent: facts.hostTag });
  }
  if (tag === 'meta' || tag === 'link') {
    return warned('metadata-in-body', { child: tag, parent: facts.hostTag });
  }
  return undefined;
};

const voidRule: Rule = (_query, facts) => {
  if (facts.hostTag !== undefined && facts.host?.kind === 'element' && HTML_VOID_TAGS.has(facts.hostTag)) {
    return refusal('void-parent', { parent: facts.hostTag });
  }
  return undefined;
};

// Parents that take a fixed set of children (the browser drops or foster-parents the rest, or the content model forbids it).
const ONLY_CHILDREN: Readonly<Record<string, readonly string[]>> = {
  ul: ['li', 'script', 'style', 'template'],
  ol: ['li', 'script', 'style', 'template'],
  menu: ['li', 'script', 'style', 'template'],
  dl: ['dt', 'dd', 'div', 'script', 'style', 'template'],
  table: ['caption', 'colgroup', 'thead', 'tbody', 'tfoot', 'tr', 'script', 'style', 'template'],
  thead: ['tr', 'script', 'style', 'template'],
  tbody: ['tr', 'script', 'style', 'template'],
  tfoot: ['tr', 'script', 'style', 'template'],
  tr: ['td', 'th', 'script', 'style', 'template'],
  colgroup: ['col', 'template'],
  select: ['option', 'optgroup', 'hr', 'script', 'template'],
  optgroup: ['option', 'script', 'template'],
  datalist: ['option', 'script', 'template'],
  picture: ['source', 'img', 'script', 'style', 'template'],
  video: ['source', 'track', 'script', 'style', 'template'],
  audio: ['source', 'track', 'script', 'style', 'template'],
};

// Parents whose stray text the browser moves out of the way (foster parenting, or the select's own content model).
const TEXT_REPARENTED_PARENTS: ReadonlySet<string> = new Set([
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'colgroup',
  'select',
  'optgroup',
  'picture',
  'video',
  'audio',
]);
const TEXT_UNWANTED_PARENTS: ReadonlySet<string> = new Set(['ul', 'ol', 'menu', 'dl']);

// Children that mean nothing without their parent: where they may stand, as written in the spec's content models.
const NEEDS_PARENT: Readonly<Record<string, readonly string[]>> = {
  li: ['ul', 'ol', 'menu'],
  dt: ['dl', 'div'],
  dd: ['dl', 'div'],
  tr: ['table', 'thead', 'tbody', 'tfoot'],
  td: ['tr'],
  th: ['tr'],
  thead: ['table'],
  tbody: ['table'],
  tfoot: ['table'],
  caption: ['table'],
  colgroup: ['table'],
  col: ['colgroup'],
  option: ['select', 'datalist', 'optgroup'],
  optgroup: ['select'],
  summary: ['details'],
  legend: ['fieldset'],
  source: ['picture', 'video', 'audio'],
  track: ['video', 'audio'],
  figcaption: ['figure'],
  rt: ['ruby'],
  rp: ['ruby'],
};

/** Tags that stand anywhere a script's output may: they render no layout of their own. */
const ALWAYS_ALLOWED: ReadonlySet<string> = new Set(['script', 'style', 'template', 'noscript']);

const needsParentRule: Rule = (query, facts) => {
  const node = query.node;
  const tag = tagOf(node);
  if (tag === undefined || facts.foreign) {
    return undefined;
  }
  const expected = NEEDS_PARENT[tag];
  if (expected === undefined) {
    return undefined;
  }
  const params = { child: tag, parent: expected.join(' / ') };
  const host = facts.host;
  if (host === undefined) {
    // A page's root is a document, so a bare `<li>` is wrong there; a component's root is the component's output, in a parent unknown to the file.
    return query.document === 'page' ? refusal('needs-parent', params) : warned('unknown-component-parent', params);
  }
  if (host.kind === 'frontmatter' || host.kind === 'fragment' || host.kind === 'transparent') {
    return undefined;
  }
  if (facts.hostTag === undefined) {
    return warned('unknown-component-parent', params);
  }
  if (expected.includes(facts.hostTag)) {
    // A `<dt>` or `<dd>` inside a `<div>` is valid only within a `<dl>`.
    return (tag === 'dt' || tag === 'dd') && facts.hostTag === 'div' && !facts.ancestorTags.includes('dl') ? refusal('needs-parent', params) : undefined;
  }
  return refusal('needs-parent', params);
};

const contentModelRule: Rule = (query, facts) => {
  const hostTag = facts.hostTag;
  if (hostTag === undefined || facts.foreign || facts.host?.kind === 'frontmatter') {
    return undefined;
  }
  const node = query.node;
  const strict = ONLY_CHILDREN[hostTag];
  if (strict !== undefined) {
    return strictParentVerdict(node, hostTag, strict);
  }
  if (HTML_TEXT_ONLY_PARENTS.has(hostTag)) {
    return phrasingParentVerdict(node, hostTag);
  }
  return undefined;
};

function strictParentVerdict(node: PlacementNode, hostTag: string, allowed: readonly string[]): PlacementVerdict | undefined {
  switch (node.kind) {
    case 'element':
      return allowed.includes(node.tag.toLowerCase()) ? undefined : refusal('content-model', { child: node.tag, parent: hostTag });
    case 'component':
      if (node.tag === undefined) {
        return warned('unknown-component-child', { child: 'component', parent: hostTag });
      }
      return allowed.includes(node.tag.toLowerCase()) ? undefined : refusal('content-model', { child: node.tag, parent: hostTag });
    case 'text':
      if (node.blank) {
        return undefined;
      }
      if (TEXT_REPARENTED_PARENTS.has(hostTag)) {
        return refusal('text-position', { parent: hostTag });
      }
      return TEXT_UNWANTED_PARENTS.has(hostTag) ? warned('text-in-list', { parent: hostTag }) : undefined;
    case 'doctype':
    case 'comment':
    case 'code':
    case 'fragment':
    case 'slot':
      return undefined;
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

function phrasingParentVerdict(node: PlacementNode, hostTag: string): PlacementVerdict | undefined {
  const tag = tagOf(node);
  if (tag === undefined) {
    return undefined; // Text, code, a comment, a fragment, a slot or a component of unknown tag: all fit in text.
  }
  if (HTML_PHRASING_TAGS.has(tag) || ALWAYS_ALLOWED.has(tag)) {
    return undefined;
  }
  return refusal('content-model', { child: tag, parent: hostTag });
}

const firstChildRule: Rule = (query, facts) => {
  const lead = facts.hostTag === 'details' ? 'summary' : facts.hostTag === 'fieldset' ? 'legend' : undefined;
  if (lead === undefined || facts.host?.kind !== 'element') {
    return undefined;
  }
  const leading = (sibling: PlacementNode): boolean => rendersNothing(sibling);
  if (isElementTag(query.node, lead)) {
    const standsFirst = query.before.every(leading);
    return standsFirst && !hasElement(query.after, lead) ? undefined : refusal('first-child', { child: lead, parent: facts.hostTag ?? '' });
  }
  // Anything ahead of an existing summary or legend pushes it off the first place.
  if (!rendersNothing(query.node) && hasElement(query.after, lead) && query.before.every(leading)) {
    return refusal('first-child', { child: lead, parent: facts.hostTag ?? '' });
  }
  return undefined;
};

const INTERACTIVE_TAGS: ReadonlySet<string> = new Set(['a', 'button']);

const nestedRule: Rule = (query, facts) => {
  const node = query.node;
  if (facts.foreign || (node.kind !== 'element' && node.kind !== 'component')) {
    return undefined;
  }
  const tags = new Set<string>(node.descendants ?? []);
  const own = tagOf(node);
  if (own !== undefined) {
    tags.add(own);
  }
  const insideInteractive = facts.ancestorTags.some((tag) => INTERACTIVE_TAGS.has(tag));
  if (insideInteractive) {
    for (const tag of tags) {
      if (INTERACTIVE_TAGS.has(tag)) {
        return refusal('nested-interactive', { child: tag, parent: facts.ancestorTags.filter((name) => INTERACTIVE_TAGS.has(name)).at(-1) ?? 'a' });
      }
    }
  }
  if (tags.has('form') && facts.ancestorTags.includes('form')) {
    return refusal('nested-form', {});
  }
  // A link or button placed around... is a wrap, which asks with the wrapper as the node and the wrapped nodes as descendants.
  return undefined;
};

const slotRule: Rule = (query) => (query.node.kind === 'slot' && query.document === 'page' ? refusal('slot-in-page', {}) : undefined);

const RULES: readonly Rule[] = [
  frontmatterRule,
  doctypeRule,
  htmlRule,
  headRule,
  bodyRule,
  documentContentRule,
  voidRule,
  metadataRule,
  needsParentRule,
  contentModelRule,
  firstChildRule,
  nestedRule,
  slotRule,
];

// --- Tag names the adapters share -------------------------------------------------------

/** The tag a node's name stands for in markup: `Fragment` and an empty name are fragments, `slot` is Astro's slot. */
export function placementNodeOfName(name: string, kind: 'element' | 'component', renderedTag: string | undefined): PlacementNode {
  assert(name.length <= 128, 'A tag name is within the tag-name bound');
  if (name === '' || name === 'Fragment') {
    return { kind: 'fragment' };
  }
  if (name === 'slot') {
    return { kind: 'slot' };
  }
  return kind === 'element' ? { kind: 'element', tag: name } : { kind: 'component', tag: renderedTag };
}

/** The doctype's own spelling: `<!doctype html>` in any case, any spacing. */
export function isDoctypeText(text: string): boolean {
  return /^\s*<!doctype\b[^>]*>\s*$/i.test(text);
}
