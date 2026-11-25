// Dragging on the canvas: the frame's half. It notices a press that becomes a drag, follows the pointer,
// measures what is under it and tells the editor; the editor decides where the drop lands
// (src/editor/canvasDrop.ts) and draws the line on the canvas and in the Navigator from that one decision.
//
// Why the frame follows the pointer: a press inside the frame keeps the pointer there until it is released
// (the browser's implicit capture), so the editor never hears the moves. The frame posts one probe per
// animation frame at most, however fast the pointer moves, so the editor's work per frame is bounded too.
//
// A probe is the chain of levels under the pointer, deepest first, up to the file's root list: each level's
// box, its content box (the box less padding and border, where an insertion line belongs), the flow its
// children are laid out in, and for the two deepest levels the boxes of their rendered children. That is
// O(depth + siblings) per probe; the index of which paths are children of which is built once per drag.
//
// The same probes serve a drag that starts elsewhere: a component dragged from the palette or a row dragged
// from the Navigator crosses into the frame as a native drag, and the frame answers its `dragover` the same way.
//
// Escape cancels; a release outside the frame's viewport cancels; a lost pointer cancels. Near the top or the
// bottom edge the page scrolls, so a drop can reach what is out of view.

import { assert } from '../../shared/core/assert';
import { isElement, type Rect } from './frameBasics';
import { canvasInert, canvasSelects } from './frameInteraction';
import { parentPath } from './framePaths';
import { activeScope, elementsWithPath, inScope, pathsOf, PATH_ATTR, regions, runsOf } from './frameRegions';
import { rectsForPath } from './frameMeasure';
import { isCanvasTextEditing } from './frameTextNative';

export const FRAME_DRAG_LIMITS = {
  /** Pixels the pointer travels before a press becomes a drag (the click guard's own distance, frameInteraction.ts). */
  startDistancePx: 6,
  /** Levels one probe measures: the tree's own depth bound, plus the root list. */
  levelsMax: 65,
  /** Children one level reports: the nearest to the pointer. A structural bound of one probe, not of the page. */
  childrenMax: 256,
  /** The band at the top and bottom of the viewport that scrolls the page while dragging. */
  edgeScrollPx: 40,
  /** The fastest the page scrolls per frame at the very edge. */
  edgeScrollStepPxMax: 24,
} as const satisfies Record<string, number>;

/** How a container lays out its children (src/editor/canvasDrop.ts DROP_FLOWS). */
type Flow = 'block' | 'column' | 'column-reverse' | 'row' | 'row-reverse' | 'grid' | 'wrap';

interface WireLevel {
  readonly path: string;
  readonly box: Rect;
  readonly content: Rect;
  readonly flow: Flow;
  readonly children?: readonly { readonly path: string; readonly box: Rect }[];
}

/** The node under a viewport point, by the same resolution a click uses (Desktop's and Studio's own hit tests). */
export type DragLocate = (x: number, y: number) => { readonly path: string; readonly occurrence: number } | undefined;

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pressed'; readonly x: number; readonly y: number; readonly path: string; readonly occurrence: number }
  | { readonly kind: 'dragging'; readonly path: string; x: number; y: number }
  /** Escape or the editor ended it while the button is still down: the release that follows is swallowed. */
  | { readonly kind: 'ended' };

let phase: Phase = { kind: 'idle' };
let locate: DragLocate | undefined;
let post: (message: unknown) => void = () => undefined;
let probeFrame: number | undefined;
let scrollFrame: number | undefined;
let nativePoint: { readonly x: number; readonly y: number; readonly outside: boolean } | undefined;
// Which paths are children of which, built when a drag starts (O(nodes) once, never per move).
let childIndex: ReadonlyMap<string, readonly string[]> = new Map();
const cursorStyleId = 'avb-drag-cursor';

/** Installs the canvas drag on this frame. `locate` is the click's own hit test; `send` posts to the editor. */
export function installCanvasDrag(options: { readonly locate: DragLocate; readonly send: (message: unknown) => void }): void {
  locate = options.locate;
  post = options.send;
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('pointercancel', () => cancel('interrupted'), true);
  window.addEventListener('blur', () => cancel('interrupted'));
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('dragover', onNativeOver, true);
  window.addEventListener('dragleave', onNativeLeave, true);
  window.addEventListener('drop', onNativeDrop, true);
}

/** Messages from the editor about the drag: its verdict for the cursor, or an end to it. False when not ours. */
export function receiveDragMessage(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const type: unknown = Reflect.get(data, 'type');
  if (type === 'avb:drag-feedback') {
    const allowed: unknown = Reflect.get(data, 'allowed');
    if (phase.kind === 'dragging' && typeof allowed === 'boolean') {
      showCursor(allowed ? 'grabbing' : 'not-allowed');
    }
    return true;
  }
  if (type === 'avb:drag-stop') {
    if (phase.kind === 'dragging') {
      finish({ kind: 'ended' });
    } else if (phase.kind === 'pressed') {
      phase = { kind: 'idle' };
    }
    return true;
  }
  return false;
}

/** Whether a canvas drag is under way: the hover and the click stand aside for it. */
export function canvasDragging(): boolean {
  return phase.kind === 'dragging';
}

function onPointerDown(event: PointerEvent): void {
  phase = { kind: 'idle' };
  if (event.button !== 0) {
    return;
  }
  // Select mode only: in interact mode a press belongs to the page (a slider, a text field).
  if (!canvasSelects()) {
    return;
  }
  if (!canvasInert()) {
    return;
  }
  if (event.metaKey || event.ctrlKey || event.shiftKey) {
    return;
  }
  if (isCanvasTextEditing(event.target)) {
    return;
  }
  const hit = locate?.(event.clientX, event.clientY);
  if (hit === undefined) {
    return;
  }
  phase = { kind: 'pressed', x: event.clientX, y: event.clientY, path: hit.path, occurrence: hit.occurrence };
}

function onPointerMove(event: PointerEvent): void {
  if (phase.kind === 'pressed') {
    if ((event.buttons & 1) === 0) {
      phase = { kind: 'idle' }; // The release happened somewhere this frame never heard.
      return;
    }
    if (Math.hypot(event.clientX - phase.x, event.clientY - phase.y) < FRAME_DRAG_LIMITS.startDistancePx) {
      return;
    }
    const pressed = phase;
    phase = { kind: 'dragging', path: pressed.path, x: event.clientX, y: event.clientY };
    childIndex = buildChildIndex();
    showCursor('grabbing');
    post({ type: 'avb:drag-start', path: pressed.path, occurrence: pressed.occurrence, x: pressed.x, y: pressed.y });
    scheduleProbe();
    return;
  }
  if (phase.kind === 'dragging') {
    event.preventDefault();
    phase.x = event.clientX;
    phase.y = event.clientY;
    scheduleProbe();
    scheduleEdgeScroll();
  }
}

function onPointerUp(event: PointerEvent): void {
  if (phase.kind === 'dragging') {
    const outside = outsideViewport(event.clientX, event.clientY);
    // The last move may still wait for its frame: the drop is judged at the point of release.
    sendProbe('pointer', { x: event.clientX, y: event.clientY });
    post({ type: 'avb:drag-end', source: 'pointer', x: event.clientX, y: event.clientY, outside });
    finish({ kind: 'idle' });
    return;
  }
  phase = { kind: 'idle' };
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') {
    return;
  }
  if (phase.kind !== 'dragging') {
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  post({ type: 'avb:drag-cancel', reason: 'escape' });
  finish({ kind: 'ended' });
}

function cancel(reason: 'interrupted'): void {
  if (phase.kind === 'dragging') {
    post({ type: 'avb:drag-cancel', reason });
  }
  finish({ kind: 'idle' });
}

function finish(next: Phase): void {
  assert(next.kind === 'idle' || next.kind === 'ended', 'finish: a drag ends idle or ended');
  phase = next;
  if (probeFrame !== undefined) {
    cancelAnimationFrame(probeFrame);
    probeFrame = undefined;
  }
  if (scrollFrame !== undefined) {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = undefined;
  }
  childIndex = new Map();
  showCursor(undefined);
}

// One probe per animation frame, of wherever the pointer is by then.
function scheduleProbe(): void {
  if (probeFrame !== undefined) {
    return;
  }
  probeFrame = requestAnimationFrame(() => {
    probeFrame = undefined;
    if (phase.kind === 'dragging') {
      sendProbe('pointer', { x: phase.x, y: phase.y });
    } else if (nativePoint !== undefined) {
      sendProbe('native', nativePoint);
    }
  });
}

function sendProbe(source: 'pointer' | 'native', point: { readonly x: number; readonly y: number }): void {
  const outside = outsideViewport(point.x, point.y);
  const levels = outside ? [] : measureLevels(point.x, point.y);
  const dragged = phase.kind === 'dragging' ? (rectsForPath(phase.path) ?? []).slice(0, FRAME_DRAG_LIMITS.childrenMax) : [];
  post({ type: 'avb:drag-over', source, x: point.x, y: point.y, outside, levels, dragged });
}

// While the pointer rests near the top or bottom edge the page scrolls, faster the nearer it is, and the place
// under the pointer is measured again. The loop ends when the pointer leaves the band or the page cannot move.
function scheduleEdgeScroll(): void {
  if (scrollFrame !== undefined) {
    return;
  }
  scrollFrame = requestAnimationFrame(edgeScrollTick);
}

// One frame of the edge scroll; it asks for the next frame itself while there is somewhere to go.
function edgeScrollTick(): void {
  scrollFrame = undefined;
  if (phase.kind !== 'dragging') {
    return;
  }
  const step = edgeScrollStep(phase.y, window.innerHeight);
  if (step === 0) {
    return;
  }
  const before = window.scrollY;
  window.scrollBy(0, step);
  if (window.scrollY === before) {
    return; // At the end of the page: nothing more to reach.
  }
  scheduleProbe();
  scrollFrame = requestAnimationFrame(edgeScrollTick);
}

/** Pixels to scroll this frame for a pointer at `y` in a viewport `height` tall: negative up, positive down. */
export function edgeScrollStep(y: number, height: number): number {
  const band = FRAME_DRAG_LIMITS.edgeScrollPx;
  if (height < band * 3) {
    return 0; // A viewport this short is all edge: scrolling would never stop.
  }
  if (y < band) {
    return -Math.ceil(((band - Math.max(y, 0)) / band) * FRAME_DRAG_LIMITS.edgeScrollStepPxMax);
  }
  if (y > height - band) {
    return Math.ceil(((Math.min(y, height) - (height - band)) / band) * FRAME_DRAG_LIMITS.edgeScrollStepPxMax);
  }
  return 0;
}

function outsideViewport(x: number, y: number): boolean {
  if (x < 0 || y < 0) {
    return true;
  }
  return x > window.innerWidth || y > window.innerHeight;
}

// --- A drag from outside the frame: the palette or the Navigator -------------------------------------------

function nativePayload(event: DragEvent): boolean {
  const types = event.dataTransfer?.types ?? [];
  // `avb/insert` is a tile from the Add elements panel (src/editor/insertDragData.ts); the preload imports nothing of the renderer, so the name is repeated here.
  return types.includes('avb/component') || types.includes('avb/node') || types.includes('avb/insert');
}

function onNativeOver(event: DragEvent): void {
  if (!canvasSelects() || !nativePayload(event)) {
    return;
  }
  event.preventDefault(); // Says the frame takes the drop; the editor decides what it does.
  if (childIndex.size === 0) {
    childIndex = buildChildIndex();
  }
  nativePoint = { x: event.clientX, y: event.clientY, outside: false };
  scheduleProbe();
}

function onNativeLeave(event: DragEvent): void {
  if (nativePoint === undefined) {
    return;
  }
  if (event.relatedTarget !== null) {
    return; // Still inside the document: between two of its elements.
  }
  nativePoint = undefined;
  childIndex = new Map();
  post({ type: 'avb:drag-over', source: 'native', x: event.clientX, y: event.clientY, outside: true, levels: [], dragged: [] });
}

function onNativeDrop(event: DragEvent): void {
  if (!canvasSelects() || !nativePayload(event)) {
    return;
  }
  event.preventDefault();
  sendProbe('native', { x: event.clientX, y: event.clientY });
  post({ type: 'avb:drag-end', source: 'native', x: event.clientX, y: event.clientY, outside: false });
  nativePoint = undefined;
  childIndex = new Map();
}

// --- Measuring the levels under the pointer ----------------------------------------------------------------

const ROOT = '';

function measureLevels(x: number, y: number): WireLevel[] {
  const hit = locate?.(x, y);
  const chain: string[] = [];
  for (let path = hit?.path; path !== undefined && chain.length < FRAME_DRAG_LIMITS.levelsMax - 1; path = parentPath(path)) {
    chain.push(path);
  }
  chain.push(ROOT);
  return chain.map((path, depth) => measureLevel(path, { x, y }, depth < 2 ? 'children' : 'own'));
}

function measureLevel(path: string, point: { readonly x: number; readonly y: number }, measure: 'children' | 'own'): WireLevel {
  const childPaths = childIndex.get(path) ?? [];
  const container = containerOf(path, childPaths);
  const box = path === ROOT ? rootBox() : (nearestRect(rectsForPath(path) ?? [], point) ?? rectOf(container));
  const children = measure === 'children' ? measureChildren(childPaths, point) : undefined;
  const flow = flowOf(container, children ?? []);
  return { path, box, content: contentRect(container, box), flow, ...(children === undefined ? {} : { children }) };
}

function measureChildren(childPaths: readonly string[], point: { readonly x: number; readonly y: number }): { readonly path: string; readonly box: Rect }[] {
  const measured: { readonly path: string; readonly box: Rect; readonly distance: number }[] = [];
  for (const childPath of childPaths) {
    const box = nearestRect(rectsForPath(childPath) ?? [], point);
    if (box !== undefined && (box.w > 0 || box.h > 0)) {
      measured.push({ path: childPath, box, distance: distanceTo(box, point) });
    }
  }
  if (measured.length > FRAME_DRAG_LIMITS.childrenMax) {
    measured.sort((left, right) => left.distance - right.distance);
    measured.length = FRAME_DRAG_LIMITS.childrenMax;
  }
  return measured.map(({ path, box }) => ({ path, box }));
}

// The element that lays a level's children out: the parent of its first child's element (a component's slot
// container, a loop's list), else the level's own element; the body for the root list.
function containerOf(path: string, childPaths: readonly string[]): Element {
  for (const childPath of childPaths) {
    const element = firstElement(childPath);
    if (element?.parentElement) {
      return element.parentElement;
    }
  }
  if (path !== ROOT) {
    const own = firstElement(path);
    if (own !== undefined) {
      return own;
    }
  }
  return document.body;
}

function firstElement(path: string): Element | undefined {
  for (const run of runsOf(path) ?? []) {
    const element = run.find(isElement);
    if (element !== undefined) {
      return element;
    }
  }
  return elementsWithPath(path)[0];
}

/** The flow of a container's children, read from its computed style; a block of side-by-side inline children reads as a wrapping row. */
function flowOf(container: Element, children: readonly { readonly box: Rect }[]): Flow {
  const style = getComputedStyle(container);
  const display = style.display;
  if (display.includes('grid')) {
    return 'grid';
  }
  if (display.includes('flex')) {
    const direction = style.flexDirection;
    if (direction === 'column' || direction === 'column-reverse') {
      return direction;
    }
    if (style.flexWrap !== 'nowrap') {
      return 'wrap';
    }
    return direction === 'row-reverse' ? 'row-reverse' : 'row';
  }
  const [first, second] = children;
  if (first !== undefined && second !== undefined) {
    if (first.box.y < second.box.y + second.box.h && second.box.y < first.box.y + first.box.h) {
      return 'wrap'; // Inline children side by side in a block.
    }
  }
  return 'block';
}

function contentRect(container: Element, box: Rect): Rect {
  const style = getComputedStyle(container);
  const left = px(style.paddingLeft) + px(style.borderLeftWidth);
  const right = px(style.paddingRight) + px(style.borderRightWidth);
  const top = px(style.paddingTop) + px(style.borderTopWidth);
  const bottom = px(style.paddingBottom) + px(style.borderBottomWidth);
  const own = container === document.body ? box : rectOf(container);
  return { x: own.x + left, y: own.y + top, w: Math.max(0, own.w - left - right), h: Math.max(0, own.h - top - bottom) };
}

function px(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rectOf(element: Element): Rect {
  const bounds = element.getBoundingClientRect();
  return { x: bounds.left, y: bounds.top, w: bounds.width, h: bounds.height };
}

function rootBox(): Rect {
  const body = document.body.getBoundingClientRect();
  return { x: 0, y: body.top, w: window.innerWidth, h: Math.max(body.height, window.innerHeight - body.top) };
}

function nearestRect(rects: readonly Rect[], point: { readonly x: number; readonly y: number }): Rect | undefined {
  let best: Rect | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const rect of rects) {
    const distance = distanceTo(rect, point);
    if (distance < bestDistance) {
      best = rect;
      bestDistance = distance;
    }
  }
  return best;
}

function distanceTo(rect: Rect, point: { readonly x: number; readonly y: number }): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.w));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.h));
  return Math.hypot(dx, dy);
}

// Every path the page holds in the open file's namespace, under its parent's path (the root list under '').
function buildChildIndex(): ReadonlyMap<string, readonly string[]> {
  const seen = new Set<string>();
  const add = (path: string): void => {
    if (inScope(path)) {
      seen.add(path);
    }
  };
  for (const path of regions.keys()) {
    add(path);
  }
  for (const element of Array.from(document.querySelectorAll(`[${PATH_ATTR}]`))) {
    for (const path of pathsOf(element)) {
      add(path);
    }
  }
  const index = new Map<string, string[]>();
  for (const path of seen) {
    if (!isNodePath(path)) {
      continue;
    }
    const parent = parentPath(path) ?? ROOT;
    const list = index.get(parent) ?? [];
    list.push(path);
    index.set(parent, list);
  }
  for (const list of index.values()) {
    list.sort((left, right) => lastIndex(left) - lastIndex(right));
  }
  return index;
}

// A node's own path in the open file: `0.2.1`, or `Card.astro|0.2` while a component is open. A ::before layer
// or another file's path is none.
function isNodePath(path: string): boolean {
  const bar = path.lastIndexOf('|');
  if (path.slice(0, bar + 1) !== activeScope) {
    return false;
  }
  return /^\d+(\.\d+)*$/.test(path.slice(bar + 1));
}

function lastIndex(path: string): number {
  const dot = path.lastIndexOf('.');
  const bar = path.lastIndexOf('|');
  return Number(path.slice(Math.max(dot, bar) + 1));
}

function showCursor(cursor: 'grabbing' | 'not-allowed' | undefined): void {
  const existing = document.getElementById(cursorStyleId);
  if (cursor === undefined) {
    existing?.remove();
    return;
  }
  const style = existing ?? document.createElement('style');
  style.id = cursorStyleId;
  // Over the design cursor's own `!important` rule (frameInteraction.ts), and later in the document, so it wins.
  style.textContent = `*, *::before, *::after { cursor: ${cursor} !important; }`;
  if (existing === null) {
    (document.head ?? document.documentElement).append(style);
  }
}
