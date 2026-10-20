// The page as the editor knows it: the regions its markers enclose, the paths
// tagged onto rendered elements, the instance being edited, and the preview
// token that says which rendering the frame shows. Lowest of the frame's
// modules; the measuring, reporting and hit-testing above it read this state.

import type { Box, Rect, TaggedPlace } from './frameBasics';
import { PRELOAD_LIMITS, isChildNode, isComment, isElement, isText } from './frameBasics';

// --- Node outlines --------------------------------------------------------
// Pages served through the app's marker plugin wrap every model node in
// <!--avb-s:path--> / <!--avb-e:path--> comment pairs. Record each pair's
// run of sibling DOM nodes, then take the markers out.
//
// Comments, not elements: a <template> counts for :nth-child, :first-child,
// + and ~ like anything else, so the markers this replaced shifted the
// page's own structural selectors for as long as they were in the DOM —
// through first paint, since they can only be removed once the run has been
// recorded. A comment is invisible to all of those. A node in a named slot
// is marked the same way: its markers have to carry the `slot` attribute to
// travel with it, and a <Fragment slot="…" set:html> carries the attribute
// while putting nothing but the comment in the slot.
//
// A <template> is still READ as a marker below. Nothing writes one any more,
// but a page served by a dev server that started before this app was updated
// still has them, and a canvas that suddenly could not read its own markers
// would be a blank navigator with no way to tell why.
//
// The app tracks paths; their rects are pushed back on scroll/resize/DOM
// changes, and hovering the page reports the deepest node under the cursor.
export const regions = new Map<string, Node[][]>(); // path -> [ [node, ...], ... ]
export let trackedPaths: string[] = [];
// The file the app is addressing: empty for the page, or a component's
// namespace while one is open. Every .astro under src carries markers now,
// so hover and click must resolve within the file being edited.
export let activeScope = '';
export const inScope = (nodePath: string) =>
  activeScope ? nodePath.startsWith(activeScope) : !nodePath.includes('|');

// Which rendered copy of the open component is being edited. A component
// used inside a loop renders once per item, and drilling into one card
// means THAT card — so everything below (outlines, hit testing, the classes
// the style panel reads) narrows to the nodes that one instance put on the
// page. Its siblings stay as dim and as unclickable as the rest of it.
export let focusPath = '';
export let focusOcc = 0;
// The Feedback tab is open: a click annotates whatever element is under the
// pointer, in any file, instead of selecting within the open one.
export let annotating = false;
// A run whose every node has left the document isn't an instance any more:
// a patched page collects fresh runs and leaves the old ones in the map.
const isLive = (run: Node[]) => run.some((node) => node.isConnected);
// Undefined until asked, then the answer: no roots (nothing to narrow) or
// the run of nodes the focused instance rendered. Recomputed whenever the
// DOM moves — a patched page rebuilds the regions these come from.
let focusCache: { readonly roots: Node[] | undefined } | undefined;

// The focused instance is worked out again on its next read: the page moved,
// was rebuilt, or the app focused another.
export function resetFocusCache(): void {
  focusCache = undefined;
}

// What the app tracks, set as one by its `avb:track` message: the paths it
// watches, the scope that decides what is hit-testable, and the instance
// being edited.
export function setTracking(next: {
  readonly paths: string[];
  readonly scope: string;
  readonly focus: string;
  readonly occurrence: number;
  /** Absent from callers that never annotate, such as Stacki Studio's client. */
  readonly annotating?: boolean;
}): void {
  trackedPaths = next.paths;
  activeScope = next.scope;
  focusPath = next.focus;
  focusOcc = next.occurrence;
  annotating = next.annotating ?? false;
}
export const focusRoots = (): Node[] | undefined => {
  if (focusCache !== undefined) {
    return focusCache.roots;
  }
  focusCache = { roots: undefined };
  if (focusPath) {
    const runs = (regions.get(focusPath) || []).filter(isLive);
    // Any run at all is the instance that was opened, and everything below —
    // outlines, hit testing, what a scroll-to aims at — should mean THAT one.
    // This used to require two: with `<Button/>` written three times in a
    // page, each has its own path, so the one that was opened has a single
    // run, no narrowing happened, and the component's own paths resolved to
    // all three instances at once — three outlines on screen, and a scroll
    // that went to whichever came first in the document.
    //
    // Zero runs still doesn't narrow: a layout's marker pair is split across
    // <head> and <body> and never pairs up, and narrowing to nothing would
    // hide the page.
    if (runs.length) {
      focusCache = { roots: runs[focusOcc] || runs[0] };
    } else {
      // No marker pair at all: the instance is addressed by attribute — a
      // component rendered into another one's slot, or one whose root is a
      // conditional. Its places are the tagged elements, and the occurrence
      // picks the one that was opened, exactly as the click that opened it
      // counted them.
      //
      // Without this, nothing narrowed while such a component was open, and
      // every path inside it meant every instance on the page: 53 elements
      // answer to Button's `button_text`, so its outline was the union of all
      // of them — a box a thousand pixels tall — and the button itself
      // reported four boxes, one per copy, with the selected one among them
      // only by luck.
      //
      // The nested reads inside taggedPlaces ask focusRoots again; the cache
      // already holds no roots by then, so they narrow to nothing and this
      // decides the answer, rather than recurring.
      const places = taggedPlaces(focusPath);
      const one = places[focusOcc] || places[0];
      if (one) {
        focusCache = { roots: [one.el] };
      }
    }
  }
  return focusCache.roots;
};
export const inFocus = (node: Node): boolean => {
  const roots = focusRoots();
  if (!roots) {
    return true;
  }
  return roots.some((root) => root === node || (root.nodeType === 1 && root.contains(node)));
};
// The occurrences of a path that are on the page, narrowed to the focused
// instance when there is one. Rects, classes and occurrence numbering all
// read this, so "the second copy" means the same thing to all of them.
export const runsOf = (nodePath: string): Node[][] | undefined => {
  const runs = regions.get(nodePath);
  if (!runs) {
    return runs;
  }
  const live = runs.filter(isLive);
  return focusRoots() ? live.filter((run) => run.some(inFocus)) : live;
};
// Whether the markers have been walked yet. The app can ask about a node
// before then — a selection made while the page is still parsing, or in the
// instant after a patch — and the honest answer is "not yet", not "no such
// element". Every answer carries this so the asker can tell the two apart,
// and the announcement below tells it when to try again.
export let mapped = false;
export const announceMapped = () => {
  mapped = true;
  try {
    window.parent.postMessage({ type: 'avb:canvas-ready' }, '*');
  } catch {
    /* no parent to tell */
  }
  announceRender();
};

// --- The preview token (plan §9, step 7) ----------------------------------
// Every file the dev plugin marks carries one stamp, <!--avb-d:<sha256>:<file>-->,
// naming the bytes it was marked from. The stamps on the page are the
// manifest of this rendering, and its token — the SHA-256 of the manifest's
// canonical text — rides on every located event, so the app can refuse a
// click from a rendering the files have since moved past. Mirrors
// shared/page/previewToken.ts, which this sandboxed preload cannot require; the
// contract test (test/electron/previewServer/previewBridge.test.ts) pins the two to each
// other. The patcher gathers the stamps at the document's end after each
// patch; the page arrives with them wherever each file rendered.
const STAMP_PREFIX = 'avb-d:';
export const STAMP_ATTRIBUTE = 'data-avb-d';
const STAMPS_MAX = 20000; // LIMITS.previewMarkersMax
const MANIFEST_FILES_MAX = 512; // LIMITS.previewManifestFilesMax
export let renderToken: string | undefined = undefined;
let renderStamps: { readonly file: string; readonly checksum: string }[] | undefined;
let renderSeq = 0;
// Undefined when the page's stamps cannot form one manifest: too many, or
// one file stamped with two checksums (a rendering mixing versions of it).
const readManifest = (): { file: string; checksum: string }[] | undefined => {
  const byFile = new Map<string, string>();
  let stamps = 0;
  const record = (data: string): boolean => {
    stamps += 1;
    if (stamps > STAMPS_MAX) {
      return false;
    }
    if (!data.startsWith(STAMP_PREFIX)) {
      return true;
    }
    const rest = data.slice(STAMP_PREFIX.length);
    const checksum = rest.slice(0, 64);
    const file = rest.slice(65);
    if (!/^[0-9a-f]{64}$/.test(checksum) || rest[64] !== ':' || !file) {
      return true;
    }
    const seen = byFile.get(file);
    if (seen !== undefined && seen !== checksum) {
      return false;
    }
    byFile.set(file, checksum);
    return true;
  };
  const stack: Node[] = [document];
  while (stack.length) {
    const parent = stack.pop();
    if (!parent) {
      break;
    }
    for (let node = parent.firstChild; node; node = node.nextSibling) {
      if (isElement(node)) {
        const carried = node.getAttribute(STAMP_ATTRIBUTE);
        if (carried !== null) {
          if (STAMPS_MAX * (65 + 1_024) < carried.length) {
            return undefined;
          }
          // Newlines cannot occur in a stamped path, unlike spaces, so a file
          // such as `Hero Card.astro` remains one token while inherited stamps
          // can still travel together through component props.
          const tokens = carried.split('\n').filter(Boolean);
          if (STAMPS_MAX < tokens.length) {
            return undefined;
          }
          for (const token of tokens) {
            if (!record(token)) {
              return undefined;
            }
          }
        }
        stack.push(node);
        continue;
      }
      if (!isComment(node) || !node.data.startsWith(STAMP_PREFIX)) {
        continue;
      }
      if (!record(node.data)) {
        return undefined;
      }
    }
  }
  if (byFile.size > MANIFEST_FILES_MAX) {
    return undefined;
  }
  return [...byFile.keys()]
    .sort((left, right) => (left < right ? -1 : left === right ? 0 : 1))
    .map((file) => ({ file, checksum: byFile.get(file) ?? '' }));
};
const announceRender = () => {
  renderSeq += 1;
  const seq = renderSeq;
  renderToken = undefined; // Until this rendering's digest is known, events carry none.
  renderStamps = undefined;
  const stamps = readManifest();
  const subtle = globalThis.crypto?.subtle;
  if (!stamps || !subtle) {
    return;
  }
  const canonical = stamps.map((stamp) => `${stamp.checksum} ${stamp.file}\n`).join('');
  subtle.digest('SHA-256', new TextEncoder().encode(canonical)).then(
    (digest) => {
      if (seq !== renderSeq) {
        return;
      } // A newer rendering has announced itself.
      const bytes = Array.from(new Uint8Array(digest));
      renderToken = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
      renderStamps = stamps;
      reportRender();
    },
    () => {
      /* no digest, no token: the app refuses this rendering's events */
    },
  );
};

// The first announcement can precede the editor's message listener on a fast
// iframe load. Re-send the verified rendering when the editor registers the
// frame, without rehashing or briefly clearing its token.
export function reportRender(): void {
  if (renderToken === undefined || renderStamps === undefined) {
    return;
  }
  try {
    window.parent.postMessage(
      { type: 'avb:render', token: renderToken, stamps: renderStamps },
      '*',
    );
  } catch {
    /* no parent to tell */
  }
}

// Element nodes also carry their path as an attribute, because the node
// references above go stale: the page's own scripts are free to rebuild
// the DOM, and text-animation libraries do exactly that — GSAP SplitText
// rewrites a paragraph as one clone per line, leaving the original element
// (the one recorded here) holding just the last line. Attributes ride
// along on clones, so the path can be re-resolved live. It has to be an
// attribute rather than leaving marker *nodes* in the DOM: an element marker
// would change what :first-child/:nth-child match.
export const PATH_ATTR = 'data-avb-p';

// An element can carry more than one path, space separated. The page
// addresses a slotted element by its page path (written into the markup by
// the serializer, since a slotted node can't be wrapped in markers); the
// component that renders the slot addresses that same element by its own
// path. Whichever file is open picks its namespace out of the list.
export const pathsOf = (element: Element): string[] =>
  (element.getAttribute(PATH_ATTR) || '').split(' ').filter(Boolean);
// Which tags this file put on an element itself, as opposed to the ones the
// page arrived with. The serializer writes a tag into the markup wherever a
// marker pair can't go — a slotted node, a word in an inline run, a component
// whose root is a conditional — and those belong to the file. The ones added
// here are bookkeeping, and only bookkeeping is ours to withdraw.
const ourTags = new WeakMap<Element, Set<string>>();
// The shortest path this element carries in each component file — a marker
// run tags every element it holds, so one element can carry several paths in
// the same file, and the shortest of them is the highest node it stands for.
const nsOf = (element: Element): Map<string, string> => {
  const out = new Map<string, string>();
  for (const nodePath of pathsOf(element)) {
    const bar = nodePath.indexOf('|');
    if (bar === -1) {
      continue;
    }
    const file = nodePath.slice(0, bar + 1);
    const inner = nodePath.slice(bar + 1);
    const had = out.get(file);
    if (had === undefined || inner.length < had.length) {
      out.set(file, inner);
    }
  }
  return out;
};

// The nearest ancestor that stands for a node this one is nested UNDER, in
// the same file. Undefined means this element is where that file's rendering
// begins — the root of a component instance.
const nsParent = (element: Element, file: string, inner: string): Element | undefined => {
  let up = taggedAncestor(element);
  while (up) {
    const theirs = nsOf(up).get(file);
    if (theirs !== undefined && inner.startsWith(`${theirs}.`)) {
      return up;
    }
    up = taggedAncestor(up);
  }
  return undefined;
};
// The nearest strict ancestor that carries a path, if any.
export const taggedAncestor = (element: Element): Element | undefined =>
  element.parentElement?.closest(`[${PATH_ATTR}]`) ?? undefined;

// What the page calls a component instance belongs on the element the
// instance rendered as its root. It does not always land there: the
// serializer hands the page's path to the component as a prop, and the
// component decides where its `...rest` goes. A form field forwards it to the
// <select>, so a FormSelect was named on the control and not on the <label>
// around it — and everything downstream meant the control. The outline drew
// around the box and left the field's own label outside it, and a click on
// that label reached past the component to whatever contained it.
//
// Only for an element that is inside a component's rendering and is not the
// root of any of them. An element that IS a root already answers for its own
// instance, and its page path is its own name: a page section is the root of
// Section.astro and sits inside the layout's slot, so it carries a path in
// the layout's namespace too — climbing that would put the section's name on
// <body>.
//
// The path is added to the root rather than moved off the element the
// component put it on: that element still answers to it in the component's
// own file, and the outermost of the two is what the boxes and the hit
// testing already prefer.
// Whether a page path on this element ARRIVED here — the caller's name for an
// instance, riding in on `{...rest}` — as opposed to being the element's own
// name.
//
// The serializer writes an element's own path first and whatever came in on
// the spread after it, and the tags this file adds are known (`ourTags`), so
// what is left is what the page was served with. A page path at the head of
// that list is the element's own name: the page wrote `<section>` and the
// serializer tagged that very element, and there is nothing to work out.
//
// Without this, a plain section slotted into a layout was promoted — it
// carries a path in the LAYOUT's namespace, because the collector tags
// everything inside a marker run, and it is not the root of that namespace,
// so the climb ran all the way to <html>. A Webflow export is exactly that
// shape: nine sections, all nine names ending up on <html>, and selecting
// any one of them outlined the entire page.
const rodeIn = (element: Element, path: string): boolean => {
  const mine = ourTags.get(element);
  const written = pathsOf(element).filter((nodePath) => !mine?.has(nodePath));
  const at = written.indexOf(path);
  return at > 0 && written.slice(0, at).some((nodePath) => nodePath.includes('|'));
};

const promoteInstanceTags = () => {
  for (const element of Array.from(document.querySelectorAll(`[${PATH_ATTR}]`))) {
    const page = pathsOf(element).filter(
      (nodePath) => !nodePath.includes('|') && rodeIn(element, nodePath),
    );
    if (!page.length) {
      continue;
    }
    const ns = nsOf(element);
    if (!ns.size) {
      continue;
    }
    let file: string | undefined = undefined;
    for (const [candidateFile, inner] of ns) {
      if (!nsParent(element, candidateFile, inner)) {
        file = undefined;
        break;
      } // a root: leave it alone
      if (!file) {
        file = candidateFile;
      }
    }
    if (!file) {
      continue;
    }
    // nsParent returns a strict ancestor, so the climb ends within the
    // element's depth in the document.
    let at = element;
    let innerOf = nsOf(at).get(file);
    let up = innerOf === undefined ? undefined : nsParent(at, file, innerOf);
    while (up) {
      at = up;
      innerOf = nsOf(at).get(file);
      up = innerOf === undefined ? undefined : nsParent(at, file, innerOf);
    }
    if (at === element) {
      continue;
    }
    for (const nodePath of page) {
      addPath(at, nodePath);
    }
  }
};

const addPath = (element: Element, nodePath: string): void => {
  const list = pathsOf(element);
  if (list.includes(nodePath)) {
    return;
  }
  list.push(nodePath);
  element.setAttribute(PATH_ATTR, list.join(' '));
  let mine = ourTags.get(element);
  if (!mine) {
    ourTags.set(element, (mine = new Set()));
  }
  mine.add(nodePath);
};
// The elements a path is on, one per copy — outermost only. A path can land
// on an element AND on something inside it: inside slot content the marker
// is written onto the markup (see serializeNodeMarked), and a component that
// spreads its rest props puts it on whatever element it spreads onto, which
// may sit inside the one the collector tagged. Those are one copy addressed
// twice, and counting them as two made a node with a single instance report
// "copy 2" for a click in the wrong half of itself — and the classes and
// spacing lists, which are one entry per occurrence, disagree with the boxes.
export const elementsWithPath = (nodePath: string): Element[] => {
  const all: Element[] = Array.from(document.querySelectorAll(`[${PATH_ATTR}]`)).filter(
    (element) => pathsOf(element).includes(nodePath) && inFocus(element),
  );
  return all.filter(
    (element) => !all.some((other) => other !== element && other.contains(element)),
  );
};

// A source class edit changes every rendering of that node, including loop
// copies outside the focused instance. Measurement still uses the focused set.
export const allElementsWithPath = (nodePath: string, countMax: number): Element[] | undefined => {
  const all: Element[] = [];
  const tagged = document.querySelectorAll(`[${PATH_ATTR}]`);
  for (let index = 0; index < tagged.length; index += 1) {
    const element = tagged.item(index);
    if (!element) {
      continue;
    }
    if (!pathsOf(element).includes(nodePath)) {
      continue;
    }
    all.push(element);
    if (all.length > countMax) {
      return undefined;
    }
  }
  return all.filter(
    (element) => !all.some((other) => other !== element && other.contains(element)),
  );
};

// The path a node marks, or undefined when it isn't a marker. `kind` is 's'/'e'.
const markerPath = (node: Node, kind: 's' | 'e'): string | undefined => {
  if (isComment(node)) {
    const tag = `avb-${kind}:`;
    return node.data.startsWith(tag) ? node.data.slice(tag.length) : undefined;
  }
  if (isElement(node) && node.tagName === 'TEMPLATE') {
    return node.getAttribute(`data-avb-${kind}`) ?? undefined;
  }
  return undefined;
};

export const collectRegions = () => {
  pruneRegions();
  const { starts, markers } = findMarkers();
  // What each path was found to hold this pass, so a tag left on an element
  // the region no longer contains can be taken off again (untagStale).
  const collected = new Map<string, Set<Node>>();
  for (const start of starts) {
    const nodePath = markerPath(start, 's');
    if (nodePath === undefined) {
      continue;
    } // a start marker always carries a path
    const run = runAfter(start, nodePath);
    let set = collected.get(nodePath);
    if (!set) {
      set = new Set();
      collected.set(nodePath, set);
    }
    for (const node of run) {
      set.add(node);
    }
    recordRun(nodePath, run);
  }
  untagStale(collected);
  for (const node of markers) {
    if (isChildNode(node)) {
      node.remove();
    }
  }
  promoteInstanceTags();
  focusCache = undefined; // new runs — the focused instance may be among them
};

// Runs that have left the document go first. A patched page collects
// again, and what it collected last time is either the same nodes (the
// patch morphed them in place) or nodes that are gone — never a second
// copy of the node, however many times the page is edited.
const pruneRegions = () => {
  for (const [nodePath, runs] of regions) {
    const live = runs.filter(isLive);
    if (live.length) {
      regions.set(nodePath, live);
    } else {
      regions.delete(nodePath);
    }
  }
};

// One pass in document order over both marker forms — the deeper path has
// to be seen last so that it wins the tag on an element they share.
// Walked by hand rather than with a TreeWalker: this runs in the preload's
// isolated world, and depending on nothing but firstChild/nextSibling
// keeps it working whatever that world does or doesn't expose. It is also
// the only thing standing between the page and no outlines at all —
// startOutlines gives up entirely when nothing is recorded.
const findMarkers = (): { starts: Node[]; markers: Node[] } => {
  const starts: Node[] = [];
  const markers: Node[] = [];
  const visit = (parent: Node, depth: number) => {
    if (depth > PRELOAD_LIMITS.domDepthMax) {
      return;
    }
    for (let node = parent.firstChild; node; node = node.nextSibling) {
      const isStart = markerPath(node, 's') !== undefined;
      if (isStart) {
        starts.push(node);
      }
      if (isStart || markerPath(node, 'e') !== undefined) {
        markers.push(node);
      }
      if (isElement(node)) {
        visit(node, depth + 1);
      }
    }
  };
  visit(document, 0);
  return { starts, markers };
};

// The run a start marker opens, tagging each element in it with the path.
//
// The run ends at the matching close marker, and a run with no close
// marker among its siblings is EMPTY — never "everything after it".
// Both markers are written as siblings around the node, so a start
// whose end isn't there has lost it, and the honest reading of that is
// that the region holds nothing. Swallowing instead put the following
// element inside the region, which then answered for clicks on it: the
// docs footer reported a comment when its fine print was clicked.
const runAfter = (start: Node, nodePath: string): Node[] => {
  let end: Node | undefined = undefined;
  for (let node = start.nextSibling; node; node = node.nextSibling) {
    if (markerPath(node, 'e') === nodePath) {
      end = node;
      break;
    }
  }
  const run: Node[] = [];
  for (let node = start.nextSibling; node && node !== end; node = node.nextSibling) {
    if (!end) {
      break;
    }
    run.push(node);
    // A chunk group's run contains its members, which are marked too —
    // document order puts the deeper path last, so it wins the tag.
    if (isElement(node) && node.tagName !== 'TEMPLATE') {
      addPath(node, nodePath);
    }
  }
  return run;
};

// The same place, collected again: it replaces itself. Appending would
// make one node look like many — the same box drawn over and over (and
// the overlays are translucent, so a node hovered after fourteen edits
// was painted fourteen times, an opaque wash over the page), and every
// count of "which copy" off by however many edits had been made.
const recordRun = (nodePath: string, run: Node[]) => {
  if (!regions.has(nodePath)) {
    regions.set(nodePath, []);
  }
  const runs = regions.get(nodePath) ?? [];
  const again = runs.findIndex((other) => other.some((node) => run.includes(node)));
  if (again >= 0) {
    runs[again] = run;
  } else {
    runs.push(run);
  }
};

// A tag WE added is only good while the region still holds the element. They
// used to accumulate and never come off, so one bad pass — a marker briefly
// out of place — left an element permanently answering to a path it wasn't
// in.
//
// The tags the markup came with are not ours to withdraw, and taking them
// meant a click landing nowhere. Five buttons on a page all carry
// `Button.astro|0.0.0` — the component's own root, the same path in every
// instance — and only the ones a marker pair happened to wrap counted as
// collected, so the rest lost the tag. Open Button.astro, click one of
// those, and the canvas could not place the click at all: no path in the
// open file, but something under the pointer, which reads as "looked away"
// and closed the component you were editing.
const untagStale = (collected: Map<string, Set<Node>>) => {
  for (const element of Array.from(document.querySelectorAll(`[${PATH_ATTR}]`))) {
    const mine = ourTags.get(element);
    const kept = pathsOf(element).filter(
      (nodePath) =>
        !mine?.has(nodePath) ||
        !collected.has(nodePath) ||
        (collected.get(nodePath)?.has(element) ?? false),
    );
    if (kept.length === pathsOf(element).length) {
      continue;
    }
    for (const nodePath of pathsOf(element)) {
      if (!kept.includes(nodePath)) {
        mine?.delete(nodePath);
      }
    }
    if (kept.length) {
      element.setAttribute(PATH_ATTR, kept.join(' '));
    } else {
      element.removeAttribute(PATH_ATTR);
    }
  }
};

// Grows `acc` (a left/top/right/bottom box, or undefined) by one node's box.
// `depth` counts the `display: contents` elements descended through.
export const addNode = (acc: Box | undefined, node: Node, depth = 0): Box | undefined => {
  if (!node.isConnected) {
    return acc;
  }
  if (depth > PRELOAD_LIMITS.domDepthMax) {
    return acc;
  }
  let rect: DOMRect | undefined = undefined;
  if (isElement(node)) {
    if (node.tagName === 'TEMPLATE') {
      return acc;
    }
    rect = node.getBoundingClientRect();
    // `display: contents` generates no box of its own, so the element
    // measures zero however big its content is. Astro sets it on
    // <astro-island>/<astro-slot>, which is every client: component — they
    // selected fine (hover walks the DOM) but drew no outline. Fall back to
    // the children, which do generate boxes.
    if (rect.width === 0 && rect.height === 0) {
      let grown = acc;
      for (const child of Array.from(node.childNodes)) {
        grown = addNode(grown, child, depth + 1);
      }
      return grown;
    }
  } else if (isComment(node)) {
    return acc; // a marker still sitting in a recorded run — no box to add
  } else if (isText(node) && node.textContent.trim()) {
    const range = document.createRange();
    range.selectNode(node);
    rect = range.getBoundingClientRect();
  }
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    return acc;
  }
  if (!acc) {
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  }
  return {
    left: Math.min(acc.left, rect.left),
    top: Math.min(acc.top, rect.top),
    right: Math.max(acc.right, rect.right),
    bottom: Math.max(acc.bottom, rect.bottom),
  };
};

export const toRect = (box: Box): Rect => ({
  x: box.left,
  y: box.top,
  w: box.right - box.left,
  h: box.bottom - box.top,
});

// The tagged elements that are really PLACES, each with its box.
//
// No marker pair — a slotted element, or a word inside an inline run, carries
// its path as an attribute instead: a marker beside either would land in the
// wrong slot or add a space between words. Inside a loop that means one
// tagged element per item, and they are the occurrences of that node.
//
// One list, read by the boxes AND by the click that picks one of them, so
// "the second copy" means the same thing to both. It didn't: the outlines
// counted tagged elements and the click counted marker runs, of which a
// tagged node has none — so clicking the second link in a list reported
// occurrence 0 and the first one lit up.
export const taggedPlaces = (nodePath: string): TaggedPlace[] => {
  const out: TaggedPlace[] = [];
  for (const element of elementsWithPath(nodePath)) {
    const acc = addNode(undefined, element);
    if (acc) {
      out.push({ el: element, rect: toRect(acc) });
    }
  }
  // A line splitter leaves hollow copies of an element behind; they are not
  // places, and counting them would shift every occurrence after them.
  const real = out.filter((place) => place.rect.w > 0 && place.rect.h > 0);
  return real.length ? real : out;
};
