// Showing what hides an element the editor was asked to go to. An audit can name a button in a
// closed modal, an inactive tab panel or a closed <details>: it draws no box, so the go-to
// selected it with nothing on the canvas to outline. While that selection lasts, whatever hides
// it is shown: a closed block gets `stacki-opened` (the class a component shows its open state
// with), a <details> or <dialog> that still hides is opened, and a panel hidden in a stack is
// made visible with the panels drawn over it hidden. Only the canvas's copy of the page changes,
// never the project's files, and every change is put back when the editor looks elsewhere.

import { assert } from '../../shared/core/assert';
import { PRELOAD_LIMITS, isElement } from './frameBasics';
import { elementsWithPath, runsOf } from './frameRegions';

const SIBLINGS_MAX = 200;
const OPENED_CLASS = 'stacki-opened';

/** One change made to the page, and how to take it back. */
type Undo = () => void;

let undos: Undo[] = [];
/** The outermost element this module changed: while the editor looks inside it, it stays shown. */
let shown: Element[] = [];

/** The element copy `occurrence` of a path draws: its marked run's first element, or its tagged one. */
function targetOf(nodePath: string, occurrence: number): Element | undefined {
  const runs = runsOf(nodePath);
  const run = runs?.[occurrence] ?? runs?.[0];
  const marked = run?.find((node): node is Element => isElement(node) && node.tagName !== 'TEMPLATE' && node.isConnected);
  if (marked !== undefined) {
    return marked;
  }
  // The tags, not measured places: a hidden element has no box to be measured by.
  const tagged = elementsWithPath(nodePath);
  return tagged[occurrence] ?? tagged[0];
}

const holds = (element: Element): boolean => shown.some((root) => root.contains(element));

/**
 * Called for each go-to and selection scroll. A target inside what is already shown keeps it;
 * any other target puts the page back, and `unhide` then shows what hides the new one.
 */
export function showTarget(nodePath: string, occurrence: number, options: { readonly unhide: boolean }): void {
  const target = targetOf(nodePath, occurrence);
  if (target !== undefined && holds(target)) {
    return;
  }
  restoreHidden();
  if (options.unhide && target !== undefined) {
    unhide(target);
  }
}

/** The page put back once nothing the editor tracks is inside what was shown. */
export function restoreUntracked(paths: readonly string[]): void {
  if (shown.length === 0) {
    return;
  }
  if (!paths.some((nodePath) => elementsWithPath(nodePath).some(holds))) {
    restoreHidden();
  }
}

export function restoreHidden(): void {
  for (const undo of undos.reverse()) {
    undo();
  }
  undos = [];
  shown = [];
}

// Outermost first: an ancestor shown may be what hid the ones inside it.
function unhide(target: Element): void {
  const chain: Element[] = [];
  let at: Element | undefined = target;
  while (at !== undefined && at !== document.body && chain.length < PRELOAD_LIMITS.domDepthMax) {
    chain.push(at);
    at = at.parentElement ?? undefined;
  }
  for (const element of chain.reverse()) {
    const before = undos.length;
    openDetails(element, target);
    showBlock(element);
    showPanel(element);
    if (undos.length > before) {
      shown.push(element);
    }
  }
  assert(shown.length <= chain.length, 'unhide: only the target’s own chain is shown');
}

function openDetails(element: Element, target: Element): void {
  if (element.tagName !== 'DETAILS' || element.hasAttribute('open') || element === target) {
    return;
  }
  if (element.querySelector(':scope > summary')?.contains(target) === true) {
    return;
  }
  setAttribute(element, 'open', '');
}

// A block that is not displayed: its own open state first, then the platform's, then plain display.
function showBlock(element: Element): void {
  const undisplayed = (): boolean => window.getComputedStyle(element).display === 'none';
  if (!undisplayed()) {
    return;
  }
  if (!element.classList.contains(OPENED_CLASS)) {
    element.classList.add(OPENED_CLASS);
    undos.push(() => element.classList.remove(OPENED_CLASS));
  }
  if (undisplayed() && element.tagName === 'DIALOG') {
    setAttribute(element, 'open', '');
  }
  if (undisplayed()) {
    setStyle(element, { display: 'revert' });
  }
}

// A panel kept invisible (stacked tab panels, slides): shown at once, and what is drawn in its place hidden.
function showPanel(element: Element): void {
  const style = window.getComputedStyle(element);
  const invisible = style.visibility === 'hidden';
  if (!invisible && Number.parseFloat(style.opacity) !== 0) {
    return;
  }
  setStyle(element, { transition: 'none', animation: 'none', visibility: 'visible', opacity: '1', translate: 'none' });
  const box = element.getBoundingClientRect();
  const siblings = Array.from(element.parentElement?.children ?? []).slice(0, SIBLINGS_MAX);
  for (const sibling of siblings) {
    if (sibling !== element && coversSamePlace(box, sibling.getBoundingClientRect())) {
      // Opacity too: a child that sets itself visible (a reveal animation) would show through visibility alone.
      setStyle(sibling, { transition: 'none', animation: 'none', visibility: 'hidden', opacity: '0' });
    }
  }
}

// Whether two boxes start in the same place, as a stack of panels does.
function coversSamePlace(box: DOMRect, other: DOMRect): boolean {
  if (other.width === 0 || other.height === 0) {
    return false;
  }
  return Math.abs(box.left - other.left) < 2 && Math.abs(box.top - other.top) < 2;
}

function setAttribute(element: Element, name: string, value: string): void {
  element.setAttribute(name, value);
  undos.push(() => element.removeAttribute(name));
}

// A render can write the element's style while it is shown, and restoring the whole attribute
// would put the old one over it until a refresh. So the attribute goes back as it was only while
// nothing else wrote it; otherwise declaration by declaration, where it still says what was set.
function setStyle(element: Element, declarations: Readonly<Record<string, string>>): void {
  if (!(element instanceof HTMLElement || element instanceof SVGElement)) {
    return;
  }
  const attribute = element.getAttribute('style');
  const changed = Object.entries(declarations).map(([property, value]) => {
    const before = { value: element.style.getPropertyValue(property), priority: element.style.getPropertyPriority(property) };
    element.style.setProperty(property, value, 'important');
    return { property, before, set: element.style.getPropertyValue(property) };
  });
  const shownAs = element.getAttribute('style');
  undos.push(() => {
    if (element.getAttribute('style') === shownAs) {
      putAttributeBack(element, attribute);
      return;
    }
    for (const { property, before, set } of changed) {
      if (element.style.getPropertyValue(property) !== set) {
        continue;
      }
      if (before.value === '') {
        element.style.removeProperty(property);
      } else {
        element.style.setProperty(property, before.value, before.priority);
      }
    }
  });
}

// `getAttribute` answers null for an element without one: that one is taken off again.
function putAttributeBack(element: Element, attribute: ReturnType<Element['getAttribute']>): void {
  if (typeof attribute === 'string') {
    element.setAttribute('style', attribute);
  } else {
    element.removeAttribute('style');
  }
}
