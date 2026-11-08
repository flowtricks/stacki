// A reordered node moves on the canvas the moment it is dropped.
//
// Measured before this existed (Studio demo, the marketing site's home page): the
// drop landed in the Navigator at once and the canvas followed about 380 ms later,
// because the new order reaches the page only after the source is written and the
// whole page is rendered again; on Desktop and Studio that is a write, a file
// watcher and an Astro render. The canvas already holds the node and the sibling it
// lands beside, so it moves that node's own elements straight away: the same nodes,
// with their listeners, their running animations and their markers, not a copy.
// The paths the page is tagged with move with it (shared/page/canvasMove.ts), so the
// selection outline and hover find the moved node at its new path at once.
//
// The rebuilt page is still the authority. A patch is the difference between the
// server's previous rendering and its new one, applied to the live page
// (electron/previewClient/morphClient.ts), and it assumes the live page is the
// previous rendering plus whatever the page's own scripts did. So just before a patch
// the move is taken back, and the patch applies as it always has, in the same task:
// nothing paints in between, so nothing flashes and nothing moves twice. Which
// rendering arrived is told by the page's source stamps (data-avb-d), as for a
// pending delete (framePendingDelete.ts): a rendering of the source from before the
// move is a render of the old file, so the move is shown again right after it; any
// newer rendering settles it. A write that is refused never renders, so the app says
// so (`avb:move-revert`) and the move is taken back; a rendering that never comes
// takes it back after a bound.

import { assert } from '../../shared/core/assert';
import { canvasMoveNodePath, renumberedCanvasPath, type CanvasMove } from '../../shared/page/canvasMove';
import { PRELOAD_LIMITS, isComment, isElement, isText } from './frameBasics';

export const FRAME_MOVE_LIMITS = {
  /** Moves shown at once before the page confirms any: drops faster than a render. */
  pendingMax: 16,
  /** Tagged elements and markers one move renumbers. */
  stampedMax: 50_000,
  /** Comments read for the page's source stamps. */
  stampsMax: 20_000,
  /** Elements one node renders side by side at the top of its run. */
  runMax: 256,
  /** How long a shown move waits for the rendering that confirms it. A Studio render
   * has a 15-second deadline and its push 20 seconds (morphClient.ts); past this the
   * write is taken as lost and the canvas goes back to what the page says. */
  holdMs: 20_000,
} as const satisfies Record<string, number>;

const PATH_ATTRIBUTE = 'data-avb-p';
const STAMP_ATTRIBUTE = 'data-avb-d';
const STAMP_PREFIX = 'avb-d:';
const MARKER = /^avb-([se]):(.*)$/;

/** What one shown move changed, to put back exactly. */
interface Undo {
  readonly nodes: readonly ChildNode[];
  readonly parent: ParentNode;
  /** The sibling the run sat before; undefined when it ended its parent. */
  readonly next: ChildNode | undefined;
  readonly attributes: readonly { readonly element: Element; readonly value: string }[];
  readonly comments: readonly { readonly comment: Comment; readonly data: string }[];
}

interface Shown {
  readonly move: CanvasMove;
  readonly undo: Undo;
}

let shown: Shown[] = [];
// The page's source stamps when the first pending move was shown; a rendering with the
// same stamps is a render of the old file.
let shownFrom: string | undefined;
let holdTimer: ReturnType<typeof setTimeout> | undefined;
// Set while this module dispatches `avb:morphed` itself, so its own listener ignores it.
let announcing = false;

/**
 * Moves the node's elements now. False when the canvas cannot show this move safely
 * (its elements or its neighbour are not on the page, or it renders as several runs,
 * as a node in a loop does); the rebuilt page shows it then, as before.
 */
export function showCanvasMove(move: CanvasMove): boolean {
  assert(move.count >= 1, 'showCanvasMove: a move moves at least its node');
  assert(move.from.length > 0, 'showCanvasMove: a moved node has a path');
  if (shown.length >= FRAME_MOVE_LIMITS.pendingMax) {
    return false;
  }
  const stamps = shown.length === 0 ? sourceStamps(document) : shownFrom;
  const undo = applyMove(move);
  if (undo === undefined) {
    return false;
  }
  shown = [...shown, { move, undo }];
  shownFrom = stamps;
  clearTimeout(holdTimer);
  holdTimer = setTimeout(revertCanvasMoves, FRAME_MOVE_LIMITS.holdMs);
  announceMoved();
  assert(shown.length <= FRAME_MOVE_LIMITS.pendingMax, 'showCanvasMove: pending moves stay inside their bound');
  return true;
}

/** Takes every shown move back: the write was refused, or never rendered. */
export function revertCanvasMoves(): void {
  const had = shown.length > 0;
  takeBack();
  forget();
  if (had) {
    announceMoved();
  }
}

/** Whether moves are shown and waiting for the page to confirm them. */
export function canvasMovesPending(): boolean {
  return shown.length > 0;
}

/** The patcher's two moments (morphClient.ts): before it patches, and after. */
export function listenForCanvasMoves(): void {
  let replay: readonly CanvasMove[] = [];
  document.addEventListener('avb:before-morph', (event) => {
    if (shown.length === 0) {
      replay = [];
      return;
    }
    const incoming = event instanceof CustomEvent && event.detail instanceof Document ? sourceStamps(event.detail) : undefined;
    // An old-file rendering is shown again after the patch; anything newer settles it.
    const stale = shownFrom !== undefined && shownFrom !== '' && incoming === shownFrom;
    replay = stale ? shown.map((entry) => entry.move) : [];
    takeBack();
    if (!stale) {
      forget();
    }
  });
  document.addEventListener('avb:after-patch', () => {
    const moves = replay;
    replay = [];
    if (moves.length === 0) {
      return;
    }
    // The patch rebuilt what it touched, so each move is found and made again; one
    // that no longer applies is left to the next rendering.
    const kept: Shown[] = [];
    for (const move of moves) {
      const undo = applyMove(move);
      if (undo !== undefined) {
        kept.push({ move, undo });
      }
    }
    shown = kept;
    if (kept.length === 0) {
      forget();
    }
  });
}

/** Whether `avb:morphed` came from a shown move rather than a patch. */
export function announcingCanvasMove(): boolean {
  return announcing;
}

// --- Internals ---------------------------------------------------------------------

function forget(): void {
  clearTimeout(holdTimer);
  holdTimer = undefined;
  shown = [];
  shownFrom = undefined;
}

// Newest first, so each undo meets the page exactly as its move left it.
function takeBack(): void {
  for (let index = shown.length - 1; index >= 0; index--) {
    const entry = shown[index];
    assert(entry !== undefined, 'takeBack: the index lies inside the shown moves');
    undoMove(entry.undo);
  }
  shown = [];
}

// Everything that measures the page listens for a patch: the outline, hover, the
// regions, the guide. A shown move is one, without a rendering to hand them.
function announceMoved(): void {
  announcing = true;
  try {
    document.dispatchEvent(new CustomEvent('avb:morphed', { detail: undefined }));
  } finally {
    announcing = false;
  }
}

function applyMove(move: CanvasMove): Undo | undefined {
  const nodeToken = move.scope + canvasMoveNodePath(move).join('.');
  const anchorToken = move.scope + move.anchor.path.join('.');
  const moved = runOf(nodeToken);
  const anchor = runOf(anchorToken);
  if (moved === undefined || anchor === undefined) {
    return undefined;
  }
  const first = moved[0];
  const last = moved.at(-1);
  const anchorFirst = anchor[0];
  const anchorLast = anchor.at(-1);
  if (first === undefined || last === undefined || anchorFirst === undefined || anchorLast === undefined) {
    return undefined;
  }
  const parent = first.parentNode;
  const anchorParent = anchorFirst.parentNode;
  if (parent === null || anchorParent === null) {
    return undefined;
  }
  // Neither run may hold the other: a node never lands inside itself, and a run that
  // swallowed its neighbour would move the neighbour too.
  if (moved.some((node) => node === anchorFirst || node.contains(anchorFirst)) || anchor.some((node) => node.contains(first))) {
    return undefined;
  }
  const next = last.nextSibling ?? undefined;
  const reference = move.anchor.placement === 'before' ? anchorFirst : anchorLast.nextSibling;
  for (const node of moved) {
    anchorParent.insertBefore(node, reference);
  }
  assert(first.parentNode === anchorParent, 'applyMove: the moved run sits beside its anchor');
  const renumbered = renumber(move);
  return { nodes: moved, parent, next, ...renumbered };
}

function undoMove(undo: Undo): void {
  const next = undo.next !== undefined && undo.next.parentNode === undo.parent ? undo.next : undefined;
  for (const node of undo.nodes) {
    if (next === undefined) {
      undo.parent.appendChild(node);
    } else {
      undo.parent.insertBefore(node, next);
    }
  }
  for (const { element, value } of undo.attributes) {
    element.setAttribute(PATH_ATTRIBUTE, value);
  }
  for (const { comment, data } of undo.comments) {
    comment.data = data;
  }
  assert(
    undo.nodes.every((node) => node.parentNode === undo.parent),
    'undoMove: the run is back where it was',
  );
}

// The node's run of sibling DOM nodes: its marker pair and what lies between when the
// page has markers, else its outermost tagged elements, which must sit side by side.
function runOf(token: string): ChildNode[] | undefined {
  return markedRun(token) ?? taggedRun(token);
}

function markedRun(token: string): ChildNode[] | undefined {
  const starts = commentsWhere((data) => data === `avb-s:${token}`);
  if (starts.length !== 1) {
    return undefined; // None (no markers), or one per loop item: not one run to move.
  }
  const start = starts[0];
  assert(start !== undefined, 'markedRun: the one start marker is present');
  const run: ChildNode[] = [start];
  for (let node = start.nextSibling; node !== null; node = node.nextSibling) {
    run.push(node);
    if (isComment(node) && node.data === `avb-e:${token}`) {
      return run.some(isElement) ? run : undefined;
    }
    if (run.length > FRAME_MOVE_LIMITS.runMax) {
      return undefined;
    }
  }
  return undefined; // An unclosed pair: a layout's markers split across head and body.
}

function taggedRun(token: string): ChildNode[] | undefined {
  if (!/^[^"\\]*$/.test(token)) {
    return undefined;
  }
  const tagged = document.querySelectorAll(`[${PATH_ATTRIBUTE}~="${token}"]`);
  const outermost: Element[] = [];
  for (let index = 0; index < tagged.length && outermost.length <= FRAME_MOVE_LIMITS.runMax; index++) {
    const element = tagged.item(index);
    if (element !== null && !hasTaggedAncestor(element, token)) {
      outermost.push(element);
    }
  }
  const first = outermost[0];
  if (first === undefined || outermost.length > FRAME_MOVE_LIMITS.runMax) {
    return undefined;
  }
  // Side by side under one parent, with nothing of the page's own between them but
  // whitespace and comments; anything else means several instances, not one node.
  const run: ChildNode[] = [];
  let remaining = outermost.length;
  for (let node: ChildNode | undefined = first; node !== undefined && remaining > 0; node = node.nextSibling ?? undefined) {
    if (isElement(node) && outermost.includes(node)) {
      remaining -= 1;
    } else if (!(isComment(node) || (isText(node) && node.data.trim() === ''))) {
      return undefined;
    }
    run.push(node);
    if (run.length > FRAME_MOVE_LIMITS.runMax) {
      return undefined;
    }
  }
  return remaining === 0 ? run : undefined;
}

// Whether an element sits inside another element tagged with the same path: a
// component's root forwards its instance's path to the elements inside it.
function hasTaggedAncestor(element: Element, token: string): boolean {
  let depth = 0;
  for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
    depth += 1;
    assert(depth <= PRELOAD_LIMITS.domDepthMax, 'hasTaggedAncestor: the page nests inside the walk bound');
    if ((parent.getAttribute(PATH_ATTRIBUTE) ?? '').split(' ').includes(token)) {
      return true;
    }
  }
  return false;
}

// Every tagged element and marker of the move's file, renumbered; the old values kept
// for the undo.
function renumber(move: CanvasMove): Pick<Undo, 'attributes' | 'comments'> {
  const attributes: { readonly element: Element; readonly value: string }[] = [];
  const tagged = document.querySelectorAll(`[${PATH_ATTRIBUTE}]`);
  const count = Math.min(tagged.length, FRAME_MOVE_LIMITS.stampedMax);
  for (let index = 0; index < count; index++) {
    const element = tagged.item(index);
    const value = element?.getAttribute(PATH_ATTRIBUTE);
    if (element === null || value === null || value === undefined) {
      continue;
    }
    const next = value
      .split(' ')
      .map((token) => (token === '' ? token : renumberedCanvasPath(token, move)))
      .join(' ');
    if (next !== value) {
      attributes.push({ element, value });
      element.setAttribute(PATH_ATTRIBUTE, next);
    }
  }
  const comments: { readonly comment: Comment; readonly data: string }[] = [];
  for (const comment of commentsWhere((data) => MARKER.test(data))) {
    const match = MARKER.exec(comment.data);
    const side = match?.[1];
    const path = match?.[2];
    if (side === undefined || path === undefined) {
      continue;
    }
    const data = `avb-${side}:${renumberedCanvasPath(path, move)}`;
    if (data !== comment.data) {
      comments.push({ comment, data: comment.data });
      comment.data = data;
    }
  }
  return { attributes, comments };
}

function commentsWhere(accept: (data: string) => boolean): Comment[] {
  const found: Comment[] = [];
  const walker = document.createTreeWalker(document, 128); // NodeFilter.SHOW_COMMENT
  for (let visited = 0; visited < FRAME_MOVE_LIMITS.stampedMax; visited++) {
    const node = walker.nextNode();
    if (node === null) {
      break;
    }
    if (isComment(node) && accept(node.data)) {
      found.push(node);
    }
  }
  return found;
}

// Which source a page is rendered from: every file's stamp, as a set. Empty when the
// page carries none; undefined past the bound, which settles a move rather than
// keeping it on a guess.
function sourceStamps(root: Document): string | undefined {
  const stamps = new Set<string>();
  const tagged = root.querySelectorAll(`[${STAMP_ATTRIBUTE}]`);
  if (tagged.length > FRAME_MOVE_LIMITS.stampsMax) {
    return undefined;
  }
  for (let index = 0; index < tagged.length; index++) {
    for (const token of (tagged.item(index)?.getAttribute(STAMP_ATTRIBUTE) ?? '').split('\n')) {
      if (token !== '') {
        stamps.add(token);
      }
    }
  }
  const walker = root.createTreeWalker(root, 128); // NodeFilter.SHOW_COMMENT
  for (let visited = 0; visited <= FRAME_MOVE_LIMITS.stampsMax; visited++) {
    const node = walker.nextNode();
    if (node === null) {
      return [...stamps].sort().join('\n');
    }
    if (isComment(node) && node.data.startsWith(STAMP_PREFIX)) {
      stamps.add(node.data);
    }
  }
  return undefined;
}
