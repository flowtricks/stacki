// Text a page hands to a component instance — its slot content, or one of its
// props — marked on the canvas with a dashed outline while that instance is
// selected, so it reads as editable before anything is clicked. A double
// click types in it (frameText.ts). Its hover needs no selection: pointing at
// the words of any instance outlines them and names them at once.
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

import type { CanvasTextBlocked, CanvasTextCatalog, CanvasTextTarget } from '../../shared/properties/canvasText';
import { assert } from '../../shared/core/assert';
import { ownershipOf, type Ownership } from '../../shared/properties/outlineOwnership';
import { isEditableThroughProps, textReach } from '../../shared/properties/closedComponentReach';
import { elementsWithPath, pathsOf, runsOf } from './frameRegions';
import { inlineTextRuns } from './inlineText';
import { ownClasses } from './frameMeasure';
import { elementsAt, matchCanvasText } from './frameTextMatch';

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
  /** The text nodes that read the words; empty for the words being typed in, which the editor's element stands for. */
  readonly nodes: readonly Text[];
}

export function installTextMarks(source: MarkSource): () => void {
  const layer = document.createElement('div');
  layer.setAttribute('data-avb-text-marks', '');
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;contain:strict;';
  let frame = 0;
  let pointer: { readonly x: number; readonly y: number } | undefined;
  // A button held while the pointer moves is a drag or a resize in flight: nothing is hovered until it ends. (The interaction
  // module's own drag flag stays set after a click's pointer has moved on, so it cannot say whether a drag is going on now.)
  let held = false;
  // The text clicked while its instance stays selected, by catalog key.
  let picked: string | undefined;
  // A click on prop text whose instance is not yet the selection: the click selects the instance and picks the words at once, but
  // the app's selection arrives a message later, so the pick waits for it instead of being dropped by the next frame.
  let awaiting: { readonly key: string; readonly scope: string } | undefined;
  let reported = '';
  const draw = () => {
    frame = 0;
    const shown = markedNow(source);
    // The text being typed in is the picked one for as long as the editor is
    // open: the app draws it and its parent in their editing look.
    const editing = source.editing();
    const typing = shown.some(({ target }) => sameKey(target.key, editing));
    if (awaiting !== undefined && source.focus().has(awaiting.scope)) {
      awaiting = undefined; // The selection arrived: the words are among the instance's marked ones now.
    }
    picked = typing
      ? shown.find(({ target }) => sameKey(target.key, editing))?.target.key
      : shown.some(({ target }) => target.key === picked) || awaiting?.key === picked
        ? picked
        : undefined;
    const at = held ? undefined : pointer;
    // The selected instance's marked words first; otherwise any prop text under the pointer, selected or not.
    const hover = at ? (shown.find((match) => holds(wordsBox(match), at) && reachable(match, at)) ?? hoverBeforeSelect(source, at)) : undefined;
    const chosen =
      shown.find(({ target }) => target.key === picked) ??
      (awaiting === undefined ? undefined : matchesWhere(source.catalog(), (target) => target.key === awaiting?.key)[0]);
    if (!layer.isConnected) {
      document.documentElement.appendChild(layer);
    }
    // Words a closed component writes itself (no prop or slot of the instance reaches them) get nothing: the pointer on them
    // is the component's own hover (closedComponentReach.ts).
    const refused = at && hover === undefined ? refusedAt(source, at) : undefined;
    // Prop text printed from data (a loop item's title) is marked like any prop text; the one under the pointer is drawn by the app.
    const bound = boundBoxesNow(source).filter((box) => !sameBox(box, refused));
    layer.replaceChildren(
      ...shown.filter((match) => match !== hover && match !== chosen).map((match) => dashedMark(wordsBox(match))),
      ...bound.map(dashedMark),
    );
    // Hovering words draws no outline of their own: a component's own direct text (prop text, slot text its root or its wrapper prints)
    // is the component's, so the pointer on it is the instance's hover, and only a separate child tag the page wrote (a `strong`)
    // is outlined, as the node it is. The words stay hit-testable here for the click, which picks them. A refused prop text is the
    // one hover reported, because it says why a double click opens nothing.
    const message = { type: 'avb:text-marks', hover: refused, picked: report(chosen) };
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
    held = event.buttons !== 0;
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
      const hit = markedNow(source).find((match) => holds(wordsBox(match), at) && reachable(match, at)) ?? hoverBeforeSelect(source, at);
      picked = hit?.target.key;
      const scope = hit?.target.scope;
      awaiting = hit !== undefined && scope !== undefined && !source.focus().has(scope) ? { key: hit.target.key, scope } : undefined;
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
  const typed = source.catalog()?.targets.find((target) => sameKey(target.key, editing));
  // Whether its instance is the selection yet or not (the app's selection can arrive after the editor opens), the words being typed in are picked.
  const typing = typed && element ? [{ target: typed, element, nodes: [] }] : [];
  const others = matchesWhere(source.catalog(), (target) => marked(target, focus) && !sameKey(target.key, editing));
  // Text whose element is the instance's own root — a Heading's words in its
  // <h2> — is the selection itself, not something inside it: no second
  // outline or tag is drawn over the selection's. A root that frames its words
  // (a Button's `<a>` with padding around its slot) is not its words: they get
  // their own outline, hugging them.
  return [...typing, ...others].filter((match) => !isInstanceRoot(match.element, match.target.scope) || drawnAsRun(match));
}

// Whether the pointer's real target (the browser's own hit test, which knows z-index, stacking, pointer-events, clipping and
// transforms) delivers to these words: the topmost element at the point is the words' element or inside it, or it lies inside the
// words' own instance (a stretched link laid over a card's words). Words a sibling covers, or that take no pointer, are not hovered.
function reachable(match: TextMatchAt, at: { readonly x: number; readonly y: number }): boolean {
  // An engine with no hit test (a test DOM) cannot say what covers what, so nothing is covered.
  if (typeof document.elementsFromPoint !== 'function' && typeof document.elementFromPoint !== 'function') {
    return true;
  }
  const top = elementsAt(at.x, at.y)[0];
  if (top === undefined) {
    return false;
  }
  if (match.element.contains(top)) {
    return true;
  }
  return match.target.scope !== undefined && withinScope(top, match.target);
}

// Prop or slot text under the pointer (a prop's words, or the words the page writes inside the instance), whether or not its instance is selected: the words a double click would edit once the component is
// the selection. Only targets whose instance and element are on the pointer's own ancestor chain are matched, so a catalog of
// thousands costs a set lookup each and a match for the few that are near the pointer.
function hoverBeforeSelect(source: MarkSource, at: { readonly x: number; readonly y: number }): TextMatchAt | undefined {
  const catalog = source.catalog();
  if (!catalog || !source.visible()) {
    return undefined;
  }
  const ancestors = ancestorPaths(at);
  if (ancestors.size === 0) {
    return undefined;
  }
  let best: TextMatchAt | undefined;
  for (const target of catalog.targets) {
    if (target.from === undefined || target.scope === undefined || !ancestors.has(target.scope) || !ancestors.has(target.parent)) {
      continue;
    }
    if (!isEditableThroughProps(textReach({ loaded: true, covering: target }))) {
      continue;
    }
    for (const match of matchesWhere(catalog, (candidate) => candidate === target)) {
      // Words held by an element that carries the instance's own path are the component itself (its hover is the hover),
      // unless that element is the instance's root and frames them: a Button's `<a><slot /></a>` with padding around the words.
      if (pathsOf(match.element).includes(target.scope) && !drawnAsRun(match)) {
        continue;
      }
      if (!holds(wordsBox(match), at) || !reachable(match, at)) {
        continue;
      }
      // Nested words: the innermost box under the pointer is the one named.
      if (best === undefined || best.element.contains(match.element)) {
        best = match;
      }
    }
  }
  return best;
}

// Text a prop of the instance prints from code that leads to no one string (`body={entry.body}` printed as HTML): a prop
// decides it, so it is hovered and named as refused, and its double click says where to edit it. Words no prop reaches are
// not looked for here or anywhere: the component writes them itself, and the canvas offers nothing for them.
function refusedAt(source: MarkSource, at: { readonly x: number; readonly y: number }) {
  const catalog = source.catalog();
  if (!catalog?.blocked || !source.visible()) {
    return undefined;
  }
  assert(isEditableThroughProps(textReach({ loaded: true, covering: { from: 'prop' } })), 'Text a prop prints is the instance’s to change');
  for (const entry of catalog.blocked.filter(isPropBlocked)) {
    for (const element of blockedElements(entry)) {
      const box = element.getBoundingClientRect();
      if (holds(box, at)) {
        return { x: box.left, y: box.top, w: box.width, h: box.height, label: labelOf(element).label, kind: 'refused' };
      }
    }
  }
  return undefined;
}

function isPropBlocked(entry: CanvasTextBlocked): boolean {
  return /(^|:)prop:/.test(entry.key);
}

// The elements that print a blocked text, one per copy of its instance: found by the source path of the words, since the words
// themselves are unknown (data) or differ per copy (a loop).
function blockedElements(entry: CanvasTextBlocked): Element[] {
  const found: Element[] = [];
  const runs = [...(runsOf(entry.path) ?? []), ...inlineTextRuns(entry.path)];
  for (const run of runs.slice(0, MATCHES_MAX)) {
    const element = run[0]?.parentElement;
    if (
      element &&
      element.getBoundingClientRect().width > 0 &&
      run.every((node) => node.parentElement === element) &&
      (entry.scope === undefined || insideScope(element, entry.scope)) &&
      !found.includes(element)
    ) {
      found.push(element);
    }
  }
  assert(found.length <= MATCHES_MAX, 'Blocked marks stay within their bound');
  return found;
}

// The dashed boxes of the selected instance's data-bound prop text: every copy of it that is on the page.
function boundBoxesNow(source: MarkSource): DOMRect[] {
  const catalog = source.catalog();
  if (!catalog?.blocked || !source.visible()) {
    return [];
  }
  const focus = source.focus();
  const boxes: DOMRect[] = [];
  for (const entry of catalog.blocked.filter(isPropBlocked)) {
    if (entry.scope === undefined || !focus.has(entry.scope)) {
      continue;
    }
    for (const element of blockedElements(entry)) {
      if (boxes.length < MATCHES_MAX) {
        boxes.push(element.getBoundingClientRect());
      }
    }
  }
  return boxes;
}

function sameBox(box: DOMRect, reported: { readonly x: number; readonly y: number; readonly w: number; readonly h: number } | undefined): boolean {
  return reported !== undefined && box.left === reported.x && box.top === reported.y && box.width === reported.w && box.height === reported.h;
}

// The paths of the element under a point and of everything around it.
function ancestorPaths(at: { readonly x: number; readonly y: number }): Set<string> {
  const paths = new Set<string>();
  for (const start of elementsAt(at.x, at.y)) {
    let element: Element | undefined = start;
    for (let depth = 0; element && depth < 64; depth++) {
      for (const path of pathsOf(element)) {
        paths.add(path);
      }
      element = element.parentElement ?? undefined;
    }
  }
  return paths;
}

// The editor's key for the words and the catalog's can differ by the refresh counter a content scan prefixes (`cms:2:`), so a catalog
// republished while the editor opens still names the words being typed in.
function sameKey(left: string, right: string | undefined): boolean {
  const bare = (key: string) => key.replace(/^cms:\d+:/, '');
  return right !== undefined && bare(left) === bare(right);
}

// Whether an element is the instance's own root, the outermost element carrying its path. The path can also sit on an element
// inside it (a Card's stretched link carries the Card's path), and words in that element are still words inside the instance.
function isInstanceRoot(element: Element, scope: string | undefined): boolean {
  if (scope === undefined || !pathsOf(element).includes(scope)) {
    return false;
  }
  let ancestor = element.parentElement;
  for (let depth = 0; ancestor && depth < 64; depth++) {
    if (pathsOf(ancestor).includes(scope)) {
      return false;
    }
    ancestor = ancestor.parentElement;
  }
  return true;
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
  const box = wordsBox(match);
  // `scope` names the page instance the words belong to, so the app can draw that instance (and no other) as their owner.
  return {
    x: box.left,
    y: box.top,
    w: box.width,
    h: box.height,
    ...labelOf(match.element),
    ...(match.target.scope === undefined ? {} : { scope: match.target.scope }),
    owner: ownerOfWords(match),
  };
}

function labelOf(element: Element): { readonly label: string; readonly kind: string } {
  // An element tagged from two files is a component's root, rendered by that
  // component and placed by the file that uses it: `Heading.astro|0` and
  // `Slider.astro|0.1` on one <h2>. The component's own is the file whose path
  // is a root (`|0`, no dots after the bar). A plain element a component's
  // template wrote deeper (`HomeHero.astro|0.2`) is no component's root, even
  // when another file tags it too: it is named by its class or, with none, its tag.
  const paths = pathsOf(element).filter((path) => path.lastIndexOf('|') > 0);
  const files = new Set(paths.map((path) => path.slice(0, path.lastIndexOf('|'))));
  const rootPath = paths.find((path) => /^\d+$/.test(path.slice(path.lastIndexOf('|') + 1)));
  if (rootPath !== undefined && files.size > 1) {
    const owner = rootPath.slice(0, rootPath.lastIndexOf('|'));
    return { label: owner.slice(owner.lastIndexOf('/') + 1).replace(/\.astro$/, ''), kind: 'component' };
  }
  // A class keeps its dot, as the canvas tag and the navigator spell it.
  const firstClass = ownClasses(element).find((name) => !name.startsWith('astro-'));
  return { label: firstClass === undefined ? element.localName : `.${firstClass}`, kind: 'text' };
}

// Where each accepted target's text renders: the element holding it, found
// the way a double click on the words finds it, once per element.
function matchesWhere(catalog: CanvasTextCatalog | undefined, accept: (target: CanvasTextTarget) => boolean): TextMatchAt[] {
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
      found.push({ target, element, nodes: match.nodes });
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

// Whether words sit directly in their instance's root while that root draws a box around them (padding or a border on any
// side): a Button's `<a class="button"><slot /></a>`. The root is then more than its words, so the words are outlined on
// their own, hugging them, and the pointer on the padding is the component's own hover. A root with neither (a Heading's
// `<h2><slot /></h2>`) is its words: the component's hover is the hover, as before.
function framesWords(match: TextMatchAt): boolean {
  if (match.nodes.length === 0 || !isInstanceRoot(match.element, match.target.scope)) {
    return false;
  }
  assert(
    match.nodes.every((node) => match.element.contains(node)),
    'The words of a match lie inside its element',
  );
  // The element's own window computes its style: the frame's, never another document's.
  const view = match.element.ownerDocument.defaultView;
  if (view === null) {
    return false;
  }
  const style = view.getComputedStyle(match.element);
  return FRAME_SIDES.some((side) => cssLength(style.getPropertyValue(`padding-${side}`)) > 0 || cssLength(style.getPropertyValue(`border-${side}-width`)) > 0);
}

// Whether the words are outlined as a run of their own (the range of their text) rather than as their element: the words a page
// writes into a slot, wherever the component puts them (they are the page's, whatever element draws them), and words a root
// frames (`framesWords`). The element around them stays the component's, drawn by the instance's own outline.
function drawnAsRun(match: TextMatchAt): boolean {
  return match.nodes.length > 0 && (pageWrote(match) || framesWords(match));
}

// Whether the words are text nodes the page wrote into a slot, which the canvas can tell because the preview records the run of
// nodes each page text renders (`runsOf`). Words a component prints from a string (a Button's `set:html={content}`, a prop) have no
// recorded run: they are the component's own output, even when the page's slot is where the string came from.
function pageWrote(match: TextMatchAt): boolean {
  const first = match.nodes[0];
  if (match.target.from !== 'slot' || first === undefined) {
    return false;
  }
  return (runsOf(match.target.path) ?? []).some((run) => run.includes(first));
}

// Who owns what the outline is drawn around (shared/properties/outlineOwnership.ts): the text nodes a page wrote into a slot are the
// page's; any other words are owned as the element that draws them is, by its paths.
function ownerOfWords(match: TextMatchAt): Ownership {
  return pageWrote(match) ? 'slot' : ownershipOf(pathsOf(match.element));
}

const FRAME_SIDES = ['top', 'right', 'bottom', 'left'] as const;

// A computed length in pixels; anything unreadable (a test DOM computes no styles) is no length at all.
function cssLength(value: string): number {
  const pixels = Number.parseFloat(value);
  return Number.isFinite(pixels) ? pixels : 0;
}

// The box the words are drawn in. Words drawn as a run (drawnAsRun) are measured as the words themselves (their range's box),
// never their element's, so the outline hugs the text and not the whole component; any other words are their element's box.
function wordsBox(match: TextMatchAt): DOMRect {
  const first = match.nodes[0];
  const last = match.nodes.at(-1);
  if (first === undefined || last === undefined || !drawnAsRun(match)) {
    return match.element.getBoundingClientRect();
  }
  const range = document.createRange();
  range.setStartBefore(first);
  range.setEndAfter(last);
  const box = range.getBoundingClientRect();
  assert(Number.isFinite(box.width), 'The words have a measurable box');
  return box;
}

function hasBox(element: Element): boolean {
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
}

function holds(box: DOMRect, point: { readonly x: number; readonly y: number }): boolean {
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
  return target.scope === undefined || insideScope(element, target.scope);
}

// A copy of the same component elsewhere on the page carries the same template paths but not this instance's path, so the
// ancestor chain is what tells whose words an element holds.
function insideScope(element: Element, scope: string): boolean {
  let ancestor: Element | undefined = element;
  for (let depth = 0; ancestor && depth < 64; depth++) {
    if (pathsOf(ancestor).includes(scope)) {
      return true;
    }
    ancestor = ancestor.parentElement ?? undefined;
  }
  return false;
}
