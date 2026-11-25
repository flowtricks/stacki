// The design gestures as DOM operations on a frame's document. Every function changes only the sandbox copy
// it is handed; none of them can reach the project, the editor's model or its write channels, because none of
// them is given anything but elements of a frame. Pure over a DOM, so a test runs every gesture in JSDOM.
import { DESIGN_ID_ATTRIBUTE, INSTANCE_ATTRIBUTE } from './designPrepare';
import { DESIGN_LIMITS, ELEMENT_ID_PATTERN, toDesignElementId, type DesignElementId } from './designTypes';

/** On an element a gesture copied: the design id of the element it was copied from. */
export const COPY_ATTRIBUTE = 'data-dm-copy-of';
/** On an element a gesture made: what made it (`text`, `box`, `image`, `component`, `paste`). */
export const ORIGIN_ATTRIBUTE = 'data-dm-origin';
/** On a former instance root after "Unlink": the component file it came from. */
export const UNLINKED_ATTRIBUTE = 'data-dm-unlinked';
/** On an instance root whose props Design mode changed: the props it renders with now, as JSON. */
export const PROPS_ATTRIBUTE = 'data-dm-props';
/** On the root of a component a gesture inserted: its component file. */
export const COMPONENT_ATTRIBUTE = 'data-dm-component';
/** On an element a design made free (absolutely placed): what its position was before, so the hand-off can say so. */
export const FREE_ATTRIBUTE = 'data-dm-free';

export type DesignOrigin = 'text' | 'box' | 'image' | 'component' | 'paste';

/** Mints the ids of elements a gesture makes, past every id the document already holds. */
export class ElementIdMint {
  private next: number;

  constructor(document: Document) {
    let highest = 0;
    for (const element of document.querySelectorAll('[' + DESIGN_ID_ATTRIBUTE + '^="n"]')) {
      const value = element.getAttribute(DESIGN_ID_ATTRIBUTE) ?? '';
      const parsed = Number.parseInt(value.slice(1), 36);
      if (Number.isSafeInteger(parsed) && parsed > highest) {
        highest = parsed;
      }
    }
    this.next = highest + 1;
  }

  mint(): DesignElementId {
    const id = toDesignElementId('n' + this.next.toString(36));
    this.next += 1;
    return id;
  }
}

export function designIdOf(element: Element): DesignElementId | undefined {
  const value = element.getAttribute(DESIGN_ID_ATTRIBUTE);
  return value !== null && ELEMENT_ID_PATTERN.test(value) ? toDesignElementId(value) : undefined;
}

export function elementByDesignId(document: Document, id: DesignElementId): Element | undefined {
  return document.querySelector('[' + DESIGN_ID_ATTRIBUTE + '="' + id + '"]') ?? undefined;
}

/** Gives `root` and everything in it new ids, each element remembering the one it had (a copy). */
export function renumberCopy(root: Element, mint: ElementIdMint): void {
  const elements = [root, ...root.querySelectorAll('*')];
  if (elements.length > DESIGN_LIMITS.elementsMax) {
    throw new Error('Assertion failed: renumberCopy: a copy within the element bound');
  }
  for (const element of elements) {
    const previous = element.getAttribute(DESIGN_ID_ATTRIBUTE);
    if (previous !== null) {
      element.setAttribute(COPY_ATTRIBUTE, element.getAttribute(COPY_ATTRIBUTE) ?? previous);
    }
    element.setAttribute(DESIGN_ID_ATTRIBUTE, mint.mint());
  }
}

/** Gives every element of a made subtree an id and its origin. */
export function numberMade(root: Element, mint: ElementIdMint, origin: DesignOrigin): void {
  for (const element of [root, ...root.querySelectorAll('*')].slice(0, DESIGN_LIMITS.elementsMax)) {
    element.setAttribute(DESIGN_ID_ATTRIBUTE, mint.mint());
    element.removeAttribute(COPY_ATTRIBUTE);
  }
  root.setAttribute(ORIGIN_ATTRIBUTE, origin);
}

/** Whether the element is placed outside the flow (absolute or fixed), as its frame computes it. */
export function isFree(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  if (view === null) {
    return false;
  }
  const position = view.getComputedStyle(element).position;
  return position === 'absolute' || position === 'fixed';
}

/** Moves `element` into `parent`, before `before` (at the end when undefined). Refuses to move an element into itself. */
export function moveInFlow(element: Element, parent: Element, before: Node | undefined): void {
  if (element === parent || element.contains(parent)) {
    throw new Error('Assertion failed: moveInFlow: an element never moves into itself');
  }
  if (before !== undefined && before.parentNode !== parent) {
    throw new Error('Assertion failed: moveInFlow: the next sibling belongs to the parent');
  }
  if (before === element) {
    return;
  }
  insertAt(parent, element, before);
}

/** Inserts `node` into `parent` before `before`, at the end when there is none. */
export function insertAt(parent: ParentNode, node: Node, before: Node | undefined): void {
  if (before === undefined) {
    parent.append(node);
  } else {
    parent.insertBefore(node, before);
  }
}

// A frame's document is another realm: its elements are not instances of this window's classes, so they are
// recognised by shape rather than by `instanceof`.
function isStyleDeclaration(value: unknown): value is CSSStyleDeclaration {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return typeof Reflect.get(value, 'setProperty') === 'function' && typeof Reflect.get(value, 'removeProperty') === 'function';
}

/** An element of any realm, recognised by its node type. */
export function isElementNode(node: unknown): node is Element {
  return typeof node === 'object' && node !== null && Reflect.get(node, 'nodeType') === 1;
}

function styled(element: Element): { readonly style: CSSStyleDeclaration } | undefined {
  // HTML and SVG elements carry an inline style; anything else has none to set.
  const style: unknown = Reflect.get(element, 'style');
  return isStyleDeclaration(style) ? { style } : undefined;
}

/** Sets an inline style; an empty value removes it. */
export function setInlineStyle(element: Element, property: string, value: string): void {
  const target = styled(element);
  if (target === undefined) {
    return;
  }
  if (value === '') {
    target.style.removeProperty(property);
  } else {
    target.style.setProperty(property, value);
  }
  if (element.getAttribute('style') === '') {
    element.removeAttribute('style');
  }
}

export function inlineStyleOf(element: Element, property: string): string {
  return styled(element)?.style.getPropertyValue(property) ?? '';
}

/**
 * Takes the element out of the flow at the given place in its parent, as Figma's absolute position does: its
 * parent becomes the containing block (relative, when it was static), it keeps its size, and its siblings close up.
 */
export function makeFree(
  element: Element,
  place: { readonly leftPx: number; readonly topPx: number; readonly widthPx: number; readonly heightPx: number },
): void {
  const parent = element.parentElement;
  if (parent === null) {
    throw new Error('Assertion failed: makeFree: a free element has a parent');
  }
  const view = element.ownerDocument.defaultView;
  if (view !== null && view.getComputedStyle(parent).position === 'static') {
    setInlineStyle(parent, 'position', 'relative');
  }
  if (!element.hasAttribute(FREE_ATTRIBUTE)) {
    element.setAttribute(FREE_ATTRIBUTE, view === null ? 'static' : view.getComputedStyle(element).position);
  }
  setInlineStyle(element, 'position', 'absolute');
  setInlineStyle(element, 'margin', '0');
  setInlineStyle(element, 'width', px(place.widthPx));
  // Text keeps its own height, so it never clips when its font or words change; a box keeps the one it had.
  if (!isTextLeaf(element)) {
    setInlineStyle(element, 'height', px(place.heightPx));
  }
  placeFree(element, place.leftPx, place.topPx);
}

/** Puts a free element at a place in its containing block. */
export function placeFree(element: Element, leftPx: number, topPx: number): void {
  setInlineStyle(element, 'left', px(leftPx));
  setInlineStyle(element, 'top', px(topPx));
  setInlineStyle(element, 'right', '');
  setInlineStyle(element, 'bottom', '');
  setInlineStyle(element, 'transform', inlineStyleOf(element, 'transform').includes('translate') ? 'none' : inlineStyleOf(element, 'transform'));
}

/** Pixels written as CSS: whole pixels, never a long fraction. */
export function px(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error('Assertion failed: px: a finite length');
  }
  return String(Math.round(value)) + 'px';
}

/** A copy of `element` right after it, with new ids. */
export function duplicateAfter(element: Element, mint: ElementIdMint): Element {
  const copy = element.cloneNode(true);
  if (!isElementNode(copy)) {
    throw new Error('Assertion failed: duplicateAfter: a cloned element is an element');
  }
  renumberCopy(copy, mint);
  element.after(copy);
  return copy;
}

export function setHidden(element: Element, visibility: 'hidden' | 'shown'): void {
  setInlineStyle(element, 'display', visibility === 'hidden' ? 'none' : '');
}

export function isHidden(element: Element): boolean {
  return inlineStyleOf(element, 'display') === 'none';
}

/** Inline elements a text edit may hold: an element whose children are only these (and text) is edited as text. */
const PHRASING = new Set(['A', 'ABBR', 'B', 'BR', 'CODE', 'EM', 'I', 'MARK', 'S', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'U', 'WBR']);

/** Whether a double click edits the element's text: it holds text and nothing but phrasing elements. */
export function isTextLeaf(element: Element): boolean {
  if ((element.textContent ?? '').trim() === '') {
    return false;
  }
  return [...element.querySelectorAll('*')].every((child) => PHRASING.has(child.tagName));
}

/** The elements of one instance occurrence, in document order. */
export function instanceRoots(document: Document, key: string): readonly Element[] {
  return [...document.querySelectorAll('[' + INSTANCE_ATTRIBUTE + '="' + key + '"]')];
}

/** The instance occurrence key the element is a root of, if any. */
export function instanceKeyOf(element: Element): string | undefined {
  return element.getAttribute(INSTANCE_ATTRIBUTE) ?? undefined;
}

/** "Unlink": the occurrence's roots stop being an instance and become plain elements, looking exactly as they did. */
export function unlinkInstance(document: Document, key: string, component: string): number {
  const roots = instanceRoots(document, key);
  for (const root of roots) {
    root.removeAttribute(INSTANCE_ATTRIBUTE);
    root.removeAttribute(PROPS_ATTRIBUTE);
    root.setAttribute(UNLINKED_ATTRIBUTE, component);
  }
  return roots.length;
}

/** HTML parsed in the frame's document, with scripts and Stacki's marker comments removed. */
export function parseFragment(document: Document, html: string): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = html;
  const fragment = template.content;
  for (const script of fragment.querySelectorAll('script')) {
    script.remove();
  }
  stripMarkerComments(fragment);
  return fragment;
}

/** Removes `<!--avb-…-->` comments, iteratively. */
export function stripMarkerComments(root: Node): void {
  const document = root.ownerDocument ?? (root instanceof Document ? root : undefined);
  if (document === undefined || document === null) {
    return;
  }
  const walker = document.createTreeWalker(root, 128 /* NodeFilter.SHOW_COMMENT */);
  const comments: Node[] = [];
  for (let node = walker.nextNode(); node !== null && comments.length < DESIGN_LIMITS.elementsMax; node = walker.nextNode()) {
    if ((node.nodeValue ?? '').startsWith('avb-')) {
      comments.push(node);
    }
  }
  for (const comment of comments) {
    comment.parentNode?.removeChild(comment);
  }
}

/** Inserts parsed HTML before `before` in `parent`, numbering what it made; answers the elements at its top. */
export function insertFragment(
  parent: Element,
  before: Node | undefined,
  fragment: DocumentFragment,
  mint: ElementIdMint,
  origin: DesignOrigin,
): readonly Element[] {
  const tops = [...fragment.children];
  for (const top of tops) {
    numberMade(top, mint, origin);
  }
  insertAt(parent, fragment, before);
  return tops;
}

/** Restores the element's attributes and content to the page as it was copied, keeping where it is. */
export function resetElement(element: Element, baseline: Document): boolean {
  const id = designIdOf(element);
  const original = id === undefined ? undefined : elementByDesignId(baseline, id);
  if (original === undefined) {
    return false;
  }
  for (const name of element.getAttributeNames()) {
    if (!original.hasAttribute(name)) {
      element.removeAttribute(name);
    }
  }
  for (const name of original.getAttributeNames()) {
    element.setAttribute(name, original.getAttribute(name) ?? '');
  }
  element.innerHTML = original.innerHTML;
  return true;
}

/** The element's box in its frame's coordinates (frame documents never scroll: a frame is as tall as its page). */
export interface FrameRect {
  readonly xPx: number;
  readonly yPx: number;
  readonly widthPx: number;
  readonly heightPx: number;
}

export function rectOf(element: Element): FrameRect {
  const box = element.getBoundingClientRect();
  return { xPx: box.left, yPx: box.top, widthPx: box.width, heightPx: box.height };
}
