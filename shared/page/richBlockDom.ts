// How blocks go into rich text, for both editors: the canvas editor (electron/preload/frameRichText.ts) and the Edit
// rich text dialog (src/ui/HtmlField.tsx). The browser's own `insertHTML` cannot be used for this: in a contenteditable
// it nests an image, a rule or a list inside the paragraph the caret is in, and merges the paragraph that follows into
// it with `style` attributes of its own. So a block is placed by moving whole nodes: it becomes a sibling of the
// caret's block, replacing an empty one and splitting one the caret is inside. The nodes that stay are never rewritten,
// so the browser's own undo history still applies to them.
//
// These functions need the DOM's types, which the rest of shared/ does not: only the two editors import this file.
/// <reference lib="dom" />
import { assert } from '../core/assert';

/** Walks and collections here are bounded. */
const RICH_DOM_LIMITS = { depthMax: 64, nodesMax: 20_000, historyMax: 200 } as const;

/** Elements that are blocks of their own: none of them may sit inside a paragraph, a heading or a code block. */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'P',
  'DIV',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'UL',
  'OL',
  'BLOCKQUOTE',
  'PRE',
  'HR',
  'TABLE',
  'FIGURE',
  'FIGCAPTION',
]);
/** Blocks that hold words only. */
const PHRASING_BLOCKS: ReadonlySet<string> = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE']);
/** Blocks the caret can be typed into. */
const TYPING_BLOCKS: ReadonlySet<string> = new Set([...PHRASING_BLOCKS, 'BLOCKQUOTE', 'UL', 'OL']);
/** What counts as content in a block that has no words. */
const CONTENT_SELECTOR = 'img, video, hr, table, iframe';
const MEDIA_TAGS: ReadonlySet<string> = new Set(['IMG', 'VIDEO', 'HR', 'TABLE', 'IFRAME']);

export function isBlockElement(node: Node): boolean {
  return node instanceof Element && (BLOCK_TAGS.has(node.tagName) || node.tagName === 'IMG' || node.tagName === 'VIDEO');
}

// Whether a node shows nothing: no words, no image, rule or video. A lone `<br>` holds a caret line open and shows nothing.
function isBlank(node: Node): boolean {
  if (node instanceof Element) {
    return !MEDIA_TAGS.has(node.tagName) && (node.textContent ?? '').replaceAll('​', '').trim() === '' && node.querySelector(CONTENT_SELECTOR) === null;
  }
  return (node.textContent ?? '').trim() === '';
}

/** One change of the editor's top level blocks, which the browser's undo history does not know: kept to take back. */
export interface RichHistory {
  /** Runs `change`, which may add, remove and replace the host's children but never edits a child it keeps. */
  readonly record: (change: () => void) => void;
  /** Takes the latest change back, once everything typed since has been undone. False: the undo is the browser's. */
  readonly undo: () => boolean;
  readonly redo: () => boolean;
}

interface Snapshot {
  readonly nodes: readonly ChildNode[];
  readonly html: string;
  readonly caret: Range | undefined;
}

export function createRichHistory(host: HTMLElement): RichHistory {
  const done: { readonly before: Snapshot; readonly after: Snapshot }[] = [];
  const undone: { readonly before: Snapshot; readonly after: Snapshot }[] = [];
  const take = (): Snapshot => {
    const selection = host.ownerDocument.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
    const inside = range !== undefined && host.contains(range.commonAncestorContainer);
    return { nodes: Array.from(host.childNodes), html: host.innerHTML, caret: inside ? range.cloneRange() : undefined };
  };
  const restore = (snapshot: Snapshot): void => {
    host.replaceChildren(...snapshot.nodes);
    if (snapshot.caret !== undefined) {
      const selection = host.ownerDocument.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(snapshot.caret.cloneRange());
    }
  };
  return {
    record: (change) => {
      const before = take();
      change();
      done.push({ before, after: take() });
      undone.length = 0;
      if (done.length > RICH_DOM_LIMITS.historyMax) {
        done.shift();
      }
    },
    undo: () => {
      const entry = done.at(-1);
      if (entry === undefined || host.innerHTML !== entry.after.html) {
        return false;
      }
      done.pop();
      undone.push(entry);
      restore(entry.before);
      return true;
    },
    redo: () => {
      const entry = undone.at(-1);
      if (entry === undefined || host.innerHTML !== entry.before.html) {
        return false;
      }
      undone.pop();
      done.push(entry);
      restore(entry.after);
      return true;
    },
  };
}

const histories = new WeakMap<HTMLElement, RichHistory>();

/** The one history of an editor that outlives its edits (the dialog's field): made on first use. */
export function richHistoryOf(host: HTMLElement): RichHistory {
  const history = histories.get(host) ?? createRichHistory(host);
  histories.set(host, history);
  return history;
}

/** A horizontal rule, an image or a video as the editors write it. */
export function richElement(document: Document, kind: 'img' | 'video' | 'hr' | 'ul' | 'ol', address = ''): Element {
  const element = document.createElement(kind);
  if (kind === 'img') {
    element.setAttribute('src', address);
    element.setAttribute('alt', '');
  } else if (kind === 'video') {
    element.setAttribute('src', address);
    element.setAttribute('controls', '');
  } else if (kind !== 'hr') {
    const item = document.createElement('li');
    item.append(document.createElement('br'));
    element.append(item);
  }
  return element;
}

/** The editor's caret, or the end of its content when the selection is elsewhere. */
export function richCaret(host: HTMLElement): Range {
  const selection = host.ownerDocument.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
  if (range !== undefined && host.contains(range.commonAncestorContainer)) {
    return range.cloneRange();
  }
  const end = host.ownerDocument.createRange();
  end.selectNodeContents(host);
  end.collapse(false);
  return end;
}

/**
 * The content as it is saved: without empty paragraphs at its end, which show nothing on the page (the line the editor
 * keeps open after an image, or after Enter).
 */
export function withoutTrailingEmptyBlocks(html: string): string {
  let result = html;
  for (let step = 0; step < RICH_DOM_LIMITS.nodesMax; step++) {
    const next = result.replace(/\s*<(p|h[1-6]|blockquote|pre)(?:\s[^<>]*)?>(?:\s|&nbsp;|<br\s*\/?>)*<\/\1>\s*$/, '');
    if (next === result) {
      break;
    }
    result = next;
  }
  assert(result.length <= html.length, 'Trimming never adds content');
  return result;
}

/** On the empty paragraph made to go on typing after an image, a video or a rule: while still empty it is not saved. */
const SPARE_LINE = 'data-avb-line';

/** Whether a child of the editor is a line made for typing that nothing was typed into. */
export function isSpareRichLine(node: Node): boolean {
  return node instanceof Element && node.hasAttribute(SPARE_LINE) && isBlank(node);
}

/**
 * Puts `blocks` into `host`, the element whose children are the content's blocks, at `range`: before the caret's block
 * when the caret is at its start, after it at its end, in place of an empty one, and between the two halves of one the
 * caret is inside (a list splits between its items, or inside the one the caret is in). A selection is replaced. The
 * caret ends where typing goes on: inside the last block when it holds words or an empty list item, else in the block
 * after it, an empty paragraph made for it when there is none.
 */
export function insertRichBlocks(host: HTMLElement, range: Range, blocks: readonly Element[]): void {
  assert(blocks.length > 0, 'There is a block to insert');
  assert(host.contains(range.commonAncestorContainer), 'The caret is in the editor');
  const document = host.ownerDocument;
  const start = topPosition(host, range.startContainer, range.startOffset);
  const end = topPosition(host, range.endContainer, range.endOffset);
  let from = start.index;
  let to = end.top === undefined ? end.index : end.index + 1;
  const head = start.top === undefined ? undefined : halfOf(document, [host, start.index], [range.startContainer, range.startOffset], 'head');
  const tail = end.top === undefined ? undefined : halfOf(document, [range.endContainer, range.endOffset], [host, end.index + 1], 'tail');
  // An empty line the blocks take the place of: after an image, one is left to go on typing in.
  const replacesLine = start.top !== undefined && start.top === end.top && isBlank(start.top);
  const kept: Node[] = [];
  const after: Node[] = [];
  // A block the caret is only at the edge of stays as it is, the new blocks beside it.
  if (start.top !== undefined && head === undefined && tail !== undefined && range.collapsed) {
    to = from;
  } else if (end.top !== undefined && tail === undefined && head !== undefined && range.collapsed) {
    from = to;
  } else {
    if (head !== undefined) {
      kept.push(head);
    }
    if (tail !== undefined) {
      after.push(tail);
    }
  }
  const removed = Array.from(host.childNodes).slice(from, to);
  const next = host.childNodes[to];
  removed.forEach((node) => node.remove());
  const added = [...kept, ...blocks, ...after];
  for (const node of added) {
    if (next === undefined) {
      host.append(node);
    } else {
      host.insertBefore(node, next);
    }
  }
  const last = blocks.at(-1);
  assert(last !== undefined, 'There is a last block');
  placeCaretAfter(host, last, { newLine: replacesLine });
}

// The host's child a position is in, with its index; or, for a position between children (or in the whitespace between
// blocks), the index it is at.
function topPosition(host: HTMLElement, container: Node, offset: number): { readonly top: Element | undefined; readonly index: number } {
  const children = Array.from(host.childNodes);
  if (container === host) {
    return { top: undefined, index: Math.min(offset, children.length) };
  }
  let node: Node = container;
  for (let depth = 0; node.parentNode !== host && node.parentNode !== null && depth < RICH_DOM_LIMITS.depthMax; depth++) {
    node = node.parentNode;
  }
  const index = children.findIndex((child) => child === node);
  assert(index >= 0, 'The position is inside the editor');
  return node instanceof Element ? { top: node, index } : { top: undefined, index: offset > 0 ? index + 1 : index };
}

// A copy of the part of a block before or after a position, without what shows nothing at the cut (an empty list item,
// an emptied inline element); undefined when nothing is left of it.
function halfOf(document: Document, start: readonly [Node, number], end: readonly [Node, number], side: 'head' | 'tail'): Element | undefined {
  const range = document.createRange();
  range.setStart(start[0], start[1]);
  range.setEnd(end[0], end[1]);
  const part = range.cloneContents().firstElementChild ?? undefined;
  if (part === undefined || isBlank(part)) {
    return undefined;
  }
  let edge: Element | undefined = part;
  for (let depth = 0; edge !== undefined && depth < RICH_DOM_LIMITS.depthMax; depth++) {
    let child: ChildNode | undefined = (side === 'head' ? edge.lastChild : edge.firstChild) ?? undefined;
    for (
      let step = 0;
      child !== undefined && isBlank(child) && !(child instanceof Element && child.tagName === 'BR') && step < RICH_DOM_LIMITS.nodesMax;
      step++
    ) {
      child.remove();
      child = (side === 'head' ? edge.lastChild : edge.firstChild) ?? undefined;
    }
    edge = child instanceof Element ? child : undefined;
  }
  return part;
}

function placeCaretAfter(host: HTMLElement, block: Element, options: { readonly newLine: boolean }): void {
  const document = host.ownerDocument;
  const items = block.querySelectorAll('li');
  const own = MEDIA_TAGS.has(block.tagName) ? undefined : (items[items.length - 1] ?? block);
  if (own !== undefined) {
    collapseAt(own, own.querySelector('br') !== null && isBlank(own) ? 0 : own.childNodes.length);
    return;
  }
  let following = block.nextElementSibling ?? undefined;
  if (options.newLine || following === undefined || !TYPING_BLOCKS.has(following.tagName)) {
    following = document.createElement('p');
    following.setAttribute(SPARE_LINE, '');
    following.append(document.createElement('br'));
    block.after(following);
  }
  collapseAt(following.querySelector('li') ?? following, 0);
}

function collapseAt(node: Node, offset: number): void {
  const document = node.ownerDocument;
  assert(document !== null, 'A node in the editor has a document');
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/**
 * Enter at the end of a quote goes on as a paragraph, as after a heading; the browser would start a second quote.
 * True when it did that, and the key is spent. A quote holding paragraphs or a list keeps the browser's own Enter.
 */
export function leaveQuoteOnEnter(host: HTMLElement, history: RichHistory): boolean {
  const selection = host.ownerDocument.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
  if (range === undefined || !range.collapsed || !host.contains(range.startContainer)) {
    return false;
  }
  const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const quote = start?.closest('blockquote') ?? undefined;
  if (quote === undefined || quote.parentElement !== host || quote.querySelector('p, ul, ol, div') !== null) {
    return false;
  }
  const rest = host.ownerDocument.createRange();
  rest.setStart(range.startContainer, range.startOffset);
  rest.setEnd(quote, quote.childNodes.length);
  if (rest.toString().trim() !== '') {
    return false;
  }
  const paragraph = host.ownerDocument.createElement('p');
  paragraph.append(host.ownerDocument.createElement('br'));
  history.record(() => {
    quote.after(paragraph);
    collapseAt(paragraph, 0);
  });
  return true;
}

// What the browser leaves behind while typing that nobody asked for. Each is cleared only when the content as it opened
// had none of its kind, so the author's own (an empty paragraph, a non-breaking space, a <b>) is never rewritten.
const TYPED_EMPTY = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre';
const NON_BREAKING = /\u00a0|&nbsp;|&#160;|&#xa0;/i;
const RENAMED: readonly (readonly [string, string])[] = [
  ['b', 'strong'],
  ['i', 'em'],
];

/**
 * The content as it is saved after typing in it: no empty block an Enter left behind, no non-breaking space the browser
 * typed where a space shows the same, and bold and italic as <strong> and <em>.
 */
export function withoutTypingResidue(root: Element, opened: string): void {
  for (const [from, to] of RENAMED) {
    if (!new RegExp(`<${from}[\\s>]`, 'i').test(opened)) {
      for (const element of Array.from(root.querySelectorAll(from))) {
        const renamed = root.ownerDocument.createElement(to);
        for (const attribute of Array.from(element.attributes)) {
          renamed.setAttribute(attribute.name, attribute.value);
        }
        renamed.append(...Array.from(element.childNodes));
        element.replaceWith(renamed);
      }
    }
  }
  if (!NON_BREAKING.test(opened)) {
    const blocks = Array.from(root.querySelectorAll(TYPED_EMPTY));
    (blocks.length === 0 ? [root] : blocks).forEach(plainSpaces);
  }
  if (!/<(p|h[1-6]|li|blockquote|pre)(\s[^<>]*)?>\s*<\/\1>/i.test(opened)) {
    for (const block of Array.from(root.querySelectorAll(TYPED_EMPTY)).reverse()) {
      if (isBlank(block) && block.querySelector('br') === null) {
        const list = block.parentElement;
        block.remove();
        if (list !== null && (list.tagName === 'UL' || list.tagName === 'OL') && list.children.length === 0) {
          list.remove();
        }
      }
    }
  }
}

// In one block's words: a lone non-breaking space between two characters is a space, and one that ends the block shows
// nothing. A run of spaces keeps the ones that make it show.
function plainSpaces(block: Element): void {
  if (block.tagName === 'PRE') {
    return;
  }
  const walker = block.ownerDocument.createTreeWalker(block, 4);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node && texts.length < RICH_DOM_LIMITS.nodesMax; node = walker.nextNode()) {
    if (node instanceof Text) {
      texts.push(node);
    }
  }
  const whole = texts.map((node) => node.data).join('');
  const trimmed = whole.replace(/\u00a0+$/, '').length;
  let at = 0;
  for (const node of texts) {
    const next = Array.from(node.data, (character, index) => {
      const position = at + index;
      if (character !== '\u00a0') {
        return character;
      }
      if (position >= trimmed) {
        return '';
      }
      return /\S/.test(whole.charAt(position - 1)) && /\S/.test(whole.charAt(position + 1)) ? ' ' : character;
    }).join('');
    at += node.data.length;
    if (next !== node.data) {
      node.data = next;
    }
  }
}

/**
 * Makes a copy of the content valid HTML before it is written: a paragraph, heading or code block never holds another
 * block (the browser's list commands leave `<p><ul>`), so the inner block moves out between what was around it; and
 * the `style` attributes the browser writes while joining blocks go, with the bare `<span>`s that carried them. The
 * editors only open content without `style` attributes, so none of them is the author's.
 */
export function tidyRichContent(root: Element): void {
  for (const element of Array.from(root.querySelectorAll('[style]'))) {
    element.removeAttribute('style');
    if (element.tagName === 'SPAN' && element.attributes.length === 0) {
      element.replaceWith(...Array.from(element.childNodes));
    }
  }
  const wrappers = Array.from(root.querySelectorAll('*')).filter((element) => PHRASING_BLOCKS.has(element.tagName));
  assert(wrappers.length <= RICH_DOM_LIMITS.nodesMax, 'Rich text holds a bounded number of blocks');
  for (const wrapper of wrappers.reverse()) {
    if (Array.from(wrapper.children).some((child) => BLOCK_TAGS.has(child.tagName))) {
      unnest(wrapper);
    }
  }
}

function unnest(wrapper: Element): void {
  const parts: Node[] = [];
  let run: Element | undefined;
  const close = () => {
    if (run !== undefined && !isBlank(run)) {
      parts.push(run);
    }
    run = undefined;
  };
  for (const child of Array.from(wrapper.childNodes)) {
    if (child instanceof Element && BLOCK_TAGS.has(child.tagName)) {
      close();
      parts.push(child);
    } else {
      const shallow = run ?? wrapper.cloneNode(false);
      assert(shallow instanceof Element, 'A cloned element is an element');
      run = shallow;
      run.append(child);
    }
  }
  close();
  wrapper.replaceWith(...parts);
}
