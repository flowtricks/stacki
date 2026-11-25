// A node chosen in the insert palette is on the canvas the moment it is chosen.
//
// The rebuilt page used to be the only way a new node reached the canvas: write the source,
// let the dev server compile and render the page, patch the difference in
// (docs/insert-latency.md has the measured stages). The canvas already knows what the writer
// will emit (the editor built the node from the same template), so it draws a stand-in at once:
// a plain element built from that template, or for a component a neutral labelled block, in the
// place the page will put the real one. The stand-in is tagged with the path the new node will
// have, and the siblings after it are renumbered (shared/page/canvasInsert.ts), so the selection
// outline, the hover outline and the Navigator's reveal find it straight away.
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

export const FRAME_INSERT_LIMITS = {
  /** Inserts shown at once before the page confirms any: choices faster than a render. */
  pendingMax: 16,
  /** How long a shown insert waits for the rendering that confirms it (frameMove.ts says why this long). */
  holdMs: 20_000,
} as const satisfies Record<string, number>;

export const PENDING_INSERT_ATTRIBUTE = 'data-avb-pending-insert';
const PENDING_NAME_ATTRIBUTE = 'data-avb-pending-name';
const PATH_ATTRIBUTE = 'data-avb-p';

interface Shown {
  readonly insert: CanvasInsert;
  readonly nodes: readonly ChildNode[];
  readonly paths: Pick<Undo, 'attributes' | 'comments'>;
  /** Puts back what the insert moved (a wrap: the wrapped nodes), before the stand-in is removed. */
  readonly release?: () => void;
  /** The stamp of the source the insert was planned over, when the editor said (pendingKeptFrom). */
  readonly base?: string | undefined;
}

let shown: Shown[] = [];
// The page's source stamps when the first pending insert was shown; a rendering with the
// same stamps is a render of the old file.
let shownFrom: string | undefined;
let holdTimer: ReturnType<typeof setTimeout> | undefined;
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
  const entry = applyInsert(insert);
  if (entry === undefined) {
    return false;
  }
  installPendingStyle();
  shown = [...shown, { ...entry, base }];
  shownFrom = stamps;
  clearTimeout(holdTimer);
  holdTimer = setTimeout(revertCanvasInserts, FRAME_INSERT_LIMITS.holdMs);
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
  let replay: readonly Pick<Shown, 'insert' | 'base'>[] = [];
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
    if (inserts.length === 0) {
      return;
    }
    // The patch rebuilt what it touched, so each is found and drawn again; one that no
    // longer applies is left to the next rendering.
    const kept: Shown[] = [];
    for (const { insert, base } of inserts) {
      const entry = applyInsert(insert);
      if (entry !== undefined) {
        kept.push({ ...entry, base });
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

function applyInsert(insert: CanvasInsert): Shown | undefined {
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
  const nodes = standInNodes(insert, token, place);
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
function standInNodes(insert: CanvasInsert, token: string, place: { readonly marked: boolean }): ChildNode[] | undefined {
  if (insert.node.kind === 'clone') {
    return cloneOf(insert.scope + insert.node.from.join('.'), token);
  }
  const made = standIn(insert, token);
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
  return copies.length > 0 ? copies : undefined;
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

function standIn(insert: CanvasInsert, token: string): Element {
  const node = insert.node;
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
    case 'component': {
      const block = document.createElement('div');
      block.setAttribute(PENDING_NAME_ATTRIBUTE, node.name);
      return tagged(block, token, 'component');
    }
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

// A component's stand-in is a neutral block with the component's name: a background fill, no
// border, the same size whatever the component is, until the real render replaces it.
function installPendingStyle(): void {
  if (stylesheet !== undefined && document.adoptedStyleSheets.includes(stylesheet)) {
    return; // A document that replaced this one (a client-side navigation) starts without it.
  }
  stylesheet = new CSSStyleSheet();
  stylesheet.replaceSync(
    `[${PENDING_INSERT_ATTRIBUTE}="component"] { display: block; min-height: 64px; background: rgba(127, 127, 127, 0.14); }` +
      `[${PENDING_INSERT_ATTRIBUTE}="component"]::before { content: attr(${PENDING_NAME_ATTRIBUTE}); display: block; padding: 8px 12px; ` +
      'font: 12px/1.4 system-ui, sans-serif; color: rgba(127, 127, 127, 0.9); }',
  );
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, stylesheet];
}

// A wrap: the wrapper takes the wrapped node's place and path, the node's run moves inside it, and
// every path under the node gains a step. Taking it back puts the run where it stood.
function applyWrap(insert: CanvasInsert, wrap: Extract<CanvasInsert['node'], { kind: 'wrap' }>): Shown | undefined {
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
