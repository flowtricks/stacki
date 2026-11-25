// An agent's reply as a tree: the GitHub-flavoured Markdown an agent actually writes (paragraphs, headings,
// nested and task lists, block quotes, tables, fenced code, rules, and inline code, bold, italic, strike,
// links). Pure text in, plain data out: no HTML is ever read, so what the agent wrote can only become the
// nodes below, never markup.
//
// Everything is bounded (`MARKDOWN_LIMITS`): a reply is cut at the character bound, nesting stops at the
// depth bound (deeper text is drawn as plain text), and the number of blocks, table rows, columns and
// list items are capped, so a hostile or runaway reply costs a bounded amount of work. Every loop below
// advances at least one line or one character per round, which is asserted where the loop could stall.
//
// A fence left open (a reply still streaming) is a code block to the end of the text, so a reply does not
// flash between "text" and "code" while it arrives.
import { assert } from '../../../../shared/core/assert';

export const MARKDOWN_LIMITS = {
  /** A reply is read up to this many characters. */
  charsMax: 200_000,
  /** Blocks inside blocks (quote in list in quote…). */
  depthMax: 6,
  /** Blocks in the whole reply. */
  blocksMax: 4_000,
  tableRowsMax: 300,
  tableColumnsMax: 24,
  listItemsMax: 1_000,
  /** Emphasis inside emphasis inside a link… */
  inlineDepthMax: 4,
} as const satisfies Record<string, number>;

export type CellAlign = 'start' | 'center' | 'end' | 'default';
export type TaskState = 'checked' | 'unchecked';

export type Inline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'strong'; readonly children: readonly Inline[] }
  | { readonly kind: 'emphasis'; readonly children: readonly Inline[] }
  | { readonly kind: 'strike'; readonly children: readonly Inline[] }
  | { readonly kind: 'link'; readonly href: string; readonly children: readonly Inline[] };

export interface ListItem {
  /** Undefined for an ordinary item; a task list item says whether its box is ticked. */
  readonly task: TaskState | undefined;
  readonly blocks: readonly Block[];
}

export type Block =
  | { readonly kind: 'paragraph'; readonly inline: readonly Inline[] }
  | { readonly kind: 'heading'; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly inline: readonly Inline[] }
  | { readonly kind: 'code'; readonly language: string; readonly text: string }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly start: number; readonly items: readonly ListItem[] }
  | { readonly kind: 'quote'; readonly blocks: readonly Block[] }
  | {
      readonly kind: 'table';
      readonly align: readonly CellAlign[];
      readonly header: readonly (readonly Inline[])[];
      readonly rows: readonly (readonly (readonly Inline[])[])[];
    }
  | { readonly kind: 'rule' };

/** The reply as blocks. Total: any text parses, and an empty one has no blocks. */
export function parseChatMarkdown(text: string): readonly Block[] {
  const bounded = text.length > MARKDOWN_LIMITS.charsMax ? text.slice(0, MARKDOWN_LIMITS.charsMax) : text;
  assert(bounded.length <= MARKDOWN_LIMITS.charsMax, 'parseChatMarkdown: the text is within the bound');
  const lines = bounded.replace(/\r\n?/g, '\n').split('\n').map(expandTabs);
  const budget = new Budget();
  const blocks = parseBlocks(lines, 0, budget);
  assert(budget.blocks <= MARKDOWN_LIMITS.blocksMax, 'parseChatMarkdown: the block budget holds');
  return blocks;
}

/** How many blocks the reply has produced, one counter for the whole parse (the one place this state lives). */
class Budget {
  private count = 0;

  get blocks(): number {
    return this.count;
  }

  spend(): void {
    this.count += 1;
  }
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])( +|$)(.*)$/;
const TABLE_DELIMITER = /^ *\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;

function expandTabs(line: string): string {
  return line.replace(/^\t+/, (tabs) => '    '.repeat(tabs.length));
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

interface ItemMarker {
  readonly indent: number;
  readonly ordered: boolean;
  readonly number: number;
  /** Columns the item's content is indented by: its text lines up with the first line's. */
  readonly contentIndent: number;
  readonly first: string;
}

function itemMarker(line: string): ItemMarker | undefined {
  const match = LIST_ITEM.exec(line);
  if (match === null) {
    return undefined;
  }
  const marker = match[2] ?? '';
  const spaces = (match[3] ?? '').length;
  const first = match[4] ?? '';
  const indent = (match[1] ?? '').length;
  // A rule such as "* * *" is a rule, not an empty item.
  if (RULE.test(line)) {
    return undefined;
  }
  const ordered = /^\d/.test(marker);
  // Five or more spaces after the marker make the text a code line inside the item: its content starts one space in.
  const gap = spaces === 0 || spaces > 4 ? 1 : spaces;
  return { indent, ordered, number: ordered ? Number.parseInt(marker, 10) : 1, contentIndent: indent + marker.length + gap, first };
}

function isTableStart(lines: readonly string[], index: number): boolean {
  const head = lines[index];
  const delimiter = lines[index + 1];
  if (head === undefined || delimiter === undefined || !head.includes('|') || !delimiter.includes('-') || !TABLE_DELIMITER.test(delimiter)) {
    return false;
  }
  const headCells = splitRow(head).length;
  return headCells >= 1 && headCells === splitRow(delimiter).length;
}

/** Whether `line` ends a paragraph that is running: a new block begins on it. */
function interruptsParagraph(lines: readonly string[], index: number): boolean {
  const line = lines[index] ?? '';
  if (FENCE_OPEN.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || isTableStart(lines, index)) {
    return true;
  }
  const marker = itemMarker(line);
  // Only a bullet, or a list that starts at 1, may interrupt: "see 2. below" stays text.
  return marker !== undefined && marker.first !== '' && (!marker.ordered || marker.number === 1);
}

function parseBlocks(lines: readonly string[], depth: number, budget: Budget): readonly Block[] {
  assert(depth <= MARKDOWN_LIMITS.depthMax, 'parseBlocks: within the depth bound');
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length && budget.blocks < MARKDOWN_LIMITS.blocksMax) {
    const before = index;
    const line = lines[index] ?? '';
    if (isBlank(line)) {
      index += 1;
    } else if (depth >= MARKDOWN_LIMITS.depthMax) {
      // Too deep to structure: the rest of this level is plain text.
      blocks.push({ kind: 'paragraph', inline: [{ kind: 'text', text: lines.slice(index).join('\n').trim() }] });
      budget.spend();
      index = lines.length;
    } else {
      const parsed = parseBlockAt(lines, index, depth, budget);
      blocks.push(parsed.block);
      budget.spend();
      index = parsed.next;
    }
    assert(index > before, 'parseBlocks: every round advances');
  }
  return blocks;
}

function parseBlockAt(lines: readonly string[], index: number, depth: number, budget: Budget): { readonly block: Block; readonly next: number } {
  const line = lines[index] ?? '';
  const fence = FENCE_OPEN.exec(line);
  if (fence !== null) {
    return parseFence(lines, index, fence[1] ?? '```', fence[2] ?? '');
  }
  const heading = HEADING.exec(line);
  if (heading !== null) {
    const level = Math.min(6, Math.max(1, (heading[1] ?? '#').length));
    return { block: { kind: 'heading', level: headingLevel(level), inline: parseInline(heading[2] ?? '', 0) }, next: index + 1 };
  }
  if (RULE.test(line)) {
    return { block: { kind: 'rule' }, next: index + 1 };
  }
  if (QUOTE.test(line)) {
    return parseQuote(lines, index, depth, budget);
  }
  if (isTableStart(lines, index)) {
    return parseTable(lines, index);
  }
  if (itemMarker(line) !== undefined) {
    return parseList(lines, index, depth, budget);
  }
  return parseParagraph(lines, index);
}

function headingLevel(level: number): 1 | 2 | 3 | 4 | 5 | 6 {
  switch (level) {
    case 1:
      return 1;
    case 2:
      return 2;
    case 3:
      return 3;
    case 4:
      return 4;
    case 5:
      return 5;
    default:
      return 6;
  }
}

function parseFence(lines: readonly string[], index: number, opener: string, language: string): { readonly block: Block; readonly next: number } {
  const markerChar = opener.startsWith('~') ? '~' : '`';
  const body: string[] = [];
  const openIndent = indentOf(lines[index] ?? '');
  let cursor = index + 1;
  let closed = false;
  while (cursor < lines.length) {
    const candidate = lines[cursor] ?? '';
    const trimmed = candidate.trim();
    if (trimmed.length >= opener.length && trimmed === markerChar.repeat(trimmed.length)) {
      closed = true;
      break;
    }
    // The opening fence's indent is removed from each line, as far as the line has it.
    body.push(candidate.slice(Math.min(openIndent, indentOf(candidate))));
    cursor += 1;
  }
  assert(cursor <= lines.length, 'parseFence: stays within the text');
  return { block: { kind: 'code', language, text: body.join('\n') }, next: closed ? cursor + 1 : cursor };
}

function parseQuote(lines: readonly string[], index: number, depth: number, budget: Budget): { readonly block: Block; readonly next: number } {
  const inner: string[] = [];
  let cursor = index;
  while (cursor < lines.length) {
    const line = lines[cursor] ?? '';
    if (QUOTE.test(line)) {
      inner.push(line.replace(/^ {0,3}> ?/, ''));
    } else if (!isBlank(line) && inner.length > 0 && !isBlank(inner[inner.length - 1] ?? '') && !interruptsParagraph(lines, cursor)) {
      inner.push(line); // A quote's paragraph may carry on without its ">".
    } else {
      break;
    }
    cursor += 1;
  }
  assert(cursor > index, 'parseQuote: takes at least its first line');
  return { block: { kind: 'quote', blocks: parseBlocks(inner, depth + 1, budget) }, next: cursor };
}

function parseParagraph(lines: readonly string[], index: number): { readonly block: Block; readonly next: number } {
  const taken: string[] = [(lines[index] ?? '').trim()];
  let cursor = index + 1;
  while (cursor < lines.length && !isBlank(lines[cursor] ?? '') && !interruptsParagraph(lines, cursor)) {
    taken.push((lines[cursor] ?? '').trim());
    cursor += 1;
  }
  return { block: { kind: 'paragraph', inline: parseInline(taken.join('\n'), 0) }, next: cursor };
}

function parseList(lines: readonly string[], index: number, depth: number, budget: Budget): { readonly block: Block; readonly next: number } {
  const firstMarker = itemMarker(lines[index] ?? '');
  assert(firstMarker !== undefined, 'parseList: starts on an item');
  const items: ListItem[] = [];
  let cursor = index;
  while (cursor < lines.length && items.length < MARKDOWN_LIMITS.listItemsMax) {
    const marker = itemMarker(lines[cursor] ?? '');
    // A sibling sits at about the same indent and uses the same kind of marker.
    if (marker === undefined || marker.ordered !== firstMarker.ordered || Math.abs(marker.indent - firstMarker.indent) > 1) {
      break;
    }
    const content: string[] = [marker.first];
    cursor += 1;
    while (cursor < lines.length) {
      const line = lines[cursor] ?? '';
      if (isBlank(line)) {
        const upcoming = nextNonBlank(lines, cursor);
        const after = upcoming === undefined ? undefined : lines[upcoming];
        // A blank line stays in the item only when its content carries on, indented, after it.
        if (after !== undefined && indentOf(after) >= marker.indent + 2 && itemMarker(after)?.indent !== marker.indent) {
          content.push('');
          cursor += 1;
          continue;
        }
        break;
      }
      const sibling = itemMarker(line);
      if (sibling !== undefined && sibling.indent < marker.indent + 2) {
        break;
      }
      if (indentOf(line) >= marker.indent + 2) {
        content.push(line.slice(Math.min(marker.contentIndent, indentOf(line))));
      } else if (!isBlank(content[content.length - 1] ?? '') && !interruptsParagraph(lines, cursor)) {
        content.push(line.trim()); // A lazy continuation line.
      } else {
        break;
      }
      cursor += 1;
    }
    items.push(listItem(content, depth, budget));
  }
  assert(items.length > 0, 'parseList: takes at least one item');
  assert(cursor > index, 'parseList: advances');
  return { block: { kind: 'list', ordered: firstMarker.ordered, start: firstMarker.number, items }, next: cursor };
}

function nextNonBlank(lines: readonly string[], from: number): number | undefined {
  for (let cursor = from; cursor < lines.length; cursor += 1) {
    if (!isBlank(lines[cursor] ?? '')) {
      return cursor;
    }
  }
  return undefined;
}

function listItem(content: readonly string[], depth: number, budget: Budget): ListItem {
  const head = content[0] ?? '';
  const task = /^\[( |x|X)\][ \t]+(.*)$/.exec(head);
  if (task === null) {
    return { task: undefined, blocks: parseBlocks(content, depth + 1, budget) };
  }
  const state: TaskState = task[1] === ' ' ? 'unchecked' : 'checked';
  return { task: state, blocks: parseBlocks([task[2] ?? '', ...content.slice(1)], depth + 1, budget) };
}

function parseTable(lines: readonly string[], index: number): { readonly block: Block; readonly next: number } {
  const headCells = splitRow(lines[index] ?? '');
  const columns = Math.min(headCells.length, MARKDOWN_LIMITS.tableColumnsMax);
  const align = splitRow(lines[index + 1] ?? '')
    .slice(0, columns)
    .map(cellAlign);
  const rows: (readonly Inline[])[][] = [];
  let cursor = index + 2;
  while (cursor < lines.length && rows.length < MARKDOWN_LIMITS.tableRowsMax) {
    const line = lines[cursor] ?? '';
    if (isBlank(line) || FENCE_OPEN.test(line) || HEADING.test(line) || QUOTE.test(line)) {
      break;
    }
    const cells = splitRow(line);
    // A short row is padded and a long one cut: the table keeps the header's width.
    rows.push(Array.from({ length: columns }, (_, column) => parseInline(cells[column] ?? '', 0)));
    cursor += 1;
  }
  assert(cursor >= index + 2, 'parseTable: takes the header and the delimiter');
  assert(align.length === columns, 'parseTable: one alignment per column');
  return {
    block: { kind: 'table', align, header: headCells.slice(0, columns).map((cell) => parseInline(cell, 0)), rows },
    next: cursor,
  };
}

function cellAlign(cell: string): CellAlign {
  const text = cell.trim();
  const left = text.startsWith(':');
  const right = text.endsWith(':');
  if (left && right) {
    return 'center';
  }
  if (right) {
    return 'end';
  }
  return left ? 'start' : 'default';
}

/** The cells of one table row; an escaped pipe stays in its cell, and the outer pipes are not cells. */
export function splitRow(line: string): readonly string[] {
  const text = line.trim();
  const cells: string[] = [];
  let cell = '';
  for (let position = 0; position < text.length; position += 1) {
    const character = text[position] ?? '';
    if (character === '\\' && text[position + 1] === '|') {
      cell += '|';
      position += 1;
    } else if (character === '|') {
      cells.push(cell);
      cell = '';
    } else {
      cell += character;
    }
  }
  cells.push(cell);
  if (text.startsWith('|')) {
    cells.shift();
  }
  if (text.endsWith('|') && !text.endsWith('\\|') && cells.length > 0) {
    cells.pop();
  }
  return cells.map((entry) => entry.trim()).slice(0, MARKDOWN_LIMITS.tableColumnsMax + 1);
}

// --- Inline ----------------------------------------------------------------------------------------------

const SAFE_LINK = /^(?:https?:\/\/|mailto:)[^\s<>]+$/i;
const BARE_URL = /^https?:\/\/[^\s<>]+/i;

/** Whether a link target may be opened: web and mail links only, never a script or a file. */
export function isSafeLink(href: string): boolean {
  return href.length <= 2_000 && SAFE_LINK.test(href);
}

export function parseInline(text: string, depth: number): readonly Inline[] {
  assert(depth >= 0, 'parseInline: a depth');
  const out: Inline[] = [];
  let buffer = '';
  const flush = (): void => {
    if (buffer !== '') {
      out.push({ kind: 'text', text: buffer });
      buffer = '';
    }
  };
  let position = 0;
  while (position < text.length) {
    const before = position;
    const taken = depth > MARKDOWN_LIMITS.inlineDepthMax ? undefined : inlineAt(text, position, depth);
    if (taken === undefined) {
      buffer += text[position] ?? '';
      position += 1;
    } else {
      const last = out[out.length - 1];
      if (taken.node.kind === 'text' && buffer === '' && last?.kind === 'text') {
        // Text that follows text (an escape, a link that may not open) joins it.
        out[out.length - 1] = { kind: 'text', text: last.text + taken.node.text };
      } else if (taken.node.kind === 'text') {
        buffer += taken.node.text;
      } else {
        flush();
        out.push(taken.node);
      }
      position = taken.next;
    }
    assert(position > before, 'parseInline: every round advances');
  }
  flush();
  return out;
}

interface Taken {
  readonly node: Inline;
  readonly next: number;
}

function inlineAt(text: string, position: number, depth: number): Taken | undefined {
  const character = text[position] ?? '';
  switch (character) {
    case '\\': {
      const escaped = text[position + 1];
      return escaped !== undefined && /[!-/:-@[-`{-~]/.test(escaped) ? { node: { kind: 'text', text: escaped }, next: position + 2 } : undefined;
    }
    case '`':
      return codeSpan(text, position);
    case '[':
      return link(text, position, depth);
    case '*':
    case '_':
    case '~':
      return emphasis(text, position, character, depth);
    case 'h':
      return bareLink(text, position);
    default:
      return undefined;
  }
}

function codeSpan(text: string, position: number): Taken | undefined {
  let run = 0;
  while (text[position + run] === '`') {
    run += 1;
  }
  const fence = '`'.repeat(run);
  const close = findRun(text, fence, position + run);
  if (close === undefined) {
    return { node: { kind: 'text', text: fence }, next: position + run };
  }
  let inner = text.slice(position + run, close).replace(/\n/g, ' ');
  if (inner.length > 2 && inner.startsWith(' ') && inner.endsWith(' ') && inner.trim() !== '') {
    inner = inner.slice(1, -1);
  }
  return { node: { kind: 'code', text: inner }, next: close + run };
}

/** The start of the next run of exactly `fence`'s backticks at or after `from`. */
function findRun(text: string, fence: string, from: number): number | undefined {
  let cursor = from;
  while (cursor < text.length) {
    const found = text.indexOf(fence, cursor);
    if (found < 0) {
      return undefined;
    }
    if (text[found - 1] !== '`' && text[found + fence.length] !== '`') {
      return found;
    }
    cursor = found + 1;
  }
  return undefined;
}

function link(text: string, position: number, depth: number): Taken | undefined {
  const labelEnd = text.indexOf(']', position + 1);
  if (labelEnd < 0 || text[labelEnd + 1] !== '(') {
    return undefined;
  }
  const targetEnd = text.indexOf(')', labelEnd + 2);
  if (targetEnd < 0) {
    return undefined;
  }
  const target = text
    .slice(labelEnd + 2, targetEnd)
    .trim()
    .split(/\s+/)[0];
  const label = text.slice(position + 1, labelEnd);
  const children = parseInline(label, depth + 1);
  if (target === undefined || !isSafeLink(target) || label === '') {
    // A link that must not open is its label, in plain text.
    return { node: { kind: 'text', text: label === '' ? '' : label }, next: targetEnd + 1 };
  }
  return { node: { kind: 'link', href: target, children }, next: targetEnd + 1 };
}

function bareLink(text: string, position: number): Taken | undefined {
  const previous = text[position - 1];
  if (previous !== undefined && /[\w[(]/.test(previous)) {
    return undefined;
  }
  const match = BARE_URL.exec(text.slice(position, position + 2_000));
  if (match === null) {
    return undefined;
  }
  // Closing punctuation after a link belongs to the sentence.
  const url = match[0].replace(/[.,;:!?)\]'"]+$/, '');
  if (!isSafeLink(url)) {
    return undefined;
  }
  return { node: { kind: 'link', href: url, children: [{ kind: 'text', text: url }] }, next: position + url.length };
}

function emphasis(text: string, position: number, character: '*' | '_' | '~', depth: number): Taken | undefined {
  const double = text[position + 1] === character;
  if (character === '~' && !double) {
    return undefined;
  }
  const width = double ? 2 : 1;
  const delimiter = character.repeat(width);
  const next = text[position + width];
  const previous = text[position - 1];
  if (next === undefined || /\s/.test(next)) {
    return undefined;
  }
  // An underscore inside a word (snake_case) is not emphasis.
  if (character === '_' && previous !== undefined && /\w/.test(previous)) {
    return undefined;
  }
  const close = findClose(text, delimiter, position + width, character);
  if (close === undefined) {
    return undefined;
  }
  const children = parseInline(text.slice(position + width, close), depth + 1);
  const end = close + width;
  if (character === '~') {
    return { node: { kind: 'strike', children }, next: end };
  }
  return { node: { kind: double ? 'strong' : 'emphasis', children }, next: end };
}

function findClose(text: string, delimiter: string, from: number, character: string): number | undefined {
  let cursor = from;
  while (cursor < text.length) {
    const found = text.indexOf(delimiter, cursor);
    if (found < 0 || found === from) {
      if (found === from) {
        cursor = found + 1;
        continue;
      }
      return undefined;
    }
    const before = text[found - 1] ?? '';
    const after = text[found + delimiter.length] ?? '';
    const run = delimiter.length === 1 && after === character; // "**" is not a single "*".
    const word = character === '_' && /\w/.test(after);
    if (!/\s/.test(before) && !run && !word && before !== character) {
      return found;
    }
    cursor = found + 1;
  }
  return undefined;
}

// --- Quick replies ---------------------------------------------------------------------------------------

export interface QuickReply {
  /** The number the option carries in the agent's list. */
  readonly number: number;
  readonly label: string;
}

/** An options list is at most this long, so a numbered log is not mistaken for choices. */
export const QUICK_REPLIES_MAX = 6;
/** One option is a short line. */
export const QUICK_REPLY_CHARS_MAX = 140;

/**
 * The options of a block of text that is only a numbered list ("1. Do X", "2) Do Y"), counting from 1 without
 * gaps: what an agent writes when it wants the person to choose. Anything else, including a longer or
 * unnumbered list, is not a set of choices and answers undefined.
 */
export function parseQuickReplies(text: string): readonly QuickReply[] | undefined {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length < 2 || lines.length > QUICK_REPLIES_MAX) {
    return undefined;
  }
  const replies: QuickReply[] = [];
  for (const line of lines) {
    const match = /^\s*(\d{1,2})[.)]\s+(\S.*)$/.exec(line);
    const number = match === null ? undefined : Number.parseInt(match[1] ?? '', 10);
    const label = match?.[2]?.trim();
    if (number === undefined || label === undefined || number !== replies.length + 1 || label.length > QUICK_REPLY_CHARS_MAX) {
      return undefined;
    }
    replies.push({ number, label });
  }
  assert(replies.length === lines.length, 'parseQuickReplies: one reply per line');
  return replies;
}

/** The text a chosen option sends: its number and words, so the agent cannot mistake which was meant. */
export function quickReplyText(reply: QuickReply): string {
  return `${reply.number}. ${reply.label}`;
}
