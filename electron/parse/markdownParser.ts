// Parses .md / .mdx pages into the same editable tree model as .astro pages,
// with the source range of every node and of every attribute Markdown writes,
// and prints Markdown nodes: the new ones an edit adds, and a node before and
// after an edit, so the edit reaches disk as the difference between the two
// (electron/documents/markdownEdits.ts; plan §3.4, §11 step 10). A Markdown page is
// never printed whole to be saved.
//
// The tree uses the node kinds the rest of the app already understands, so the
// navigator, the props panel, text editing, undo, copy/paste and the insert
// palette all work without knowing markdown exists:
//
//   heading      → element h1…h6      paragraph  → element p
//   list         → element ul / ol     list item  → element li
//   blockquote   → element blockquote  rule       → element hr
//   fenced code  → element pre (props.lang), one text child holding the code
//   image-only   → element img (props.src / props.alt)
//   anything else → raw-line, kept verbatim
//
// Inline formatting (**bold**, [links](…), `code`) stays as markdown inside the
// text node rather than becoming a tree of its own. That keeps a paragraph one
// editable field — the way a writer thinks about it — and, more importantly,
// makes printing exact: text this parser does not interpret is text it cannot
// corrupt.
//
// PRINTING IS EXACT. Every block records the source details that would
// otherwise be normalised away — the bullet character, the fence character and
// width, setext vs ATX headings, blank lines between items — so printing a
// node that was not edited reproduces its bytes, and printing the whole page
// reproduces the file (the round-trip tests pin it). An edit is written as the
// difference between the node printed before and after it, placed on the
// node's own bytes; anything this file cannot reproduce exactly belongs in a
// raw-line instead.
//
// SPANS (plan §3.2, step 10). Each container — a quote, a list item — reads
// its lines with its own syntax taken off the front, and every line remembers
// where its text starts in the file, so a node's range is exact however deep
// it sits: slicing the file at it gives the node as printed at its place, with
// the container's prefix on every line after the first. Offsets are UTF-16,
// into the text as read, a leading byte-order mark included.

import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import type { Attr } from '../../shared/page/pageNode';
import { parseTemplate, serializeNodes } from './astroParser';
import { type MarkdownNodeList, type PrintNode, type MarkdownLayout, splitFrontmatter, layoutFromFrontmatter, splitLines, lineAt } from './markdownLines';
import { type ParseEnv, parseBlocks, assignPathIds } from './markdownBlocks';

export { type PrintNode, type MarkdownLayout } from './markdownLines';

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

function serializeBlocks(nodes: readonly PrintNode[] | undefined, out: string[]): void {
  for (const node of nodes ?? []) {
    pushBlanks(out, node.mdBlanksBefore ?? 0);
    serializeBlock(node, out);
  }
  // Only a parsed list carries the count; 'in' keeps the read cast-free.
  const trailing = nodes && 'mdTrailingBlanks' in nodes ? Number(nodes['mdTrailingBlanks']) : 0;
  pushBlanks(out, trailing);
}

function pushBlanks(out: string[], count: number): void {
  assert(count <= LIMITS.treeNodesMax, 'Blank runs are inside the parser bound');
  for (let i = 0; i < count; i++) {
    out.push('');
  }
}

function attrValue(attr: Attr | undefined): string | undefined {
  return attr !== undefined && 'value' in attr ? attr.value : undefined;
}

function textOf(node: PrintNode): string {
  return (node.children ?? [])
    .filter((child) => child.kind === 'text')
    .map((child) => child.value)
    .join('');
}

// A node the app created (from the insert palette, or by pasting) has none of
// the md* source details, so these defaults are also the "new block" format.
function serializeBlock(node: PrintNode, out: string[]): void {
  switch (node.kind) {
    case 'raw-line':
    case 'raw':
      out.push(...String(node.value ?? node.inner ?? '').split('\n'));
      return;
    case 'text':
      out.push(...String(node.value ?? '').split('\n'));
      return;
    case 'comment':
      out.push(`<!--${node.value}-->`);
      return;
    default:
      serializeElement(node, out);
  }
}

function serializeElement(node: PrintNode, out: string[]): void {
  const name = node.name || '';
  if (/^h[1-6]$/.test(name)) {
    serializeHeading(node, out);
  } else if (name === 'p') {
    out.push(...textOf(node).split('\n'));
  } else if (name === 'hr') {
    out.push(node.mdRaw ?? '---');
  } else if (name === 'img') {
    const propText = (name: string): string => attrValue(node.props?.[name]) ?? '';
    const title = propText('title') ? ` "${propText('title')}"` : '';
    out.push(`![${propText('alt')}](${propText('src')}${title})`);
  } else if (name === 'pre') {
    serializeFence(node, out);
  } else if (name === 'blockquote') {
    serializeQuote(node, out);
  } else if (name === 'ul' || name === 'ol') {
    serializeList(node, out);
  } else {
    serializeMarkup(node, out);
  }
}

function serializeHeading(node: PrintNode, out: string[]): void {
  if (node.mdSetext) {
    out.push(textOf(node));
    out.push(node.mdSetext);
    return;
  }
  const hashes = '#'.repeat(Number((node.name ?? '').charAt(1)));
  const indent = node.mdIndent ?? '';
  out.push(`${indent}${hashes}${node.mdGap ?? ' '}${textOf(node)}${node.mdTrail ?? ''}`);
}

function serializeFence(node: PrintNode, out: string[]): void {
  const indent = node.mdIndent ?? '';
  const fence = node.mdFence ?? '```';
  const info = node.mdInfo ?? attrValue(node.props?.['lang']) ?? '';
  out.push(`${indent}${fence}${info}`);
  const lines = textOf(node).split('\n');
  if (lines.length !== 1 || lines[0] !== '') {
    out.push(...lines);
  }
  if (!node.mdUnclosed) {
    out.push(`${indent}${fence}`);
  }
}

function serializeQuote(node: PrintNode, out: string[]): void {
  const inner: string[] = [];
  serializeBlocks(node.children ?? [], inner);
  const gap = node.mdGap ?? ' ';
  for (const line of inner) {
    out.push(line ? `>${gap}${line}` : '>');
  }
}

function serializeList(node: PrintNode, out: string[]): void {
  const ordered = node.name === 'ol';
  const marker = node.mdMarker ?? (ordered ? '.' : '-');
  const start = Number(attrValue(node.props?.['start']) ?? 1) || 1;
  const indent = node.mdIndent ?? '';
  (node.children ?? []).forEach((item, index) => {
    pushBlanks(out, item.mdBlanksBefore ?? 0);
    const number = ordered ? (node.mdNumbers?.[index] ?? start + index) : undefined;
    serializeItem(item, { marker, number, indent }, out);
  });
}

/** How one item's marker is written: the list's marker character, the item's
 * number in an ordered list, and the list's own indentation. */
interface ItemMarker {
  readonly marker: string;
  readonly number: number | undefined;
  readonly indent: string;
}

// The first line carries the marker after the list's indentation; the rest
// are indented to the item's content.
function serializeItem(item: PrintNode, at: ItemMarker, out: string[]): void {
  const bullet = at.number === undefined ? at.marker : `${at.number}${at.marker}`;
  const gap = item.mdGap ?? ' ';
  const inner: string[] = [];
  serializeBlocks(item.children ?? [], inner);
  const pad = ' '.repeat(at.indent.length + bullet.length + gap.length);
  inner.forEach((line, index) => {
    if (index === 0) {
      out.push(`${at.indent}${bullet}${gap}${line}`);
    } else {
      out.push(line ? pad + line : '');
    }
  });
  if (!inner.length) {
    out.push(`${at.indent}${bullet}`);
  }
}

// Anything else came from JSX (a component in MDX, or an HTML block) — the
// .astro serializer owns those, and owns them exactly. It returns a string
// with a trailing newline; markdown works in lines, so drop it.
function serializeMarkup(node: PrintNode, out: string[]): void {
  const text = serializeNodes([node]).replace(/\n$/, '');
  // Untouched? Then write back what was there. The comparison is between two
  // serializations, not two source strings, so it answers "does this node
  // still say what the source said" rather than "is the text identical" —
  // formatting the .astro writer would normalise doesn't count as a change.
  if (node.mdSource !== undefined) {
    const original = parseTemplate(node.mdSource);
    if (original.clean && original.nodes.length === 1) {
      if (serializeNodes(original.nodes).replace(/\n$/, '') === text) {
        out.push(...node.mdSource.split('\n'));
        return;
      }
    }
  }
  out.push(...text.split('\n'));
}

// Lines a container reads, written at their place: every line after the first
// carries the prefix, and a blank one only the prefix's visible part (`>`).
function placedLines(lines: readonly string[], layout: MarkdownLayout): string {
  const blank = layout.prefix.trimEnd();
  return lines
    .map((line, index) => {
      if (index === 0) {
        return line;
      }
      return line === '' ? blank : `${layout.prefix}${line}`;
    })
    .join(layout.eol);
}

// ---------------------------------------------------------------------------
// Page API
// ---------------------------------------------------------------------------

export interface MarkdownModel {
  readonly format: 'md' | 'mdx';
  readonly imports: readonly { readonly name: string; readonly path: string }[];
  // The YAML block, shown in the frontmatter editor. `layout:` is also
  // surfaced separately so the layout picker can drive it.
  readonly extraFrontmatter: string;
  readonly frontmatterLang: 'yaml';
  readonly layoutPath: string | undefined;
  readonly nodes: MarkdownNodeList;
  readonly mdEol: string;
  readonly mdEndsWithNewline: boolean;
  readonly mdHasFrontmatter: boolean;
  /** Where the body starts, after the byte-order mark and the frontmatter. */
  readonly bodyStart: number;
}

export type MarkdownParse =
  { readonly editable: true; readonly model: MarkdownModel } | { readonly editable: false; readonly reason: string; readonly bail: undefined };

/** Parse a Markdown or MDX page. Every node has its source range; a page whose
 * tree exceeds the wire model's bounds is not editable (the code panel still
 * is), never cut short. */
function parseMarkdownPage(source: string, { mdx = false }: { readonly mdx?: boolean } = {}): MarkdownParse {
  if (source.length > LIMITS.ipcFieldCharsMax) {
    // i18n-ignore: diagnostic for a page that is not editable (carried for logs and tests); the code view states it in its own words.
    return { editable: false, reason: 'The page exceeds the source limit.', bail: undefined };
  }
  // A leading byte-order mark is not content (plan §3.2); it stays in the
  // file, and offsets count it.
  const bom = source.startsWith('﻿') ? 1 : 0;
  const text = source.slice(bom);
  const { frontmatter, body, offset } = splitFrontmatter(text);
  const env: ParseEnv = { mdx, imports: [], esm: [] };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = splitLines(body, bom + offset);
  // A trailing newline shows up as one empty final line; it is the file's line
  // ending, not a blank line, so it is dropped here and printed back after.
  const endsWithNewline = lineAt(lines, lines.length - 1).text === '';
  if (endsWithNewline) {
    lines.pop();
  }
  const nodes = parseBlocks(lines, env, 0);
  const size = assignPathIds(nodes);
  if (size.nodes > LIMITS.treeNodesMax || size.depth > LIMITS.treeDepthMax) {
    // i18n-ignore: diagnostic for a page that is not editable (carried for logs and tests); the code view states it in its own words.
    return { editable: false, reason: 'The page exceeds the tree limits.', bail: undefined };
  }
  return {
    editable: true,
    model: {
      format: mdx ? 'mdx' : 'md',
      imports: env.imports,
      extraFrontmatter: frontmatter ?? '',
      frontmatterLang: 'yaml',
      layoutPath: layoutFromFrontmatter(frontmatter),
      nodes,
      mdEol: eol,
      mdEndsWithNewline: endsWithNewline,
      mdHasFrontmatter: frontmatter !== undefined,
      bodyStart: bom + offset,
    },
  };
}

/** The page printed whole, from its model: the round-trip oracle the tests
 * hold the parser and printer to. Never a write path (plan §11 step 10): a
 * Markdown page reaches disk only as splices; the lint fence keeps this
 * printer to this module and the tests. */
function serializeMarkdownPage(
  model: Pick<MarkdownModel, 'extraFrontmatter' | 'mdHasFrontmatter' | 'mdEol' | 'mdEndsWithNewline'> & { readonly nodes: readonly PrintNode[] },
): string {
  const out: string[] = [];
  const fm = model.extraFrontmatter;
  if (model.mdHasFrontmatter || fm.trim()) {
    out.push('---');
    if (fm !== '') {
      // The block keeps the file's own line breaks; splitting on LF alone left
      // each CR in place, so a CRLF page gained a CR per line (CR CR LF).
      out.push(...fm.split(/\r?\n/));
    }
    out.push('---');
  }
  serializeBlocks(model.nodes, out);
  const eol = model.mdEol || '\n';
  return out.join(eol) + (model.mdEndsWithNewline === false ? '' : eol);
}

/** A block, or the text of one, written at its place: the bytes its range
 * holds when it was parsed there and not edited since. A list item needs its
 * list's marker: printMarkdownItem. */
function printMarkdownNode(node: PrintNode, layout: MarkdownLayout): string {
  const out: string[] = [];
  serializeBlock(node, out);
  return placedLines(out, layout);
}

/** A list item written at its place: from its marker (the list's indentation
 * belongs to the list) to its last line. */
function printMarkdownItem(item: PrintNode, at: Pick<ItemMarker, 'marker' | 'number'> & { readonly indent: string }, layout: MarkdownLayout): string {
  const out: string[] = [];
  serializeItem(item, at, out);
  const [first, ...rest] = out;
  assert(first !== undefined, 'An item prints at least its marker line');
  assert(first.startsWith(at.indent), 'An item line starts with its list indentation');
  return placedLines([first.slice(at.indent.length), ...rest], layout);
}

/** The frontmatter block a model describes, as it is written: `---`, the YAML,
 * `---`, in the file's line breaks, without the break after the closing
 * fence. */
function printMarkdownFrontmatter(yaml: string, eol: string): string {
  const lines = yaml === '' ? [] : yaml.split(/\r?\n/);
  return ['---', ...lines, '---'].join(eol);
}

export { layoutFromFrontmatter, parseMarkdownPage, printMarkdownFrontmatter, printMarkdownItem, printMarkdownNode, serializeMarkdownPage, splitFrontmatter };
