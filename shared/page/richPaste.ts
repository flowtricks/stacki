// What a paste brings into rich text, for both editors: the canvas editor (electron/preload/frameRichText.ts) and the
// Edit rich text dialog (src/ui/HtmlField.tsx). Pasted HTML keeps its structure and nothing else. Words and links go in
// where the caret is, with the browser's own command (its undo history keeps them); paragraphs, headings, lists,
// quotes and images are placed as blocks of their own (richBlockDom.ts), never inside the paragraph the caret is in.
// A line of words (content that may sit inside a <p>) takes blocks as lines.
/// <reference lib="dom" />
import { assert } from '../core/assert';
import { BOUNDARY_LIMITS } from '../core/boundary';
import { insertRichBlocks, isBlockElement, richCaret, type RichHistory } from './richBlockDom';

export interface RichPaste {
  readonly html: string;
  readonly text: string;
  /** ⇧⌘V: the words alone. */
  readonly plain: boolean;
}

export interface RichPasteTarget {
  readonly host: HTMLElement;
  readonly history: RichHistory;
  /** `rich` takes blocks; `line` is one line of words. */
  readonly kind: 'rich' | 'line';
  /** Whether images come along. Off for fields that keep text alone. */
  readonly media: boolean;
}

/** Puts a paste in at the caret. */
export function pasteRichText(target: RichPasteTarget, paste: RichPaste): void {
  const document = target.host.ownerDocument;
  const text = paste.text.slice(0, BOUNDARY_LIMITS.textLengthMax);
  const address = text.trim();
  const range = richCaret(target.host);
  assert(target.host.contains(range.commonAncestorContainer), 'The paste goes into the editor');
  if (!paste.plain && !range.collapsed && /^(?:https?:\/\/|mailto:|tel:)\S+$/i.test(address)) {
    document.execCommand('createLink', false, address);
    return;
  }
  const markup =
    !paste.plain && paste.html !== '' && paste.html.length <= BOUNDARY_LIMITS.textLengthMax
      ? cleanPastedHTML(paste.html, document, { media: target.media })
      : plainHTML(text);
  const holder = document.createElement('template');
  holder.innerHTML = markup;
  const nodes = Array.from(holder.content.childNodes).filter((node) => !(node instanceof Text && node.data.trim() === ''));
  const blocks = nodes.filter((node) => node instanceof Element && isBlockElement(node));
  const [only] = nodes;
  // One paragraph's words are words: they join the paragraph the caret is in.
  if (nodes.length === 1 && only instanceof Element && only.tagName === 'P') {
    document.execCommand('insertHTML', false, only.innerHTML);
    return;
  }
  if (blocks.length === 0) {
    document.execCommand('insertHTML', false, markup);
    return;
  }
  if (target.kind === 'line') {
    const lines = nodes.map((node) => (node instanceof Element && isBlockElement(node) ? node.innerHTML : wrapped(document, [node]).innerHTML));
    document.execCommand('insertHTML', false, lines.filter((line) => line !== '').join('<br>'));
    return;
  }
  const placed = asBlocks(document, nodes);
  target.history.record(() => insertRichBlocks(target.host, range, placed));
}

// Loose words between pasted blocks become paragraphs of their own.
function asBlocks(document: Document, nodes: readonly ChildNode[]): readonly Element[] {
  const blocks: Element[] = [];
  let run: ChildNode[] = [];
  const close = () => {
    if (run.length > 0) {
      blocks.push(wrapped(document, run, 'p'));
      run = [];
    }
  };
  for (const node of nodes) {
    if (node instanceof Element && isBlockElement(node)) {
      close();
      blocks.push(node);
    } else {
      run.push(node);
    }
  }
  close();
  assert(blocks.every(isBlockElement), 'Everything placed beside a block is a block');
  return blocks;
}

function wrapped(document: Document, nodes: readonly ChildNode[], tag = 'div'): Element {
  const element = document.createElement(tag);
  element.append(...nodes);
  return element;
}

// Plain text: one line is words; several are a paragraph each, blank lines only dividing them.
function plainHTML(text: string): string {
  const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  assert(!escaped.includes('<'), 'Pasted words hold no markup');
  const lines = escaped.split(/\r?\n/);
  if (lines.length === 1) {
    return escaped;
  }
  return lines
    .filter((line) => line.trim() !== '')
    .map((line) => `<p>${line}</p>`)
    .join('');
}

export function safeHTMLLink(value: string): boolean {
  const text = value.trim();
  if (/[\u0000-\u0020\u007f]/.test(text)) {
    return false;
  }
  return /^(?:https?:\/\/|mailto:|tel:|#|\/|\.\.?\/)/i.test(text);
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
export function cleanPastedHTML(html: string, document: Document, options: { readonly media?: boolean } = {}): string {
  assert(html.length <= BOUNDARY_LIMITS.textLengthMax, 'Rich text: paste limit exceeded');
  const template = document.createElement('template');
  template.innerHTML = html;
  const elements = Array.from(template.content.querySelectorAll('*')).reverse();
  assert(elements.length <= BOUNDARY_LIMITS.itemsMax, 'Rich text: paste element limit exceeded');
  // Innermost first, so an element is cleaned before the one around it moves it.
  for (const element of elements) {
    if (options.media === true && element.localName === 'img' && cleanPastedImage(element)) {
      continue;
    }
    cleanPastedElement(element, document);
  }
  const cleaned = template.innerHTML.replace(/<p>\s*<\/p>/g, '');
  assert(!/<script/i.test(cleaned), 'A cleaned paste holds no script');
  return cleaned;
}

// An image at a web or project address comes along with its words for those who cannot see it; any other (a data:
// URL the size of a file) is dropped with the rest.
function cleanPastedImage(element: Element): boolean {
  const source = element.getAttribute('src') ?? '';
  if (!/^(?:https?:\/\/|\/)/i.test(source)) {
    return false;
  }
  const alt = element.getAttribute('alt') ?? '';
  for (const attribute of Array.from(element.attributes)) {
    element.removeAttribute(attribute.name);
  }
  element.setAttribute('src', source);
  element.setAttribute('alt', alt);
  return true;
}

function cleanPastedElement(element: Element, document: Document): void {
  const tag = element.localName;
  if (PASTE_DROPS.has(tag)) {
    element.remove();
    return;
  }
  const renamed = PASTE_RENAMES[tag] ?? tag;
  if (!PASTE_TAGS.has(renamed)) {
    element.replaceWith(...Array.from(element.childNodes));
    return;
  }
  const href = element.getAttribute('href')?.trim() ?? '';
  // A link that could act (javascript:) or goes nowhere keeps only its text.
  if (tag === 'a' && !safeHTMLLink(href)) {
    element.replaceWith(...Array.from(element.childNodes));
    return;
  }
  const target = renamed === tag ? element : document.createElement(renamed);
  for (const attribute of Array.from(element.attributes)) {
    element.removeAttribute(attribute.name);
  }
  if (tag === 'a') {
    target.setAttribute('href', href);
  }
  if (target !== element) {
    target.append(...Array.from(element.childNodes));
    element.replaceWith(target);
  }
}
