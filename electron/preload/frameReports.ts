import { assert } from '../../shared/core/assert';
import { authoredStyleMutation } from './frameAuthoredStyles';
// What the frame tells the app as the page changes: the tracked rectangles,
// following a page that moves by itself, which nodes rendered, their states
// and classes, the opened instance, and the scheduling that keeps all of it to
// one pass per frame. Mutations are classified here, so the frame's own
// writes never trigger a pass.

import { splitPseudoPath, type PseudoLayer } from '../../shared/page/pseudoPath';
import type { Rect, Spacing } from './frameBasics';
import { PROBE_ATTR, isComment, isElement, isText } from './frameBasics';
import {
  PATH_ATTR,
  elementsWithPath,
  focusRoots,
  inFocus,
  inScope,
  pathsOf,
  regions,
  resetFocusCache,
  runsOf,
  taggedPlaces,
  trackedPaths,
} from './frameRegions';
import { STACKI_CLASSES, classesForPath, ownClasses, rectsForPath, resetThinCache, spacingForPath } from './frameMeasure';

// The boxes as last reported, so the watcher below can tell whether the page
// has moved since — see `followMotion`.
let lastSentRects: Record<string, Rect[] | undefined> = {};

export const sendRects = () => {
  if (!trackedPaths.length) {
    return;
  }
  const rects: Record<string, Rect[] | undefined> = {};
  const classes: Record<string, string[][]> = {};
  const spacing: Record<string, (Spacing | undefined)[]> = {};
  for (const nodePath of trackedPaths) {
    rects[nodePath] = rectsForPath(nodePath);
    classes[nodePath] = classesForPath(nodePath);
    spacing[nodePath] = spacingForPath(nodePath);
  }
  lastSentRects = rects;
  window.parent.postMessage(
    {
      type: 'avb:rects',
      rects,
      classes,
      spacing,
    },
    '*',
  );
};

// --- a page that moves by itself ------------------------------------------
//
// Every measurement above is triggered by something that HAPPENED: a scroll,
// a mutation, a resize, an element changing size. A CSS animation is none of
// those. A marquee translates its track sixty times a second with the DOM
// untouched, the elements the same size and the page not scrolled — so a box
// was measured once, at the moment the node was selected, and then stood
// still while the thing it was drawn around travelled out from under it.
//
// A strip that renders its content twice makes that unreadable rather than
// merely wrong: the copy the outline was measured on moves away, the other
// copy arrives where it was, and the box looks like it is stuck on the first
// copy however far along you click.
//
// Nothing announces this, so the only way to know is to look. Measure the
// tracked boxes every so often, and when they have moved with nothing having
// happened, follow them frame by frame until they settle again.
const MOVE_SLACK = 0.5; // sub-pixel drift is not movement
const STILL_FRAMES = 20; // …and a third of a second of stillness is a stop
export const LOOK_EVERY = 200; // ms between looks while the page is holding still

const boxesMoved = (before: Rect[] | undefined, now: Rect[] | undefined): boolean => {
  if (!before || !now || before.length !== now.length) {
    return true;
  }
  for (let i = 0; i < now.length; i++) {
    for (const key of ['x', 'y', 'w', 'h'] as const) {
      if (Math.abs((before[i]?.[key] ?? 0) - (now[i]?.[key] ?? 0)) > MOVE_SLACK) {
        return true;
      }
    }
  }
  return false;
};

const trackedMoved = () => {
  for (const nodePath of trackedPaths) {
    // Never reported yet is not movement: the send that reports it is
    // already on its way.
    if (!lastSentRects[nodePath]) {
      continue;
    }
    if (boxesMoved(lastSentRects[nodePath], rectsForPath(nodePath))) {
      return true;
    }
  }
  return false;
};

let following = false;
let stillFor = 0;
const followMotion = () => {
  if (!trackedPaths.length) {
    following = false;
    return;
  }
  if (trackedMoved()) {
    stillFor = 0;
    // The measurements that go stale with the boxes. Not the `stacki-opened`
    // class: painting it writes to the DOM, and a write on every frame of an
    // animation is a mutation storm answered by another measurement.
    resetThinCache();
    resetFocusCache();
    sendRects();
  } else if (++stillFor >= STILL_FRAMES) {
    following = false;
    return;
  }
  requestAnimationFrame(followMotion);
};

export const watchMotion = () => {
  if (following || !trackedPaths.length || !trackedMoved()) {
    return;
  }
  following = true;
  stillFor = 0;
  requestAnimationFrame(followMotion);
};
let lastRenderedKey = '';
// The nodes the last walk found rendered: what a restyle re-reads states for.
let lastRendered: string[] = [];
export const sendRendered = () => {
  const rendered = [];
  const seen = new Set<string>(); // `rendered`, for lookups: a page holds thousands
  for (const nodePath of regions.keys()) {
    if (!inScope(nodePath)) {
      continue;
    }
    let live = false;
    for (const run of runsOf(nodePath) || []) {
      for (const node of run) {
        if (!node.isConnected) {
          continue;
        }
        if (isElement(node) && node.tagName !== 'TEMPLATE') {
          live = true;
        } else if (isText(node) && node.textContent !== null && node.textContent.trim()) {
          live = true;
        }
        if (live) {
          break;
        }
      }
      if (live) {
        break;
      }
    }
    // The tag survives on clones when a script rebuilds the DOM, so a node
    // whose recorded run went stale is still rendering something.
    if (!live && elementsWithPath(nodePath).length) {
      live = true;
    }
    if (live) {
      rendered.push(nodePath);
      seen.add(nodePath);
    }
  }
  // A slotted node is never wrapped in markers — it's addressed by the tag
  // alone (see pathsOf) — so it has no region to be found above. Anything
  // carrying a tag is on the page by definition.
  for (const element of Array.from(document.querySelectorAll(`[${PATH_ATTR}]`))) {
    if (!inFocus(element)) {
      continue;
    }
    for (const nodePath of pathsOf(element)) {
      if (inScope(nodePath) && !seen.has(nodePath)) {
        rendered.push(nodePath);
        seen.add(nodePath);
      }
    }
  }
  lastRendered = rendered;
  sendStates(rendered);
  const key = rendered.join('\n');
  if (key === lastRenderedKey) {
    return;
  }
  lastRenderedKey = key;
  window.parent.postMessage({ type: 'avb:rendered-nodes', paths: rendered }, '*');
};

// Nodes that are on the page but not taking part in it: `display: none` (there
// and not drawn) and `pointer-events: none` (drawn and not clickable). Both
// are true of the element as the page computes it — they can arrive from any
// rule in any stylesheet, so the source cannot answer and the navigator has
// no way to ask per row.
//
// The same pass notes each element whose ::before or ::after is drawn (it has
// `content` and is displayed): a pseudo-element exists only in CSS, so the
// navigator, which lists the source, could not show it as a layer.
//
// Read in the same pass, and only for nodes that put an element on the page:
// a computed style is cheap to read one at a time and not free by the
// hundred, so this rides the walk that already happens rather than adding
// one of its own.
let lastStatesKey = '';
const firstElementFor = (nodePath: string): Element | undefined => {
  for (const run of runsOf(nodePath) || []) {
    const element = run.find((node): node is Element => isElement(node) && node.tagName !== 'TEMPLATE');
    if (element && element.isConnected) {
      return element;
    }
  }
  return elementsWithPath(nodePath)[0] || undefined;
};
// Whether a pseudo-element is drawn: `content` other than none/normal, and displayed.
const drawsPseudo = (element: Element, pseudo: '::before' | '::after'): boolean => {
  const style = window.getComputedStyle(element, pseudo);
  return style.content !== 'none' && style.content !== 'normal' && style.content !== '' && style.display !== 'none';
};
// The nodes the last pass found drawing a ::before or ::after, kept for the
// pointer (frameTargets.ts): a pseudo-element is measured under the cursor
// only for a node listed here, so moving over the rest of the page costs no
// computed-style read at all.
let drawnBefore: ReadonlySet<string> = new Set<string>();
let drawnAfter: ReadonlySet<string> = new Set<string>();
/** Whether the last pass found the node at `nodePath` drawing `pseudo`. */
export const drawsPseudoAt = (nodePath: string, pseudo: PseudoLayer): boolean => (pseudo === 'before' ? drawnBefore : drawnAfter).has(nodePath);
const sendStates = (rendered: string[]): void => {
  const hidden = [];
  const inert = [];
  const before: string[] = [];
  const after: string[] = [];
  for (const nodePath of rendered) {
    const element = firstElementFor(nodePath);
    if (!element) {
      continue;
    }
    try {
      const cs = window.getComputedStyle(element);
      if (cs.display === 'none') {
        hidden.push(nodePath);
      }
      if (cs.pointerEvents === 'none') {
        inert.push(nodePath);
      }
      if (drawsPseudo(element, '::before')) {
        before.push(nodePath);
      }
      if (drawsPseudo(element, '::after')) {
        after.push(nodePath);
      }
    } catch {
      /* an element that cannot be measured says nothing about itself */
    }
  }
  drawnBefore = new Set(before);
  drawnAfter = new Set(after);
  const key = `${hidden.join(' ')}|${inert.join(' ')}|${before.join(' ')}|${after.join(' ')}`;
  if (key === lastStatesKey) {
    return;
  }
  lastStatesKey = key;
  window.parent.postMessage({ type: 'avb:node-states', hidden, inert, before, after }, '*');
};

// The classes each node actually ended up with. `class:list={[...]}` and
// `class={expr}` are expressions, so the source can't say what they resolve
// to — only the rendered element knows, and the navigator has no way to ask
// per row. Reported for every node in the open file, first instance only:
// a label needs one answer, and where instances differ the first is the one
// the outline and the props panel are already showing.
let lastClassKey = '';

// The app asked a different question (its scope or focused instance changed),
// or dropped what it held (its tree changed shape), so the next rendered-nodes,
// states and classes reports are sent even if unchanged. The states were left
// out: the app dropped them on an edit, the page said nothing new, and the
// navigator lost its ::before rows and hidden marks until something changed.
export function forgetReportedKeys(): void {
  lastRenderedKey = '';
  lastStatesKey = '';
  lastClassKey = '';
}
export const sendClasses = () => {
  const out: Record<string, string[]> = {};
  for (const nodePath of regions.keys()) {
    if (!inScope(nodePath)) {
      continue;
    }
    const list = classesForPath(nodePath)[0];
    if (list && list.length) {
      out[nodePath] = list;
    }
  }
  // Slotted nodes have no marker pair, so they never appear above.
  for (const element of Array.from(document.querySelectorAll(`[${PATH_ATTR}]`))) {
    const own = ownClasses(element);
    if (!own.length || !inFocus(element)) {
      continue;
    }
    for (const nodePath of pathsOf(element)) {
      if (inScope(nodePath) && !out[nodePath]) {
        out[nodePath] = own;
      }
    }
  }
  const key = JSON.stringify(out);
  if (key === lastClassKey) {
    return;
  }
  lastClassKey = key;
  window.parent.postMessage({ type: 'avb:node-classes', classes: out }, '*');
};

// Selecting a node in the navigator brings it onto the page. Only scrolls
// when the node is actually out of sight (boxInView): selecting something
// already on screen shouldn't move the page under the user.
//
// Only ever down the page, and only the page itself. A site is routinely wider
// than the frame on purpose — a hero video bleeding off the right, a track of
// cards, a decorative circle hanging off the edge — and clips it with
// `overflow-x: hidden` or `clip` on the body or a wrapper. Scrolling sideways
// to reveal such a node moves a viewport the site never meant to scroll, and
// nothing on the canvas can scroll it back: the page stays stuck to one side.
// `scrollIntoView` is worse still, because it also scrolls every clipping
// ancestor on the way. So the target is computed here, vertically, and the
// window is the one thing that moves.
const SCROLL_MARGIN = 24;
// Whether the person can already see a box, so a reveal has nothing to do. All
// of it inside the frame is in view, up to the very edge: the margin says where
// a reveal lands, not what counts as seen, and nothing covers the frame (the
// toolbar sits outside it). A box too tall to fit is in view while it covers the
// frame from edge to edge. Only its top showing is not enough: that may be a
// sliver at the bottom, which a reveal is there to fix.
const boxInView = (top: number, height: number, viewportHeight: number): boolean => {
  assert(height >= 0, 'boxInView: a box has no negative height');
  const bottom = top + height;
  if (top >= 0) {
    if (bottom <= viewportHeight) {
      return true;
    }
  }
  if (top <= 0) {
    return bottom >= viewportHeight;
  }
  return false;
};
// Where the page has to go for a box to be on screen, vertically: the scroll
// position it already has when the box is in view, and otherwise enough to
// bring it in. A box taller than the viewport is aligned to its top rather than
// centred, which would push the beginning of it out.
const revealTop = (top: number, height: number, viewportHeight: number, scrollTop: number): number => {
  assert(Number.isFinite(top), 'revealTop: the box has a top');
  assert(Number.isFinite(height), 'revealTop: the box has a height');
  assert(viewportHeight >= 0, 'revealTop: the viewport has a height');
  if (boxInView(top, height, viewportHeight)) {
    return scrollTop;
  }
  const offset = height >= viewportHeight - SCROLL_MARGIN * 2 ? SCROLL_MARGIN : Math.floor((viewportHeight - height) / 2);
  const target = Math.max(0, Math.round(scrollTop + top - offset));
  assert(target >= 0, 'revealTop: a scroll position is never negative');
  return target;
};
// A ::before or ::after that paints no box has nothing of its own to reveal, so
// its element stands in: the row was picked to get to that place on the page.
const rectsForPseudoHost = (nodePath: string): Rect[] | undefined => {
  const pseudo = splitPseudoPath(nodePath);
  return pseudo === undefined ? undefined : rectsForPath(pseudo.nodePath);
};
export const scrollPathIntoView = (nodePath: string, occ: number): void => {
  const rects = rectsForPath(nodePath) ?? rectsForPseudoHost(nodePath);
  if (!rects || !rects.length) {
    return;
  }
  // One path can render many times (a node inside a loop, a component used
  // repeatedly). Scroll to the instance being worked in, not whichever one
  // happens to come first in the document.
  const rect = rects[occ] ?? rects[0]; // viewport-relative
  if (!rect) {
    return;
  }
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const top = revealTop(rect.y, rect.h, viewportHeight, window.scrollY);
  if (top === window.scrollY) {
    return;
  }
  // No `left`: the horizontal scroll stays wherever it is (see above).
  window.scrollTo({ top, behavior: 'smooth' });
  finishReveal(top);
};

// A smooth scroll can stall short of where it was sent: on Linux the first
// reveal of a page stopped 9px down and stayed there, the selection still far
// below the fold, until the next reveal. So the frame watches the scroll it
// started, and when the page stops moving before it arrives, it jumps the
// rest of the way. A person who scrolls in the meantime has taken over, and
// is left alone. Bounded: REVEAL_CHECKS_MAX checks, REVEAL_CHECK_MS apart.
const REVEAL_CHECK_MS = 100;
const REVEAL_CHECKS_MAX = 10;
let revealWatch: ReturnType<typeof setTimeout> | undefined;
const finishReveal = (target: number): void => {
  assert(target >= 0, 'finishReveal: a scroll target is never negative');
  clearTimeout(revealWatch);
  let last = window.scrollY;
  let checks = 0;
  const check = (): void => {
    checks += 1;
    assert(checks <= REVEAL_CHECKS_MAX, 'finishReveal: the watch is bounded');
    const now = window.scrollY;
    const arrived = Math.abs(now - target) <= 1;
    if (arrived) {
      revealWatch = undefined;
      return;
    }
    // Moving away from the target means a person scrolled: theirs now.
    const awayFromTarget = Math.abs(now - target) > Math.abs(last - target) + 1;
    if (awayFromTarget) {
      revealWatch = undefined;
      return;
    }
    if (now === last || checks === REVEAL_CHECKS_MAX) {
      revealWatch = undefined;
      window.scrollTo({ top: target, behavior: 'instant' });
      return;
    }
    last = now;
    revealWatch = setTimeout(check, REVEAL_CHECK_MS);
  };
  revealWatch = setTimeout(check, REVEAL_CHECK_MS);
};

// `stacki-opened` on the instance being edited — the one that was actually
// double-clicked, not every copy of the component. It goes on the element(s)
// the instance rendered at its top level, which for a component with one root
// is that root; a component that renders two siblings marks both, because it
// has no single root to speak of.
//
// Painted from focusRoots(), so it means exactly what the outline, the hit
// testing and the scroll-to mean by "the open instance" — one place decides,
// and a component used inside a loop marks the card that was opened.
//
// Where the instance IS depends on how it was addressed. Most have a marker
// pair, and the run between it is them. A component whose root is a
// conditional has none: `{render && heading && (<details/>)}` renders the
// branch's own element and the serializer puts the path on that element
// rather than wrapping it — a marker beside it would land outside the branch,
// where it would mark the instance whether the branch rendered or not. Same
// for a component rendered into another one's slot. The element carrying the
// path is the instance, so that is what gets marked, and the occurrence picks
// the copy that was opened exactly as the click that opened it did.
// A component's region holds its <script> and <style> too. They are elements,
// and they are not what anyone means by the root of the component.
const UNRENDERED = new Set(['TEMPLATE', 'SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE']);
const openedRoots = (): Element[] => (focusRoots() || []).filter((node): node is Element => isElement(node) && !UNRENDERED.has(node.tagName));

let openedEls: Element[] = [];
export const paintOpened = () => {
  const next = openedRoots();
  // Only when it actually moved. Writing the class again with the same value
  // is still a write, and the canvas re-measures on any mutation — so a
  // repaint that changed nothing scheduled the next repaint, once a frame,
  // for as long as the component stayed open.
  if (next.length === openedEls.length && next.every((element, i) => element === openedEls[i])) {
    return;
  }
  for (const element of openedEls) {
    if (!next.includes(element)) {
      element.classList.remove('stacki-opened');
    }
  }
  for (const element of next) {
    element.classList.add('stacki-opened');
  }
  openedEls = next;
};

// The canvas answers two different questions, and only one of them is asked
// by a pointer.
//
//   where the tracked nodes ARE — a box each, for the two or three paths the
//   app is watching. Changes when the page scrolls, when something moves, and
//   when the app watches a different node.
//
//   what the page IS — which nodes put anything on it, and what each one's
//   classes came out as. Those are facts about the whole file: they cost a
//   walk of every marked node, five thousand of them on a page of any size,
//   and they can only change when the DOM does.
//
// Both were sent together, so moving the pointer to a new node re-walked the
// page. On a large one that walk is most of a second, and it is the wait
// before an outline appears.
let rectsQueued = false;
let pageQueued = false;
export const queueRects = (pageToo = false) => {
  resetThinCache(); // scrolled, resized or rebuilt — every box moved
  resetFocusCache(); // …including the instance being edited
  pageQueued = pageQueued || pageToo;
  if (rectsQueued) {
    return;
  }
  rectsQueued = true;
  requestAnimationFrame(() => {
    rectsQueued = false;
    const page = pageQueued;
    pageQueued = false;
    paintOpened();
    sendRects();
    if (page) {
      sendRendered();
      sendClasses();
    }
  });
};

// Measure on the next frame, and once more a moment later. The second pass is
// for changes whose effect lands after the change itself: a stylesheet swapped
// into <head> by the dev server is applied, then the page relayouts, and a box
// read in between is the box from before. Dragging a padding value writes CSS
// several times a second, so a measurement one beat behind is an outline that
// never catches up.
let settleTimer: ReturnType<typeof setTimeout> | undefined;
export const remeasure = () => {
  // Something changed the document — which nodes rendered, and what their
  // classes resolved to, are both back in question.
  queueRects(true);
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => queueRects(true), 120);
};

// A change that only restyles the page — an inline style, a stylesheet the
// dev server swapped into <head>, a resize — moves boxes and can hide or
// show a node, but cannot change which nodes rendered or what their classes
// are: those are structural, and re-deriving them walks every marked node.
// So a restyle re-measures the tracked boxes as remeasure does, and re-reads
// the hidden and inert states at once — or, when they were read less than
// STATES_INTERVAL_MS ago, once that interval is up: an animation restyles
// every frame, and each read is a computed style per rendered node.
const STATES_INTERVAL_MS = 250;
let styleSettleTimer: ReturnType<typeof setTimeout> | undefined;
let statesTimer: ReturnType<typeof setTimeout> | undefined;
let statesReadMs = Number.NEGATIVE_INFINITY;
const readStates = () => {
  statesReadMs = performance.now();
  sendStates(lastRendered);
};
export const remeasureStyles = () => {
  queueRects();
  clearTimeout(styleSettleTimer);
  styleSettleTimer = setTimeout(() => queueRects(), 120);
  clearTimeout(statesTimer);
  const sinceMs = performance.now() - statesReadMs;
  statesTimer = setTimeout(readStates, Math.max(0, STATES_INTERVAL_MS - sinceMs));
};

// What a batch of mutations means for the canvas: nothing, a restyle, or a
// change to the page's structure. The canvas writes to the page itself —
// path tags, marker comments it lifts out, the probe a colour is computed
// on, the viewport-height variable and its override sheet, its own classes —
// and each of those writes used to start a whole-page walk, including every
// colour the style panel asked about. Its own writes are now told apart by
// what they touched, never by timing.
type MutationKind = 'none' | 'css' | 'page';
const ownElement = (node: Node): boolean => {
  if (!isElement(node)) {
    return false;
  }
  if (node.id === 'avb-design-style' || node.id === 'avb-vh-override') {
    return true;
  }
  return node.hasAttribute(PROBE_ATTR);
};
const ownNode = (node: Node): boolean => {
  if (isComment(node)) {
    return /^avb-[se]:/.test(node.data); // A marker the canvas lifts out.
  }
  return ownElement(node);
};
const classTokens = (value: string | undefined): Set<string> => new Set((value ?? '').split(/\s+/).filter((token) => token !== ''));
// Only the canvas's own classes came or went.
const ownClassChange = (record: MutationRecord): boolean => {
  if (!isElement(record.target)) {
    return false; // A class record always targets an element; never ours otherwise.
  }
  const before = classTokens(record.oldValue ?? undefined);
  const after = classTokens(record.target.getAttribute('class') ?? undefined);
  for (const token of [...before, ...after]) {
    if (before.has(token) !== after.has(token) && !STACKI_CLASSES.has(token)) {
      return false;
    }
  }
  return true;
};
const withoutViewportHeight = (style: string | undefined): string => (style ?? '').replace(/--avb-vh:[^;]*;?\s*/g, '').trim();
const ownAttributeChange = (record: MutationRecord): boolean => {
  const target = record.target;
  if (ownElement(target) || record.attributeName === PATH_ATTR) {
    return true;
  }
  if (record.attributeName === 'class') {
    return ownClassChange(record);
  }
  if (authoredStyleMutation(record)) {
    return true;
  }
  if (record.attributeName === 'style' && target === document.documentElement) {
    const now = withoutViewportHeight(document.documentElement.getAttribute('style') ?? undefined);
    return withoutViewportHeight(record.oldValue ?? undefined) === now;
  }
  return false;
};
const insideHead = (node: Node): boolean => !!document.head && document.head.contains(node);
const recordKind = (record: MutationRecord): MutationKind => {
  if (record.type === 'attributes') {
    if (ownAttributeChange(record)) {
      return 'none';
    }
    if (insideHead(record.target)) {
      return 'css';
    }
    // Attributes can change layout, visibility and selector matching, but only
    // class changes invalidate reported class lists. Any script that responds by
    // replacing markup produces its own child-list record and structural pass.
    return record.attributeName === 'class' ? 'page' : 'css';
  }
  if (record.type === 'characterData') {
    const parent = record.target.parentNode;
    if (parent !== null && ownElement(parent)) {
      return 'none';
    }
    return insideHead(record.target) ? 'css' : 'page';
  }
  const nodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
  if (ownElement(record.target) || nodes.every(ownNode)) {
    return 'none';
  }
  return insideHead(record.target) ? 'css' : 'page';
};
export const mutationKind = (records: readonly MutationRecord[]): MutationKind => {
  let kind: MutationKind = 'none';
  for (const record of records) {
    const next = recordKind(record);
    if (next === 'page') {
      return 'page';
    }
    if (next === 'css') {
      kind = 'css';
    }
  }
  return kind;
};

// Which rendered copy of a node the target sits in. A node inside a loop
// is recorded once per item, so the runs are the instances in order.
export const occurrenceOf = (path: string, target: Node | undefined): number => {
  const runs = runsOf(path);
  if (runs && runs.length > 1) {
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      if (!run) {
        continue;
      }
      for (const node of run) {
        if (!node.isConnected) {
          continue;
        }
        if (node === target) {
          return i;
        }
        if (node.nodeType === 1 && target !== undefined && node.contains(target)) {
          return i;
        }
      }
    }
    return 0;
  }
  // A node addressed by its tag rather than by markers has no runs at all —
  // a link inside a list item is written as part of an inline run, and a
  // marker between the words would render as a space. Its copies are the
  // tagged elements, counted in the same order the boxes are measured in.
  const places = taggedPlaces(path);
  if (places.length > 1) {
    for (let i = 0; i < places.length; i++) {
      const place = places[i];
      if (!place) {
        continue;
      }
      const element = place.el;
      if (element === target) {
        return i;
      }
      if (target !== undefined && element.contains(target)) {
        return i;
      }
    }
  }
  return 0;
};
