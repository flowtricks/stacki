// The rich text editor's HTML written back as Markdown (markdownBlocks.ts reads
// it). The editor shows every block of the body as one element; each element it
// still shows exactly as it was rendered is written as that block's own bytes,
// with the blank lines that stood before it. Only the blocks the person changed,
// added or typed into are printed, in the style the rest of the document uses:
// its bullet, fence, emphasis marker, paragraph width and link spellings.
//
// Matching is by the element's HTML: the blocks as rendered and the elements as
// edited are both serialised by the same DOM, so an untouched block compares
// equal however the editor treated its neighbours. The longest common subsequence
// pairs them, so a block moved, inserted or removed leaves the others matched.
import { assert } from '../../shared/core/assert';
import { KEPT_CLASS, printDocument, type MarkdownDocument, type MarkdownItem, type MarkdownStyle } from './markdownBlocks';

export const MARKDOWN_WRITE_LIMITS = {
  /** The most block pairs the matcher compares; past it, only the unchanged ends match. */
  matchCellsMax: 4_000_000,
  /** How deep elements nest before their text is written plainly. */
  depthMax: 24,
} as const;

/** The edited HTML as Markdown, keeping every unchanged block of `base` byte for byte. */
export function markdownFromHTML(html: string, base: MarkdownDocument, document: Document): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const units = unitsOf([...template.content.childNodes]);
  const originals = base.blocks.map((placed) => normalizedHTML(placed.block.html, document));
  const matches = matchBlocks(
    originals,
    units.map((unit) => unit.key),
  );
  const writer: Writer = { style: base.style, items: reusableItems(base, document) };
  let markdown = base.lead;
  let previous: number | undefined;
  let written = 0;
  for (const [at, unit] of units.entries()) {
    const original = matches.get(at);
    const placed = original === undefined ? undefined : base.blocks[original];
    const text = placed === undefined ? writeUnit(unit, writer, 0) : placed.block.source;
    if (text === '') {
      continue;
    }
    // Two blocks that stood together keep the lines between them; anything else is one blank line.
    const together = placed !== undefined && original !== undefined && previous !== undefined && original === previous + 1;
    const gap = written === 0 ? '' : together ? placed.gap : '\n\n';
    markdown += gap + text;
    previous = original;
    written += 1;
  }
  const result = markdown + (base.blocks.length > 0 ? base.trail : written > 0 ? '\n' : '');
  assert(written > 0 || result.trim() === '', 'A body with no blocks writes no text');
  if (matches.size === base.blocks.length && matches.size === units.length) {
    assert(result === printDocument(base), 'An unchanged body writes back byte for byte');
  }
  return result;
}

/** HTML as the DOM serialises it, so rendered and edited blocks compare alike. */
export function normalizedHTML(html: string, document: Document): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.innerHTML;
}

// ---------------------------------------------------------------------------
// Units and matching
// ---------------------------------------------------------------------------

/** A top-level block element, or a run of loose inline content read as a paragraph. */
type Unit =
  | { readonly kind: 'block'; readonly element: Element; readonly key: string }
  | { readonly kind: 'inline'; readonly nodes: readonly Node[]; readonly key: string };

const BLOCK_TAGS = new Set('p div h1 h2 h3 h4 h5 h6 ul ol li blockquote pre hr table figure'.split(' '));

function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

function isText(node: Node): node is Text {
  return node.nodeType === 3;
}

function unitsOf(nodes: readonly Node[]): readonly Unit[] {
  const units: Unit[] = [];
  let inline: Node[] = [];
  const flush = (): void => {
    if (inline.some((node) => !isText(node) || node.data.trim() !== '')) {
      // An inline run never matches a block: the key cannot be an element's HTML.
      units.push({ kind: 'inline', nodes: inline, key: `\u0000${inline.map((node) => node.textContent ?? '').join('')}` });
    }
    inline = [];
  };
  for (const node of nodes) {
    if (isElement(node) && BLOCK_TAGS.has(node.localName)) {
      flush();
      units.push({ kind: 'block', element: node, key: node.outerHTML });
    } else if (isElement(node) || isText(node)) {
      inline.push(node);
    }
  }
  flush();
  assert(units.length <= nodes.length, 'Units never outnumber the nodes they group');
  return units;
}

/** Which original block each edited unit is, by the longest common subsequence. */
function matchBlocks(originals: readonly string[], edited: readonly string[]): ReadonlyMap<number, number> {
  const matches = new Map<number, number>();
  let head = 0;
  while (head < originals.length && head < edited.length && originals[head] === edited[head]) {
    matches.set(head, head);
    head += 1;
  }
  let tail = 0;
  while (tail < originals.length - head && tail < edited.length - head && originals[originals.length - 1 - tail] === edited[edited.length - 1 - tail]) {
    matches.set(edited.length - 1 - tail, originals.length - 1 - tail);
    tail += 1;
  }
  const middleOriginals = originals.slice(head, originals.length - tail);
  const middleEdited = edited.slice(head, edited.length - tail);
  if (middleOriginals.length * middleEdited.length <= MARKDOWN_WRITE_LIMITS.matchCellsMax) {
    for (const [editedAt, originalAt] of longestCommon(middleOriginals, middleEdited)) {
      matches.set(head + editedAt, head + originalAt);
    }
  }
  assert(matches.size <= Math.min(originals.length, edited.length), 'Each block matches at most once');
  return matches;
}

// Pairs (edited index, original index) of a longest common subsequence.
function longestCommon(originals: readonly string[], edited: readonly string[]): readonly (readonly [number, number])[] {
  const rows = originals.length + 1;
  const columns = edited.length + 1;
  const lengths = new Uint32Array(rows * columns);
  for (let i = originals.length - 1; i >= 0; i -= 1) {
    for (let j = edited.length - 1; j >= 0; j -= 1) {
      lengths[i * columns + j] =
        originals[i] === edited[j]
          ? (lengths[(i + 1) * columns + j + 1] ?? 0) + 1
          : Math.max(lengths[(i + 1) * columns + j] ?? 0, lengths[i * columns + j + 1] ?? 0);
    }
  }
  const pairs: (readonly [number, number])[] = [];
  let i = 0;
  let j = 0;
  while (i < originals.length && j < edited.length) {
    if (originals[i] === edited[j]) {
      pairs.push([j, i]);
      i += 1;
      j += 1;
    } else if ((lengths[(i + 1) * columns + j] ?? 0) >= (lengths[i * columns + j + 1] ?? 0)) {
      i += 1;
    } else {
      j += 1;
    }
  }
  assert(pairs.length <= Math.min(originals.length, edited.length), 'A common subsequence is no longer than either side');
  return pairs;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

interface Writer {
  readonly style: MarkdownStyle;
  /** A top-level list item's HTML → its own lines, reused where the item is unchanged. */
  readonly items: ReadonlyMap<string, MarkdownItem>;
}

function reusableItems(base: MarkdownDocument, document: Document): ReadonlyMap<string, MarkdownItem> {
  const items = new Map<string, MarkdownItem>();
  for (const placed of base.blocks) {
    for (const item of placed.block.items) {
      const key = normalizedHTML(item.html, document);
      if (!items.has(key)) {
        items.set(key, item);
      }
    }
  }
  return items;
}

function writeUnit(unit: Unit, writer: Writer, depth: number): string {
  switch (unit.kind) {
    case 'inline':
      return paragraphMarkdown(unit.nodes, writer.style, 0);
    case 'block':
      return blockMarkdown(unit.element, writer, depth);
    default: {
      const exhaustive: never = unit;
      return exhaustive;
    }
  }
}

function blockMarkdown(element: Element, writer: Writer, depth: number): string {
  const children = [...element.childNodes];
  if (depth > MARKDOWN_WRITE_LIMITS.depthMax) {
    return paragraphText(escapeText(collapse(element.textContent ?? '')), writer.style, 0);
  }
  switch (element.localName) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return headingMarkdown(element, writer.style);
    case 'pre':
      return codeMarkdown(element, writer.style);
    case 'blockquote':
      return quoteMarkdown(children, writer, depth);
    case 'ul':
    case 'ol':
      return listMarkdown(element, writer, depth);
    case 'hr':
      return writer.style.rule;
    default:
      // A paragraph, or a `div` the editor made: holding blocks, it is written as them.
      if (children.some((child) => isElement(child) && BLOCK_TAGS.has(child.localName))) {
        return blocksMarkdown(children, writer, depth + 1);
      }
      return paragraphMarkdown(children, writer.style, 0);
  }
}

function blocksMarkdown(nodes: readonly Node[], writer: Writer, depth: number): string {
  return unitsOf(nodes)
    .map((unit) => writeUnit(unit, writer, depth))
    .filter((text) => text !== '')
    .join('\n\n');
}

function headingMarkdown(element: Element, style: MarkdownStyle): string {
  const level = Number.parseInt(element.localName.slice(1), 10);
  assert(level >= 1, 'A heading is level one or deeper');
  assert(level <= 6, 'A heading is level six or shallower');
  const text = inlineMarkdown([...element.childNodes], style, 0)
    .replace(/\s*\n\s*/g, ' ')
    .trim();
  if (text === '') {
    return '';
  }
  if (style.setext && level <= 2) {
    return `${text}\n${(level === 1 ? '=' : '-').repeat(Math.max(3, Math.min(text.length, 80)))}`;
  }
  return `${'#'.repeat(level)} ${text}`;
}

// A kept block is its own source again; a code block is fenced in the document's fence.
function codeMarkdown(element: Element, style: MarkdownStyle): string {
  const text = codeText(element).replace(/\n$/, '');
  if (element.classList.contains(KEPT_CLASS)) {
    return text;
  }
  const code = element.querySelector('code');
  const language = /(?:^|\s)language-([\w#+.-]+)/.exec(`${code?.getAttribute('class') ?? ''} ${element.getAttribute('class') ?? ''}`)?.[1];
  const info = language === undefined ? '' : (style.infos.get(language) ?? language);
  const longest = Math.max(0, ...[...text.matchAll(style.fence === '`' ? /`+/g : /~+/g)].map((match) => match[0].length));
  const fence = style.fence.repeat(Math.max(3, longest + 1));
  return text === '' ? `${fence}${info}\n${fence}` : `${fence}${info}\n${text}\n${fence}`;
}

// The text of a code block, with the line breaks the editor wrote as elements.
function codeText(node: Node, depth = 0): string {
  if (depth > MARKDOWN_WRITE_LIMITS.depthMax) {
    return node.textContent ?? '';
  }
  let text = '';
  for (const child of node.childNodes) {
    if (isText(child)) {
      text += child.data;
    } else if (isElement(child) && child.localName === 'br') {
      text += '\n';
    } else if (isElement(child)) {
      const inner = codeText(child, depth + 1);
      if ((child.localName === 'div' || child.localName === 'p') && text !== '' && !text.endsWith('\n')) {
        text += '\n';
      }
      text += inner;
    }
  }
  return text;
}

function quoteMarkdown(children: readonly Node[], writer: Writer, depth: number): string {
  const inner = blocksMarkdown(children, writer, depth + 1);
  if (inner === '') {
    return '';
  }
  return inner
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}

function listMarkdown(list: Element, writer: Writer, depth: number): string {
  const { style } = writer;
  const ordered = list.localName === 'ol';
  const start = ordered ? Number.parseInt(list.getAttribute('start') ?? '1', 10) : 1;
  const first = Number.isSafeInteger(start) && start >= 0 ? start : 1;
  const items = [...list.children];
  const loose = items.some((item) => [...item.children].some((child) => child.localName === 'p'));
  const written = items.map((item, at) => {
    const marker = ordered ? `${first + at}${style.delimiter} ` : `${style.bullet} `;
    const reused = depth === 0 ? reusedItem(item.outerHTML, marker, writer) : undefined;
    return reused ?? itemMarkdown(item, marker, writer, depth);
  });
  assert(written.length === items.length, 'Every item is written');
  return written.join(loose ? '\n\n' : '\n');
}

// An unchanged top-level item keeps its lines, when its marker is the one it would get.
function reusedItem(html: string, marker: string, writer: Writer): string | undefined {
  const item = writer.items.get(html);
  if (item === undefined) {
    return undefined;
  }
  const written = item.source.trimStart();
  return written.startsWith(marker.trimEnd()) && item.source.length - written.length === 0 ? item.source : undefined;
}

function itemMarkdown(item: Element, marker: string, writer: Writer, depth: number): string {
  const indent = ' '.repeat(marker.length);
  const children = item.localName === 'li' ? [...item.childNodes] : [item];
  const loose = [...item.children].some((child) => child.localName === 'p');
  const parts = unitsOf(children)
    .map((unit) => (unit.kind === 'inline' ? paragraphMarkdown(unit.nodes, writer.style, marker.length) : blockMarkdown(unit.element, writer, depth + 1)))
    .filter((text) => text !== '');
  if (parts.length === 0) {
    return marker.trimEnd();
  }
  const body = parts.join(loose ? '\n\n' : '\n');
  return body
    .split('\n')
    .map((line, at) => (at === 0 ? marker + line : line === '' ? '' : indent + line))
    .join('\n');
}

// ---------------------------------------------------------------------------
// Paragraphs and inline text
// ---------------------------------------------------------------------------

function paragraphMarkdown(nodes: readonly Node[], style: MarkdownStyle, indent: number): string {
  return paragraphText(inlineMarkdown(nodes, style, 0), style, indent);
}

// Inline Markdown laid out as a paragraph: hard breaks kept, wrapped as the document wraps.
function paragraphText(inline: string, style: MarkdownStyle, indent: number): string {
  const segments = inline.split('\n').map((segment) => segment.trim());
  while (segments.length > 0 && segments[segments.length - 1] === '') {
    segments.pop();
  }
  while (segments.length > 0 && segments[0] === '') {
    segments.shift();
  }
  if (segments.length === 0) {
    return '';
  }
  const width = style.wrapColumns === undefined ? undefined : Math.max(20, style.wrapColumns - indent);
  const lines = segments.map((segment) => wrapLine(segment, width).map(escapeLineStart).join('\n'));
  return lines.join('\\\n');
}

// A word that would start a block at the start of a line.
const BLOCK_WORD = /^(?:#{1,6}|[-+*]|\d{1,9}[.)]|=+|-+|>.*|`{3,}.*|~{3,}.*)$/;

function escapeLineStart(line: string): string {
  const word = line.split(' ')[0] ?? '';
  if (!BLOCK_WORD.test(word)) {
    return line;
  }
  const ordered = /^(\d{1,9})([.)])/.exec(line);
  return ordered === null ? `\\${line}` : `${ordered[1] ?? ''}\\${line.slice((ordered[1] ?? '').length)}`;
}

// Greedy wrapping at spaces; never before a word that would start a block.
function wrapLine(text: string, width: number | undefined): readonly string[] {
  if (width === undefined || text.length <= width) {
    return [text];
  }
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line === '') {
      line = word;
    } else if (line.length + 1 + word.length <= width || BLOCK_WORD.test(word)) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  lines.push(line);
  assert(lines.join(' ') === text, 'Wrapping only turns spaces into line breaks');
  return lines;
}

function collapse(text: string): string {
  return text.replace(/[\s\u00a0]+/g, ' ');
}

// Text as Markdown reads it literally: every character that would format is escaped.
function escapeText(text: string): string {
  return text
    .replace(/\\(?=[!-/:-@[-`{-~])/g, '\\\\')
    .replace(/[*`[\]]/g, '\\$&')
    .replace(/~(?=~)/g, '\\~')
    .replace(/<(?=[A-Za-z/!?])/g, '\\<')
    .replace(/&(?=#?[A-Za-z0-9]+;)/g, '\\&')
    .replace(/(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/g, '\\_');
}

const RAW_TAGS = new Set('u sub sup mark small kbd'.split(' '));

function inlineMarkdown(nodes: readonly Node[], style: MarkdownStyle, depth: number): string {
  let text = '';
  for (const [at, node] of nodes.entries()) {
    const next = nodes[at + 1]?.textContent ?? '';
    text += inlineNode(node, style, { depth, before: text.slice(-1), after: next.slice(0, 1) });
  }
  return text;
}

interface InlinePlace {
  readonly depth: number;
  /** The characters either side, which decide whether `_` can mark a word part. */
  readonly before: string;
  readonly after: string;
}

function inlineNode(node: Node, style: MarkdownStyle, place: InlinePlace): string {
  if (isText(node)) {
    return escapeText(collapse(node.data));
  }
  if (!isElement(node)) {
    return '';
  }
  if (place.depth > MARKDOWN_WRITE_LIMITS.depthMax) {
    return escapeText(collapse(node.textContent ?? ''));
  }
  const children = [...node.childNodes];
  const inner = (): string => inlineMarkdown(children, style, place.depth + 1);
  const inWord = /[A-Za-z0-9]/.test(place.before) || /[A-Za-z0-9]/.test(place.after);
  switch (node.localName) {
    case 'strong':
    case 'b':
      return wrapMark(inner(), style.strong === '__' && inWord ? '**' : style.strong);
    case 'em':
    case 'i':
      return wrapMark(inner(), style.emphasis === '_' && inWord ? '*' : style.emphasis);
    case 's':
    case 'strike':
    case 'del':
      return wrapMark(inner(), '~~');
    case 'code':
      return codeSpan(node.textContent ?? '');
    case 'a':
      return linkMarkdown(node, inner(), style);
    case 'img':
      return imageMarkdown(node, style);
    case 'br':
      return '\n';
    default:
      if (RAW_TAGS.has(node.localName)) {
        return `<${node.localName}>${inner()}</${node.localName}>`;
      }
      return BLOCK_TAGS.has(node.localName) ? `${inner()}\n` : inner();
  }
}

// Marks hug their text: spaces inside the element are written outside the markers.
function wrapMark(inner: string, marker: string): string {
  const core = inner.trim();
  if (core === '') {
    return inner;
  }
  const leading = inner.slice(0, inner.length - inner.trimStart().length);
  const trailing = inner.slice(inner.trimEnd().length);
  return `${leading}${marker}${core}${marker}${trailing}`;
}

function codeSpan(raw: string): string {
  const code = raw.replace(/\n/g, ' ');
  if (code === '') {
    return '';
  }
  const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map((match) => match[0].length));
  const ticks = '`'.repeat(longest + 1);
  const pad = code.startsWith('`') || code.endsWith('`') || (code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') ? ' ' : '';
  return `${ticks}${pad}${code}${pad}${ticks}`;
}

function destination(address: string): string {
  const balanced = (address.match(/\(/g) ?? []).length === (address.match(/\)/g) ?? []).length;
  return /[\s<>]/.test(address) || !balanced ? `<${address.replace(/[<>]/g, (character) => `\\${character}`)}>` : address;
}

function titlePart(element: Element): string {
  const title = element.getAttribute('title');
  return title === null || title === '' ? '' : ` "${title.replace(/(["\\])/g, '\\$1')}"`;
}

function linkMarkdown(element: Element, inner: string, style: MarkdownStyle): string {
  const href = element.getAttribute('href') ?? '';
  const text = element.textContent ?? '';
  if (inner.trim() === '') {
    return inner;
  }
  if (href === '') {
    return inner;
  }
  const address = style.addresses.get(href) ?? href;
  if (style.autolinks.has(href)) {
    if (text === href) {
      return `<${href}>`;
    }
    if (`mailto:${text}` === href) {
      return `<${text}>`;
    }
  }
  const label = style.references.get(address);
  if (label !== undefined && titlePart(element) === '') {
    return `[${inner}][${label}]`;
  }
  return `[${inner}](${destination(address)}${titlePart(element)})`;
}

function imageMarkdown(element: Element, style: MarkdownStyle): string {
  const source = element.getAttribute('src') ?? '';
  if (source === '') {
    return '';
  }
  const alt = (element.getAttribute('alt') ?? '').replace(/([[\]\\])/g, '\\$1');
  return `![${alt}](${destination(style.addresses.get(source) ?? source)}${titlePart(element)})`;
}
