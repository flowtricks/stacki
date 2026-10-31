// Text a page hands to a component instance — its slot content, or one of its
// props — marked on the canvas with a dashed outline while that instance is
// selected, so it reads as editable before anything is clicked. A double
// click types in it (frameText.ts).
//
// Under the pointer it behaves like an element: the app draws its hover
// outline, and once clicked its selection outline, with the instance's own
// outline stepping back to a parent's (PreviewOverlays.tsx). The text has no
// page node for the app to measure — a component may even strip the markers
// around it — so this reports the hovered and picked boxes itself
// (`avb:text-marks`). The dashed marks at rest are drawn here, in the page, so
// they sit on the element exactly and move with it; they take no clicks, step
// aside for the text being typed in, and are hidden whenever the canvas is
// not selecting.

import type { CanvasTextCatalog, CanvasTextTarget } from '../../shared/properties/canvasText';
import { assert } from '../../shared/core/assert';
import { elementsWithPath, pathsOf } from './frameRegions';
import { matchCanvasText } from './frameTextMatch';

// Matches made at most per question; a page with more marked text marks the first ones.
const MATCHES_MAX = 200;

interface MarkSource {
  readonly catalog: () => CanvasTextCatalog | undefined;
  readonly editing: () => string | undefined;
  /** The element of the text being typed in: its words no longer match the catalog's. */
  readonly editingElement: () => Element | undefined;
  readonly focus: () => ReadonlySet<string>;
  readonly visible: () => boolean;
  readonly post: (message: unknown) => void;
}

interface TextMatchAt {
  readonly target: CanvasTextTarget;
  readonly element: Element;
}

export function installTextMarks(source: MarkSource): () => void {
  const layer = document.createElement('div');
  layer.setAttribute('data-avb-text-marks', '');
  layer.style.cssText =
    'position:fixed;inset:0;pointer-events:none;z-index:2147483646;contain:strict;';
  let frame = 0;
  let pointer: { readonly x: number; readonly y: number } | undefined;
  // The text clicked while its instance stays selected, by catalog key.
  let picked: string | undefined;
  let reported = '';
  const draw = () => {
    frame = 0;
    const shown = markedNow(source);
    // The text being typed in is the picked one for as long as the editor is
    // open: the app draws it and its parent in their editing look.
    const editing = source.editing();
    const typing = shown.some(({ target }) => target.key === editing);
    picked = typing
      ? editing
      : shown.some(({ target }) => target.key === picked)
        ? picked
        : undefined;
    const at = pointer;
    const hover = at ? shown.find(({ element }) => holds(element, at)) : undefined;
    const chosen = shown.find(({ target }) => target.key === picked);
    if (!layer.isConnected) {
      document.documentElement.appendChild(layer);
    }
    layer.replaceChildren(
      ...shown
        .filter((match) => match !== hover && match !== chosen)
        .map(({ element }) => dashedMark(element.getBoundingClientRect())),
    );
    const message = { type: 'avb:text-marks', hover: report(hover), picked: report(chosen) };
    const text = JSON.stringify(message);
    if (text !== reported) {
      reported = text;
      source.post(message);
    }
  };
  const schedule = () => {
    if (!frame) {
      frame = requestAnimationFrame(draw);
    }
  };
  window.addEventListener('pointermove', (event) => {
    pointer = { x: event.clientX, y: event.clientY };
    schedule();
  });
  // The preload installs this before the page has a root element, so leaving
  // the page is heard on the window: a pointer out with nowhere to go.
  window.addEventListener('pointerout', (event) => {
    if (event.relatedTarget === null) {
      pointer = undefined;
      schedule();
    }
  });
  window.addEventListener(
    'click',
    (event) => {
      const at = { x: event.clientX, y: event.clientY };
      picked = markedNow(source).find(({ element }) => holds(element, at))?.target.key;
      schedule();
    },
    true,
  );
  window.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  document.addEventListener('avb:morphed', schedule);
  return schedule;
}

// The marked text of the selected instance, one match per element.
function markedNow(source: MarkSource): TextMatchAt[] {
  const focus = source.focus();
  if (!source.visible()) {
    return [];
  }
  // Typing changes the words, so the text being edited is found by the editor's
  // own element rather than by matching what the catalog says it reads.
  const editing = source.editing();
  const element = source.editingElement();
  const typed = source.catalog()?.targets.find((target) => target.key === editing);
  const typing = typed && element && marked(typed, focus) ? [{ target: typed, element }] : [];
  const others = matchesWhere(
    source.catalog(),
    (target) => marked(target, focus) && target.key !== editing,
  );
  // Text whose element is the instance's own root — a Heading's words in its
  // <h2> — is the selection itself, not something inside it: no second
  // outline or tag is drawn over the selection's.
  return [...typing, ...others].filter(
    (match) => !pathsOf(match.element).includes(match.target.scope ?? ''),
  );
}

function dashedMark(box: DOMRect): HTMLElement {
  const mark = document.createElement('div');
  mark.style.cssText =
    `position:absolute;left:${box.left}px;top:${box.top}px;` +
    `width:${box.width}px;height:${box.height}px;` +
    'border:1px dashed #30c158;border-radius:2px;box-sizing:border-box;';
  return mark;
}

// A hovered or picked text as the app draws it: its element's box, named for
// the component whose root it is, or else for its class or tag.
function report(match: TextMatchAt | undefined) {
  if (!match) {
    return undefined;
  }
  const box = match.element.getBoundingClientRect();
  return { x: box.left, y: box.top, w: box.width, h: box.height, ...labelOf(match.element) };
}

function labelOf(element: Element): { readonly label: string; readonly kind: string } {
  // An element tagged from two files is a component's root, rendered by that
  // component and placed by the file that uses it: `Heading.astro|0` and
  // `Slider.astro|0.1` on one <h2>. The first is the component's own.
  const files = pathsOf(element).flatMap((path) => {
    const at = path.lastIndexOf('|');
    return at > 0 ? [path.slice(0, at)] : [];
  });
  const owner = files[0];
  if (owner !== undefined && new Set(files).size > 1) {
    const name = owner.slice(owner.lastIndexOf('/') + 1).replace(/\.astro$/, '');
    return { label: name, kind: 'component' };
  }
  return { label: element.classList[0] ?? element.localName, kind: 'text' };
}

// Where each accepted target's text renders: the element holding it, found
// the way a double click on the words finds it, once per element.
function matchesWhere(
  catalog: CanvasTextCatalog | undefined,
  accept: (target: CanvasTextTarget) => boolean,
): TextMatchAt[] {
  const found: TextMatchAt[] = [];
  const seen = new Set<Element>();
  for (const target of catalog?.targets ?? []) {
    if (!accept(target)) {
      continue;
    }
    for (const parent of elementsWithPath(target.parent)) {
      if (found.length >= MATCHES_MAX) {
        return found;
      }
      if (!withinScope(parent, target)) {
        continue;
      }
      const match = matchCanvasText(target, wordsIn(parent, target) ?? parent);
      const element = match?.element;
      if (!element || seen.has(element) || !hasBox(element)) {
        continue;
      }
      seen.add(element);
      found.push({ target, element });
    }
  }
  assert(found.length <= MATCHES_MAX, 'Marked text stays within its bound');
  return found;
}

// The element directly holding a text node that reads the target's words.
function wordsIn(parent: Element, target: CanvasTextTarget): Element | undefined {
  const words = folded(target.value);
  const walker = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  for (let count = 0; node && count < 2_000; count++) {
    if (folded(node.textContent ?? '') === words) {
      return node.parentElement ?? undefined;
    }
    node = walker.nextNode();
  }
  return undefined;
}

function folded(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function hasBox(element: Element): boolean {
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
}

function holds(element: Element, point: { readonly x: number; readonly y: number }): boolean {
  const box = element.getBoundingClientRect();
  return point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
}

/** Whether a target is marked: slot or prop text of the selected instance. */
export function marked(target: CanvasTextTarget, focus: ReadonlySet<string>): boolean {
  if (target.from === undefined || target.scope === undefined) {
    return false;
  }
  return focus.has(target.scope);
}

/** Whether an element sits inside the page instance a target belongs to. */
export function withinScope(element: Element, target: CanvasTextTarget): boolean {
  if (target.scope === undefined) {
    return true;
  }
  let ancestor: Element | undefined = element;
  for (let depth = 0; ancestor && depth < 64; depth++) {
    if (pathsOf(ancestor).includes(target.scope)) {
      return true;
    }
    ancestor = ancestor.parentElement ?? undefined;
  }
  return false;
}
