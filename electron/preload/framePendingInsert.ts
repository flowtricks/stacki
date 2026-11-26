// A node chosen in the insert palette is on the canvas the moment it is chosen.
//
// The rebuilt page used to be the only way a new node reached the canvas: write the source,
// let the dev server compile and render the page, patch the difference in
// (docs/insert-latency.md has the measured stages).
//
// For a plain element the canvas knows what the writer will emit (the editor built the node from
// the same template), so it draws it at once, in the place the page will put the real one. A
// component is rendered by the server, so the canvas shows only what is real: a copy of an
// instance the page already holds written the same way (canvasTwin.ts), and otherwise nothing.
// Nothing stays invisible only while the render is on time (it usually is: about a tenth of a
// second); past `waitingMs` a quiet bar, with no label, holds the place until it arrives. Either
// way an element tagged with the path the new node will have is in the page at once, and the
// siblings after it are renumbered (shared/page/canvasInsert.ts), so the selection outline, the
// hover outline and the Navigator's reveal find the right node.
//
// The rebuilt page is still the authority, exactly as for a reorder shown ahead of its write
// (frameMove.ts). A patch is the difference between the server's previous rendering and its new
// one, applied to the live page, and it assumes the live page is the previous rendering plus
// whatever the page's own scripts did. So just before a patch the stand-in is taken back and the
// paths put back, and the patch applies as it always has, in the same task: nothing paints in
// between, so nothing flashes and the real render lands over the stand-in without a jump. Which
// rendering arrived is told by the source stamps (data-avb-d): a rendering of the source from
// before the insert is a render of the old file, so the stand-in is drawn again right after it;
// any newer rendering settles it. A write that is refused never renders, so the app says so
// (`avb:insert-revert`) and the stand-in goes; a rendering that never comes takes it away after a
// bound. The stand-in is never written anywhere: it lives in this frame's DOM and nowhere else.

import { assert } from '../../shared/core/assert';
import { insertedNodeToken, renumberedInsertPath, renumberedWrapPath, type CanvasInsert } from '../../shared/page/canvasInsert';
import { canvasMovesPending, pendingKeptFrom, putBackPaths, renumberPaths, runOf, sourceStamps, type Undo } from './frameMove';
import { isChildNode, isComment, isElement } from './frameBasics';
import { revealWhenDrawn } from './frameReveal';

export const FRAME_INSERT_LIMITS = {
  /** Inserts shown at once before the page confirms any: choices faster than a render. */
  pendingMax: 16,
  /** How long a shown insert waits for the rendering that confirms it (frameMove.ts says why this long). */
  holdMs: 20_000,
  /** How long a component's render may take before its place is marked: well past an ordinary render, short of a wait that reads as nothing happening. */
  waitingMs: 600,
} as const satisfies Record<string, number>;

export const PENDING_INSERT_ATTRIBUTE = 'data-avb-pending-insert';
const PATH_ATTRIBUTE = 'data-avb-p';

interface Shown {
  readonly insert: CanvasInsert;
  readonly nodes: readonly ChildNode[];
  readonly paths: Pick<Undo, 'attributes' | 'comments'>;
  /** Puts back what the insert moved (a wrap: the wrapped nodes), before the stand-in is removed. */
  readonly release?: () => void;
  /** The stamp of the source the insert was planned over, when the editor said (pendingKeptFrom). */
  readonly base?: string | undefined;
  /** Marked once its render has been waited for longer than `waitingMs`. */
  readonly wait: Wait;
}

let shown: Shown[] = [];
// The page's source stamps when the first pending insert was shown; a rendering with the
// same stamps is a render of the old file.
let shownFrom: string | undefined;
let holdTimer: ReturnType<typeof setTimeout> | undefined;
// One per insert shown, so there are never more than `pendingMax`.
let waitingTimers: readonly ReturnType<typeof setTimeout>[] = [];
let stylesheet: CSSStyleSheet | undefined;

/**
 * Draws the stand-in now. False when the canvas cannot show this insert safely (the sibling it
 * stands beside is not on the page, or renders as several runs, as a node in a loop does, or a
 * reorder is being shown): the rebuilt page shows it then, as before.
 */
export function showCanvasInsert(insert: CanvasInsert, base?: string): boolean {
  assert(insert.anchor.placement === 'inside' || insert.anchor.path.length > 0, 'showCanvasInsert: a sibling anchor has a path');
  if (shown.length >= FRAME_INSERT_LIMITS.pendingMax || canvasMovesPending()) {
    return false;
  }
  const stamps = shown.length === 0 ? sourceStamps(document) : shownFrom;
  const entry = applyInsert(insert, 'quiet');
  if (entry === undefined) {
    return false;
  }
  installPendingStyle();
  shown = [...shown, { ...entry, base, wait: 'quiet' }];
  shownFrom = stamps;
  clearTimeout(holdTimer);
  holdTimer = setTimeout(revertCanvasInserts, FRAME_INSERT_LIMITS.holdMs);
  const timer = setTimeout(() => markSlow(insert), FRAME_INSERT_LIMITS.waitingMs);
  waitingTimers = [...waitingTimers.slice(1 - FRAME_INSERT_LIMITS.pendingMax), timer];
  announceInserted();
  assert(shown.length <= FRAME_INSERT_LIMITS.pendingMax, 'showCanvasInsert: pending inserts stay inside their bound');
  return true;
}

/** Takes every stand-in away: the write was refused, or never rendered. */
export function revertCanvasInserts(): void {
  const had = shown.length > 0;
  takeBack();
  forget();
  if (had) {
    announceInserted();
  }
}

/** Whether stand-ins are shown and waiting for the page to confirm them. */
export function canvasInsertsPending(): boolean {
  return shown.length > 0;
}

/** The patcher's two moments (morphClient.ts): before it patches, and after. */
export function listenForCanvasInserts(): void {
  let replay: readonly Replayed[] = [];
  let confirmed = false;
  document.addEventListener('avb:before-morph', (event) => {
    if (shown.length === 0) {
      replay = [];
      return;
    }
    const incoming = event instanceof CustomEvent && event.detail instanceof Document ? sourceStamps(event.detail) : undefined;
    // A rendering from before an insert draws it again after the patch; the inserts it includes settle.
    const from = pendingKeptFrom(
      shown.map((entry) => entry.base),
      incoming,
      shownFrom,
    );
    replay = shown.slice(from);
    confirmed = from > 0 || replay.length === 0;
    takeBack();
    if (replay.length === 0) {
      forget();
    } else if (from > 0) {
      shownFrom = incoming; // The page now shows this rendering; the kept inserts were shown over it.
    }
  });
  document.addEventListener('avb:after-patch', () => {
    const inserts = replay;
    replay = [];
    if (confirmed) {
      confirmed = false;
      // The new node is on the page only now: a reveal asked for while nothing was drawn happens
      // once the frame has mapped this rendering, which it does on `avb:morphed`, right after.
      setTimeout(revealWhenDrawn, 0);
    }
    if (inserts.length === 0) {
      return;
    }
    // The patch rebuilt what it touched, so each is found and drawn again; one that no
    // longer applies is left to the next rendering.
    drawAgain(inserts);
  });
}

// --- Internals ---------------------------------------------------------------------

type Replayed = Pick<Shown, 'insert' | 'base' | 'wait'>;

// Draws taken-back inserts again, each as marked or as quiet as its own wait has made it.
function drawAgain(inserts: readonly Replayed[]): void {
  const kept: Shown[] = [];
  for (const { insert, base, wait } of inserts) {
    const entry = applyInsert(insert, wait);
    if (entry !== undefined) {
      kept.push({ ...entry, base, wait });
    }
  }
  shown = kept;
  if (kept.length === 0) {
    forget();
  }
}

// This insert's wait is over: if it is still not rendered, its place is marked with a bar.
function markSlow(insert: CanvasInsert): void {
  if (!shown.some((entry) => entry.insert === insert)) {
    return; // Rendered or refused meanwhile.
  }
  const inserts = shown.map((entry): Shown => (entry.insert === insert ? { ...entry, wait: 'marked' } : entry));
  takeBack();
  drawAgain(inserts);
  announceInserted();
  revealWhenDrawn();
}

function forget(): void {
  for (const timer of waitingTimers) {
    clearTimeout(timer);
  }
  waitingTimers = [];
  clearTimeout(holdTimer);
  holdTimer = undefined;
  shown = [];
  shownFrom = undefined;
}

// Newest first, so each take-back meets the page exactly as its insert left it.
function takeBack(): void {
  for (let index = shown.length - 1; index >= 0; index -= 1) {
    const entry = shown[index];
    assert(entry !== undefined, 'takeBack: the index lies inside the shown inserts');
    entry.release?.();
    for (const node of entry.nodes) {
      node.parentNode?.removeChild(node);
    }
    putBackPaths(entry.paths);
  }
  shown = [];
}

// Everything that measures the page listens for a patch: the outline, hover, the regions, the
// guide. A shown stand-in is one, without a rendering to hand them.
function announceInserted(): void {
  document.dispatchEvent(new CustomEvent('avb:morphed', { detail: undefined }));
}

/** Whether a component still to be rendered is invisible, or holds its place with a bar. */
type Wait = 'quiet' | 'marked';

type Applied = Omit<Shown, 'base' | 'wait'>;

function applyInsert(insert: CanvasInsert, wait: Wait): Applied | undefined {
  if (insert.node.kind === 'wrap') {
    return applyWrap(insert, insert.node);
  }
  const place = placeOf(insert);
  if (place === undefined) {
    return undefined;
  }
  // The anchor is numbered as before the insert, so it is found before anything renumbers.
  const paths = renumberPaths((token) => renumberedInsertPath(token, insert));
  const token = insertedNodeToken(insert);
  const nodes = standInNodes(insert, token, place, wait);
  if (nodes === undefined) {
    putBackPaths(paths);
    return undefined;
  }
  for (const node of nodes) {
    if (place.reference === undefined) {
      place.parent.append(node);
    } else {
      place.reference.before(node);
    }
  }
  const made = nodes.find(isElement);
  assert(made !== undefined, 'applyInsert: a stand-in has an element');
  assert(made.parentNode === place.parent, 'applyInsert: the stand-in sits where the page will put the node');
  return { insert, nodes, paths };
}

// The parent the stand-in goes into and the node it goes before (null: last), read off the
// sibling it stands beside, or off the element it fills.
function placeOf(insert: CanvasInsert): { readonly parent: ParentNode; readonly reference: ChildNode | undefined; readonly marked: boolean } | undefined {
  const token = insert.scope + insert.anchor.path.join('.');
  const run = runOf(token);
  const first = run?.[0];
  const last = run?.at(-1);
  if (run === undefined || first === undefined || last === undefined) {
    return undefined;
  }
  const marked = isComment(first) && first.data.startsWith('avb-s:');
  if (insert.anchor.placement === 'inside') {
    const element = run.find(isElement);
    if (element === undefined || run.filter(isElement).length !== 1) {
      return undefined;
    }
    return { parent: element, reference: undefined, marked };
  }
  const parent = first.parentNode;
  if (parent === null) {
    return undefined;
  }
  return { parent, reference: insert.anchor.placement === 'before' ? first : (last.nextSibling ?? undefined), marked };
}

// The stand-in's nodes: the marker pair around one element, or a copy of what another node rendered.
function standInNodes(insert: CanvasInsert, token: string, place: { readonly marked: boolean }, wait: Wait): ChildNode[] | undefined {
  let drawn = insert.node;
  if (drawn.kind === 'clone') {
    // The page's paths are numbered as after the insert by now, the copied node's with them.
    const copy = cloneOf(renumberedInsertPath(insert.scope + drawn.from.join('.'), insert), token);
    if (drawn.twinOf === undefined) {
      return copy;
    }
    // A twin the page does not render, or one opened since it was rendered, is not what will land.
    if (copy !== undefined && !hasLiveState(copy)) {
      return copy;
    }
    drawn = { kind: 'component', name: drawn.twinOf };
  }
  const made = standIn(drawn, token, wait);
  return place.marked ? [document.createComment(`avb-s:${token}`), made, document.createComment(`avb-e:${token}`)] : [made];
}

// A deep copy of the source's run (markers included), every path under the source renamed to the new one.
function cloneOf(sourceToken: string, token: string): ChildNode[] | undefined {
  const run = runOf(sourceToken);
  if (run === undefined) {
    return undefined;
  }
  const rename = (value: string): string =>
    value === sourceToken ? token : value.startsWith(sourceToken + '.') ? token + value.slice(sourceToken.length) : value;
  const copies = run.map((node) => node.cloneNode(true)).filter(isChildNode);
  for (const copy of copies) {
    if (isElement(copy)) {
      retag(copy, rename);
      copy.setAttribute(PENDING_INSERT_ATTRIBUTE, 'clone');
    } else if (isComment(copy)) {
      copy.data = renamedMarker(copy.data, rename);
    }
  }
  return copies.some(isElement) ? copies : undefined;
}

// Something opened since the server rendered it (a disclosure, a menu): the new instance lands closed.
function hasLiveState(nodes: readonly ChildNode[]): boolean {
  const opened = '[open], [aria-expanded="true"]';
  return nodes.some((node) => isElement(node) && (node.matches(opened) || node.querySelector(opened) !== null));
}

function retag(root: Element, rename: (value: string) => string): void {
  const tagged = [root, ...Array.from(root.querySelectorAll(`[${PATH_ATTRIBUTE}]`))];
  for (const element of tagged) {
    const value = element.getAttribute(PATH_ATTRIBUTE);
    if (value !== null) {
      element.setAttribute(PATH_ATTRIBUTE, value.split(' ').map(rename).join(' '));
    }
  }
  const walker = document.createTreeWalker(root, 128); // NodeFilter.SHOW_COMMENT
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (isComment(node)) {
      node.data = renamedMarker(node.data, rename);
    }
  }
}

function renamedMarker(data: string, rename: (value: string) => string): string {
  const match = /^avb-([se]):(.*)$/.exec(data);
  return match?.[1] !== undefined && match[2] !== undefined ? `avb-${match[1]}:${rename(match[2])}` : data;
}

function standIn(node: CanvasInsert['node'], token: string, wait: Wait): Element {
  switch (node.kind) {
    case 'element': {
      const element = document.createElement(node.tag);
      for (const [name, value] of node.attributes) {
        element.setAttribute(name, value);
      }
      if (node.text !== undefined) {
        element.textContent = node.text;
      }
      return tagged(element, token, 'element');
    }
    case 'clone':
    case 'wrap':
      throw new Error('standIn: a clone is made by cloneOf and a wrap by applyWrap');
    case 'component':
      // A template takes no box, so nothing shows and nothing beside it moves; it still names the place.
      return tagged(document.createElement(wait === 'quiet' ? 'template' : 'div'), token, 'component');
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

function tagged(element: Element, token: string, kind: 'element' | 'component'): Element {
  element.setAttribute(PATH_ATTRIBUTE, token);
  element.setAttribute(PENDING_INSERT_ATTRIBUTE, kind);
  return element;
}

// A component still waiting for a slow render: a quiet bar across its place, with no border and no
// words, so nothing in it can be taken for the component's own content.
function installPendingStyle(): void {
  if (stylesheet !== undefined && document.adoptedStyleSheets.includes(stylesheet)) {
    return; // A document that replaced this one (a client-side navigation) starts without it.
  }
  stylesheet = new CSSStyleSheet();
  stylesheet.replaceSync(
    `div[${PENDING_INSERT_ATTRIBUTE}="component"] { display: block; align-self: stretch; justify-self: stretch; box-sizing: border-box; ` +
      'min-width: min(100%, 160px); height: 40px; border-radius: 4px; background: rgba(127, 127, 127, 0.14); }',
  );
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, stylesheet];
}

// A wrap: the wrapper takes the wrapped node's place and path, the node's run moves inside it, and
// every path under the node gains a step. Taking it back puts the run where it stood.
function applyWrap(insert: CanvasInsert, wrap: Extract<CanvasInsert['node'], { kind: 'wrap' }>): Applied | undefined {
  const sourceToken = insert.scope + wrap.from.join('.');
  const run = runOf(sourceToken);
  const first = run?.[0];
  const parent = first?.parentNode;
  if (run === undefined || first === undefined || parent === null || parent === undefined) {
    return undefined;
  }
  const marked = isComment(first) && first.data.startsWith('avb-s:');
  const next = run.at(-1)?.nextSibling ?? undefined;
  const paths = renumberPaths((token) => renumberedWrapPath(token, insert));
  const wrapper = tagged(document.createElement(wrap.tag), sourceToken, 'element');
  const before = marked ? document.createComment(`avb-s:${sourceToken}`) : undefined;
  const after = marked ? document.createComment(`avb-e:${sourceToken}`) : undefined;
  const nodes: ChildNode[] = [...(before === undefined ? [] : [before]), wrapper, ...(after === undefined ? [] : [after])];
  first.before(...nodes);
  wrapper.append(...run);
  assert(wrapper.parentNode === parent, 'applyWrap: the wrapper stands where the wrapped node stood');
  const release = (): void => {
    for (const node of run) {
      if (next !== undefined && next.parentNode === parent) {
        next.before(node);
      } else {
        parent.append(node);
      }
    }
  };
  return { insert, nodes, paths, release };
}
