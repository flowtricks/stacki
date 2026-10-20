// Pointing at the page: which node is under the pointer, by marker regions,
// tagged elements and the widened thin targets, and the hover, click and
// double-click the canvas turns into selection.

import { PRELOAD_LIMITS, isElement } from './frameBasics';
import {
  PATH_ATTR,
  annotating,
  announceMapped,
  collectRegions,
  inFocus,
  inScope,
  pathsOf,
  regions,
  renderToken,
  runsOf,
  taggedAncestor,
} from './frameRegions';
import { thinAt } from './frameMeasure';
import {
  LOOK_EVERY,
  mutationKind,
  occurrenceOf,
  queueRects,
  remeasure,
  remeasureStyles,
  watchMotion,
} from './frameReports';

let designMode = false;

// The app tracks a node, so the frame is the canvas: clicks select.
export function enterDesignMode(): void {
  designMode = true;
}

// The hover the app was last told about; undefined until it has been told.
let lastHover: { readonly path: string | undefined; readonly occurrence: number } | undefined;

// Deepest marked node whose rendered DOM contains the target, plus which
// instance of it was hit — the app outlines only that one.
const nodeAt = (
  target: Node | undefined,
  x?: number,
  y?: number,
): { path: string | undefined; occurrence: number; outside: boolean } => {
  const tagged = taggedFor(target, x, y);
  // Whether anything at all was under the pointer, focus aside. No path
  // means the canvas could not place the click; `outside` means it could,
  // somewhere this file/instance doesn't own — and only the second is
  // somebody looking away from what they are editing. The app needs them
  // apart: it backs out of a component on one and must sit still for the
  // other.
  const anyTag = target instanceof Element ? target.closest(`[${PATH_ATTR}]`) : undefined;
  const best = deepestRegionAt(target, x, y, tagged && pathsOf(tagged).find(inScope));
  // Nothing containing the cursor can be flat, so this runs last, over the
  // node that did win: a zero-height child of it takes precedence.
  if (x !== undefined && y !== undefined) {
    const thin = thinAt(x, y, best);
    if (thin) {
      return { path: thin.path, occurrence: occurrenceOf(thin.path, thin.el), outside: false };
    }
  }
  // Resolved separately from the search above: when the winning path came
  // from the tag, its own runs were never scanned.
  return {
    path: best,
    occurrence: best ? occurrenceOf(best, target) : 0,
    outside: !best && !!anyTag,
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
  return (
    x >= rect.left - EDGE &&
    x <= rect.right + EDGE &&
    y >= rect.top - EDGE &&
    y <= rect.bottom + EDGE
  );
};

// The tagged element that answers for the target. Clones the page's own
// scripts made aren't in any recorded run, so the tag is the only way to
// reach them — without this, clicking a split paragraph would select its
// parent instead.
const taggedFor = (target: Node | undefined, x?: number, y?: number): Element | undefined => {
  let tagged =
    target instanceof Element ? (target.closest(`[${PATH_ATTR}]`) ?? undefined) : undefined;
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
const deepestRegionAt = (
  target: Node | undefined,
  x: number | undefined,
  y: number | undefined,
  tagPath: string | undefined,
): string | undefined => {
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
      const hit = run.some(
        (node) =>
          node.isConnected &&
          node.nodeType === 1 &&
          (node === target || (target !== undefined && node.contains(target))),
      );
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
const targetAt = (event: MouseEvent): Node | undefined =>
  (event.clientX || event.clientY
    ? document.elementFromPoint(event.clientX, event.clientY)
    : undefined) || (event.target instanceof window.Node ? event.target : undefined);

// Same resolution for hover, click and dblclick, so what lights up under the
// cursor is exactly what a click selects. While annotating, the hover is the
// element a click would annotate.
const nodeAtEvent = (event: MouseEvent) => {
  if (annotating) {
    const annotation = annotationAt(event);
    return { path: annotation?.path, occurrence: annotation?.occurrence ?? 0, outside: false };
  }
  return event.clientX || event.clientY
    ? nodeAt(targetAt(event), event.clientX, event.clientY)
    : nodeAt(targetAt(event));
};

// --- Annotating (the Feedback tab) -----------------------------------------
// Every element is reachable without drilling in: the deepest tagged element
// under the pointer, whatever file rendered it, with the chain of files it
// renders through — the page, each component instance, then the element.

interface AnnotationStep {
  /** The project-relative component file, or '' for the page. */
  readonly file: string;
  readonly path: string;
}

const annotationAt = (event: MouseEvent) => {
  const target = targetAt(event);
  let tagged =
    target instanceof Element ? (target.closest(`[${PATH_ATTR}]`) ?? undefined) : undefined;
  // A synthesised event with no coordinates keeps its target, as nodeAtEvent does.
  const located = event.clientX || event.clientY;
  const x = located ? event.clientX : undefined;
  const y = located ? event.clientY : undefined;
  while (tagged && !holdsPoint(tagged, x, y)) {
    tagged = taggedAncestor(tagged);
  }
  const chain = tagged ? annotationChain(tagged) : [];
  const leaf = chain.at(-1);
  if (!tagged || !leaf) {
    return undefined;
  }
  const path = leaf.file ? `${leaf.file}|${leaf.path}` : leaf.path;
  return { path, occurrence: occurrenceOf(path, tagged), chain, label: labelOf(tagged) };
};

// Each file the element renders through has a deepest node around it: the
// nearest tagged ancestor-or-self carrying one of that file's paths, its
// deepest path there. The file whose node wraps the element most tightly is
// the element itself; the others are outer, by how far up the document their
// node still reaches. So a page's section slotted into a layout ends on the
// page (the layout's slot reaches higher), and an element inside a component
// ends on the component (its instance on the page reaches higher). Ties —
// a component's root, which carries its instance's page path — put the page first.
const annotationChain = (element: Element): AnnotationStep[] => {
  const nearest = new Map<string, string>(); // file → that deepest marker path
  const reach = new Map<string, number>(); // marker path → highest level carrying it
  let at: Element | undefined = element;
  for (let level = 0; at && level < PRELOAD_LIMITS.domDepthMax; level++) {
    const here = new Map<string, string>();
    for (const nodePath of pathsOf(at)) {
      const file = fileOf(nodePath);
      const had = here.get(file);
      if (!nearest.has(file) && (had === undefined || depthOf(nodePath) > depthOf(had))) {
        here.set(file, nodePath);
      }
      reach.set(nodePath, level);
    }
    for (const [file, nodePath] of here) {
      nearest.set(file, nodePath);
    }
    at = taggedAncestor(at);
  }
  const steps = [...nearest].map(([file, nodePath]) => ({
    file,
    path: file ? nodePath.slice(file.length + 1) : nodePath,
    reach: reach.get(nodePath) ?? 0,
  }));
  steps.sort(
    (outer, inner) => inner.reach - outer.reach || pageFirst(outer.file) - pageFirst(inner.file),
  );
  return steps.map(({ file, path }) => ({ file, path }));
};

const depthOf = (nodePath: string): number => nodePath.split('.').length;
const pageFirst = (file: string): number => (file === '' ? 0 : 1);

const fileOf = (nodePath: string): string => {
  const bar = nodePath.indexOf('|');
  return bar === -1 ? '' : nodePath.slice(0, bar);
};

// What the note's row calls the element: its tag and first class, `div.hero`.
const labelOf = (element: Element): string => {
  const first = element.classList[0];
  const tag = element.tagName.toLowerCase();
  return first ? `${tag}.${first}` : tag;
};

export const startOutlines = () => {
  // A page edit now patches the document instead of reloading it, so the
  // markers this map is built from move without the page ever going away.
  // Registered before the early return: the first collection can come up
  // empty (a page whose markup arrives with the first patch), and this is
  // what gets it a second chance.
  document.addEventListener('avb:morphed', () => {
    collectRegions();
    announceMapped();
    queueRects(true);
  });
  collectRegions();
  // Said even when the page has no markers at all: "nothing here" is a real
  // answer, and withholding it would leave every question waiting out its
  // timeout.
  announceMapped();
  if (!regions.size) {
    return;
  }
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
  listenForPointer();
  listenForContextMenu();
};

// Polls for motion nothing announces (see followMotion).
const lookForMotion = () => {
  const look = setInterval(watchMotion, LOOK_EVERY);
  // A repeating timer is the one thing here that would hold a Node process
  // open — the suites run this file in jsdom, and a page's heartbeat is not
  // a reason for `node test/…` never to come back. In the browser the handle
  // is a number and this does nothing — both are checked without asserting.
  if (
    typeof look === 'object' &&
    look !== null &&
    'unref' in look &&
    typeof look['unref'] === 'function'
  ) {
    look['unref']();
  }
};

// Hover, double-click and click, each resolved to the node under the pointer.
const listenForPointer = () => {
  document.addEventListener('mousemove', (event) => {
    const { path: nodePath, occurrence } = nodeAtEvent(event);
    if (
      lastHover === undefined ||
      nodePath !== lastHover.path ||
      occurrence !== lastHover.occurrence
    ) {
      lastHover = { path: nodePath, occurrence };
      postLocated('avb:hover-node', { path: nodePath, occurrence });
    }
  });
  document.documentElement.addEventListener('mouseleave', startOutlinesClearHover);
  // Double-clicking a component opens it for editing, the way Webflow
  // drills into one.
  document.addEventListener(
    'dblclick',
    (event) => {
      if (!designMode) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      // Annotating reaches inside components already: nothing to open.
      if (annotating) {
        return;
      }
      // Report even when nothing in scope matched: markup the layout renders
      // itself (nav, footer — anything outside the page's <slot>) has no
      // in-scope marker, and the app opens the layout for those.
      // With the occurrence: a component inside a loop renders once per
      // item, and opening it means the one under the cursor.
      const { path: nodePath, occurrence } = nodeAtEvent(event);
      postLocated('avb:open-node', { path: nodePath || undefined, occurrence });
    },
    true,
  );

  // In the design canvas (any frame the app tracks paths in), clicking
  // selects the node in the app instead of activating links/buttons.
  // Interactive preview frames never receive avb:track, so they keep
  // normal page behavior.
  document.addEventListener(
    'click',
    (event) => {
      if (!designMode) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (annotating) {
        const annotation = annotationAt(event);
        if (annotation) {
          postLocated('avb:annotate-node', annotation);
        }
        return;
      }
      // A click that hits no marked node still reports (no path), with
      // `outside` saying whether it landed on something the open file simply
      // doesn't own — which is what the app backs out of a component on.
      const { path: nodePath, occurrence, outside } = nodeAtEvent(event);
      postLocated('avb:click-node', {
        path: nodePath || undefined,
        occurrence,
        outside: !!outside,
      });
    },
    true,
  );
};

// Right-click resolves the same source node and occurrence as an ordinary selection.
function listenForContextMenu(): void {
  document.addEventListener(
    'contextmenu',
    (event) => {
      if (!designMode) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const { path, occurrence, outside } = nodeAtEvent(event);
      postLocated('avb:context-node', {
        path: path || undefined,
        occurrence,
        outside: !!outside,
        left: event.clientX,
        top: event.clientY,
      });
    },
    true,
  );
}

function startOutlinesClearHover(): void {
  // Told nothing yet, or told of a node: either way, the pointer has left.
  if (lastHover === undefined || lastHover.path !== undefined) {
    lastHover = { path: undefined, occurrence: 0 };
    // Clear messages use the same located-message contract as hover hits.
    postLocated('avb:hover-node', { path: undefined, occurrence: 0 });
  }
}

// Every located event names the rendering it landed on (step 7): the app
// acts on it only while that rendering is still what the files hold.
function postLocated(type: string, located: Record<string, unknown>): void {
  window.parent.postMessage({ type, ...located, token: renderToken }, '*');
}
