// Which lines stay pinned at the top of a code editor as it scrolls, and where.
//
// This is the pure half of sticky scroll: codeStickyScroll.ts owns the DOM. Blocks
// come from the language's syntax tree, through the same fold information the fold
// gutter uses, so a brace in a string or a comment is not a block, and one rule
// covers CSS, JS and TS without a table of node names here.
//
// A block pins while a row of the stack is inside it. Row `i` sits `i` line heights
// below the top of the scroller, so block `i` pins once the line that opens it has
// passed that row and until its last line has. Between those two moments the pinned
// line sits at its row, and as the block ends it slides out with the content below.
//
// A block's header is its whole opening, not its first line. A selector list or a
// long signature can take many lines, and while any of them shows, a pin would only
// repeat it, so nothing pins until the line with the brace has gone. By then none of
// it is in view, so the row shows all of it, joined onto one line.
//
// Everything is in the editor's own document, which is the shown view of the source
// (codeIndentView.ts), so nothing here maps offsets between the two. Heights come
// from the editor's height map, so a folded block is simply one line tall.

import { foldNodeProp, syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { assert } from '../../shared/core/assert';

/** The most lines that pin. Past it the innermost lines stay: they name what is being edited. */
export const STICKY_LINES_MAX = 3;

// The share of a short editor the pinned lines may cover, so code stays readable below them.
const STICKY_HEIGHT_SHARE_MAX = 0.4;
// Nesting deeper than this is not code a person reads. The walk up stops here rather than
// trusting the tree's depth, and the lines it did not reach only go unpinned.
const STICKY_TREE_DEPTH_MAX = 256;
// How far back a block looks for an earlier block of the same statement.
const STICKY_SIBLINGS_MAX = 32;
// An opening taller than this is not a name any row could show, so its first line stands in.
const STICKY_HEADER_LINES_MAX = 32;

const NO_BLOCKS: readonly StickyBlock[] = [];
const NO_STACK: StickyStack = { rows: [], heightPx: 0 };

/** A block of code that can pin: the line that names it and where it ends. */
export interface StickyBlock {
  /** The start of the block's first line: the number a row shows and where a click goes. */
  readonly headerFrom: number;
  /** The start of the line that opens the block: the one with its `{` or `>`. */
  readonly openFrom: number;
  /** Just past what opens the block. */
  readonly openTo: number;
  /** The end of the block, on its last line. */
  readonly to: number;
}

/** A run of the document in a pinned row, with what goes before it. */
export interface StickyHeaderPiece {
  readonly from: number;
  readonly to: number;
  readonly separator: '' | ' ';
}

/** One visual line of the editor. A folded block is one of these. */
export interface StickyLineBox {
  readonly from: number;
  readonly top: number;
  readonly bottom: number;
}

/** The part of the editor's height map this module reads. */
export interface StickyLineMap {
  lineBlockAt(position: number): StickyLineBox;
  lineBlockAtHeight(height: number): StickyLineBox;
}

export interface StickyStackInput {
  /** Distance scrolled past the top of the first line, in the height map's terms. */
  readonly scrollTop: number;
  readonly lineHeight: number;
  readonly rowsMax: number;
  readonly lines: StickyLineMap;
  /** The blocks around a position, outermost first. */
  readonly blocksAt: (position: number) => readonly StickyBlock[];
}

export interface StickyRow {
  readonly block: StickyBlock;
  /** Distance from the top of the scroller. Negative while a line leaves. */
  readonly offsetPx: number;
}

export interface StickyStack {
  /** Outermost first. A row earlier in the list covers one later in it. */
  readonly rows: readonly StickyRow[];
  /** How much of the scroller the rows cover. */
  readonly heightPx: number;
}

type SyntaxNode = ReturnType<typeof syntaxTree>['topNode'];

/** Where in a line the tree is asked. */
interface StickyPlace {
  /** The start of the line. */
  readonly line: number;
  readonly position: number;
  readonly side: -1 | 1;
}

interface PinnedBlock {
  readonly block: StickyBlock;
  readonly openTop: number;
  readonly endBottom: number;
}

/** How many lines may pin in a scroller this tall. */
export function stickyRowsMax(viewportHeightPx: number, lineHeightPx: number): number {
  assert(Number.isFinite(viewportHeightPx), 'stickyRowsMax: the viewport height is finite');
  assert(lineHeightPx > 0, 'stickyRowsMax: a line has height');
  const rows = Math.floor((viewportHeightPx * STICKY_HEIGHT_SHARE_MAX) / lineHeightPx);
  return Math.max(0, Math.min(STICKY_LINES_MAX, rows));
}

/**
 * The blocks around a line, outermost first, for the line holding `position`. A line
 * counts as inside a block from the line that opens it to its last line, so a pinned
 * line takes over as the real one scrolls away.
 *
 * A line can open a block (`items.map(() => {`), close one (`});`) or both
 * (`} else {`), and the tree only answers for one place at a time. So both ends of
 * its text are asked: the end knows what opens, the start what closes. When a line
 * does both, what opens wins, as its header is in place to take over the row.
 *
 * The cost is two tree lookups and walks up the nesting, whatever the file's length.
 */
export function stickyBlocksAt(state: EditorState, position: number): readonly StickyBlock[] {
  assert(position >= 0, 'stickyBlocksAt: the position is in the document');
  assert(position <= state.doc.length, 'stickyBlocksAt: the position is in the document');
  const line = state.doc.lineAt(position);
  const textFrom = line.from + (line.text.length - line.text.trimStart().length);
  const textTo = line.from + line.text.trimEnd().length;
  const atStart = stickyBlocksAround(state, { line: line.from, position: textFrom, side: 1 });
  if (textFrom >= textTo) {
    return atStart;
  }
  const atEnd = stickyBlocksAround(state, { line: line.from, position: textTo, side: -1 });
  return stickyBlocksStartWith(atStart, atEnd) ? atStart : atEnd;
}

/**
 * The height the stack would have with `position`'s line directly below it. This
 * does not depend on the current scroll, so the caret can be kept clear of lines
 * that only pin once the editor has scrolled to it.
 */
export function stickyHeightAt(state: EditorState, position: number, options: { readonly lineHeight: number; readonly rowsMax: number }): number {
  assert(options.lineHeight > 0, 'stickyHeightAt: a line has height');
  assert(options.rowsMax >= 0, 'stickyHeightAt: the row limit is not negative');
  const lineFrom = state.doc.lineAt(position).from;
  const above = stickyBlocksAt(state, position).filter((block) => block.openFrom < lineFrom);
  return Math.min(above.length, options.rowsMax) * options.lineHeight;
}

/**
 * What a block's row shows, in order: every line of its opening with its line break
 * and indentation taken out, so `h1,` over `h2 {` reads `h1, h2 {`. The first line
 * keeps its indentation, which is what lines the row up with the code below it.
 */
export function stickyHeaderPieces(state: EditorState, block: StickyBlock): readonly StickyHeaderPiece[] {
  assert(block.headerFrom <= block.openFrom, 'stickyHeaderPieces: a block opens at or after its first line');
  const first = state.doc.lineAt(block.headerFrom);
  const last = state.doc.lineAt(block.openFrom);
  assert(first.from === block.headerFrom, 'stickyHeaderPieces: a header starts at the start of a line');
  if (first.number === last.number) {
    return [{ from: first.from, to: first.to, separator: '' }];
  }
  if (last.number - first.number >= STICKY_HEADER_LINES_MAX) {
    return [{ from: first.from, to: first.to, separator: '' }];
  }
  const pieces: StickyHeaderPiece[] = [{ from: first.from, to: first.from + first.text.trimEnd().length, separator: '' }];
  let previous = first.text.trimEnd();
  for (let number = first.number + 1; number <= last.number; number++) {
    const line = state.doc.line(number);
    const text = line.text.trim();
    if (text.length > 0) {
      const from = line.from + (line.text.length - line.text.trimStart().length);
      pieces.push({ from, to: from + text.length, separator: stickySeparator(previous, text) });
      previous = text;
    }
  }
  return pieces;
}

/** The lines pinned at a scroll position and where each sits. Bounded by nesting, not by file length. */
export function stickyStack(input: StickyStackInput): StickyStack {
  const { scrollTop, lineHeight, rowsMax } = input;
  assert(Number.isFinite(scrollTop), 'stickyStack: the scroll position is finite');
  assert(lineHeight > 0, 'stickyStack: a line has height');
  assert(Number.isSafeInteger(rowsMax), 'stickyStack: the row limit is a whole number');
  assert(rowsMax >= 0, 'stickyStack: the row limit is not negative');
  if (rowsMax === 0) {
    return NO_STACK;
  }
  if (scrollTop <= 0) {
    return NO_STACK;
  }
  const blocksAt = stickyBlocksMemo(input.blocksAt);
  const pinned = stickyPinnedBlocks({ ...input, blocksAt });
  const rows = pinned.length > rowsMax ? stickyRowsPastLimit(pinned, { ...input, blocksAt }) : stickyRowsWithinLimit(pinned, input);
  const visible = rows.filter((row) => row.offsetPx + lineHeight > 0);
  if (visible.length === 0) {
    return NO_STACK;
  }
  const heightPx = Math.max(...visible.map((row) => row.offsetPx + lineHeight));
  assert(visible.length <= rowsMax + 1, 'stickyStack: only one line past the limit shows, as it leaves');
  assert(heightPx <= (rowsMax + 1) * lineHeight, 'stickyStack: the stack stays within its limit');
  return { rows: visible, heightPx };
}

function stickyBlocksAround(state: EditorState, place: StickyPlace): readonly StickyBlock[] {
  const innerFirst: StickyBlock[] = [];
  let node: SyntaxNode | undefined = syntaxTree(state).resolveInner(place.position, place.side);
  for (let depth = 0; node !== undefined && depth < STICKY_TREE_DEPTH_MAX; depth++) {
    const block = stickyIsBlock(node) ? stickyBlockOf(node, state) : undefined;
    if (block !== undefined) {
      if (stickyBlockHolds(block, place)) {
        // Blocks opening on one line are one row, which lasts as long as the outer of them.
        if (innerFirst.at(-1)?.headerFrom === block.headerFrom) {
          innerFirst.pop();
        }
        innerFirst.push(block);
      }
    }
    node = node.parent ?? undefined;
  }
  return innerFirst.length === 0 ? NO_BLOCKS : innerFirst.reverse();
}

// Whether `blocks` is `prefix` with more inside it: the line closes what is left over.
function stickyBlocksStartWith(blocks: readonly StickyBlock[], prefix: readonly StickyBlock[]): boolean {
  if (blocks.length <= prefix.length) {
    return false;
  }
  return prefix.every((block, index) => block.headerFrom === blocks[index]?.headerFrom);
}

function stickyIsBlock(node: SyntaxNode): boolean {
  if (node.type.prop(foldNodeProp) === undefined) {
    return false;
  }
  // A comment folds, but it names nothing, and text inside it edits no selector.
  return !node.name.includes('Comment');
}

function stickyBlockOf(node: SyntaxNode, state: EditorState): StickyBlock | undefined {
  const fold = node.type.prop(foldNodeProp);
  assert(fold !== undefined, 'stickyBlockOf: a block folds');
  // The fold range starts just past what opens the block, in every grammar here,
  // which is how a block's opening is known without naming any node.
  const inside = fold(node, state);
  if (inside === null) {
    return undefined;
  }
  const openFrom = state.doc.lineAt(inside.from).from;
  const last = state.doc.lineAt(node.to);
  // A block that closes on the line it opens has nothing below it to stay above.
  if (openFrom >= last.from) {
    return undefined;
  }
  return { headerFrom: state.doc.lineAt(stickyHeaderPosition(node)).from, openFrom, openTo: inside.from, to: node.to };
}

/**
 * Where the code that names a block starts. A CSS block starts at its brace, which
 * for a selector list or a long signature is the line that says least, so the name
 * comes from the statement that owns the block, from its first line. An `else` is
 * the exception: its statement starts at the `if`, so it keeps its own line.
 */
function stickyHeaderPosition(node: SyntaxNode): number {
  const owner = node.parent;
  if (owner === null) {
    return node.from;
  }
  if (owner.type.isTop) {
    return node.from;
  }
  if (stickyIsBlock(owner)) {
    return node.from;
  }
  return stickyFollowsBlock(node) ? node.from : owner.from;
}

function stickyFollowsBlock(node: SyntaxNode): boolean {
  let sibling = node.prevSibling;
  for (let count = 0; sibling !== null && count < STICKY_SIBLINGS_MAX; count++) {
    if (stickyIsBlock(sibling)) {
      return true;
    }
    sibling = sibling.prevSibling;
  }
  return false;
}

// Code reads `run(a, b)`, not `run( a, b )`, when a break inside brackets goes, and a
// tag's `>` on a line of its own closes up to the tag the same way.
function stickySeparator(before: string, after: string): StickyHeaderPiece['separator'] {
  if (/[([{]$/.test(before)) {
    return '';
  }
  return /^(?:[)\]}]|\/?>$)/.test(after) ? '' : ' ';
}

function stickyBlockHolds(block: StickyBlock, place: StickyPlace): boolean {
  if (block.openFrom > place.line) {
    return false;
  }
  return place.position <= block.to;
}

// The stack looks at the same few lines more than once, and a lookup is the costly part.
function stickyBlocksMemo(blocksAt: StickyStackInput['blocksAt']): StickyStackInput['blocksAt'] {
  const seen = new Map<number, readonly StickyBlock[]>();
  return (position) => {
    const known = seen.get(position);
    if (known !== undefined) {
      return known;
    }
    const blocks = blocksAt(position);
    seen.set(position, blocks);
    return blocks;
  };
}

function stickyPinnedBlocks(input: StickyStackInput): readonly PinnedBlock[] {
  const pinned: PinnedBlock[] = [];
  for (let depth = 0; depth < STICKY_TREE_DEPTH_MAX; depth++) {
    const next = stickyPinnedAtDepth(input, depth, pinned.at(-1));
    if (next === undefined) {
      break;
    }
    pinned.push(next);
  }
  return pinned;
}

// Within the limit a block's row is its depth. Past it every block shares the last
// row, which it holds from its opening reaching the bottom of the stack to its end
// passing the top of that row. A block ending is looked for first, as it is above.
function stickyPinnedAtDepth(input: StickyStackInput, depth: number, parent: PinnedBlock | undefined): PinnedBlock | undefined {
  const { scrollTop, lineHeight, rowsMax } = input;
  const withinLimit = depth < rowsMax;
  const rowTop = scrollTop + Math.min(depth, rowsMax - 1) * lineHeight;
  const openLimit = withinLimit ? rowTop : rowTop + lineHeight;
  const probes = withinLimit ? [rowTop] : [rowTop, openLimit];
  for (const probe of probes) {
    const blocks = input.blocksAt(input.lines.lineBlockAtHeight(probe).from);
    const block = blocks[depth];
    if (block !== undefined) {
      if (blocks[depth - 1]?.headerFrom === parent?.block.headerFrom) {
        const candidate = stickyPinnedBlock(block, input.lines);
        if (stickyStaysPinned(candidate, { openLimit, rowTop, lineHeight })) {
          return candidate;
        }
      }
    }
  }
  return undefined;
}

function stickyPinnedBlock(block: StickyBlock, lines: StickyLineMap): PinnedBlock {
  const openTop = lines.lineBlockAt(block.openFrom).top;
  const endBottom = lines.lineBlockAt(block.to).bottom;
  assert(endBottom >= openTop, 'stickyPinnedBlock: a block ends below where it opens');
  return { block, openTop, endBottom };
}

function stickyStaysPinned(candidate: PinnedBlock, place: { readonly openLimit: number; readonly rowTop: number; readonly lineHeight: number }): boolean {
  // Strictly past the row: a line sitting exactly in its row needs no copy over it,
  // and the first line of a file at rest must stay clickable.
  if (candidate.openTop >= place.openLimit) {
    return false;
  }
  // A folded block is one line tall, so it scrolls like any other line. Half a line
  // of slack keeps rounding in measured heights from deciding that.
  if (candidate.endBottom - candidate.openTop < place.lineHeight * 1.5) {
    return false;
  }
  return candidate.endBottom > place.rowTop;
}

function stickyRowsWithinLimit(pinned: readonly PinnedBlock[], input: StickyStackInput): readonly StickyRow[] {
  const { scrollTop, lineHeight } = input;
  return pinned.map((item, depth) => ({
    block: item.block,
    offsetPx: Math.min(depth * lineHeight, item.endBottom - scrollTop - lineHeight),
  }));
}

/**
 * More blocks are open than rows, so a window of the innermost shows, and the window
 * moves by a whole row when the innermost block changes. Moving it in one step would
 * jump every line at once, so it moves as the content does: a block coming in rises
 * with its real line and lifts the stack, and a block ending stays put while the
 * stack comes down over it. When a sibling takes its place the window has no need to
 * move, so the ending block is pushed out as usual. The top row of the window is one
 * line above the limit, so it shows only as it comes or goes.
 */
function stickyRowsPastLimit(pinned: readonly PinnedBlock[], input: StickyStackInput): readonly StickyRow[] {
  const { scrollTop, lineHeight, rowsMax } = input;
  const innermost = pinned.at(-1);
  assert(innermost !== undefined, 'stickyRowsPastLimit: more blocks than rows means at least one');
  const lastRowTop = (rowsMax - 1) * lineHeight;
  const entering = Math.min(lineHeight, Math.max(0, innermost.openTop - scrollTop - lastRowTop));
  const leaving = Math.min(lineHeight, Math.max(0, lastRowTop - (innermost.endBottom - scrollTop - lineHeight)));
  const stackBottom = input.lines.lineBlockAtHeight(scrollTop + rowsMax * lineHeight).from;
  const followed = input.blocksAt(stackBottom).length >= pinned.length;
  const stackShift = entering > 0 ? entering : followed ? 0 : leaving;
  const innermostShift = entering > 0 ? entering : followed ? -leaving : 0;
  const shown = pinned.slice(-(rowsMax + 1));
  assert(shown.length === rowsMax + 1, 'stickyRowsPastLimit: the window is one row taller than the limit');
  return shown.map((item, index) => {
    const shift = item === innermost ? innermostShift : stackShift;
    return {
      block: item.block,
      offsetPx: Math.min((index - 1) * lineHeight + shift, item.endBottom - scrollTop - lineHeight),
    };
  });
}
