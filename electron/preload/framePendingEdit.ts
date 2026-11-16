// An edit to a node the canvas already shows appears the moment it is made: an attribute set or
// removed (a class, a prop on a plain element, a renamed attribute), the words of an element, a
// renamed tag. What the server must render (a component's props, an expression) keeps the old DOM
// and, after a short wait, says the element is updating: never a blank, never a flash.
//
// Same contract as a reorder or an insert shown ahead of its write (frameMove.ts, framePendingInsert.ts):
// the changes are real DOM changes, so structural and attribute selectors re-evaluate in the same
// frame; the morph client takes them back just before it patches and draws them again right after
// a render of the old source (judged by the source stamps); a refused write takes them back; a
// bound ends the wait. Words are never set on an element the person is typing in. Nothing here
// writes a file.

import { assert } from '../../shared/core/assert';
import { parseCanvasEdits, type CanvasEdit } from '../../shared/page/canvasEdit';
import { sourceStamps } from './frameMove';
import { allElementsWithPath } from './frameRegions';

export const FRAME_EDIT_LIMITS = {
  /** Edits shown at once before the page confirms any. */
  pendingMax: 256,
  /** How long a shown edit waits for the rendering that confirms it. */
  holdMs: 20_000,
  /** How long an element waits for its render before it says it is updating. */
  updatingAfterMs: 80,
  /** Elements one edit touches (a node in a loop is one element per item). */
  elementsMax: 1024,
} as const satisfies Record<string, number>;

export const UPDATING_ATTRIBUTE = 'data-avb-updating';

interface Shown {
  readonly edit: CanvasEdit;
  readonly undo: () => void;
}

let shown: Shown[] = [];
let shownFrom: string | undefined;
let holdTimer: ReturnType<typeof setTimeout> | undefined;
let updatingTimer: ReturnType<typeof setTimeout> | undefined;
let updatingPaths: string[] = [];
let stylesheet: CSSStyleSheet | undefined;

/** Shows the edits now; returns how many changed the page (or will mark it updating). */
export function showCanvasEdits(input: unknown): number {
  const edits = parseCanvasEdits(input);
  if (edits === undefined || edits.length === 0) {
    return 0;
  }
  const stamps = shown.length === 0 ? sourceStamps(document) : shownFrom;
  let count = 0;
  for (const edit of edits) {
    if (shown.length >= FRAME_EDIT_LIMITS.pendingMax) {
      break;
    }
    const entry = applyEdit(edit);
    if (entry !== undefined) {
      shown = [...shown, entry];
      count += 1;
    }
  }
  if (count > 0) {
    shownFrom = stamps;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(revertCanvasEdits, FRAME_EDIT_LIMITS.holdMs);
    announce();
  }
  return count;
}

/** Takes every shown edit back: the write was refused, or never rendered. */
export function revertCanvasEdits(): void {
  const had = shown.length > 0;
  takeBack();
  forget();
  if (had) {
    announce();
  }
}

export function canvasEditsPending(): boolean {
  return shown.length > 0;
}

/** The patcher's two moments (morphClient.ts): before it patches, and after. */
export function listenForCanvasEdits(): void {
  let replay: readonly CanvasEdit[] = [];
  document.addEventListener('avb:before-morph', (event) => {
    if (shown.length === 0) {
      replay = [];
      return;
    }
    const incoming = event instanceof CustomEvent && event.detail instanceof Document ? sourceStamps(event.detail) : undefined;
    const stale = shownFrom !== undefined && shownFrom !== '' && incoming === shownFrom;
    replay = stale ? shown.map((entry) => entry.edit) : [];
    takeBack();
    if (!stale) {
      forget();
    }
  });
  document.addEventListener('avb:after-patch', () => {
    const edits = replay;
    replay = [];
    if (edits.length === 0) {
      return;
    }
    const kept: Shown[] = [];
    for (const edit of edits) {
      const entry = applyEdit(edit);
      if (entry !== undefined) {
        kept.push(entry);
      }
    }
    shown = kept;
    if (kept.length === 0) {
      forget();
    }
  });
}

// --- Internals ---------------------------------------------------------------------

function forget(): void {
  clearTimeout(holdTimer);
  holdTimer = undefined;
  shown = [];
  shownFrom = undefined;
  clearUpdating();
}

function takeBack(): void {
  for (let index = shown.length - 1; index >= 0; index -= 1) {
    shown[index]?.undo();
  }
  shown = [];
  clearUpdating();
}

function announce(): void {
  document.dispatchEvent(new CustomEvent('avb:morphed', { detail: undefined }));
}

function elementsAt(path: string): Element[] {
  const found = allElementsWithPath(path);
  return found.length > FRAME_EDIT_LIMITS.elementsMax ? [] : found;
}

function applyEdit(edit: CanvasEdit): Shown | undefined {
  switch (edit.kind) {
    case 'attributes':
      return applyAttributes(edit);
    case 'text':
      return applyText(edit);
    case 'tag':
      return applyTag(edit);
    case 'updating':
      return applyUpdating(edit);
    default: {
      const exhaustive: never = edit;
      return exhaustive;
    }
  }
}

function applyAttributes(edit: Extract<CanvasEdit, { kind: 'attributes' }>): Shown | undefined {
  const elements = elementsAt(edit.path);
  if (elements.length === 0) {
    return undefined;
  }
  const previous = elements.map((element) => ({
    element,
    values: new Map([...edit.set.map(([name]) => name), ...edit.remove].map((name) => [name, element.getAttribute(name) ?? undefined] as const)),
  }));
  for (const element of elements) {
    for (const [name, value] of edit.set) {
      element.setAttribute(name, value);
    }
    for (const name of edit.remove) {
      element.removeAttribute(name);
    }
  }
  return {
    edit,
    undo: () => {
      for (const { element, values } of previous) {
        for (const [name, value] of values) {
          if (value === undefined) {
            element.removeAttribute(name);
          } else {
            element.setAttribute(name, value);
          }
        }
      }
    },
  };
}

// Words only go into an element that holds nothing but words, and never into one being typed in.
function applyText(edit: Extract<CanvasEdit, { kind: 'text' }>): Shown | undefined {
  const elements = elementsAt(edit.path).filter((element) => element.children.length === 0 && !isBeingTypedIn(element));
  if (elements.length === 0) {
    return undefined;
  }
  const previous = elements.map((element) => ({ element, nodes: Array.from(element.childNodes) }));
  for (const element of elements) {
    element.textContent = edit.text;
  }
  return {
    edit,
    undo: () => {
      for (const { element, nodes } of previous) {
        element.replaceChildren(...nodes);
      }
    },
  };
}

function isBeingTypedIn(element: Element): boolean {
  const active = document.activeElement;
  const editable = element instanceof HTMLElement && element.isContentEditable;
  return editable || (active !== null && element.contains(active));
}

function applyTag(edit: Extract<CanvasEdit, { kind: 'tag' }>): Shown | undefined {
  const elements = elementsAt(edit.path);
  if (elements.length === 0) {
    return undefined;
  }
  const swaps: { readonly old: Element; readonly made: Element }[] = [];
  for (const old of elements) {
    const made = document.createElement(edit.tag);
    for (let at = 0; at < old.attributes.length; at += 1) {
      const attribute = old.attributes.item(at);
      if (attribute !== null) {
        made.setAttribute(attribute.name, attribute.value);
      }
    }
    made.append(...Array.from(old.childNodes));
    old.replaceWith(made);
    swaps.push({ old, made });
  }
  return {
    edit,
    undo: () => {
      for (const { old, made } of swaps) {
        old.append(...Array.from(made.childNodes));
        made.replaceWith(old);
      }
    },
  };
}

// The old DOM stays; the element says it is updating only if the render takes longer than a moment.
function applyUpdating(edit: Extract<CanvasEdit, { kind: 'updating' }>): Shown | undefined {
  if (elementsAt(edit.path).length === 0) {
    return undefined;
  }
  updatingPaths = [...updatingPaths, edit.path];
  clearTimeout(updatingTimer);
  updatingTimer = setTimeout(markUpdating, FRAME_EDIT_LIMITS.updatingAfterMs);
  return { edit, undo: () => undefined };
}

function markUpdating(): void {
  installStyle();
  for (const path of updatingPaths) {
    for (const element of elementsAt(path)) {
      element.setAttribute(UPDATING_ATTRIBUTE, '');
    }
  }
}

function clearUpdating(): void {
  clearTimeout(updatingTimer);
  updatingTimer = undefined;
  updatingPaths = [];
  for (const element of Array.from(document.querySelectorAll(`[${UPDATING_ATTRIBUTE}]`))) {
    element.removeAttribute(UPDATING_ATTRIBUTE);
  }
  assert(document.querySelector(`[${UPDATING_ATTRIBUTE}]`) === null, 'clearUpdating: no element still says it is updating');
}

function installStyle(): void {
  if (stylesheet !== undefined && document.adoptedStyleSheets.includes(stylesheet)) {
    return;
  }
  stylesheet = new CSSStyleSheet();
  stylesheet.replaceSync(`[${UPDATING_ATTRIBUTE}] { opacity: 0.82; transition: opacity 150ms ease-out; }`);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, stylesheet];
}
