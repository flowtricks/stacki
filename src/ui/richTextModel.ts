// The rich text editor's rules that need no live editor: the Markdown a person
// types and what it becomes, the markup a paste may bring in, and the counts
// shown under the text. HtmlField.tsx and richTextCommands.ts act on these.
import { assert } from '../../shared/core/assert';
import { BOUNDARY_LIMITS } from '../../shared/core/boundary';
import { safeHTMLLink } from './htmlFieldModel';

export const RICH_TEXT_LIMITS = {
  /** The longest run of text an inline shortcut (`**bold**`) wraps. */
  inlineCharsMax: 200,
  /** The longest block prefix (`######`, `1.`) a block shortcut reads. */
  prefixCharsMax: 6,
  /** The deepest nesting the HTML view indents; deeper markup stays on one line. */
  formatDepthMax: 32,
} as const;

/** The block kinds the editor writes, as their tags. */
export const BLOCKS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre'] as const;
export type Block = (typeof BLOCKS)[number];

/** What a line's typed prefix turns its block into. */
export type BlockShortcut =
  { readonly kind: 'block'; readonly block: Block } | { readonly kind: 'list'; readonly list: 'ul' | 'ol' } | { readonly kind: 'rule' };

/** An inline run typed in Markdown and the tag it becomes. */
export interface InlineShortcut {
  readonly tag: 'strong' | 'em' | 'code' | 's';
  /** The whole typed run, markers included, counted back from the caret. */
  readonly length: number;
  readonly text: string;
}

// A line's prefix, typed before a space, and what it makes.
const BLOCK_PREFIXES: Readonly<Record<string, BlockShortcut>> = {
  '#': { kind: 'block', block: 'h1' },
  '##': { kind: 'block', block: 'h2' },
  '###': { kind: 'block', block: 'h3' },
  '####': { kind: 'block', block: 'h4' },
  '#####': { kind: 'block', block: 'h5' },
  '######': { kind: 'block', block: 'h6' },
  '>': { kind: 'block', block: 'blockquote' },
  '```': { kind: 'block', block: 'pre' },
  '-': { kind: 'list', list: 'ul' },
  '*': { kind: 'list', list: 'ul' },
  '+': { kind: 'list', list: 'ul' },
  '1.': { kind: 'list', list: 'ol' },
  '1)': { kind: 'list', list: 'ol' },
};

/**
 * The block a paragraph becomes when its text so far is a Markdown prefix and
 * a space (`## `, `- `, `> `), or `---` for a rule. Anything else is text.
 */
export function blockShortcut(lineText: string): BlockShortcut | undefined {
  if (lineText === '---') {
    return { kind: 'rule' };
  }
  if (!lineText.endsWith(' ')) {
    return undefined;
  }
  const prefix = lineText.slice(0, -1);
  if (prefix.length > RICH_TEXT_LIMITS.prefixCharsMax) {
    return undefined;
  }
  return Object.hasOwn(BLOCK_PREFIXES, prefix) ? BLOCK_PREFIXES[prefix] : undefined;
}

// Longest markers first, so `**` is read as bold before `*` as italic.
const INLINE_PATTERNS: readonly (readonly [InlineShortcut['tag'], RegExp])[] = [
  ['strong', /\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/],
  ['s', /~~([^~\s](?:[^~]*[^~\s])?)~~$/],
  ['code', /`([^`]+)`$/],
  ['em', /(?:^|[^*\w])\*([^*\s](?:[^*]*[^*\s])?)\*$/],
  ['em', /(?:^|[^_\w])_([^_\s](?:[^_]*[^_\s])?)_$/],
];

/** The inline run the text before the caret closes (`**bold**`, `` `code` ``), if any. */
export function inlineShortcut(textBeforeCaret: string): InlineShortcut | undefined {
  const tail = textBeforeCaret.slice(-(RICH_TEXT_LIMITS.inlineCharsMax + 4));
  for (const [tag, pattern] of INLINE_PATTERNS) {
    const match = pattern.exec(tail);
    const text = match?.[1];
    if (match !== null && text !== undefined) {
      const marker = (match[0].length - text.length) / 2;
      // A leading character the pattern needed to see (a space) is not part of the run.
      const length = text.length + Math.floor(marker) * 2;
      assert(length <= match[0].length, 'An inline run is no longer than its match');
      return { tag, length, text };
    }
  }
  return undefined;
}

/** Words and characters in the text, as the field's footer shows them. */
export function textCounts(text: string): { readonly words: number; readonly characters: number } {
  assert(text.length <= BOUNDARY_LIMITS.textLengthMax, 'Rich text: text limit exceeded');
  const trimmed = text.trim();
  const words = trimmed === '' ? 0 : trimmed.split(/\s+/).length;
  assert(words <= text.length, 'There are never more words than characters');
  return { words, characters: text.replace(/\s/g, '').length };
}

/** Escapes text for insertion as HTML. */
export function escapeHTML(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// What a paste may keep, and what other tags become. Anything else is unwrapped
// to its text, so a page's styles, scripts and tracking never come along.
const PASTE_TAGS = new Set('p br strong em u s a h1 h2 h3 h4 h5 h6 ul ol li blockquote pre code hr sub sup'.split(' '));
const PASTE_RENAMES: Readonly<Record<string, string>> = {
  b: 'strong',
  i: 'em',
  strike: 's',
  del: 's',
  div: 'p',
};
const PASTE_DROPS = new Set('script style meta link title head template iframe object svg'.split(' '));

/**
 * Pasted HTML reduced to the document structure the editor writes: headings,
 * lists, quotes, emphasis and safe links keep their shape; classes, styles and
 * every other tag are dropped, keeping their text.
 */
export function cleanPastedHTML(html: string, document: Document): string {
  assert(html.length <= BOUNDARY_LIMITS.textLengthMax, 'Rich text: paste limit exceeded');
  const template = document.createElement('template');
  template.innerHTML = html;
  const elements = [...template.content.querySelectorAll('*')].reverse();
  assert(elements.length <= BOUNDARY_LIMITS.itemsMax, 'Rich text: paste element limit exceeded');
  // Innermost first, so an element is cleaned before the one around it moves it.
  for (const element of elements) {
    cleanPastedElement(element, document);
  }
  const cleaned = template.innerHTML.replace(/<p>\s*<\/p>/g, '');
  assert(!/<script/i.test(cleaned), 'A cleaned paste holds no script');
  return cleaned;
}

function cleanPastedElement(element: Element, document: Document): void {
  const tag = element.localName;
  if (PASTE_DROPS.has(tag)) {
    element.remove();
    return;
  }
  const renamed = PASTE_RENAMES[tag] ?? tag;
  if (!PASTE_TAGS.has(renamed)) {
    element.replaceWith(...element.childNodes);
    return;
  }
  const href = element.getAttribute('href')?.trim() ?? '';
  // A link that could act (javascript:) or goes nowhere keeps only its text.
  if (tag === 'a' && !safeHTMLLink(href)) {
    element.replaceWith(...element.childNodes);
    return;
  }
  const target = renamed === tag ? element : document.createElement(renamed);
  for (const attribute of [...element.attributes]) {
    element.removeAttribute(attribute.name);
  }
  if (tag === 'a') {
    target.setAttribute('href', href);
  }
  if (target !== element) {
    target.append(...element.childNodes);
    element.replaceWith(target);
  }
}

/**
 * The address a typed link stands for: a safe address as it is, an email as a
 * `mailto:` link, and a bare domain (`example.com/about`) as https. Anything
 * else is not a link.
 */
export function linkAddress(typed: string): string | undefined {
  const text = typed.trim();
  if (text === '' || text.length > BOUNDARY_LIMITS.textLengthMax) {
    return undefined;
  }
  if (safeHTMLLink(text)) {
    return text;
  }
  if (/^[^\s@/]+@[^\s@/]+\.[a-z]{2,}$/i.test(text)) {
    return `mailto:${text}`;
  }
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?$/i.test(text)) {
    return `https://${text}`;
  }
  return undefined;
}

// Elements that start their own line in the HTML view.
const LINE_TAGS = new Set(('p div h1 h2 h3 h4 h5 h6 ul ol li blockquote pre hr table thead tbody tfoot tr td th ' + 'caption figure figcaption').split(' '));

/**
 * Rich text HTML laid out to read, the way Prettier lays out a page: every
 * block on its own line, nested blocks indented two spaces, and the text of a
 * paragraph kept whole on its line. Only whitespace between blocks changes, so
 * the page renders the same.
 */
export function formatHTML(html: string, document: Document): string {
  assert(html.length <= BOUNDARY_LIMITS.textLengthMax, 'Rich text: text limit exceeded');
  const template = document.createElement('template');
  template.innerHTML = html;
  const lines = formatChildren(template.content, 0);
  const formatted = lines.join('\n');
  assert(!formatted.startsWith(' '), 'The top level is not indented');
  return formatted;
}

// The lines a node's children make, at a depth of indentation.
function formatChildren(parent: ParentNode, depth: number): string[] {
  const lines: string[] = [];
  let inline = '';
  const flush = (): void => {
    if (inline.trim() !== '') {
      lines.push('  '.repeat(depth) + inline.trim());
    }
    inline = '';
  };
  for (const node of parent.childNodes) {
    if (isElement(node) && LINE_TAGS.has(node.localName)) {
      flush();
      lines.push(...formatBlock(node, depth));
    } else {
      inline += serializeInline(node);
    }
  }
  flush();
  return lines;
}

// A block on one line, or, holding blocks of its own, opened and closed around them.
function formatBlock(element: Element, depth: number): string[] {
  const indent = '  '.repeat(depth);
  const nested = [...element.children].some((child) => LINE_TAGS.has(child.localName));
  if (!nested || element.localName === 'pre' || depth >= RICH_TEXT_LIMITS.formatDepthMax) {
    return [indent + element.outerHTML];
  }
  const open = element.outerHTML.slice(0, element.outerHTML.indexOf('>') + 1);
  return [indent + open, ...formatChildren(element, depth + 1), `${indent}</${element.localName}>`];
}

function serializeInline(node: ChildNode): string {
  if (isElement(node)) {
    return node.outerHTML;
  }
  if (node.nodeType === node.TEXT_NODE) {
    // Whitespace between blocks is layout; inside a line it is one space.
    return escapeText(node.textContent ?? '').replace(/\s+/g, ' ');
  }
  return '';
}

function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\u00a0/g, '&nbsp;');
}

// By node type rather than `instanceof`, which fails for a node from another
// document's realm (a test's JSDOM window).
function isElement(node: Node): node is Element {
  return node.nodeType === node.ELEMENT_NODE;
}
