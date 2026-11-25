// The rich text editor's edits, applied to its live content. Every change goes
// through `document.execCommand`, deprecated but still the only way to edit
// a contentEditable that keeps the browser's own undo history: ⌘Z steps back
// through toolbar actions, shortcuts and Markdown conversions alike.
import { assert } from '../../shared/core/assert';
import { BLOCKS, escapeHTML, type Block, type BlockShortcut, type InlineShortcut } from './richTextModel';

/** The inline marks the toolbar toggles. */
export type Mark = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'superscript' | 'subscript';
export const MARKS: readonly Mark[] = ['bold', 'italic', 'underline', 'strike', 'code', 'superscript', 'subscript'];

/** What the selection sits in, so the toolbar can show it. */
export interface FormatState {
  readonly marks: ReadonlySet<Mark>;
  readonly block: Block;
  readonly list: 'ul' | 'ol' | undefined;
  readonly link: HTMLAnchorElement | undefined;
}

/** Everything the toolbar and the keyboard can ask the editor to do. */
export type RichTextAction =
  | { readonly kind: 'mark'; readonly mark: Mark }
  | { readonly kind: 'block'; readonly block: Block }
  | { readonly kind: 'list'; readonly list: 'ul' | 'ol' }
  | { readonly kind: 'rule' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'link' }
  | { readonly kind: 'history'; readonly step: 'undo' | 'redo' };

/** A key press, as much of it as the shortcuts read. */
export interface KeyPress {
  readonly key: string;
  readonly code: string;
  /** ⌘ on a Mac, Ctrl elsewhere. */
  readonly mod: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

/**
 * The action a key press stands for. ⌘B, ⌘I, ⌘U, ⌘Z and ⇧⌘Z are left to the
 * browser, which already does them; these are the ones it does not know.
 */
export function shortcutAction(press: KeyPress): RichTextAction | undefined {
  if (!press.mod) {
    return undefined;
  }
  const key = press.key.toLowerCase();
  if (press.alt) {
    // ⌥⌘0 to ⌥⌘6, as in Google Docs: a paragraph, or a heading of that level. With Shift
    // it is the app command range (shared/properties/appShortcuts.ts), never a heading.
    if (press.shift) {
      return undefined;
    }
    const digit = /^Digit([0-6])$/.exec(press.code)?.[1];
    if (digit === undefined) {
      return undefined;
    }
    return { kind: 'block', block: digit === '0' ? 'p' : blockOf(`h${digit}`) };
  }
  if (press.shift) {
    const shifted: Readonly<Record<string, RichTextAction>> = {
      Digit7: { kind: 'list', list: 'ol' },
      Digit8: { kind: 'list', list: 'ul' },
      Digit9: { kind: 'block', block: 'blockquote' },
      KeyX: { kind: 'mark', mark: 'strike' },
    };
    return Object.hasOwn(shifted, press.code) ? shifted[press.code] : undefined;
  }
  if (key === 'k') {
    return { kind: 'link' };
  }
  if (key === 'e') {
    return { kind: 'mark', mark: 'code' };
  }
  if (key === '.') {
    return { kind: 'mark', mark: 'superscript' };
  }
  if (key === ',') {
    return { kind: 'mark', mark: 'subscript' };
  }
  return key === '\\' ? { kind: 'clear' } : undefined;
}

/** Carries out an action other than a link, which needs the field's own bubble. */
export function performAction(host: HTMLElement, action: Exclude<RichTextAction, { readonly kind: 'link' }>): void {
  switch (action.kind) {
    case 'mark':
      toggleMark(host, action.mark);
      return;
    case 'block':
      setBlock(host, action.block);
      return;
    case 'list':
      toggleList(action.list);
      return;
    case 'rule':
      insertRule();
      return;
    case 'clear':
      clearFormatting();
      return;
    case 'history':
      document.execCommand(action.step);
      return;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

export const EMPTY_FORMAT: FormatState = {
  marks: new Set(),
  block: 'p',
  list: undefined,
  link: undefined,
};

// The browser's names for the marks it toggles itself.
const MARK_COMMANDS: Readonly<Record<Exclude<Mark, 'code'>, string>> = {
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
  strike: 'strikeThrough',
  superscript: 'superscript',
  subscript: 'subscript',
};

const BROWSER_MARKS: readonly Exclude<Mark, 'code'>[] = ['bold', 'italic', 'underline', 'strike', 'superscript', 'subscript'];

const BLOCK_SELECTOR = 'p, div, h1, h2, h3, h4, h5, h6, blockquote, pre, li';

/** The selection's range when it is inside the editor. */
export function rangeIn(host: HTMLElement): Range | undefined {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) {
    return undefined;
  }
  const range = selection.getRangeAt(0);
  return host.contains(range.commonAncestorContainer) ? range : undefined;
}

/** The marks, block, list and link the caret is in. */
export function readFormat(host: HTMLElement): FormatState {
  const range = rangeIn(host);
  if (range === undefined) {
    return EMPTY_FORMAT;
  }
  const element = elementOf(range.startContainer);
  const marks = new Set<Mark>();
  for (const mark of BROWSER_MARKS) {
    if (document.queryCommandState(MARK_COMMANDS[mark])) {
      marks.add(mark);
    }
  }
  if (inside(element, host, 'code')) {
    marks.add('code');
  }
  const blockTag = inside(element, host, BLOCKS.filter((tag) => tag !== 'p').join(','));
  const list = inside(element, host, 'ul, ol');
  const link = inside(element, host, 'a');
  return {
    marks,
    block: blockOf(blockTag?.localName),
    list: list?.localName === 'ol' ? 'ol' : list === undefined ? undefined : 'ul',
    link: link instanceof HTMLAnchorElement ? link : undefined,
  };
}

/** Turns a mark on or off over the selection. */
export function toggleMark(host: HTMLElement, mark: Mark): void {
  assert(MARKS.includes(mark), 'A mark the editor knows');
  if (mark === 'code') {
    toggleCode(host);
  } else {
    document.execCommand(MARK_COMMANDS[mark]);
  }
}

/** Makes the caret's block the given kind; choosing its current kind makes it a paragraph. */
export function setBlock(host: HTMLElement, block: Block): void {
  assert(BLOCKS.includes(block), 'A block the editor knows');
  const current = readFormat(host).block;
  const next = current === block ? 'p' : block;
  document.execCommand('formatBlock', false, `<${next}>`);
}

/** Starts, switches or ends a bulleted or numbered list. */
export function toggleList(list: 'ul' | 'ol'): void {
  document.execCommand(list === 'ul' ? 'insertUnorderedList' : 'insertOrderedList');
}

/** A horizontal rule, with a paragraph after it to keep typing in. */
export function insertRule(): void {
  document.execCommand('insertHTML', false, '<hr><p><br></p>');
}

/** Removes inline formatting and links from the selection. */
export function clearFormatting(): void {
  document.execCommand('removeFormat');
  document.execCommand('unlink');
}

/**
 * Links the selection, or the link the caret is in, to `href`; with nothing
 * selected the address itself is inserted as the link's text.
 */
export function applyLink(host: HTMLElement, href: string): void {
  const range = rangeIn(host);
  assert(range !== undefined, 'A link is applied where the editor has its selection');
  const link = readFormat(host).link;
  if (link !== undefined) {
    selectNode(link);
  }
  if (rangeIn(host)?.collapsed === true) {
    const text = escapeHTML(href);
    document.execCommand('insertHTML', false, `<a href="${text}">${text}</a>`);
  } else {
    document.execCommand('createLink', false, href);
  }
}

/** Removes the link the caret is in, keeping its text. */
export function removeLink(host: HTMLElement): void {
  const link = readFormat(host).link;
  if (link !== undefined) {
    selectNode(link);
  }
  document.execCommand('unlink');
}

/**
 * Turns the line's typed prefix into what it stands for: the prefix is deleted
 * and the block becomes a heading, quote, code block, list or rule.
 */
export function applyBlockShortcut(host: HTMLElement, shortcut: BlockShortcut): void {
  const range = rangeIn(host);
  assert(range !== undefined, 'A shortcut is typed where the editor has its selection');
  const prefix = lineRange(host, range);
  selectRange(prefix);
  document.execCommand('delete');
  switch (shortcut.kind) {
    case 'block':
      document.execCommand('formatBlock', false, `<${shortcut.block}>`);
      return;
    case 'list':
      toggleList(shortcut.list);
      return;
    case 'rule':
      insertRule();
      return;
    default: {
      const exhaustive: never = shortcut;
      return exhaustive;
    }
  }
}

/** Replaces a typed `**run**` before the caret with the element it stands for. */
export function applyInlineShortcut(host: HTMLElement, shortcut: InlineShortcut): void {
  const range = rangeIn(host);
  assert(range !== undefined, 'A shortcut is typed where the editor has its selection');
  const node = range.startContainer;
  assert(node instanceof Text, 'An inline shortcut closes in a run of text');
  assert(range.startOffset >= shortcut.length, 'The typed run is all before the caret');
  const typed = document.createRange();
  typed.setStart(node, range.startOffset - shortcut.length);
  typed.setEnd(node, range.startOffset);
  selectRange(typed);
  const html = `<${shortcut.tag}>${escapeHTML(shortcut.text)}</${shortcut.tag}>`;
  document.execCommand('insertHTML', false, html);
  // What is typed next is plain again, not more of the run.
  const command = shortcut.tag === 'code' ? undefined : TAG_COMMANDS[shortcut.tag];
  if (command !== undefined && document.queryCommandState(command)) {
    document.execCommand(command);
  }
}

const TAG_COMMANDS: Readonly<Record<'strong' | 'em' | 's', string>> = {
  strong: 'bold',
  em: 'italic',
  s: 'strikeThrough',
};

/** The text of the caret's block from its start up to the caret. */
export function lineBeforeCaret(host: HTMLElement): string | undefined {
  const range = rangeIn(host);
  return range === undefined ? undefined : lineRange(host, range).toString();
}

/** The block the caret is in, when it is a plain paragraph (or bare text). */
export function inParagraph(host: HTMLElement): boolean {
  const range = rangeIn(host);
  if (range === undefined) {
    return false;
  }
  const block = elementOf(range.startContainer)?.closest(BLOCK_SELECTOR);
  if (block === null || block === undefined || !host.contains(block)) {
    return true;
  }
  return block.localName === 'p' || block.localName === 'div';
}

/** Whether the caret is in code, where Markdown is text. */
export function inCode(host: HTMLElement): boolean {
  const range = rangeIn(host);
  return range !== undefined && inside(elementOf(range.startContainer), host, 'code, pre') !== undefined;
}

// Code: wraps the selection's text, or unwraps the code the caret is in.
function toggleCode(host: HTMLElement): void {
  const range = rangeIn(host);
  if (range === undefined) {
    return;
  }
  const code = inside(elementOf(range.startContainer), host, 'code');
  if (code !== undefined) {
    selectNode(code);
    document.execCommand('insertHTML', false, escapeHTML(code.textContent ?? ''));
    return;
  }
  if (!range.collapsed) {
    document.execCommand('insertHTML', false, `<code>${escapeHTML(range.toString())}</code>`);
  }
}

// From the start of the caret's block to the caret.
function lineRange(host: HTMLElement, range: Range): Range {
  const block = elementOf(range.startContainer)?.closest(BLOCK_SELECTOR);
  const line = document.createRange();
  line.setStart(block !== null && block !== undefined && host.contains(block) ? block : host, 0);
  line.setEnd(range.startContainer, range.startOffset);
  return line;
}

function inside(element: Element | undefined, host: HTMLElement, selector: string) {
  const found = element?.closest(selector);
  return found !== null && found !== undefined && host.contains(found) ? found : undefined;
}

function elementOf(node: Node): Element | undefined {
  const element = node instanceof Element ? node : node.parentElement;
  return element ?? undefined;
}

function blockOf(tag: string | undefined): Block {
  const block = BLOCKS.find((known) => known === tag);
  return block ?? 'p';
}

function selectNode(node: Node): void {
  const range = document.createRange();
  range.selectNodeContents(node);
  selectRange(range);
}

function selectRange(range: Range): void {
  const selection = window.getSelection();
  assert(selection !== null, 'The editor has a selection to set');
  selection.removeAllRanges();
  selection.addRange(range);
}
