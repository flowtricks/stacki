// Formatting a selection in rich inline content: bold, italic, superscript,
// subscript, code, span and link. The Settings Content field and the canvas
// selection bar both run these, so a word formatted in either place gets the
// same markup. Each acts on the browser selection inside `host`, restored from
// the range the caller saved, and leaves the formatted words selected.

import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { domToNodes, isDOMElement, type InlineNode } from './richContentModel';

export interface FormatState {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly superscript?: boolean;
  readonly subscript?: boolean;
  readonly code?: boolean;
  readonly span?: boolean;
  readonly link?: boolean;
}

/** The editable element and the selection a press acts on. */
export interface RichTarget {
  readonly host: HTMLElement | undefined;
  readonly savedRange: { current: Range | undefined };
}

export type RichCommand = 'bold' | 'italic' | 'superscript' | 'subscript';
export type RichWrapTag = 'code' | 'span';

// The wrapper of `tag` the whole selection sits inside, or undefined. Both ends
// are resolved down to the node they point AT, rather than reading
// sel.anchorNode: a range can select an element from its parent — start
// (parent, i), end (parent, i+1) — and that is exactly what surrounding the
// selection leaves behind, so asking the anchor (the parent) whether it is
// inside `tag` answers no about the tag it just made.
export function richTagAround(host: HTMLElement | undefined, tag: string): Element | undefined {
  const selection = window.getSelection();
  if (!host || !selection || selection.rangeCount === 0) {
    return undefined;
  }
  const range = selection.getRangeAt(0);
  const at = (container: Node, offset: number) => {
    const node = container.nodeType === 1 ? container.childNodes[offset] || container : container;
    const element = isDOMElement(node) ? node : node.parentElement;
    return element ? element.closest(tag) : undefined;
  };
  // The end boundary points just PAST its node, so step back one.
  const start = at(range.startContainer, range.startOffset);
  const end = at(range.endContainer, range.endOffset - (range.endContainer.nodeType === 1 ? 1 : 0));
  const element = start && start === end ? start : undefined;
  return element && host.contains(element) && element !== host ? element : undefined;
}

// Formatting state at the current selection, for highlighting buttons.
export function richReadStates(host: HTMLElement | undefined): FormatState {
  const inTag = (tag: string) => !!richTagAround(host, tag);
  let states: FormatState = {};
  try {
    states = {
      bold: document.queryCommandState('bold'),
      italic: document.queryCommandState('italic'),
      superscript: document.queryCommandState('superscript'),
      subscript: document.queryCommandState('subscript'),
    };
  } catch {
    states = {};
  }
  return { ...states, code: inTag('code'), span: inTag('span'), link: inTag('a') };
}

// Snapshot the live selection as the range the next press restores.
// Every action below re-reads it rather than leaving that to the
// `selectionchange` listener, because that event is fired from a queued
// task: a second press landing in the same task would otherwise act on the
// range from before the first one, which by then has been dragged along by
// the DOM edit and no longer means what it did. That is how pressing Code
// twice quickly used to nest a <code> inside a <code>.
export function richSaveSelection(target: RichTarget): void {
  const { host, savedRange } = target;
  const selection = window.getSelection();
  if (!host || !selection || selection.rangeCount === 0) {
    return;
  }
  const range = selection.getRangeAt(0);
  if (host.contains(range.commonAncestorContainer)) {
    savedRange.current = range.cloneRange();
  }
}

export function richRestoreSelection(target: RichTarget): void {
  const range = target.savedRange.current;
  if (!range) {
    return;
  }
  const selection = window.getSelection();
  if (!selection) {
    return;
  }
  selection.removeAllRanges();
  // A clone: addRange can adopt the very range it is handed, and then
  // surroundContents below would rewrite the saved one as a side effect.
  selection.addRange(range.cloneRange());
}

/** Bold, italic, superscript or subscript, as the browser's editing command. */
export function richExec(target: RichTarget, command: RichCommand): void {
  target.host?.focus();
  richRestoreSelection(target);
  document.execCommand(command, false);
  richSaveSelection(target);
}

// Take the selection out of the nearest `tag` around it, leaving its text
// where it was. The button is a toggle — pressing one that is already lit has
// to turn it off, and for a <span> that is the only way back: a span with no
// attributes on it yet is invisible, so one added by mistake could otherwise
// only be removed by editing the file.
function richUnwrapTag(target: RichTarget, tag: string): boolean {
  const selection = window.getSelection();
  const element = richTagAround(target.host, tag);
  if (!element) {
    return false;
  }
  const parent = element.parentNode;
  assert(parent !== null, 'RichContent: inline wrapper has a parent');
  const first = element.firstChild;
  const last = element.lastChild;
  assert(
    element.childNodes.length <= LIMITS.treeNodesMax,
    'RichContent: unwrap child limit exceeded',
  );
  for (const child of Array.from(element.childNodes)) {
    parent.insertBefore(child, element);
  }
  parent.removeChild(element);
  // Keep the text selected, so the bubble stays up and the next press acts on
  // the same words.
  if (first && last) {
    const wrappedRange = document.createRange();
    wrappedRange.setStartBefore(first);
    wrappedRange.setEndAfter(last);
    selection?.removeAllRanges();
    selection?.addRange(wrappedRange);
  }
  return true;
}

/**
 * Code or span: there is no editing command for either, so the selection is
 * wrapped by hand — or unwrapped, when it already sits in one. Returns whether
 * the content changed.
 */
export function richWrapTag(target: RichTarget, tag: RichWrapTag): boolean {
  target.host?.focus();
  richRestoreSelection(target);
  // Already inside one: the press means "stop".
  if (richUnwrapTag(target, tag)) {
    richSaveSelection(target);
    return true;
  }
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return false;
  }
  const range = selection.getRangeAt(0);
  const element = document.createElement(tag);
  try {
    range.surroundContents(element);
  } catch {
    // Selection crosses element boundaries — extract and rewrap.
    element.appendChild(range.extractContents());
    range.insertNode(element);
  }
  selection.removeAllRanges();
  const contentsRange = document.createRange();
  contentsRange.selectNodeContents(element);
  selection.addRange(contentsRange);
  richSaveSelection(target);
  return true;
}

/** A link around the selection. An empty URL changes nothing. */
export function richApplyLink(target: RichTarget, url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) {
    return false;
  }
  target.host?.focus();
  richRestoreSelection(target);
  document.execCommand('createLink', false, trimmed);
  richSaveSelection(target);
  return true;
}

/** The content of an edited element, as nodes. */
export function richContentNodes(element: HTMLElement): InlineNode[] {
  const next = domToNodes(element);
  // Deleting the last character leaves a <br> behind: a contentEditable
  // needs one line for the caret to sit on, so the browser puts a
  // placeholder there. It isn't content, and writing it out means the
  // component still receives slot content — a heading emptied in the panel
  // would keep rendering, holding a line break. A lone <br> is that
  // placeholder and nothing else, so it clears to nothing.
  const only = next.length === 1 ? next[0] : undefined;
  if (only?.kind === 'element' && only.name === 'br') {
    return [];
  }
  return next;
}
