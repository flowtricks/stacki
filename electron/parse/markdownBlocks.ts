// Reading a Markdown body block by block: ESM, markup, fences, rules,
// headings, quotes, lists, tables and paragraphs, each a node with the source
// span it came from; then the path ids the tree is addressed by
// (markdownParser.ts).

import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import type { Attr, AttrSpan } from '../../shared/page/pageNode';
import { parseTemplate } from './astroParser';
import {
  type Line,
  type MdNode,
  type MarkdownNodeList,
  PENDING_ID,
  ATX_RE,
  FENCE_RE,
  FENCE_CLOSE_RE,
  RULE_RE,
  BULLET_RE,
  ORDERED_RE,
  QUOTE_RE,
  SETEXT_RE,
  MARKUP_RE,
  LAZY_BREAK_RE,
  IMAGE_ONLY_RE,
  ESM_RE,
  MDX_IMPORT_RE,
  CONTAINER_DEPTH_MAX,
  lineAt,
  isBlank,
  lineEnd,
  nonBlankEnd,
  placed,
  type Joined,
  joinedLines,
  relocate,
  markdownAttr,
} from './markdownLines';

/** A line as one container sees it: its text with the container's own syntax
 * taken off the front (a quote's `>`, an item's indentation), and where that
 * text starts in the file. */

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

export interface ParseEnv {
  readonly mdx: boolean;
  readonly imports: { name: string; path: string }[];
  readonly esm: string[];
}

/** What one block reader consumed: its nodes, and the first line after them. */
export interface BlockRead {
  readonly nodes: readonly MdNode[];
  readonly next: number;
}

// Splits `lines` (already dedented to their container) into block nodes at
// `depth`. Blank lines are carried on the node that follows them, so the exact
// spacing of the source comes back when it is printed.
export function parseBlocks(lines: readonly Line[], env: ParseEnv, depth: number): MarkdownNodeList {
  const nodes: MarkdownNodeList = [];
  let pendingBlanks = 0;
  let index = 0;
  // Every pass consumes at least one line.
  for (let pass = 0; index < lines.length; pass++) {
    assert(pass < lines.length, 'Each pass consumes a line');
    if (isBlank(lineAt(lines, index))) {
      pendingBlanks += 1;
      index += 1;
      continue;
    }
    const read = readBlock(lines, index, env, depth);
    assert(read.next > index, 'A block consumes at least one line');
    for (const node of read.nodes) {
      if (pendingBlanks) {
        node.mdBlanksBefore = pendingBlanks;
      }
      pendingBlanks = 0;
      nodes.push(node);
    }
    index = read.next;
  }
  // Trailing blank lines have no node to ride on, so they are recorded on the
  // list itself — otherwise printing would trim the end of the container.
  nodes.mdTrailingBlanks = pendingBlanks;
  return nodes;
}

// The first reader that recognises the line decides the block. The order is
// the parser's grammar: a thematic break before lists (`- - -` is a rule, not
// three bullets), a table before a paragraph.
export function readBlock(lines: readonly Line[], index: number, env: ParseEnv, depth: number): BlockRead {
  return (
    readEsm(lines, index, env) ??
    readMarkup(lines, index, env) ??
    readFence(lines, index) ??
    readRule(lines, index) ??
    readHeading(lines, index) ??
    readQuote(lines, index, env, depth) ??
    readList(lines, index, env, depth) ??
    readTable(lines, index) ??
    readParagraph(lines, index)
  );
}

// MDX: ESM imports and exports. Hoisted into the same `imports` list an
// .astro page has, so the palette can tell which components this page can
// use; the block stays in the tree so the block order survives.
export function readEsm(lines: readonly Line[], index: number, env: ParseEnv): BlockRead | undefined {
  if (!env.mdx) {
    return undefined;
  }
  if (!ESM_RE.test(lineAt(lines, index).text)) {
    return undefined;
  }
  const next = nonBlankEnd(lines, index);
  const text = joinedLines(lines.slice(index, next)).text;
  const im = text.match(MDX_IMPORT_RE);
  if (im) {
    env.imports.push({ name: im[1] ?? '', path: im[2] ?? '' });
  } else {
    env.esm.push(text);
  }
  const node: MdNode = {
    ...placed(lines, index, next),
    kind: 'raw-line',
    value: text,
    mdEsm: true,
  };
  return { nodes: [node], next };
}

// An HTML or JSX block. A component in MDX is exactly the JSX an .astro page
// holds, so it is parsed by the .astro parser and lands in the tree as the
// same node — which is what makes a component inside a post selectable and
// editable. It runs to the first blank line, which is how both markdown and
// MDX delimit an embedded block.
export function readMarkup(lines: readonly Line[], index: number, env: ParseEnv): BlockRead | undefined {
  if (!MARKUP_RE.test(lineAt(lines, index).text)) {
    return undefined;
  }
  const next = nonBlankEnd(lines, index);
  const block = joinedLines(lines.slice(index, next));
  const raw: BlockRead = {
    nodes: [{ ...placed(lines, index, next), kind: 'raw-line', value: block.text }],
    next,
  };
  const parsed = parseTemplate(block.text, 0);
  // One node per block, not per element. The canvas numbers markdown blocks
  // by their index among the document's root nodes, and remark treats a run
  // of raw HTML as a single node however many tags it holds — so a block that
  // opens two sibling elements has to stay one node here too, or every block
  // after it would be numbered one too high. MDX is exempt: there each JSX
  // element really is its own root node.
  if (!env.mdx) {
    if (!parsed.clean || parsed.nodes.length !== 1) {
      return raw;
    }
  }
  if (!parsed.clean || parsed.nodes.length === 0) {
    return raw;
  }
  const nodes: MdNode[] = parsed.nodes;
  relocate(nodes, block.at);
  const [only] = nodes;
  if (only !== undefined && nodes.length === 1) {
    // The .astro printer reflows what it writes (a short component collapses
    // onto one line). Keeping the source lets the printer emit it verbatim for
    // as long as the node still means the same thing.
    only.mdSource = block.text;
  }
  return { nodes, next };
}

export function readFence(lines: readonly Line[], index: number): BlockRead | undefined {
  const opening = lineAt(lines, index);
  const fence = opening.text.match(FENCE_RE);
  if (!fence) {
    return undefined;
  }
  const marker = fence[2] ?? '';
  const info = fence[3] ?? '';
  const close = closingFence(lines, index + 1, marker);
  const bodyEnd = close ?? lines.length;
  const next = close === undefined ? lines.length : close + 1;
  const body = lines.slice(index + 1, bodyEnd);
  const lang = info.trim();
  const node: MdNode = {
    ...placed(lines, index, next),
    kind: 'element',
    name: 'pre',
    props: lang ? { lang: { type: 'string', value: lang } } : {},
    children: body.length ? [{ ...placed(lines, index + 1, bodyEnd), kind: 'text', value: joinedLines(body).text }] : [],
    mdIndent: fence[1] ?? '',
    mdFence: marker,
    mdInfo: info,
  };
  if (lang) {
    // The info string runs to the end of the line; its language is its start.
    const from = lineEnd(opening) - info.length;
    node.attrSpans = [markdownAttr('lang', [from, from + lang.length], [from, from + lang.length])];
  }
  // Only a closed fence has the closing line re-emitted; the flag is omitted
  // when false, which keeps serialized JSON byte-identical.
  if (close === undefined) {
    node.mdUnclosed = true;
  }
  return { nodes: [node], next };
}

// The index of the line closing a fence opened with `marker`, if any.
export function closingFence(lines: readonly Line[], from: number, marker: string): number | undefined {
  for (let at = from; at < lines.length; at++) {
    const close = lineAt(lines, at).text.match(FENCE_CLOSE_RE);
    const found = close?.[2] ?? '';
    if (close) {
      if (found.length >= marker.length) {
        if (found.charAt(0) === marker.charAt(0)) {
          return at;
        }
      }
    }
  }
  return undefined;
}

export function readRule(lines: readonly Line[], index: number): BlockRead | undefined {
  const line = lineAt(lines, index);
  if (!RULE_RE.test(line.text)) {
    return undefined;
  }
  const node: MdNode = {
    ...placed(lines, index, index + 1),
    kind: 'element',
    name: 'hr',
    props: {},
    children: undefined,
    mdRaw: line.text,
  };
  return { nodes: [node], next: index + 1 };
}

export function readHeading(lines: readonly Line[], index: number): BlockRead | undefined {
  const line = lineAt(lines, index);
  const atx = line.text.match(ATX_RE);
  if (!atx) {
    return undefined;
  }
  const indent = atx[1] ?? '';
  const hashes = atx[2] ?? '';
  const gap = atx[3] ?? '';
  const text = atx[4] ?? '';
  const from = line.start + indent.length + hashes.length + gap.length;
  const node: MdNode = {
    ...placed(lines, index, index + 1),
    kind: 'element',
    name: `h${hashes.length}`,
    props: {},
    children: text ? [{ id: PENDING_ID, kind: 'text', value: text, start: from, end: from + text.length }] : [],
    mdIndent: indent,
    mdGap: gap,
    mdTrail: atx[5] ?? '',
  };
  return { nodes: [node], next: index + 1 };
}

export function readQuote(lines: readonly Line[], index: number, env: ParseEnv, depth: number): BlockRead | undefined {
  if (!QUOTE_RE.test(lineAt(lines, index).text)) {
    return undefined;
  }
  const inner: Line[] = [];
  let gap = ' ';
  let next = index;
  while (next < lines.length) {
    const line = lineAt(lines, next);
    const quoteMatch = line.text.match(QUOTE_RE);
    if (!quoteMatch) {
      // A lazy continuation line belongs to the quote's last paragraph.
      if (isBlank(line) || LAZY_BREAK_RE.test(line.text)) {
        break;
      }
      inner.push(line);
      next++;
      continue;
    }
    if (quoteMatch[2]) {
      gap = quoteMatch[2];
    }
    const taken = (quoteMatch[1] ?? '').length + 1 + (quoteMatch[2] ?? '').length;
    inner.push({ text: quoteMatch[3] ?? '', start: line.start + taken });
    next++;
  }
  if (depth >= CONTAINER_DEPTH_MAX) {
    return rawBlock(lines, index, next);
  }
  const node: MdNode = {
    ...placed(lines, index, next),
    kind: 'element',
    name: 'blockquote',
    props: {},
    children: parseBlocks(inner, env, depth + 1),
    mdGap: gap,
  };
  return { nodes: [node], next };
}

// Lines kept verbatim as one block: a container nested past the bound.
export function rawBlock(lines: readonly Line[], index: number, next: number): BlockRead {
  const text = joinedLines(lines.slice(index, next)).text;
  return { nodes: [{ ...placed(lines, index, next), kind: 'raw-line', value: text }], next };
}

/** One list's shape, read off its first line: what every item of it shares. */
export interface ListShape {
  readonly ordered: boolean;
  readonly indent: string;
  readonly marker: string;
}

export function readList(lines: readonly Line[], index: number, env: ParseEnv, depth: number): BlockRead | undefined {
  const first = lineAt(lines, index).text;
  const bullet = first.match(BULLET_RE);
  const ordered = first.match(ORDERED_RE);
  const opening = bullet ?? ordered;
  if (!opening) {
    return undefined;
  }
  const shape: ListShape = {
    ordered: ordered !== null,
    indent: opening[1] ?? '',
    marker: ordered ? (ordered[3] ?? '.') : (bullet?.[2] ?? '-'),
  };
  // The items' extents first: a list nested past the bound is kept raw
  // before any of its items is read into blocks.
  const reads: { readonly at: number; readonly item: ItemRead }[] = [];
  let next = index;
  while (next < lines.length) {
    const item = readItem(lines, next, shape);
    if (item === undefined) {
      break; // A different marker or indent starts a different list.
    }
    reads.push({ at: next, item });
    next = item.next;
  }
  assert(reads.length > 0, 'A list has the item its first line opened');
  if (depth >= CONTAINER_DEPTH_MAX) {
    return rawBlock(lines, index, next);
  }
  const items = reads.map(({ at, item }) => itemNode(lines, at, item, env, depth));
  const numbers = reads.flatMap(({ item }) => (item.number === undefined ? [] : [item.number]));
  const node = listNode(lines, index, next, { shape, items, numbers });
  if (reads.some(({ item }) => item.loose)) {
    node.mdLoose = true;
  }
  return { nodes: [node], next };
}

/** One item's lines: the text after its marker, then what is indented under it. */
export interface ItemRead {
  readonly inner: readonly Line[];
  readonly gap: string;
  readonly number: number | undefined;
  readonly loose: boolean;
  /** The last line holding the item's content. */
  readonly last: number;
  readonly next: number;
}

export function readItem(lines: readonly Line[], index: number, shape: ListShape): ItemRead | undefined {
  const line = lineAt(lines, index);
  const match = line.text.match(shape.ordered ? ORDERED_RE : BULLET_RE);
  if (!match) {
    return undefined;
  }
  if ((match[1] ?? '') !== shape.indent) {
    return undefined;
  }
  if ((shape.ordered ? match[3] : match[2]) !== shape.marker) {
    return undefined;
  }
  const gap = (shape.ordered ? match[4] : match[3]) ?? '';
  const content = (shape.ordered ? match[5] : match[4]) ?? '';
  const markerWidth = shape.ordered ? (match[2]?.length ?? 0) + 1 : 1;
  const contentIndent = shape.indent.length + markerWidth + gap.length;
  const inner: Line[] = [{ text: content, start: line.start + contentIndent }];
  const pad = ' '.repeat(contentIndent);
  let loose = false;
  let last = index;
  let next = index + 1;
  // Continuation lines: anything indented under the item, plus blank lines
  // that are followed by more of the item.
  while (next < lines.length) {
    const continued = lineAt(lines, next);
    if (isBlank(continued)) {
      const resumed = firstNonBlank(lines, next);
      if (resumed === undefined || !lineAt(lines, resumed).text.startsWith(pad)) {
        break;
      }
      loose = true;
      for (let blank = next; blank < resumed; blank++) {
        inner.push({ text: '', start: lineAt(lines, blank).start });
      }
      next = resumed;
      continue;
    }
    if (!continued.text.startsWith(pad)) {
      break;
    }
    const text = continued.text.slice(contentIndent);
    inner.push({ text, start: continued.start + contentIndent });
    last = next;
    next++;
  }
  const number = shape.ordered ? Number(match[2] ?? '') : undefined;
  return { inner, gap, number, loose, last, next };
}

export function firstNonBlank(lines: readonly Line[], from: number): number | undefined {
  for (let at = from; at < lines.length; at++) {
    if (!isBlank(lineAt(lines, at))) {
      return at;
    }
  }
  return undefined;
}

// An item starts at its marker: the list's own indentation belongs to the
// list, whose first item starts one indentation later than it does.
export function itemNode(lines: readonly Line[], index: number, item: ItemRead, env: ParseEnv, depth: number): MdNode {
  const line = lineAt(lines, index);
  const indent = (line.text.match(/^\s*/)?.[0] ?? '').length;
  return {
    id: PENDING_ID,
    kind: 'element',
    name: 'li',
    props: {},
    children: parseBlocks(item.inner, env, depth + 2),
    mdGap: item.gap,
    start: line.start + indent,
    end: lineEnd(lineAt(lines, item.last)),
  };
}

export function listNode(
  lines: readonly Line[],
  index: number,
  next: number,
  read: {
    readonly shape: ListShape;
    readonly items: MdNode[];
    readonly numbers: readonly number[];
  },
): MdNode {
  const { shape, items } = read;
  const last = items[items.length - 1];
  assert(last?.end !== undefined, 'A list ends where its last item ends');
  const start = lineAt(lines, index).start;
  const node: MdNode = {
    id: PENDING_ID,
    kind: 'element',
    name: shape.ordered ? 'ol' : 'ul',
    props: {},
    children: items,
    mdIndent: shape.indent,
    mdMarker: shape.marker,
    start,
    end: last.end,
  };
  assert(next > index, 'A list consumes its first line');
  if (shape.ordered) {
    // Re-emitted exactly: a list written 1. 1. 1. must not become 1. 2. 3.
    node.mdNumbers = read.numbers;
    const first = read.numbers[0];
    assert(first !== undefined, 'An ordered list has its first number');
    if (first !== 1) {
      node.props = { start: { type: 'string', value: String(first) } };
      // The digits say the number; `07.` says it too, and then no span can
      // hold the value as the props record reports it, so none is recorded.
      const digits = lineAt(lines, index).text.slice(shape.indent.length).match(/^\d+/)?.[0];
      if (digits === String(first)) {
        const from = start + shape.indent.length;
        const range = [from, from + digits.length] as const;
        node.attrSpans = [markdownAttr('start', range, range)];
      }
    }
  }
  return node;
}

// A table's shape lives in its alignment row; nothing in the tree models
// that, so it stays source.
export function readTable(lines: readonly Line[], index: number): BlockRead | undefined {
  if (!lineAt(lines, index).text.includes('|')) {
    return undefined;
  }
  if (index + 1 >= lines.length) {
    return undefined;
  }
  const alignment = lineAt(lines, index + 1).text;
  if (!/^[\s|:-]+$/.test(alignment) || !alignment.includes('-')) {
    return undefined;
  }
  return rawBlock(lines, index, nonBlankEnd(lines, index));
}

// A paragraph ends where another block begins.
export function endsParagraph(text: string): boolean {
  return ATX_RE.test(text) || FENCE_RE.test(text) || RULE_RE.test(text) || QUOTE_RE.test(text) || MARKUP_RE.test(text) || SETEXT_RE.test(text);
}

// A paragraph, and the setext heading or image it can turn out to be.
export function readParagraph(lines: readonly Line[], index: number): BlockRead {
  let next = index + 1;
  while (next < lines.length) {
    const line = lineAt(lines, next);
    if (isBlank(line) || endsParagraph(line.text)) {
      break;
    }
    next++;
  }
  const text = joinedLines(lines.slice(index, next));
  const textNode: MdNode = { ...placed(lines, index, next), kind: 'text', value: text.text };
  // An underline directly under paragraph text makes it a heading. This is
  // decided here rather than by looking ahead, because `---` is both a setext
  // underline and a thematic break and only the paragraph above it tells them
  // apart: touching the text it's a heading, separated by a blank line it's a
  // rule (the blank ends the paragraph first).
  const underline = next < lines.length ? lineAt(lines, next).text : undefined;
  if (underline !== undefined && SETEXT_RE.test(underline)) {
    const node: MdNode = {
      ...placed(lines, index, next + 1),
      kind: 'element',
      name: underline.trim().charAt(0) === '=' ? 'h1' : 'h2',
      props: {},
      children: [textNode],
      mdSetext: underline,
    };
    return { nodes: [node], next: next + 1 };
  }
  const image = imageNode(lines, index, next, text);
  if (image !== undefined) {
    return { nodes: [image], next };
  }
  const node: MdNode = {
    ...placed(lines, index, next),
    kind: 'element',
    name: 'p',
    props: {},
    children: [textNode],
  };
  return { nodes: [node], next };
}

// `![alt](src "title")` alone: its alt, source and title as attributes, each
// with the range it is written in (the brackets and quotes around alt and
// title belong to the attribute, not the value).
export function imageNode(lines: readonly Line[], index: number, next: number, text: Joined): MdNode | undefined {
  const img = text.text.match(IMAGE_ONLY_RE);
  if (!img) {
    return undefined;
  }
  const alt = img[1] ?? '';
  const source = img[2] ?? '';
  const title = img[3];
  const at = (offset: number): number => text.at(offset);
  const props: Record<string, Attr> = { src: { type: 'string', value: source } };
  const spans: AttrSpan[] = [];
  const altEnd = 2 + alt.length;
  if (alt) {
    props['alt'] = { type: 'string', value: alt };
    spans.push(markdownAttr('alt', [at(1), at(altEnd + 1)], [at(2), at(altEnd)]));
  }
  const sourceStart = altEnd + 2;
  const sourceRange = [at(sourceStart), at(sourceStart + source.length)] as const;
  spans.push(markdownAttr('src', sourceRange, sourceRange));
  if (title) {
    props['title'] = { type: 'string', value: title };
    const titleEnd = text.text.length - 2; // The closing quote, before `)`.
    const titleStart = titleEnd - title.length;
    spans.push(markdownAttr('title', [at(titleStart - 1), at(titleEnd + 1)], [at(titleStart), at(titleEnd)]));
  }
  return {
    ...placed(lines, index, next),
    kind: 'element',
    name: 'img',
    props,
    children: undefined,
    mdImage: true,
    attrSpans: spans,
  };
}

// ---------------------------------------------------------------------------
// Ids and bounds
// ---------------------------------------------------------------------------

// Give every node of a finished tree its path id. The tree is the parse's
// own, just built, so this is the one place its ids are written; nodes the
// .astro parser built for a JSX block get paths in this tree. Iterative.
export function assignPathIds(roots: readonly MdNode[]): { nodes: number; depth: number } {
  const pending: { readonly node: MdNode; readonly path: string; readonly depth: number }[] = [];
  roots.forEach((node, index) => pending.push({ node, path: String(index), depth: 0 }));
  let depth = 0;
  for (let visited = 0; visited < pending.length; visited++) {
    const entry = pending[visited];
    assert(entry !== undefined, 'The visit index lies inside the pending list');
    entry.node.id = `n${entry.path}`;
    depth = Math.max(depth, entry.depth);
    if (pending.length > LIMITS.treeNodesMax) {
      return { nodes: pending.length, depth };
    }
    (entry.node.children ?? []).forEach((child, index) => pending.push({ node: child, path: `${entry.path}.${index}`, depth: entry.depth + 1 }));
  }
  return { nodes: pending.length, depth };
}
