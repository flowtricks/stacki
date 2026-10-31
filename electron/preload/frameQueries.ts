import { parseCanvasInteraction } from '../../shared/properties/canvasInteraction';
import { hidePendingDelete, settlePendingDeletes } from './framePendingDelete';
import { setCanvasInteraction } from './frameInteraction';
// The app asking the frame: a path's elements and computed values, the paths
// it tracks, scrolling a node into view and the viewport height to freeze; and
// starting the frame once the document is ready.

import { PROBE_ATTR, isElement, isText } from './frameBasics';
import { queryAuthoredStyles } from './frameStyleSources';
import { list, pathText, text } from '../../shared/core/boundary';
import { LIMITS } from '../../shared/core/limits';
import { renderedPageImage, renderedPageType } from './framePageMetadata';
import { renderedPageText } from './framePageText';
import { freezeViewportHeight, report } from './frameViewport';
import { startGuide, type GuideFrame } from './frameGuide';
import {
  PATH_ATTR,
  activeScope,
  allElementsWithPath,
  elementsWithPath,
  focusOcc,
  focusPath,
  mapped,
  pathsOf,
  reportRender,
  resetFocusCache,
  runsOf,
  setTracking,
} from './frameRegions';
import { ownClasses, resetThinCache } from './frameMeasure';
import {
  forgetReportedKeys,
  paintOpened,
  scrollPathIntoView,
  sendClasses,
  sendRects,
  sendRendered,
} from './frameReports';
import { enterDesignMode, startOutlines } from './frameTargets';

// Nodes that put nothing on the page: a component that returns null for the
// props it was given (an <Img> with no src, a grid with no children) still
// has its marker pair, with nothing between them. Structural only — no
// measuring — so this can cover every node in the file rather than the two
// or three whose rects are tracked. A node that renders only whitespace
// counts as empty; one that renders a zero-size element does not, because
// something IS there.
// What actually reached the page. Reported the positive way round, because
// a node can put nothing on screen in two ways: its markers are there with
// nothing between them (a component that returned null), or its markers
// never got emitted at all — everything inside a component that rendered
// nothing, whose slot content was never evaluated. Only the app knows the
// full node list, so it takes this set and treats the rest as unrendered.
//
// Structural only, no measuring, so it can cover every node in the file.
// The scope and instance the page-wide answers were last worked out for.
// `undefined` until the first track, so the first one always answers.
let lastQuestion: string | undefined;
// --- Asking the page itself ------------------------------------------------
//
// The style panel used to answer "does this selector target this element?"
// by walking the app's source tree, which stops at a component's edge: a
// rule hinging on a class the component renders (`.section > *`) looked like
// no match, and a class added by a script was invisible. The rendered page
// is right here, so ask it — Chromium's own selector engine, over the real
// DOM, knows every element and every class however it got there.
const elementsForPath = (nodePath: string): Element[] => {
  const out: Element[] = [];
  for (const run of runsOf(nodePath) || []) {
    for (const node of run) {
      if (!isElement(node)) {
        continue;
      }
      // A run holds everything between the marker pair, which includes the
      // markers of anything nested. Those are detached once collected, and a
      // <template> among them — from a page served before this app was
      // updated — never describes the element anyway: reporting one as the
      // node's identity tells the style panel the tag is `template` and there
      // are no classes. Same rule the rect measuring uses.
      if (!node.isConnected || node.tagName === 'TEMPLATE') {
        continue;
      }
      out.push(node);
    }
  }
  for (const element of elementsWithPath(nodePath)) {
    if (!out.includes(element)) {
      out.push(element);
    }
  }
  // A node that renders nothing of its own (a component wrapping a fragment,
  // `display: contents`) still has descendants that do — the first of those
  // stands in for it, the same fallback the rect measuring uses.
  if (!out.length) {
    const first = Array.from(document.querySelectorAll(`[${PATH_ATTR}]`)).find((element) =>
      pathsOf(element).some((x) => x.startsWith(nodePath + '.')),
    );
    if (first) {
      out.push(first);
    }
  }
  return out;
};

const identityOf = (element: Element) => ({
  tag: element.tagName.toLowerCase(),
  id: element.id || undefined,
  classes: ownClasses(element),
  attributes: Object.fromEntries(
    Array.from(element.attributes)
      .filter((attribute) => !attribute.name.startsWith('data-avb-'))
      .map((attribute) => [attribute.name, attribute.value]),
  ),
});

// The app posts these messages with structured payloads; anything else from
// its window — or from another frame entirely — is not ours to act on.
const recordPayload = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null;

// The app's questions and instructions, from its own window only.
export function listenForQueries(): void {
  // After the patch has swapped the nodes and their stamps (see the listener's note).
  document.addEventListener('avb:morphed', () => setTimeout(settlePendingDeletes, 0));
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window.parent) {
      return;
    }
    const data: unknown = event.data;
    if (!recordPayload(data)) {
      return;
    }
    const interaction = parseCanvasInteraction(data);
    if (interaction !== undefined) {
      setCanvasInteraction(interaction);
      return;
    }
    if (data['type'] === 'avb:query' && typeof data['id'] === 'number') {
      answerQuery(data, data['id']);
      return;
    }
    if (data['type'] === 'avb:class-patch') {
      applyClassPatch(data);
      return;
    }
    if (data['type'] === 'avb:request-render') {
      reportRender();
      return;
    }
    if (data['type'] === 'avb:hide-pending') {
      hidePending(data['path']);
      return;
    }
    guideFrame?.receive(data);
    if (data['type'] === 'avb:track' && Array.isArray(data['paths'])) {
      track(data, data['paths']);
    }
    if (data['type'] === 'avb:scroll-to' && typeof data['path'] === 'string') {
      scrollPathIntoView(data['path'], typeof data['occ'] === 'number' ? data['occ'] : 0);
    }
    if (data['type'] === 'avb:set-vh' && typeof data['px'] === 'number') {
      freezeViewportHeight(data['px']);
    }
  });
}

// A deleted node, hidden until the rebuilt page confirms it (framePendingDelete.ts).
function hidePending(input: unknown): void {
  let path: string;
  try {
    path = pathText(input);
  } catch {
    return;
  }
  hidePendingDelete(path);
  sendRects();
}

const CLASS_PATCH_NAMES_MAX = 64;
const CLASS_PATCH_OCCURRENCES_MAX = 1024;

function applyClassPatch(data: Record<string, unknown>): void {
  let path: string;
  let add: string[];
  let remove: string[];
  try {
    path = pathText(data['path']);
    add = list(text)(data['add']);
    remove = list(text)(data['remove']);
  } catch {
    return;
  }
  if (add.length + remove.length > CLASS_PATCH_NAMES_MAX) {
    return;
  }
  if ([...add, ...remove].some((name) => !name || name.length > 256 || /\s/.test(name))) {
    return;
  }
  const elements = allElementsWithPath(path, CLASS_PATCH_OCCURRENCES_MAX);
  if (!elements) {
    return;
  }
  for (const element of elements) {
    for (const name of remove) {
      element.classList.remove(name);
    }
    for (const name of add) {
      element.classList.add(name);
    }
  }
  sendClasses();
  sendRects();
}

const answerQuery = (data: Record<string, unknown>, id: number) => {
  if (data['pageText'] === true) {
    window.parent.postMessage(
      { type: 'avb:query-result', id, found: true, pageText: renderedPageText(document) },
      '*',
    );
    return;
  }
  if (data['pageMetadata'] === true) {
    window.parent.postMessage(
      {
        type: 'avb:query-result',
        id,
        found: true,
        pageImage: renderedPageImage(document),
        pageType: renderedPageType(document),
      },
      '*',
    );
    return;
  }
  const path = typeof data['path'] === 'string' ? data['path'] : '';
  const els = path ? elementsForPath(path) : [];
  const styleHost = els[0] ?? answerQueryTextHost(path, data['textParentPath']);
  const wanted = (Array.isArray(data['compute']) ? data['compute'] : []).filter(
    (value): value is string => typeof value === 'string',
  );
  // No element named, or none found: the question is about the page rather
  // than about a node. That is what the variables panel asks — a value is
  // the same colour wherever it is written, and the custom properties it
  // leans on are declared on :root, which is this element. Only `compute`
  // takes this: the reads below are ABOUT a node, and answering them from
  // the root would be answering a different question.
  const host = styleHost ?? document.documentElement;
  const computed = wanted.length && host ? computeValues(host, wanted) : {};
  const props = Array.isArray(data['props']) ? data['props'] : [];
  const computedProps = props.length && styleHost ? computeProperties(styleHost, props) : {};
  const selectors = (Array.isArray(data['selectors']) ? data['selectors'] : []).filter(
    (value): value is string => typeof value === 'string',
  );
  const matched: Record<string, boolean | undefined> = {};
  for (const selector of selectors) {
    try {
      // Any of the element's occurrences matching counts — a loop child is
      // one node in the tree and many elements on the page.
      matched[selector] = els.some((element) => element.matches(selector));
    } catch {
      matched[selector] = undefined; // not a selector this engine accepts
    }
  }
  window.parent.postMessage(
    {
      type: 'avb:query-result',
      id,
      ready: mapped,
      found: styleHost !== undefined,
      computed,
      computedProps,
      ...(styleHost
        ? queryAuthoredStyles(
            styleHost,
            props.filter((prop): prop is string => typeof prop === 'string'),
            els[0] ? 'element' : 'text',
          )
        : {}),
      identity: els[0] ? identityOf(els[0]) : undefined,
      matched,
    },
    '*',
  );
};

// A text run inherits its rendered parent's style, including styles inside a
// component that the source tree cannot see. This host is only for computed
// reads: attributing its selectors or classes to the text would target edits
// at the parent instead of the selected node.
function answerQueryTextHost(path: string, parent: unknown): Element | undefined {
  const runs = runsOf(path) ?? [];
  if (runs.length > LIMITS.treeNodesMax) {
    return undefined;
  }
  let visited = 0;
  for (const run of runs) {
    for (const node of run) {
      visited += 1;
      if (visited > LIMITS.treeNodesMax) {
        return undefined;
      }
      if (isText(node)) {
        if (node.isConnected) {
          if (node.data.trim().length > 0) {
            return node.parentElement ?? undefined;
          }
        }
      }
    }
  }
  return runs.length === 0 ? answerQueryTextParent(path, parent) : undefined;
}

// The renderer must opt in for a known text node. Merely failing to locate an
// element must never substitute some ancestor's styles or editing identity.
function answerQueryTextParent(path: string, input: unknown): Element | undefined {
  if (input === undefined) {
    return undefined;
  }
  let parent: string;
  try {
    parent = pathText(input);
  } catch {
    return undefined;
  }
  if (!path.startsWith(`${parent}.`)) {
    return undefined;
  }
  if (!/^\d+$/.test(path.slice(parent.length + 1))) {
    return undefined;
  }
  return elementsWithPath(parent)[0];
}

// What a value actually resolves to ON THIS ELEMENT. `var(--background)`
// means nothing in the app's own document — the panel painted it there
// and got transparent — and it can mean different things on two elements
// of the same page (a theme class, a container query, a colour scheme).
// Only the page can say, so it is asked: a throwaway span in the element
// inherits its custom properties, takes the value as a colour, and the
// engine hands back the computed one.
const computeValues = (host: Element, wanted: string[]): Record<string, string | undefined> => {
  const computed: Record<string, string | undefined> = {};
  const probe = document.createElement('span');
  probe.setAttribute(PROBE_ATTR, ''); // The canvas's own: no page walk (mutationKind).
  probe.setAttribute('style', 'position:absolute;width:0;height:0;visibility:hidden');
  host.appendChild(probe);
  for (const value of wanted) {
    try {
      // A sentinel first: assigning a value the engine rejects leaves the
      // previous one in place, and reading that back would report a
      // colour the value never had.
      probe.style.color = 'rgb(1, 2, 3)';
      probe.style.color = value;
      computed[value] =
        probe.style.color === 'rgb(1, 2, 3)' ? undefined : getComputedStyle(probe).color;
    } catch {
      computed[value] = undefined;
    }
  }
  probe.remove();
  return computed;
};

// What the element's style ACTUALLY is for a property nothing in the panel
// sets — inherited from a parent, painted by a `*` rule the panel can't see
// past a component edge, or a user-agent default. The panel highlights that
// value in its dropdowns so an unset control still shows what's on the page.
const computeProperties = (
  element: Element,
  props: unknown[],
): Record<string, string | undefined> => {
  const computedProps: Record<string, string | undefined> = {};
  // Design mode paints `cursor: default !important` over everything (see the
  // top of this file), so the page's own cursor is hidden behind it. Lift that
  // sheet for the read and put it straight back — nothing paints in between,
  // and otherwise every element would report `default`.
  const designStyle = document.getElementById('avb-design-style');
  const designSheet = designStyle instanceof HTMLStyleElement ? designStyle : undefined;
  try {
    if (designSheet) {
      designSheet.disabled = true;
    }
    const cs = getComputedStyle(element);
    for (const prop of props) {
      if (typeof prop !== 'string') {
        continue;
      }
      computedProps[prop] = cs.getPropertyValue(prop) || undefined;
    }
  } catch {
    // A detached or cross-document element answers nothing; the panel
    // falls back to its own defaults.
  } finally {
    if (designSheet) {
      designSheet.disabled = false;
    }
  }
  return computedProps;
};

const track = (data: Record<string, unknown>, paths: unknown[]) => {
  enterDesignMode();
  setTracking({
    paths: paths.filter((nodePath): nodePath is string => typeof nodePath === 'string'),
    scope: typeof data['scope'] === 'string' ? data['scope'] : '',
    focus: typeof data['focus'] === 'string' ? data['focus'] : '',
    occurrence: typeof data['focusOcc'] === 'number' ? data['focusOcc'] : 0,
  });
  resetFocusCache();
  resetThinCache(); // scope decides what's hit-testable
  paintOpened();
  sendRects();
  // The page-wide answers, but only when the QUESTION changed. Tracking a
  // different node does not change which nodes rendered — and the app
  // tracks a new node on every hover, so answering that here walked the
  // whole page each time the pointer moved.
  //
  // The scope and the focused instance do change it: both decide which
  // nodes are asked about at all.
  const question = `${activeScope}|${focusPath}|${focusOcc}`;
  if (question !== lastQuestion) {
    lastQuestion = question;
    forgetReportedKeys();
    sendRendered();
    sendClasses();
  }
};

// The column guide's page side, once the frame has started.
let guideFrame: GuideFrame | undefined;

const start = () => {
  report();
  startOutlines();
  guideFrame = startGuide((message) => window.parent.postMessage(message, '*'));
  // Tell the app which route this frame is on (used by interactive
  // preview mode to follow link navigation).
  try {
    window.parent.postMessage(
      { type: 'avb:navigated', path: location.pathname + location.search },
      '*',
    );
  } catch {
    /* ignore */
  }
  try {
    const ro = new ResizeObserver(report);
    ro.observe(document.documentElement);
    if (document.body) {
      ro.observe(document.body);
    }
  } catch {
    /* old engines: load event still reports */
  }
  window.addEventListener('load', report);
};
// Starts the frame now, or once the document has been parsed.
export function startWhenReady(): void {
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}
