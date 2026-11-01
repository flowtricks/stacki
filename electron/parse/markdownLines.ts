// A Markdown page as lines: the node and line shapes the parser builds, the
// patterns each block starts with, the frontmatter split, and moving source
// offsets onto the page (markdownParser.ts).

import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import type { Attr, AttrSpan } from '../../shared/page/pageNode';
import { toUtf16Span } from '../../shared/core/span';

export interface Line {
  readonly text: string;
  readonly start: number;
}

// The node bag this module builds. Mutable while a parse builds it — the block
// readers fill in the fields a node turns out to need, and the final pass
// writes the ids — and read-only once the model is returned. The md* fields
// exist only to make printing exact.
export interface MdNode {
  id?: string;
  kind: string;
  name?: string;
  value?: string;
  inner?: string;
  props?: Record<string, Attr> | undefined;
  children?: MdNode[] | undefined;
  start?: number;
  end?: number;
  attrSpans?: readonly AttrSpan[];
  mdBlanksBefore?: number;
  mdIndent?: string;
  mdFence?: string;
  mdInfo?: string;
  mdUnclosed?: boolean;
  mdRaw?: string;
  mdGap?: string;
  mdTrail?: string;
  mdSetext?: string;
  mdImage?: boolean;
  mdNumbers?: readonly number[];
  mdLoose?: boolean;
  mdMarker?: string;
  mdSource?: string;
  mdEsm?: boolean;
}

// Trailing blank lines ride on the list itself (see the end of parseBlocks).
export type MarkdownNodeList = MdNode[] & { mdTrailingBlanks?: number };

/** What the printer reads: a parsed node, or a new one an edit adds. */
export interface PrintNode {
  readonly kind: string;
  readonly name?: string;
  readonly value?: string;
  readonly inner?: string;
  readonly props?: Readonly<Record<string, Attr>> | undefined;
  readonly children?: readonly PrintNode[] | undefined;
  readonly mdBlanksBefore?: number;
  readonly mdIndent?: string;
  readonly mdFence?: string;
  readonly mdInfo?: string;
  readonly mdUnclosed?: boolean;
  readonly mdRaw?: string;
  readonly mdGap?: string;
  readonly mdTrail?: string;
  readonly mdSetext?: string;
  readonly mdNumbers?: readonly number[];
  readonly mdMarker?: string;
  readonly mdSource?: string;
}

/** Where a node is written: the prefix every line after its first carries
 * (a quote's `> `, an item's indentation, both when nested) and the file's
 * line break. */
export interface MarkdownLayout {
  readonly prefix: string;
  readonly eol: string;
}

// Nodes are built with this placeholder id; the final pass writes each node's
// structural path (`n0`, `n0.2`, `n0.2.1`), as the .astro parser does, so a
// parse is a pure function of its text (plan §4, §11.9).
export const PENDING_ID = 'n0';

export const ATX_RE = /^(\s{0,3})(#{1,6})(\s+)(.*?)(\s*#*\s*)$/;
export const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})\s*(.*)$/;
export const FENCE_CLOSE_RE = /^(\s{0,3})(`{3,}|~{3,})\s*$/;
export const RULE_RE = /^(\s{0,3})((?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
export const BULLET_RE = /^(\s*)([-*+])(\s+)(.*)$/;
export const ORDERED_RE = /^(\s*)(\d{1,9})([.)])(\s+)(.*)$/;
export const QUOTE_RE = /^(\s{0,3})>(\s?)(.*)$/;
export const SETEXT_RE = /^(\s{0,3})(=+|-+)\s*$/;
export const MARKUP_RE = /^\s{0,3}</;
// A line that ends a quote's lazy continuation: the start of another block.
export const LAZY_BREAK_RE = /^\s{0,3}(#|>|```|~~~|[-*+]\s|\d+[.)]\s)/;
// A line that is nothing but an image — the one inline construct promoted to a
// node of its own, so the asset picker can edit it like any other <img>.
export const IMAGE_ONLY_RE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/;
export const ESM_RE = /^(import|export)\s/;
export const MDX_IMPORT_RE = /^import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/;

// A quote or list nested deeper than this is kept as one raw block: its
// blocks would need more tree depth than the wire model allows, and reading it
// would recurse once per level (AGENTS.md §10). Three levels are left for the
// deepest container's own children: an item, its paragraph, and the text.
export const CONTAINER_DEPTH_MAX = LIMITS.treeDepthMax - 3;

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

// Markdown frontmatter is YAML, not JS, so it is kept as text and handed to the
// same frontmatter editor .astro pages use. `layout:` is read back out by name
// because the layout picker needs it — see layoutFromFrontmatter.
export function splitFrontmatter(source: string): {
  frontmatter: string | undefined;
  body: string;
  offset: number;
} {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/);
  if (!match) {
    return { frontmatter: undefined, body: source, offset: 0 };
  }
  const offset = match[0]?.length ?? 0;
  return { frontmatter: match[1], body: source.slice(offset), offset };
}

// The `layout:` value from YAML frontmatter, unquoted. Markdown pages pick
// their layout here rather than by importing it, so the app's layout picker
// reads and writes this field.
export function layoutFromFrontmatter(frontmatter: string | undefined): string | undefined {
  if (!frontmatter) {
    return undefined;
  }
  const match = frontmatter.match(/^[ \t]*layout[ \t]*:[ \t]*(.+?)[ \t]*$/m);
  if (!match) {
    return undefined;
  }
  return (match[1] ?? '').replace(/^['"]|['"]$/g, '') || undefined;
}

// ---------------------------------------------------------------------------
// Lines and offsets
// ---------------------------------------------------------------------------

// The body's lines, each with the file offset of its first character. A line
// break is `\n` or `\r\n` (the break itself belongs to no line), as
// `body.split(/\r?\n/)` splits it.
export function splitLines(body: string, base: number): Line[] {
  const lines: Line[] = [];
  let from = 0;
  // Each pass consumes one line break, so the loop ends within the body.
  for (let at = body.indexOf('\n'); at !== -1; at = body.indexOf('\n', from)) {
    const end = at > from && body.charCodeAt(at - 1) === 0x0d ? at - 1 : at;
    lines.push({ text: body.slice(from, end), start: base + from });
    from = at + 1;
  }
  lines.push({ text: body.slice(from), start: base + from });
  assert(lines.length >= 1, 'A body has at least one line');
  return lines;
}

export function lineAt(lines: readonly Line[], index: number): Line {
  const line = lines[index];
  assert(line !== undefined, 'A line index lies inside its container');
  return line;
}

export function isBlank(line: Line): boolean {
  return line.text.trim() === '';
}

export function lineEnd(line: Line): number {
  return line.start + line.text.length;
}

// Where the run of non-blank lines starting at `from` ends.
export function nonBlankEnd(lines: readonly Line[], from: number): number {
  let at = from;
  while (at < lines.length) {
    if (isBlank(lineAt(lines, at))) {
      break;
    }
    at++;
  }
  return at;
}

// A new node's id and the range of lines `first` up to (not including) `next`.
export function placed(lines: readonly Line[], first: number, next: number): { id: string; start: number; end: number } {
  assert(first < next, 'A node covers at least one line');
  const start = lineAt(lines, first).start;
  return { id: PENDING_ID, start, end: lineEnd(lineAt(lines, next - 1)) };
}

/** Lines joined with `\n`, as a block reads them, and the file offset of any
 * offset into that text: a position inside or at the end of a line is that
 * far into the line's own text in the file. */
export interface Joined {
  readonly text: string;
  readonly at: (offset: number) => number;
}

export function joinedLines(lines: readonly Line[]): Joined {
  assert(lines.length > 0, 'A block joins at least one line');
  const starts: number[] = [];
  let length = 0;
  for (const line of lines) {
    starts.push(length);
    length += line.text.length + 1;
  }
  const text = lines.map((line) => line.text).join('\n');
  const at = (offset: number): number => {
    assert(offset >= 0, 'A joined offset is not negative');
    assert(offset <= text.length, 'A joined offset lies inside the text');
    // The last line starting at or before the offset: binary search.
    let low = 0;
    let high = starts.length - 1;
    for (let pass = 0; pass <= 32; pass++) {
      if (low < high) {
        const middle = low + Math.ceil((high - low) / 2);
        if ((starts[middle] ?? 0) <= offset) {
          low = middle;
        } else {
          high = middle - 1;
        }
      } else {
        return lineAt(lines, low).start + (offset - (starts[low] ?? 0));
      }
    }
    throw new Error('Assertion failed: the line search ends within 32 passes');
  };
  return { text, at };
}

// Markup nodes parsed from a joined block carry offsets into that block; move
// them, and their attributes', to the file. Iterative: the depth bound is the
// template parser's, not the call stack's.
export function relocate(roots: readonly MdNode[], at: (offset: number) => number): void {
  const pending = [...roots];
  for (let visited = 0; visited < pending.length; visited++) {
    assert(visited < LIMITS.treeNodesMax, 'Relocation stays inside the tree bound');
    const node = pending[visited];
    assert(node !== undefined, 'The visit index lies inside the pending list');
    assert(node.start !== undefined, 'A located template node has a start');
    assert(node.end !== undefined, 'A located template node has an end');
    node.start = at(node.start);
    node.end = at(node.end);
    if (node.attrSpans !== undefined) {
      node.attrSpans = node.attrSpans.map((entry) => relocatedAttr(entry, at));
    }
    pending.push(...(node.children ?? []));
  }
}

export function relocatedAttr(entry: AttrSpan, at: (offset: number) => number): AttrSpan {
  const moved = (span: { readonly start: number; readonly end: number }) => toUtf16Span(at(span.start), at(span.end));
  switch (entry.type) {
    case 'string':
    case 'expr':
      return {
        ...entry,
        span: moved(entry.span),
        nameSpan: moved(entry.nameSpan),
        valueSpan: moved(entry.valueSpan),
      };
    case 'bare':
      return { ...entry, span: moved(entry.span), nameSpan: moved(entry.nameSpan) };
    case 'spread':
    case 'markdown':
      return { ...entry, span: moved(entry.span), valueSpan: moved(entry.valueSpan) };
    default: {
      const exhaustive: never = entry;
      return exhaustive;
    }
  }
}

// An attribute Markdown writes in its own syntax: `span` includes its
// delimiters (the brackets around alt text, the quotes around a title), the
// value span is the value alone.
export function markdownAttr(name: string, span: readonly [number, number], value: readonly [number, number]): AttrSpan {
  return {
    type: 'markdown',
    name,
    span: toUtf16Span(span[0], span[1]),
    valueSpan: toUtf16Span(value[0], value[1]),
  };
}
