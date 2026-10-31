// Finding a text run that has no markers of its own.
//
// An inline run — `The way <strong>we</strong> change` — is written on one
// line with no markers in it, because the newlines around a marker render as
// spaces between words (astroSerializeMarked.ts). Its elements still carry
// their paths as attributes; its text runs carry nothing. So a selected text
// run measured no box and drew no outline, though the words were on screen.
//
// The run is still findable. The model and the markup agree on order: the
// parent's tagged element holds the run's children in sequence, and every
// element among them is tagged with its own path. The text at index k is
// therefore the text between the tagged sibling before it and the one after.
// The answer is only claimed where it is certain to be k's alone: right after
// the sibling at k - 1 (or the start), and up to the sibling at k + 1 (or the
// end). An index two past the last tagged sibling is not claimed, because an
// unmarked expression may sit between them.

import { assert } from '../../shared/core/assert';
import { isElement, isText } from './frameBasics';
import { elementsWithPath, pathsOf, runsOf } from './frameRegions';

// Bounds on the walk: siblings scanned per container, and containers per path.
const INLINE_LIMITS = { childrenMax: 4096, containersMax: 256, descendantsMax: 4096 } as const;

interface InlinePlace {
  readonly parent: string;
  readonly index: number;
}

/** The parent path and child index of a path, or undefined for a root. */
export function inlinePlace(nodePath: string): InlinePlace | undefined {
  const dot = nodePath.lastIndexOf('.');
  if (dot <= 0) {
    return undefined;
  }
  const parent = nodePath.slice(0, dot);
  const digits = nodePath.slice(dot + 1);
  if (!/^\d+$/.test(digits)) {
    return undefined;
  }
  const index = Number(digits);
  if (!Number.isSafeInteger(index)) {
    return undefined;
  }
  assert(parent.length > 0, 'An inline place has a parent path');
  assert(index >= 0, 'An inline place has a non-negative index');
  return { parent, index };
}

/**
 * The text nodes of an unmarked text run, grouped by the place they render
 * (one group per occurrence of the parent). Empty when the run can't be
 * placed with certainty.
 */
export function inlineTextRuns(nodePath: string): Text[][] {
  const place = inlinePlace(nodePath);
  if (!place) {
    return [];
  }
  const containers = parentContainers(place.parent).slice(0, INLINE_LIMITS.containersMax);
  const out: Text[][] = [];
  for (const container of containers) {
    const run = textInContainer(container, place);
    if (run.length > 0) {
      out.push(run);
    }
  }
  return out;
}

// The elements the parent renders as. Its marker runs are already held, so
// they are read first; the document is only searched for a parent that is
// known by its tag alone. Re-measuring runs on every scroll, and a scroll must
// not walk the page (test/electron/preload/hoverCost.test.js).
function parentContainers(parent: string): Element[] {
  const fromRuns = (runsOf(parent) ?? []).flatMap((run) => run.filter(isElement));
  return fromRuns.length ? fromRuns : elementsWithPath(parent);
}

// The child index an element is tagged with under `parent`, if any.
function siblingIndex(element: Element, parent: string): number | undefined {
  const prefix = parent + '.';
  for (const token of pathsOf(element)) {
    if (token.startsWith(prefix)) {
      const place = inlinePlace(token);
      if (place?.parent === parent) {
        return place.index;
      }
    }
  }
  return undefined;
}

// The element whose children are the run: the parent of a tagged sibling when
// there is one (a component may wrap its slot in elements of its own), else
// the container itself.
function runHost(container: Element, parent: string): Element | undefined {
  const tagged = container.querySelectorAll('[data-avb-p]');
  const count = Math.min(tagged.length, INLINE_LIMITS.descendantsMax);
  for (let at = 0; at < count; at += 1) {
    const element = tagged.item(at);
    assert(element !== null, 'A tagged descendant within the count exists');
    if (siblingIndex(element, parent) !== undefined) {
      return element.parentElement ?? undefined;
    }
  }
  return container;
}

function textInContainer(container: Element, place: InlinePlace): Text[] {
  const host = runHost(container, place.parent);
  if (!host) {
    return [];
  }
  const children = Array.from(host.childNodes);
  if (children.length > INLINE_LIMITS.childrenMax) {
    return [];
  }
  // The tagged sibling just before the gap; -1 is the start of the run.
  let before = -1;
  let gap: Text[] = [];
  for (const child of children) {
    const index = isElement(child) ? siblingIndex(child, place.parent) : undefined;
    if (index === undefined) {
      if (before === place.index - 1) {
        if (isText(child)) {
          if (child.data.trim()) {
            gap.push(child);
          }
        }
      }
      continue;
    }
    if (before === place.index - 1) {
      // The gap closes at the next tagged sibling: k's only if that is k + 1.
      return index === place.index + 1 ? gap : [];
    }
    // Out of order is the page's doing — a script moved them, or a loop
    // repeated them — not ours to crash on; it only means this run is unsure.
    if (index <= before) {
      return [];
    }
    before = index;
    gap = [];
  }
  // The end of the run closes the gap. Nothing after k is known to be absent,
  // but no tagged sibling follows either, and an index past it is not claimed.
  return before === place.index - 1 ? gap : [];
}

/**
 * The path of the unmarked text run under a point, when that run sits beside
 * tagged siblings inside the element `parent` names — the words around a
 * <strong>. A run that is its element's only content is not reported: there
 * the element is what is being pointed at, as it always was.
 */
export function inlineTextPathAt(parent: string, x: number, y: number): string | undefined {
  // Not every engine has it (jsdom does not); without it nothing is reported.
  if (typeof document.caretRangeFromPoint !== 'function') {
    return undefined;
  }
  const range = document.caretRangeFromPoint(x, y);
  const text = range?.startContainer;
  if (!text || !isText(text) || !text.data.trim() || !text.parentElement) {
    return undefined;
  }
  if (!textHoldsPoint(text, x, y)) {
    return undefined;
  }
  const index = unmarkedIndex(text, parent);
  return index === undefined ? undefined : `${parent}.${index}`;
}

// The caret lands on the nearest text even from blank space; only a point on
// the words themselves counts.
function textHoldsPoint(text: Text, x: number, y: number): boolean {
  const range = document.createRange();
  range.selectNodeContents(text);
  for (const box of Array.from(range.getClientRects())) {
    if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) {
      return true;
    }
  }
  return false;
}

// The child index of an unmarked text among tagged siblings of `parent`, by
// the same rule inlineTextRuns places it: right after the sibling before it,
// and claimed only where the sibling after it (if any) is the next index.
function unmarkedIndex(text: Text, parent: string): number | undefined {
  const host = text.parentElement;
  assert(host !== null, 'A text under the pointer has an element');
  const children = Array.from(host.childNodes);
  if (children.length > INLINE_LIMITS.childrenMax) {
    return undefined;
  }
  let before = -1;
  let tagged = 0;
  let index: number | undefined;
  for (const child of children) {
    const sibling = isElement(child) ? siblingIndex(child, parent) : undefined;
    if (child === text) {
      index = before + 1;
    } else if (sibling !== undefined) {
      tagged += 1;
      if (index !== undefined) {
        return tagged > 0 && sibling === index + 1 ? index : undefined;
      }
      if (sibling <= before) {
        return undefined;
      }
      before = sibling;
    }
  }
  return index !== undefined && tagged > 0 ? index : undefined;
}
