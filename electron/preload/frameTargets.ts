// Pointing at the page: which node is under the pointer, by marker regions,
// tagged elements and the widened thin targets, and the hover, click and
// double-click the canvas turns into selection.

import { assert } from '../../shared/core/assert';
import { canvasDragged, canvasInert, canvasSelects, holdLinkClick, replayingLinkClick, trackCanvas } from './frameInteraction';
import { inlineTextPathAt } from './inlineText';
import { PRELOAD_LIMITS, isElement, type Rect } from './frameBasics';
import {
  PATH_ATTR,
  announceMapped,
  collectRegions,
  focusPath,
  inFocus,
  inScope,
  pathsOf,
  regions,
  renderToken,
  runsOf,
  setRenderListener,
  taggedAncestor,
} from './frameRegions';
import { rectsForPath, thinAt } from './frameMeasure';
import { forgetPseudoBoxes, pseudoTargetAt } from './framePseudoTarget';
import { forgetUnionBoxes, unionTargetAt } from './frameUnionTarget';
import { type PseudoLayer } from '../../shared/page/pseudoPath';
import type { FramePointHit } from './framePointQuery';
import { LOOK_EVERY, mutationKind, occurrenceOf, queueRects, remeasure, remeasureStyles, watchMotion } from './frameReports';
import { deepHoverAt } from './frameOutlineMode';
import { iterationsForRun } from './frameIterations';

// The app tracks a node, so the frame is the canvas: clicks select.
export function enterDesignMode(): void {
  trackCanvas();
}

// The hover the app was last told about; undefined until it has been told.
let lastHover: { readonly path: string | undefined; readonly occurrence: number; readonly pseudo: PseudoLayer | undefined } | undefined;
// Where the pointer last was over the page, so a document that changes under a
// still pointer is hit-tested again rather than leaving the old outline behind.
let lastPointer: { readonly x: number; readonly y: number } | undefined;

// Tells the app what the pointer is over, when that changed.
function reportHover(picked: ReturnType<typeof nodeAt>, element: Element | undefined): void {
  // What a hover draws is what a click would pick.
  // In deep outline mode a hover inside a closed component names the element there (frameOutlineMode.ts); a click never does.
  const deep = deepHoverAt(element, picked.path);
  const { path: nodePath, occurrence, pseudo } = deep === undefined ? picked : { ...deep, pseudo: undefined };
  if (lastHover === undefined || nodePath !== lastHover.path || occurrence !== lastHover.occurrence || pseudo !== lastHover.pseudo) {
    lastHover = { path: nodePath, occurrence, pseudo };
    // A deep hover says how to label its node, which the editor's tree of the open file cannot.
    postLocated('avb:hover-node', {
      path: nodePath,
      occurrence,
      ...pseudoField(pseudo),
      ...(deep === undefined ? {} : { deep: deep.node }),
      ...boxesField(nodePath, { measurable: pseudo === undefined && deep === undefined }),
    });
  }
}

// The page changed under a pointer that has not moved: what it is over now.
// Said with the new rendering's token, so the app draws the outline again
// instead of keeping one from before the change.
function rehover(): void {
  const pointer = lastPointer;
  if (pointer === undefined) {
    return;
  }
  lastHover = undefined;
  const hit = document.elementFromPoint(pointer.x, pointer.y);
  const target = hit ? pointTarget(hit, pointer.x, pointer.y) : undefined;
  reportHover(nodeAt(target, pointer.x, pointer.y), target);
}

// Whether the target belongs to the focused instance though it renders outside it: content a script moved
// elsewhere (a modal or a menu appended to the body), still named by a path under the instance. It is not a click
// away from the instance. Only while the instance has one copy: with several, an element so named outside the
// focused one is another copy of it.
const movedOutOfFocus = (target: Node | undefined): boolean => {
  if (focusPath === '' || (regions.get(focusPath)?.length ?? 0) > 1) {
    return false;
  }
  let element = target instanceof Element ? (target.closest(`[${PATH_ATTR}]`) ?? undefined) : undefined;
  for (let depth = 0; element !== undefined && depth < PRELOAD_LIMITS.domDepthMax; depth += 1) {
    if (!inFocus(element) && pathsOf(element).some((nodePath) => nodePath === focusPath || nodePath.startsWith(`${focusPath}.`))) {
      return true;
    }
    element = taggedAncestor(element);
  }
  return false;
};

// Deepest marked node whose rendered DOM contains the target, plus which
// instance of it was hit — the app outlines only that one.
const nodeAt = (
  target: Node | undefined,
  x?: number,
  y?: number,
): {
  path: string | undefined;
  occurrence: number;
  outside: boolean;
  pseudo: PseudoLayer | undefined;
  /** The bare text run under the pointer, inside the node `path` names: only a double click asks for it. */
  textPath?: string;
} => {
  const tagged = taggedFor(target, x, y);
  // Whether anything at all was under the pointer, focus aside. No path
  // means the canvas could not place the click; `outside` means it could,
  // somewhere this file/instance doesn't own — and only the second is
  // somebody looking away from what they are editing. The app needs them
  // apart: it backs out of a component on one and must sit still for the
  // other.
  const anyTag = target instanceof Element ? target.closest(`[${PATH_ATTR}]`) : undefined;
  const best = deepestRegionAt(target, x, y, tagged && pathsOf(tagged).find(inScope));
  // A ::before or ::after is hit as its host, so the browser cannot say the
  // pointer is on one; its measured box can. Inside it, it is the target.
  if (best && x !== undefined && y !== undefined) {
    const pseudo = pseudoTargetAt(best, target, x, y);
    if (pseudo) {
      return { path: pseudo.path, occurrence: occurrenceOf(pseudo.path, target), outside: false, pseudo: pseudo.pseudo };
    }
  }
  // Nothing containing the cursor can be flat, so this runs last, over the
  // node that did win: a zero-height child of it takes precedence.
  if (x !== undefined && y !== undefined) {
    const thin = thinAt(x, y, best);
    if (thin) {
      return { path: thin.path, occurrence: occurrenceOf(thin.path, thin.el), outside: false, pseudo: undefined };
    }
  }
  // Words beside a tagged sibling (the text around a <strong> or a <br>) have no element of their own, and are
  // no target on the canvas: a hover, a click, a right click and a drag there are their owner's. The run is
  // still named, for the double click that edits it; the Navigator selects it by its own row.
  if (best && x !== undefined && y !== undefined) {
    const text = inlineTextPathAt(best, x, y);
    if (text) {
      return { path: best, occurrence: occurrenceOf(best, target), outside: false, pseudo: undefined, textPath: text };
    }
  }
  // The space between a loop's items is the element holding them as far as the
  // browser can say, but it is inside the loop's outline. Last, so it only ever
  // takes over from that element, never from anything actually under the pointer.
  if (x !== undefined && y !== undefined) {
    const union = unionTargetAt(best, target, x, y);
    if (union) {
      return { path: union.path, occurrence: union.occurrence, outside: false, pseudo: undefined };
    }
  }
  // Resolved separately from the search above: when the winning path came
  // from the tag, its own runs were never scanned.
  return {
    path: best,
    occurrence: best ? occurrenceOf(best, target) : 0,
    outside: !best && !!anyTag && !movedOutOfFocus(target),
    pseudo: undefined,
  };
};

// What lights up has to contain the pointer.
//
// A page's own scripts are free to put a child's box outside its parent's,
// and text animation does it as a matter of course: GSAP's SplitText gives
// every word a line box taller than the line, so a word hangs thirteen
// pixels above the component holding it — measured, on the page this came
// from. The pointer in the space above a heading is over one of those
// words; the browser says so, truthfully; and what got picked was a node
// whose outline starts BELOW the pointer. Which reads, fairly, as the
// margin above a thing being treated as part of the thing.
//
// So an element only answers for a point its own box holds. One that
// doesn't hands the question to the element above it, which is what the
// person was pointing at.
const EDGE = 1; // the outline is drawn on the boundary; that pixel counts
const holdsPoint = (element: Element, x: number | undefined, y: number | undefined) => {
  if (x === undefined || y === undefined) {
    return true;
  }
  const rect = element.getBoundingClientRect();
  // No box at all — a <template>, something display:none — cannot answer.
  if (rect.width === 0 && rect.height === 0) {
    return true;
  }
  return x >= rect.left - EDGE && x <= rect.right + EDGE && y >= rect.top - EDGE && y <= rect.bottom + EDGE;
};

// The tagged element that answers for the target. Clones the page's own
// scripts made aren't in any recorded run, so the tag is the only way to
// reach them — without this, clicking a split paragraph would select its
// parent instead.
const taggedFor = (target: Node | undefined, x?: number, y?: number): Element | undefined => {
  let tagged = target instanceof Element ? (target.closest(`[${PATH_ATTR}]`) ?? undefined) : undefined;
  while (x !== undefined && tagged && !holdsPoint(tagged, x, y)) {
    tagged = taggedAncestor(tagged);
  }
  // Walk out of any nested namespace until the tag belongs to the open file
  // — and, while an instance is focused, until it belongs to that instance:
  // a click on one of its siblings resolves to nothing, which is how the app
  // hears "done in here".
  while (tagged !== undefined && !(inFocus(tagged) && pathsOf(tagged).some(inScope))) {
    tagged = taggedAncestor(tagged);
  }
  return tagged;
};

// The deepest in-scope path whose marker run holds the target, or the path
// the tag named when no run goes deeper.
const deepestRegionAt = (target: Node | undefined, x: number | undefined, y: number | undefined, tagPath: string | undefined): string | undefined => {
  let best = tagPath;
  let bestDepth = best ? best.split('.').length : -1;
  for (const nodePath of regions.keys()) {
    if (!inScope(nodePath)) {
      continue;
    }
    const runs = runsOf(nodePath) || [];
    const depth = nodePath.split('.').length;
    if (depth <= bestDepth) {
      continue;
    }
    for (const run of runs) {
      const hit = run.some((node) => node.isConnected && node.nodeType === 1 && (node === target || (target !== undefined && node.contains(target))));
      if (hit) {
        // Same rule for a node addressed by markers rather than by a tag:
        // its run has to be where the pointer is.
        if (x !== undefined && !run.some((node) => isElement(node) && holdsPoint(node, x, y))) {
          break;
        }
        best = nodePath;
        bestDepth = depth;
        break;
      }
    }
  }
  return best;
};

// What the pointer is actually over. A page script that calls
// setPointerCapture — drag carousels, sliders, anything with a grab
// cursor — makes every later pointer event, INCLUDING the click, report
// the capturing element as its target. Trusting e.target there selects the
// whole carousel however deep you click. Hit-test the cursor instead; a
// synthesised event with no coordinates keeps e.target.
const targetAt = (event: MouseEvent): Node | undefined => {
  if (event.clientX || event.clientY) {
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    if (hit) {
      return pointTarget(hit, event.clientX, event.clientY);
    }
  }
  return event.target instanceof window.Node ? event.target : undefined;
};

// What the pointer is over at a point: the topmost element the browser itself hits (`elementFromPoint` already accounts for
// stacking contexts, z-index, pointer-events, visibility, clipping and transforms), or the embed under it (embedAt). Nothing is
// looked for beneath it: a covered element is not what a real pointer reaches, so it is never outlined, picked or edited. An
// element no file wrote (a script's overlay, a widget's layer) answers through its nearest tagged ancestor, as the browser's own
// event would bubble to it; nothing mapped above it answers nothing.
const pointTarget = (hit: Element, x: number, y: number): Element => embedAt(hit, x, y);

// Embedded documents take no pointer in select mode (frameInteraction.ts), so
// the hit test lands on the element around them. The embed itself is what the
// pointer is over: found among that element's own embeds, by its box. Bounded,
// since a page can hold any number of them.
const EMBEDS_CHECKED_MAX = 64;
const embedAt = (hit: Element, x: number, y: number): Element => {
  const embeds = hit.querySelectorAll('iframe, embed, object');
  const count = Math.min(embeds.length, EMBEDS_CHECKED_MAX);
  for (let index = 0; index < count; index++) {
    const embed = embeds[index];
    if (embed === undefined) {
      break;
    }
    const box = embed.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) {
      if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) {
        return embed;
      }
    }
  }
  return hit;
};

// The element under the pointer, for the deep hover's layers.
const targetElementOf = (event: MouseEvent): Element | undefined => {
  const target = targetAt(event);
  return target instanceof Element ? target : (target?.parentElement ?? undefined);
};

// Same resolution for hover, click and dblclick, so what lights up under the
// cursor is exactly what a click selects.
const nodeAtEvent = (event: MouseEvent) => (event.clientX || event.clientY ? nodeAt(targetAt(event), event.clientX, event.clientY) : nodeAt(targetAt(event)));

/**
 * The node under a viewport point, by the click's own resolution, for an app
 * dragging an overlay item (framePointQuery.ts): the box is the copy's, as a
 * click reports it. Undefined over markup no node owns.
 */
export function nodeAtPoint(x: number, y: number): FramePointHit | undefined {
  const hit = document.elementFromPoint(x, y);
  const { path: nodePath, occurrence } = nodeAt(hit ? pointTarget(hit, x, y) : undefined, x, y);
  if (!nodePath) {
    return undefined;
  }
  return { path: nodePath, occurrence, box: rectsForPath(nodePath)?.[occurrence] };
}

export const startOutlines = () => {
  // A page edit now patches the document instead of reloading it, so the
  // markers this map is built from move without the page ever going away.
  // Registered first: the first collection can come up empty (a page whose
  // markup arrives with the first patch), and this is what gets it a second
  // chance. Astro's <ClientRouter /> swaps the page in place the same way, so a
  // soft navigation re-reads the markers and the stamps too: without that the
  // frame kept vouching for the page it navigated away from, and every click on
  // the new one was refused.
  const remap = (): void => {
    collectRegions();
    announceMapped();
    if (regions.size) {
      startWatching();
    }
    queueRects(true);
  };
  // Once the new rendering's token is known, a pointer resting on the page is
  // over something new: say so with that token.
  setRenderListener(rehover);
  document.addEventListener('avb:morphed', remap);
  document.addEventListener('astro:after-swap', remap);
  collectRegions();
  // Said even when the page has no markers at all: "nothing here" is a real
  // answer, and withholding it would leave every question waiting out its
  // timeout.
  announceMapped();
  // The pointer is always heard, markers or not: a page whose markup arrives
  // later, an error page, a page the marker could not mark — the editor still
  // answers every click there (it selects what it can), and a frame that went
  // deaf left the canvas looking broken.
  listenForPointer();
  listenForContextMenu();
  if (regions.size) {
    startWatching();
  }
};

// The observers that keep outlines on their elements. Started once, as soon as
// the page has something to outline: a page with no markers has nothing to
// measure, so it does not pay for watching.
let watching = false;
const startWatching = (): void => {
  if (watching) {
    return;
  }
  watching = true;
  // Wrapped, not passed straight in: a listener is handed the Event, and
  // queueRects reads its first argument as "the page may have changed too".
  // An Event is not false, so every scroll asked for the whole-page walk —
  // half a second of it on a page of any size, sixty times a second while
  // the wheel is moving.
  window.addEventListener('scroll', () => queueRects(), true);
  window.addEventListener('resize', remeasure);
  // The whole document, not just the body: styling something writes CSS, and
  // the dev server delivers CSS by swapping a <style> in <head>. Watching the
  // body alone meant the element moved under an outline that had no idea
  // anything had happened — the outline only caught up when something else
  // (a scroll, an edit to the markup) asked for a fresh measurement.
  new MutationObserver((records) => {
    const kind = mutationKind(records);
    if (kind === 'page') {
      remeasure();
    } else if (kind === 'css') {
      remeasureStyles();
    }
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeOldValue: true,
    characterData: true,
  });
  // A layout that changed without changing the DOM at all — a rule edited
  // through the CSSOM, a font finishing loading, a container query flipping.
  // Nothing to observe there but the boxes themselves.
  try {
    // A resize restyles; it cannot change which nodes rendered.
    const ro = new ResizeObserver(remeasureStyles);
    ro.observe(document.documentElement);
    if (document.body) {
      ro.observe(document.body);
    }
  } catch {
    /* no ResizeObserver: the observers above still cover the common cases */
  }
  // And a page that moves with nothing happening at all — an animation, a
  // transition, anything that only changes where things are. Nothing above
  // fires for that; see followMotion.
  lookForMotion();
};

/**
 * The editor asks again where a click landed (`avb:click-query` `{ id, x, y }`)
 * when the rendering it first named was not current: the page is hit-tested
 * afresh, by the click's own resolution, and answered as an ordinary
 * `avb:click-node` carrying `replay: id` and the token of the rendering shown
 * NOW. Nothing reaches the page: this is a question, not a click.
 */
export function answerClickQuery(id: number, x: number, y: number): void {
  forgetKeptBoxes();
  const hit = document.elementFromPoint(x, y);
  const { path: nodePath, occurrence, outside, pseudo } = nodeAt(hit ? pointTarget(hit, x, y) : undefined, x, y);
  postLocated('avb:click-node', {
    path: nodePath || undefined,
    occurrence,
    outside: !!outside,
    x,
    y,
    box: nodePath ? rectsForPath(nodePath)?.[occurrence] : undefined,
    replay: id,
    ...iterationsField(nodePath, occurrence),
    ...pseudoField(pseudo),
  });
}

// Polls for motion nothing announces (see followMotion).
const lookForMotion = () => {
  const look = setInterval(watchMotion, LOOK_EVERY);
  // A repeating timer is the one thing here that would hold a Node process
  // open — the suites run this file in jsdom, and a page's heartbeat is not
  // a reason for `node test/…` never to come back. In the browser the handle
  // is a number and this does nothing — both are checked without asserting.
  if (typeof look === 'object' && look !== null && 'unref' in look && typeof look['unref'] === 'function') {
    look['unref']();
  }
};

// Hover, double-click and click, each resolved to the node under the pointer.
// Each listener is on the window in the capture phase, the earliest point an
// event reaches in the page: the preload runs before any page script, so a
// page handler that stops propagation or rebuilds the node under the pointer
// can no longer hide a hover from the canvas.
const listenForPointer = () => {
  window.addEventListener(
    'mousemove',
    (event) => {
      lastPointer = event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined;
      reportHover(nodeAtEvent(event), targetElementOf(event));
    },
    true,
  );
  document.documentElement.addEventListener('mouseleave', startOutlinesClearHover);
  // Double-clicking a component opens it for editing, the way Webflow
  // drills into one.
  window.addEventListener(
    'dblclick',
    (event) => {
      if (!canvasSelects()) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      // Report even when nothing in scope matched: markup the layout renders
      // itself (nav, footer — anything outside the page's <slot>) has no
      // in-scope marker, and the app opens the layout for those.
      // With the occurrence: a component inside a loop renders once per
      // item, and opening it means the one under the cursor.
      forgetKeptBoxes();
      const picked = nodeAtEvent(event);
      // A double click on bare words still asks for those words (the editor takes the caret to their field).
      const nodePath = picked.textPath ?? picked.path;
      postLocated('avb:open-node', { path: nodePath || undefined, occurrence: picked.occurrence, pressedAtMs: pressedAtMsOf(event) });
    },
    true,
  );

  // In the design canvas (any frame the app tracks paths in), clicking
  // selects the node in the app. Select mode keeps the click from the page;
  // interact mode selects and then lets the page have it too (frameInteraction.ts).
  // Interactive preview frames never receive avb:track, so they keep
  // normal page behavior.
  window.addEventListener(
    'click',
    (event) => {
      if (!canvasSelects()) {
        return;
      }
      if (replayingLinkClick()) {
        return; // Selected when it was first clicked.
      }
      if (canvasInert()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      if (canvasDragged()) {
        return;
      }
      // A click that hits no marked node still reports (no path), with
      // `outside` saying whether it landed on something the open file simply
      // doesn't own — which is what the app backs out of a component on.
      // The boxes kept for hover may be stale; a click measures afresh.
      forgetKeptBoxes();
      const { path: nodePath, occurrence, outside, pseudo } = nodeAtEvent(event);
      postLocated('avb:click-node', {
        path: nodePath || undefined,
        occurrence,
        outside: !!outside,
        // Where the pointer was, and the box of the copy it hit: an app capturing canvas
        // clicks hears the point within the element (src/features/apps/canvasCapture.ts).
        x: event.clientX,
        y: event.clientY,
        box: nodePath ? rectsForPath(nodePath)?.[occurrence] : undefined,
        pressedAtMs: pressedAtMsOf(event),
        ...iterationsField(nodePath, occurrence),
        ...pseudoField(pseudo),
        ...boxesField(nodePath, { measurable: pseudo === undefined }),
      });
      if (canvasInert()) {
        return; // Select mode has already kept the click from the page.
      }
      holdLinkClick(event);
    },
    true,
  );
};

// Right-click resolves the same source node and occurrence as an ordinary selection.
function listenForContextMenu(): void {
  document.addEventListener(
    'contextmenu',
    (event) => {
      if (!canvasSelects()) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      // As for a click: the boxes kept for hover may be stale.
      forgetKeptBoxes();
      const { path, occurrence, outside, pseudo } = nodeAtEvent(event);
      postLocated('avb:context-node', {
        path: path || undefined,
        occurrence,
        outside: !!outside,
        left: event.clientX,
        top: event.clientY,
        pressedAtMs: pressedAtMsOf(event),
        ...pseudoField(pseudo),
      });
    },
    true,
  );
}

function startOutlinesClearHover(): void {
  // Coming back in, the page may have changed under the kept boxes.
  forgetKeptBoxes();
  lastPointer = undefined;
  // Told nothing yet, or told of a node: either way, the pointer has left.
  if (lastHover === undefined || lastHover.path !== undefined) {
    lastHover = { path: undefined, occurrence: 0, pseudo: undefined };
    // Clear messages use the same located-message contract as hover hits.
    postLocated('avb:hover-node', { path: undefined, occurrence: 0 });
  }
}

// What hover keeps between moves, dropped wherever the page must be seen as it is.
function forgetKeptBoxes(): void {
  forgetPseudoBoxes();
  forgetUnionBoxes();
}

// Which pass of each loop around the node the clicked copy is in, said only when a loop around it
// marked its passes: the editor points the data picker at that item (shared/page/previewIteration.ts).
function iterationsField(
  nodePath: string | undefined,
  occurrence: number,
): { readonly iterations?: readonly { readonly path: string; readonly index: number }[] } {
  if (nodePath === undefined || nodePath === '') {
    return {};
  }
  const iterations = iterationsForRun(nodePath, runsOf(nodePath)?.[occurrence]);
  return iterations.length === 0 ? {} : { iterations };
}

// The pseudo-element a hover or click landed on, said only when there is one:
// a message about the element itself keeps the shape it always had.
function pseudoField(pseudo: PseudoLayer | undefined): { readonly pseudo?: PseudoLayer } {
  return pseudo === undefined ? {} : { pseudo };
}

// The boxes the node covers right now, sent with the hover or click that named it. The editor
// draws the outline from them in the same step it hears the event, instead of asking for the
// boxes (`avb:track`, a frame, `avb:rects`, a second render): two round trips and a frame of
// waiting between the pointer and the outline. The layout is already clean here, because the
// hit test that found the node has just forced it. A layer drawn on its own box (a ::before) or
// a deep hover is measured the usual way, so neither carries any.
function boxesField(nodePath: string | undefined, options: { readonly measurable: boolean }): { readonly boxes?: readonly Rect[] } {
  if (nodePath === undefined || !options.measurable) {
    return {};
  }
  const boxes = rectsForPath(nodePath);
  return boxes === undefined ? {} : { boxes };
}

// Every located event names the rendering it landed on (step 7): the app
// acts on it only while that rendering is still what the files hold.
// When the person pressed, on the clock the app shares (epoch milliseconds): the input event's own
// time, not the time this frame got round to it. A freshly reloaded page can post a click a few
// hundred milliseconds late, after the person has gone on to open something in the panel, and the
// app must not take that old press for one made on what they opened (soak SP-04).
function pressedAtMsOf(event: Event): number {
  const pressedAtMs = performance.timeOrigin + event.timeStamp;
  assert(Number.isFinite(pressedAtMs), 'pressedAtMsOf: a press time is a finite number');
  return pressedAtMs;
}

function postLocated(type: string, located: Record<string, unknown>): void {
  window.parent.postMessage({ type, ...located, token: renderToken }, '*');
}
