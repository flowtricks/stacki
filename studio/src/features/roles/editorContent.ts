// What a limited role may change in a page's source (shared/properties/projectRoles.ts):
// the check behind "Edit text" and "Change images", for edits that arrive as source
// text rather than as a named action. The room runs it before it applies an edit
// (rooms.ts), so it holds against a client that skips its own checks.
//
// Without the Style and Settings panel the check is strict. The words and pictures
// that may change are cut out of both versions, and what is left must be the same
// byte for byte. Anything this cannot recognise stays in, so the edit is refused:
// an attribute, a style block, a new element, an expression, a script.
//
// With the panel, settings may change, so the check runs the other way round: what
// the role may not touch (the words, the pictures, the order of the elements)
// must read the same before and after.
//
// Free of Node imports, like documentAccess.ts: the browser runs it too.
import { assert } from '../../../vendor/stacki/shared/core/assert';
import type { EditorPart } from '../../../vendor/stacki/shared/properties/projectRoles';
import { frontmatterRange } from '../source/frontmatter';
import { parsePage, type ParserNode } from '../source/source';
import { attributeSpans, imageAttributeChange, imageBindings, imageImportLines, isImageAttribute, literalStrings, type ImageBindings } from './editorImages';
import { isTextBlock, richTextRefusal, safeInlineHTML } from './editorRichText';

/** What an edit changes that the role may not. */
export type ContentRefusal = 'text' | 'images' | 'structure' | 'settings';

/** How a component shows one of its props as words: printed, or rendered as inline HTML. */
export type TextPropKind = 'text' | 'html';

export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

export interface ContentRules {
  readonly off: ReadonlySet<EditorPart>;
  /** Whether the component tag `component` shows its prop `prop` as words on the page. */
  readonly textProp: (component: string, prop: string) => TextPropKind | undefined;
  /** The frontmatter string literals each version prints as page text. */
  readonly literals: { readonly before: readonly SourceRange[]; readonly after: readonly SourceRange[] };
}

export type ContentCheck = { readonly ok: true } | { readonly ok: false; readonly refusal: ContentRefusal };

const CHECK_NODES_MAX = 20_000;
const ALLOWED: ContentCheck = { ok: true };
const refused = (refusal: ContentRefusal): ContentCheck => ({ ok: false, refusal });

/** Whether `rules` allow the page to go from `before` to `after`. */
export function checkEditorContent(before: string, after: string, rules: ContentRules): ContentCheck {
  assert(before !== after, 'Only a real change is checked');
  const left = parsePage(before, { locs: true });
  const right = parsePage(after, { locs: true });
  if (!left.editable || !right.editable) {
    return refused('settings');
  }
  const sides = {
    before: { source: before, nodes: left.model.nodes, images: imageBindings(left.model.imports) },
    after: { source: after, nodes: right.model.nodes, images: imageBindings(right.model.imports) },
  };
  return rules.off.has('sidePanel') ? checkOnlyContent(sides, rules) : checkProtectedContent(sides, rules);
}

interface Side {
  readonly source: string;
  readonly nodes: readonly ParserNode[];
  readonly images: ImageBindings;
}
interface Sides {
  readonly before: Side;
  readonly after: Side;
}

interface Cut extends SourceRange {
  /** What stands in the range's place, the same on both sides, so the rest must line up. */
  readonly mark: string;
}

interface Walk {
  readonly sides: Sides;
  readonly rules: ContentRules;
  readonly before: Cut[];
  readonly after: Cut[];
}

// ---- strict: nothing but the allowed words and pictures may differ ----------

function checkOnlyContent(sides: Sides, rules: ContentRules): ContentCheck {
  const walk: Walk = { sides, rules, before: [], after: [] };
  const walked = walkPairs(walk);
  if (!walked.ok) {
    return walked;
  }
  cutFrontmatter(walk);
  const left = applyCuts(sides.before.source, walk.before);
  const right = applyCuts(sides.after.source, walk.after);
  if (left === undefined || right === undefined) {
    return refused('settings');
  }
  return withoutEmptyFence(left) === withoutEmptyFence(right) ? ALLOWED : refused('settings');
}

interface Pair {
  readonly before: ParserNode;
  readonly after: ParserNode;
}

function walkPairs(walk: Walk): ContentCheck {
  const first = pairs(walk.sides.before.nodes, walk.sides.after.nodes);
  if (first === undefined) {
    return refused('structure');
  }
  const pending: Pair[] = [...first];
  for (let index = 0; index < pending.length; index++) {
    if (pending.length > CHECK_NODES_MAX) {
      return refused('structure');
    }
    const pair = pending[index];
    assert(pair !== undefined, 'A queued pair exists');
    const checked = walkPair(walk, pair, pending);
    if (!checked.ok) {
      return checked;
    }
  }
  return ALLOWED;
}

function pairs(before: readonly ParserNode[], after: readonly ParserNode[]): readonly Pair[] | undefined {
  if (before.length !== after.length) {
    return undefined;
  }
  return before.map((node, at) => {
    const other = after[at];
    assert(other !== undefined, 'Lists of one length pair up');
    return { before: node, after: other };
  });
}

function walkPair(walk: Walk, pair: Pair, pending: Pair[]): ContentCheck {
  const { before, after } = pair;
  if (before.kind !== after.kind || before.name !== after.name) {
    return refused('structure');
  }
  if (before.kind === 'text' || before.kind === 'expr') {
    return walkValue(walk, pair);
  }
  if (before.kind === 'element' || before.kind === 'component') {
    const attributes = cutAttributes(walk, pair);
    if (!attributes.ok) {
      return attributes;
    }
    const block = cutTextBlock(walk, pair);
    if (block !== undefined) {
      return block;
    }
  }
  const children = pairs(before.children ?? [], after.children ?? []);
  if (children === undefined) {
    return refused('structure');
  }
  pending.push(...children);
  return ALLOWED;
}

// A text node's words, or an expression that is one quoted string (`{"Hello"}`).
function walkValue(walk: Walk, pair: Pair): ContentCheck {
  const left = nodeRange(pair.before);
  const right = nodeRange(pair.after);
  if (left === undefined || right === undefined) {
    return refused('settings');
  }
  if (walk.sides.before.source.slice(left.start, left.end) === walk.sides.after.source.slice(right.start, right.end)) {
    return ALLOWED;
  }
  if (pair.before.kind === 'expr') {
    if (!literalExpression(pair.before.value) || !literalExpression(pair.after.value ?? '')) {
      return refused('settings');
    }
  }
  if (walk.rules.off.has('text')) {
    return refused('text');
  }
  walk.before.push({ ...left, mark: '\u0001T' });
  walk.after.push({ ...right, mark: '\u0001T' });
  return ALLOWED;
}

function literalExpression(value: string): boolean {
  return /^\{\s*(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')\s*\}$/.test(value);
}

// An element whose content is words and inline formatting is one text: the format
// bar adds and removes tags inside it, so it is compared as a whole.
function cutTextBlock(walk: Walk, pair: Pair): ContentCheck | undefined {
  if (!isTextBlock(pair.before, pair.after)) {
    return undefined;
  }
  const left = innerRange(walk.sides.before.source, pair.before);
  const right = innerRange(walk.sides.after.source, pair.after);
  if (left === undefined || right === undefined) {
    return undefined;
  }
  if (walk.sides.before.source.slice(left.start, left.end) === walk.sides.after.source.slice(right.start, right.end)) {
    return ALLOWED;
  }
  if (walk.rules.off.has('text')) {
    return refused('text');
  }
  const unsafe = richTextRefusal({ source: walk.sides.before.source, node: pair.before }, { source: walk.sides.after.source, node: pair.after });
  // The text is cut out whole, so every character of it must belong to a node that was just judged.
  if (unsafe || !covered(walk.sides.after.source, right, pair.after.children ?? [])) {
    return refused('settings');
  }
  walk.before.push({ ...left, mark: '\u0001B' });
  walk.after.push({ ...right, mark: '\u0001B' });
  return ALLOWED;
}

function covered(source: string, inner: SourceRange, children: readonly ParserNode[]): boolean {
  let at = inner.start;
  for (const child of children) {
    const range = nodeRange(child);
    if (range === undefined || range.start < at || source.slice(at, range.start).trim() !== '') {
      return false;
    }
    at = range.end;
  }
  return at <= inner.end && source.slice(at, inner.end).trim() === '';
}

function nodeRange(node: ParserNode): SourceRange | undefined {
  return node.start === undefined || node.end === undefined ? undefined : { start: node.start, end: node.end };
}

// Between an element's tags. Undefined for a self-closing element, which holds no text.
function innerRange(source: string, node: ParserNode): SourceRange | undefined {
  const range = nodeRange(node);
  if (range === undefined) {
    return undefined;
  }
  const named = range.start + 1 + (node.name?.length ?? 0);
  const afterAttributes = Math.max(named, ...(node.attrSpans ?? []).map((span) => span.span.end));
  const open = source.indexOf('>', afterAttributes);
  const close = source.lastIndexOf('</', range.end - 1);
  if (open < 0 || close <= open || source[open - 1] === '/') {
    return undefined;
  }
  return { start: open + 1, end: close };
}

function cutAttributes(walk: Walk, pair: Pair): ContentCheck {
  const left = attributeSpans(walk.sides.before.source, pair.before);
  const right = attributeSpans(walk.sides.after.source, pair.after);
  if (left === undefined || right === undefined) {
    return refused('settings');
  }
  for (const name of new Set([...left.keys(), ...right.keys()])) {
    const was = left.get(name);
    const now = right.get(name);
    if (was?.text === now?.text) {
      continue;
    }
    const kind = attributeKind(walk, pair, name);
    if (kind === 'settings') {
      return refused('settings');
    }
    if (walk.rules.off.has(kind)) {
      return refused(kind);
    }
    if (was !== undefined) {
      walk.before.push({ ...was.range, mark: '' });
    }
    if (now !== undefined) {
      walk.after.push({ ...now.range, mark: '' });
    }
  }
  return ALLOWED;
}

// What changing attribute `name` between the two versions of a node is.
function attributeKind(walk: Walk, pair: Pair, name: string): 'text' | 'images' | 'settings' {
  const change = { name, before: pair.before, after: pair.after, bindings: { before: walk.sides.before.images, after: walk.sides.after.images } };
  if (imageAttributeChange(change)) {
    return 'images';
  }
  if (pair.before.kind !== 'component') {
    return 'settings';
  }
  const shown = walk.rules.textProp(pair.before.name ?? '', name);
  if (shown === undefined) {
    return 'settings';
  }
  const was = pair.before.props?.[name];
  const now = pair.after.props?.[name];
  for (const value of [was, now]) {
    if (value !== undefined && value.type !== 'string') {
      return 'settings';
    }
  }
  if (shown === 'html' && now?.type === 'string') {
    return safeInlineHTML(was?.type === 'string' ? was.value : '', now.value) ? 'text' : 'settings';
  }
  return 'text';
}

// The frontmatter's allowed differences: the strings the page prints, and the
// imports of picture files, which choosing an image adds and undo removes.
function cutFrontmatter(walk: Walk): void {
  if (!walk.rules.off.has('text')) {
    walk.before.push(...walk.rules.literals.before.map((range) => ({ ...range, mark: '\u0001S' })));
    walk.after.push(...walk.rules.literals.after.map((range) => ({ ...range, mark: '\u0001S' })));
  }
  if (walk.rules.off.has('images')) {
    return;
  }
  const left = imageImportLines(walk.sides.before.source);
  const right = imageImportLines(walk.sides.after.source);
  const kept = new Set(left.map((line) => line.statement));
  const now = new Set(right.map((line) => line.statement));
  walk.before.push(...left.filter((line) => !now.has(line.statement)).map((line) => ({ start: line.start, end: line.end, mark: '' })));
  walk.after.push(...right.filter((line) => !kept.has(line.statement)).map((line) => ({ start: line.start, end: line.end, mark: '' })));
}

// `source` with every cut replaced by its mark, or undefined when two cuts overlap.
function applyCuts(source: string, cuts: readonly Cut[]): string | undefined {
  let result = '';
  let at = 0;
  for (const cut of [...cuts].sort((left, right) => left.start - right.start || left.end - right.end)) {
    if (cut.start < at || cut.end < cut.start || cut.end > source.length) {
      return undefined;
    }
    result += source.slice(at, cut.start) + cut.mark;
    at = cut.end;
  }
  return result + source.slice(at);
}

// A page with no frontmatter gains one with its first picture import; empty once that import is cut.
function withoutEmptyFence(source: string): string {
  const range = frontmatterRange(source);
  if (range === undefined || range.value.trim() !== '') {
    return source;
  }
  return source.slice(0, range.start) + source.slice(range.end).replace(/^\r?\n/, '');
}

// ---- with the panel: what is protected must read the same -------------------

function checkProtectedContent(sides: Sides, rules: ContentRules): ContentCheck {
  const left = protectedParts(sides.before, rules);
  const right = protectedParts(sides.after, rules);
  if (rules.off.has('drag') || rules.off.has('elements')) {
    if (left.structure !== right.structure) {
      return refused('structure');
    }
  }
  if (rules.off.has('text')) {
    if (left.text !== right.text) {
      return refused('text');
    }
  }
  if (rules.off.has('images')) {
    if (left.images !== right.images) {
      return refused('images');
    }
  }
  return ALLOWED;
}

function protectedParts(side: Side, rules: ContentRules) {
  const structure: string[] = [];
  const text: string[] = [];
  const images: string[] = [];
  const queue = side.nodes.map((node) => ({ node, depth: 0 }));
  for (let index = 0; index < queue.length; index++) {
    assert(queue.length <= CHECK_NODES_MAX * 5, 'A page tree is bounded');
    const entry = queue[index];
    assert(entry !== undefined, 'A queued node exists');
    const { node, depth } = entry;
    if (node.kind === 'text' || node.kind === 'expr') {
      if (node.value.trim() !== '') {
        text.push(`${depth}:${node.value.replace(/\s+/g, ' ').trim()}`);
      }
    } else if (node.kind !== 'comment') {
      structure.push(`${depth}:${node.kind}:${node.name ?? ''}`);
    }
    for (const [name, value] of Object.entries(node.props ?? {})) {
      const written = value.type === 'bare' ? '' : value.value;
      if (isImageAttribute(node, name, side.images)) {
        images.push(`${node.name ?? ''}:${name}=${written}`);
      } else if (name === 'set:html' || name === 'set:text' || rules.textProp(node.name ?? '', name) !== undefined) {
        text.push(`${node.name ?? ''}:${name}=${written}`);
      }
    }
    queue.push(...(node.children ?? []).map((child) => ({ node: child, depth: depth + 1 })));
  }
  text.push(...literalStrings(side.source));
  images.push(...imageImportLines(side.source).map((line) => line.statement));
  return { structure: structure.join('\n'), text: text.join('\n'), images: images.sort().join('\n') };
}
