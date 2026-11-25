// The gestures the keyboard, the menus and the inspector share, each one undo step on one frame. They combine
// the session (what is selected, which frame) with the DOM operations (designDom.ts); like those, they change
// a frame's copy of the page and nothing else.
import {
  FREE_ATTRIBUTE,
  duplicateAfter,
  inlineStyleOf,
  insertAt,
  insertFragment,
  designIdOf,
  isFree,
  isHidden,
  makeFree,
  moveInFlow,
  parseFragment,
  placeFree,
  renumberCopy,
  resetElement,
  setHidden,
  setInlineStyle,
} from '../model/designDom';
import { DESIGN_LIMITS, type FrameId } from '../model/designTypes';
import { beginLive, bump, commitFrame, frameBaseline, frameDocument, isLive, select, selectedElements } from './designSession';

/** Elements of a selection without the ones inside another selected element: a gesture on a parent carries its children. */
export function outermost(elements: readonly Element[]): readonly Element[] {
  return elements.filter((element) => !elements.some((other) => other !== element && other.contains(element)));
}

function usable(elements: readonly Element[]): readonly Element[] {
  return outermost(elements).filter((element) => element.tagName !== 'BODY');
}

export function deleteSelection(): boolean {
  const selected = selectedElements();
  if (selected === undefined) {
    return false;
  }
  const targets = usable(selected.elements);
  if (targets.length === 0) {
    return false;
  }
  return commitFrame(selected.frame, () => {
    const parent = targets[0]?.parentElement;
    for (const element of targets) {
      element.remove();
    }
    return parent === null || parent === undefined || parent.tagName === 'BODY' ? [] : [parent];
  });
}

export function duplicateSelection(): boolean {
  const selected = selectedElements();
  if (selected === undefined) {
    return false;
  }
  const targets = usable(selected.elements);
  return (
    targets.length > 0 &&
    commitFrame(selected.frame, (_document, mint) =>
      targets.map((element) => {
        const copy = duplicateAfter(element, mint);
        if (isFree(copy)) {
          // A free copy lands a little away from its original, as Figma's does, so both can be seen.
          placeFree(copy, pixels(inlineStyleOf(copy, 'left')) + 16, pixels(inlineStyleOf(copy, 'top')) + 16);
        }
        return copy;
      }),
    )
  );
}

export function toggleHiddenSelection(): boolean {
  const selected = selectedElements();
  if (selected === undefined) {
    return false;
  }
  const targets = usable(selected.elements);
  const hide = targets.some((element) => !isHidden(element));
  return (
    targets.length > 0 &&
    commitFrame(selected.frame, () => {
      for (const element of targets) {
        setHidden(element, hide ? 'hidden' : 'shown');
      }
      return undefined;
    })
  );
}

/** A CSS pixel length as a number; anything else reads as 0. */
export function pixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Arrow keys: a free element moves by a pixel (ten with Shift); an element in the flow trades places with its
 * neighbour, as an auto-layout child does in Figma.
 */
export function nudgeSelection(dxPx: number, dyPx: number): boolean {
  const selected = selectedElements();
  if (selected === undefined) {
    return false;
  }
  const targets = usable(selected.elements);
  if (targets.length === 0) {
    return false;
  }
  return commitFrame(selected.frame, () => {
    for (const element of targets) {
      if (isFree(element)) {
        placeFree(element, freeLeft(element) + dxPx, freeTop(element) + dyPx);
      } else {
        const forward = dxPx > 0 || dyPx > 0;
        const sibling = forward ? element.nextElementSibling : element.previousElementSibling;
        const parent = element.parentElement;
        if (sibling !== null && parent !== null) {
          moveInFlow(element, parent, forward ? (sibling.nextSibling ?? undefined) : sibling);
        }
      }
    }
    return undefined;
  });
}

function freeLeft(element: Element): number {
  const inline = inlineStyleOf(element, 'left');
  return inline === '' ? offset(element).leftPx : pixels(inline);
}

function freeTop(element: Element): number {
  const inline = inlineStyleOf(element, 'top');
  return inline === '' ? offset(element).topPx : pixels(inline);
}

/** The element's place inside its parent's padding box, which is where `left` and `top` of a free child measure from. */
export function offset(element: Element): { readonly leftPx: number; readonly topPx: number } {
  const parent = element.parentElement;
  if (parent === null) {
    return { leftPx: 0, topPx: 0 };
  }
  const box = element.getBoundingClientRect();
  const outer = parent.getBoundingClientRect();
  return { leftPx: box.left - outer.left - parent.clientLeft, topPx: box.top - outer.top - parent.clientTop };
}

/** Takes the selection out of the flow where it is now drawn (the inspector's "Free"). */
export function freeSelection(): boolean {
  const selected = selectedElements();
  if (selected === undefined) {
    return false;
  }
  const targets = usable(selected.elements).filter((element) => !isFree(element));
  if (targets.length === 0) {
    return false;
  }
  // Measured before any of them leaves the flow: taking one out moves its siblings.
  const places = targets.map((element) => ({ element, ...offset(element), box: element.getBoundingClientRect() }));
  return commitFrame(selected.frame, () => {
    for (const place of places) {
      makeFree(place.element, { leftPx: place.leftPx, topPx: place.topPx, widthPx: place.box.width, heightPx: place.box.height });
    }
    return undefined;
  });
}

const FREE_PROPERTIES = ['position', 'left', 'top', 'right', 'bottom', 'margin', 'width', 'height'] as const;

/** Puts free elements back into their parent's flow, with the position styles the page gave them. */
export function flowSelection(): boolean {
  const selected = selectedElements();
  if (selected === undefined) {
    return false;
  }
  const baseline = frameBaseline(selected.frame)?.document;
  const targets = usable(selected.elements).filter((element) => element.hasAttribute(FREE_ATTRIBUTE) || isFree(element));
  if (targets.length === 0) {
    return false;
  }
  return commitFrame(selected.frame, () => {
    for (const element of targets) {
      const id = element.getAttribute('data-dm-id');
      const original = id === null || baseline === undefined ? undefined : baseline.querySelector(`[data-dm-id="${id}"]`);
      for (const property of FREE_PROPERTIES) {
        setInlineStyle(element, property, original === undefined || original === null ? '' : inlineStyleOf(original, property));
      }
      element.removeAttribute(FREE_ATTRIBUTE);
    }
    return undefined;
  });
}

/** Sets one style on every selected element. `live` changes the document without an undo step (a scrub in progress). */
export function styleSelection(property: string, value: string): boolean {
  const selected = selectedElements();
  if (selected === undefined || selected.elements.length === 0) {
    return false;
  }
  return commitFrame(selected.frame, () => {
    for (const element of selected.elements) {
      setInlineStyle(element, property, value);
    }
    return undefined;
  });
}

/** Shows a style while it is still being chosen (a colour picker dragging): the step is taken by the `styleSelection` that ends it. */
export function previewStyle(property: string, value: string): void {
  const selected = selectedElements();
  if (selected === undefined) {
    return;
  }
  if (!isLive()) {
    beginLive(selected.frame);
  }
  for (const element of selected.elements) {
    setInlineStyle(element, property, value);
  }
  bump();
}

/** Removes every inline style the design gave the selection, back to the style attribute the page had. */
export function clearSelectionStyles(): boolean {
  const selected = selectedElements();
  if (selected === undefined) {
    return false;
  }
  const baseline = frameBaseline(selected.frame)?.document;
  return commitFrame(selected.frame, () => {
    for (const element of selected.elements) {
      const id = element.getAttribute('data-dm-id');
      const original = id === null || baseline === undefined ? undefined : (baseline.querySelector(`[data-dm-id="${id}"]`) ?? undefined);
      const style = original?.getAttribute('style') ?? undefined;
      if (style === undefined) {
        element.removeAttribute('style');
      } else {
        element.setAttribute('style', style);
      }
      element.removeAttribute(FREE_ATTRIBUTE);
    }
    return undefined;
  });
}

export function resetSelection(): boolean {
  const selected = selectedElements();
  const baseline = selected === undefined ? undefined : frameBaseline(selected.frame)?.document;
  if (selected === undefined || baseline === undefined) {
    return false;
  }
  return commitFrame(selected.frame, () => {
    for (const element of usable(selected.elements)) {
      resetElement(element, baseline);
    }
    return undefined;
  });
}

export function selectParent(): boolean {
  const selected = selectedElements();
  const parent = selected?.elements[0]?.parentElement;
  if (selected === undefined || parent === null || parent === undefined || parent.tagName === 'HTML') {
    return false;
  }
  if (parent.tagName === 'BODY') {
    select(undefined);
    return true;
  }
  const id = designIdOf(parent);
  select(id === undefined ? undefined : { frame: selected.frame, ids: [id] });
  return true;
}

// ---------------------------------------------------------------------------
// Copy and paste between frames: a clipboard of Design mode's own, never the system's
// ---------------------------------------------------------------------------

let clipboard: readonly string[] = [];

export function copySelection(): boolean {
  const selected = selectedElements();
  if (selected === undefined) {
    return false;
  }
  clipboard = usable(selected.elements).map((element) => element.outerHTML);
  return clipboard.length > 0;
}

export function hasCopied(): boolean {
  return clipboard.length > 0;
}

/** Pastes after the selection of `frame` (or at the end of its page), as copies with new ids. */
export function pasteInto(frame: FrameId): boolean {
  const document = frameDocument(frame);
  if (document === undefined || clipboard.length === 0) {
    return false;
  }
  const selected = selectedElements();
  const anchor = selected?.frame === frame ? usable(selected.elements).at(-1) : undefined;
  const parent = anchor?.parentElement ?? document.querySelector('main') ?? document.body;
  if (parent === null) {
    return false;
  }
  const html = clipboard.join('');
  return commitFrame(frame, (target, mint) => {
    const fragment = parseFragment(target, html);
    const tops = [...fragment.children];
    for (const top of tops) {
      renumberCopy(top, mint);
    }
    insertAt(parent, fragment, anchor?.nextSibling ?? undefined);
    return tops;
  });
}

/** Inserts markup a tool made into `frame`, inside `parent` before `before`, and selects it. */
export function insertMarkup(
  frame: FrameId,
  parent: Element,
  before: Node | undefined,
  html: string,
  origin: 'text' | 'box' | 'image' | 'component',
  afterInsert?: (tops: readonly Element[]) => void,
): readonly Element[] {
  let made: readonly Element[] = [];
  commitFrame(frame, (target, mint) => {
    const fragment = parseFragment(target, html);
    made = insertFragment(parent, before, fragment, mint, origin);
    afterInsert?.(made);
    return made;
  });
  return made;
}

/** The selection's elements, outermost first; at most the selection bound. */
export function selectionTargets(): readonly Element[] {
  const selected = selectedElements();
  return selected === undefined ? [] : usable(selected.elements).slice(0, DESIGN_LIMITS.selectionMax);
}
