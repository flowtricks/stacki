// The design canvas: frames side by side on an infinite, pannable, zoomable surface, and every pointer gesture
// on them. The frames' iframes take no pointer events (except the one whose text is being typed in); a press
// lands on the canvas, which finds the frame and the element under it with the frame document's own
// elementFromPoint. Wheel pans, Cmd/Ctrl-wheel and pinch zoom, Space or the hand tool drags the view, as on
// the editor's all-breakpoints canvas.
import { capturePointer, keepUnscrolled } from './designPointer';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { flowDropAt, type FlowDrop } from '../model/designDrop';
import { isFree, isTextLeaf, makeFree, moveInFlow, placeFree, setInlineStyle, inlineStyleOf, duplicateAfter, px, designIdOf } from '../model/designDom';
import { pickOnClick, pickOnDoubleClick } from '../model/designSelect';
import { nearestShift, resizeBox, snapMove, type Box, type GapHint, type ResizeHandle, type SnapGuide } from '../model/designSnap';
import { DESIGN_LIMITS, type DesignElementId, type DesignFrameRecord, type FrameId } from '../model/designTypes';
import {
  beginLive,
  cancelLive,
  commitFrame,
  frameDocument,
  frameMint,
  select,
  selectFrame,
  selectedElements,
  setEditingText,
  setTool,
  setView,
  useDesignState,
} from '../runtime/designSession';
import { insertMarkup, offset, outermost, pixels } from '../runtime/designGestures';
import type { DesignWords } from '../i18n/designWords';
import { canvasPoint, elementAt, frameAt, zoomAround, type Point } from './canvasGeometry';
import { DesignFrameView, frameHeightPx } from './DesignFrameView';
import { DesignFrameHeader } from './DesignFrameHeader';
import { DesignSelectionLayer, type CanvasMarks } from './DesignSelectionLayer';
import { escapeHTML } from './designText';

/** The modifier keys of the pointer event a gesture reads. */
interface Modifiers {
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}

const DRAG_THRESHOLD_PX = 3;
const SNAP_SCREEN_PX = 6;
const WHEEL_ZOOM_DELTA_MAX = 50;

type Gesture =
  | { readonly kind: 'pan'; readonly startX: number; readonly startY: number; readonly viewX: number; readonly viewY: number }
  | {
      readonly kind: 'press';
      readonly frame: DesignFrameRecord;
      readonly target: Element;
      readonly startX: number;
      readonly startY: number;
      readonly start: Point;
      readonly shift: boolean;
      readonly alt: boolean;
      readonly meta: boolean;
    }
  | {
      readonly kind: 'flow';
      readonly frame: DesignFrameRecord;
      readonly elements: readonly Element[];
      readonly start: Point;
      readonly saved: readonly SavedStyle[];
      readonly home: Element;
    }
  | {
      readonly kind: 'free';
      readonly frame: DesignFrameRecord;
      readonly starts: readonly { readonly element: Element; readonly leftPx: number; readonly topPx: number }[];
      readonly start: Point;
      readonly box: Box;
      readonly targets: readonly Box[];
    }
  | {
      readonly kind: 'resize';
      readonly frame: DesignFrameRecord;
      readonly element: Element;
      readonly handle: ResizeHandle;
      readonly start: Point;
      readonly box: Box;
      readonly free: boolean;
      readonly origin: { readonly leftPx: number; readonly topPx: number };
      readonly targets: readonly Box[];
    }
  | { readonly kind: 'draw'; readonly frame: DesignFrameRecord; readonly start: Point; readonly parent: Element }
  | { readonly kind: 'frame'; readonly frame: DesignFrameRecord; readonly startX: number; readonly startY: number; readonly moved: boolean };

interface SavedStyle {
  readonly element: Element;
  readonly values: readonly (readonly [string, string])[];
}

const DRAG_STYLES = ['transform', 'pointer-events', 'opacity', 'position', 'z-index'] as const;

function saveStyles(elements: readonly Element[]): readonly SavedStyle[] {
  return elements.map((element) => ({ element, values: DRAG_STYLES.map((property) => [property, inlineStyleOf(element, property)] as const) }));
}

function restoreStyles(saved: readonly SavedStyle[]): void {
  for (const entry of saved) {
    for (const [property, value] of entry.values) {
      setInlineStyle(entry.element, property, value);
    }
  }
}

function boxOf(element: Element): Box {
  const rect = element.getBoundingClientRect();
  return { xPx: rect.left, yPx: rect.top, widthPx: rect.width, heightPx: rect.height };
}

/** The boxes a moving element snaps to: its parent and its visible siblings. */
function snapTargets(element: Element, moving: readonly Element[]): readonly Box[] {
  const parent = element.parentElement;
  if (parent === null) {
    return [];
  }
  const siblings = [...parent.children].filter((child) => !moving.includes(child)).slice(0, 200);
  return [boxOf(parent), ...siblings.map(boxOf).filter((box) => box.widthPx > 0 && box.heightPx > 0)];
}

function ids(elements: readonly Element[]): readonly DesignElementId[] {
  return elements.map(designIdOf).filter((id): id is DesignElementId => id !== undefined);
}

export interface CanvasProps {
  readonly words: DesignWords;
  /** Space is held: a drag pans whatever the tool. */
  readonly spaceHeld: boolean;
  readonly onTextEdit: (frame: FrameId, element: Element) => void;
}

export function DesignCanvas({ words, spaceHeld, onTextEdit }: CanvasProps) {
  const state = useDesignState();
  const host = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | undefined>(undefined);
  const [marks, setMarks] = useState<CanvasMarks>({ hover: undefined, guides: [], gaps: [], drop: undefined, draw: undefined });
  const view = state.view;
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    const element = host.current;
    if (element === null) {
      return undefined;
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const current = viewRef.current;
      const rect = element.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        const delta = Math.max(-WHEEL_ZOOM_DELTA_MAX, Math.min(WHEEL_ZOOM_DELTA_MAX, event.deltaY));
        const scale = Math.min(DESIGN_LIMITS.zoomMax, Math.max(DESIGN_LIMITS.zoomMin, current.scale * Math.exp(-delta * 0.01)));
        setView(zoomAround(current, scale, event.clientX - rect.left, event.clientY - rect.top));
      } else {
        setView({ ...current, xPx: current.xPx - event.deltaX, yPx: current.yPx - event.deltaY });
      }
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  const pointOf = (event: { readonly clientX: number; readonly clientY: number }): Point => {
    const rect = host.current?.getBoundingClientRect() ?? new DOMRect();
    return canvasPoint(event.clientX, event.clientY, rect, viewRef.current);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) {
      return;
    }
    host.current?.focus({ preventScroll: true });
    if (state.editingText !== undefined) {
      setEditingText(undefined);
    }
    capturePointer(event.currentTarget, event.pointerId);
    const point = pointOf(event);
    if (event.button === 1 || spaceHeld || state.tool === 'hand') {
      gesture.current = { kind: 'pan', startX: event.clientX, startY: event.clientY, viewX: view.xPx, viewY: view.yPx };
      return;
    }
    const hit = frameAt(state.frames, point);
    if (hit === undefined) {
      select(undefined);
      selectFrame(undefined);
      gesture.current = { kind: 'pan', startX: event.clientX, startY: event.clientY, viewX: view.xPx, viewY: view.yPx };
      return;
    }
    const target = elementAt(hit);
    if (target === undefined) {
      return;
    }
    if (state.tool === 'text') {
      insertText(hit.frame, target, hit.local, event);
      return;
    }
    if (state.tool === 'box') {
      gesture.current = { kind: 'draw', frame: hit.frame, start: hit.local, parent: containerFor(target) };
      return;
    }
    gesture.current = {
      kind: 'press',
      frame: hit.frame,
      target,
      startX: event.clientX,
      startY: event.clientY,
      start: hit.local,
      shift: event.shiftKey,
      alt: event.altKey,
      meta: event.metaKey || event.ctrlKey,
    };
    // The press selects at once, so a drag moves what was pressed (unless it is part of a multi-selection).
    const selected = selectedElements();
    const current = selected?.frame === hit.frame.id ? selected.elements : [];
    const picked = pickOnClick(target, current, event.metaKey || event.ctrlKey ? 'deepest' : 'level');
    if (event.shiftKey) {
      const already = current.includes(picked);
      const next = already ? current.filter((element) => element !== picked) : [...current, picked];
      select({ frame: hit.frame.id, ids: ids(next) });
    } else if (!current.includes(picked)) {
      select({ frame: hit.frame.id, ids: ids([picked]) });
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = gesture.current;
    if (active === undefined) {
      hover(event);
      return;
    }
    const point = pointOf(event);
    switch (active.kind) {
      case 'pan':
        setView({ ...viewRef.current, xPx: active.viewX + event.clientX - active.startX, yPx: active.viewY + event.clientY - active.startY });
        return;
      case 'press': {
        if (Math.hypot(event.clientX - active.startX, event.clientY - active.startY) < DRAG_THRESHOLD_PX) {
          return;
        }
        gesture.current = startDrag(active, event);
        return;
      }
      case 'flow':
        dragFlow(active, { xPx: point.xPx - active.frame.xPx, yPx: point.yPx - active.frame.yPx });
        return;
      case 'free':
        dragFree(active, { xPx: point.xPx - active.frame.xPx, yPx: point.yPx - active.frame.yPx }, event);
        return;
      case 'resize':
        dragResize(active, { xPx: point.xPx - active.frame.xPx, yPx: point.yPx - active.frame.yPx }, event);
        return;
      case 'draw':
        setMarks((current) => ({
          ...current,
          draw: { frame: active.frame.id, box: drawnBox(active.start, { xPx: point.xPx - active.frame.xPx, yPx: point.yPx - active.frame.yPx }) },
        }));
        return;
      case 'frame':
        return;
      default: {
        const exhaustive: never = active;
        return exhaustive;
      }
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = gesture.current;
    gesture.current = undefined;
    const point = pointOf(event);
    if (active === undefined) {
      return;
    }
    if (active.kind === 'press') {
      // A click with no drag settles what it selects: inside a selection, the pressed level.
      const selected = selectedElements();
      const current = selected?.frame === active.frame.id ? selected.elements : [];
      if (!active.shift && current.length > 1) {
        select({ frame: active.frame.id, ids: ids([pickOnClick(active.target, [], active.meta ? 'deepest' : 'level')]) });
      }
    } else if (active.kind === 'flow') {
      finishFlow(active, { xPx: point.xPx - active.frame.xPx, yPx: point.yPx - active.frame.yPx });
    } else if (active.kind === 'free' || active.kind === 'resize') {
      commitFrame(active.frame.id, () => undefined);
    } else if (active.kind === 'draw') {
      finishDraw(active, { xPx: point.xPx - active.frame.xPx, yPx: point.yPx - active.frame.yPx });
    }
    setMarks((current) => ({ ...current, guides: [], gaps: [], drop: undefined, draw: undefined }));
  };

  const onPointerCancel = () => {
    const active = gesture.current;
    gesture.current = undefined;
    if (active !== undefined && (active.kind === 'flow' || active.kind === 'free' || active.kind === 'resize')) {
      if (active.kind === 'flow') {
        restoreStyles(active.saved);
      }
      cancelLive();
    }
    setMarks((current) => ({ ...current, guides: [], gaps: [], drop: undefined, draw: undefined }));
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const hit = frameAt(state.frames, pointOf(event));
    const target = hit === undefined ? undefined : elementAt(hit);
    if (hit === undefined || target === undefined) {
      return;
    }
    const selected = selectedElements();
    const current = selected?.frame === hit.frame.id ? selected.elements : [];
    const picked = pickOnDoubleClick(target, current);
    if (current.length === 1 && current[0] === picked && isTextLeaf(picked)) {
      onTextEdit(hit.frame.id, picked);
      return;
    }
    select({ frame: hit.frame.id, ids: ids([picked]) });
    if (isTextLeaf(picked) && current.includes(picked)) {
      onTextEdit(hit.frame.id, picked);
    }
  };

  function hover(event: ReactPointerEvent<HTMLDivElement>): void {
    const hit = frameAt(state.frames, pointOf(event));
    const target = hit === undefined ? undefined : elementAt(hit);
    if (hit === undefined || target === undefined || state.tool !== 'move' || spaceHeld) {
      if (marks.hover !== undefined) {
        setMarks((current) => ({ ...current, hover: undefined }));
      }
      return;
    }
    const selected = selectedElements();
    const current = selected?.frame === hit.frame.id ? selected.elements : [];
    const picked = pickOnClick(target, current, event.metaKey || event.ctrlKey ? 'deepest' : 'level');
    if (marks.hover?.element !== picked) {
      setMarks((current) => ({ ...current, hover: { frame: hit.frame.id, element: picked } }));
    }
  }

  function startDrag(press: Extract<Gesture, { readonly kind: 'press' }>, keys: Modifiers): Gesture | undefined {
    const freely = keys.metaKey || keys.ctrlKey;
    const selected = selectedElements();
    if (selected === undefined || selected.frame !== press.frame.id || !beginLive(press.frame.id)) {
      return undefined;
    }
    let elements = outermost(selected.elements).filter((element) => element.tagName !== 'BODY');
    if (elements.length === 0) {
      return undefined;
    }
    const mint = frameMint(press.frame.id);
    if (press.alt && mint !== undefined) {
      // Alt-drag drags a copy; the original stays where it was.
      elements = elements.map((element) => duplicateAfter(element, mint));
      select({ frame: press.frame.id, ids: ids(elements) });
    }
    const first = elements[0];
    if (first === undefined) {
      return undefined;
    }
    if (freely || elements.every(isFree)) {
      const places = elements.map((element) => ({ element, ...offset(element), box: element.getBoundingClientRect() }));
      for (const place of places) {
        if (!isFree(place.element)) {
          makeFree(place.element, { leftPx: place.leftPx, topPx: place.topPx, widthPx: place.box.width, heightPx: place.box.height });
        }
      }
      const starts = elements.map((element) => ({
        element,
        leftPx: pixels(inlineStyleOf(element, 'left')) || offset(element).leftPx,
        topPx: pixels(inlineStyleOf(element, 'top')) || offset(element).topPx,
      }));
      return { kind: 'free', frame: press.frame, starts, start: press.start, box: boxOf(first), targets: snapTargets(first, elements) };
    }
    const home = first.parentElement;
    if (home === null) {
      return undefined;
    }
    const saved = saveStyles(elements);
    for (const element of elements) {
      setInlineStyle(element, 'pointer-events', 'none');
      setInlineStyle(element, 'opacity', '0.6');
      if (inlineStyleOf(element, 'position') === '') {
        setInlineStyle(element, 'position', 'relative');
      }
      setInlineStyle(element, 'z-index', '2147483000');
    }
    return { kind: 'flow', frame: press.frame, elements, start: press.start, saved, home };
  }

  function dragFlow(active: Extract<Gesture, { readonly kind: 'flow' }>, local: Point): void {
    for (const entry of active.saved) {
      setInlineStyle(entry.element, 'transform', `translate(${px(local.xPx - active.start.xPx)}, ${px(local.yPx - active.start.yPx)})`);
    }
    const document = frameDocument(active.frame.id);
    const hit = document?.elementFromPoint(local.xPx, local.yPx);
    const drop = hit === null || hit === undefined ? undefined : flowDropAt(hit, local, active.elements, active.home);
    setMarks((current) => ({ ...current, drop: drop === undefined ? undefined : { frame: active.frame.id, drop } }));
  }

  function finishFlow(active: Extract<Gesture, { readonly kind: 'flow' }>, local: Point): void {
    const document = frameDocument(active.frame.id);
    for (const entry of active.saved) {
      setInlineStyle(entry.element, 'transform', `translate(${px(local.xPx - active.start.xPx)}, ${px(local.yPx - active.start.yPx)})`);
    }
    const hit = document?.elementFromPoint(local.xPx, local.yPx);
    const drop: FlowDrop | undefined = hit === null || hit === undefined ? undefined : flowDropAt(hit, local, active.elements, active.home);
    restoreStyles(active.saved);
    commitFrame(active.frame.id, () => {
      if (drop !== undefined) {
        for (const element of active.elements) {
          moveInFlow(element, drop.parent, drop.before);
        }
      }
      return active.elements;
    });
  }

  function dragFree(active: Extract<Gesture, { readonly kind: 'free' }>, local: Point, keys: Modifiers): void {
    const constrain = keys.shiftKey;
    let dx = local.xPx - active.start.xPx;
    let dy = local.yPx - active.start.yPx;
    if (constrain) {
      if (Math.abs(dx) > Math.abs(dy)) {
        dy = 0;
      } else {
        dx = 0;
      }
    }
    const moved: Box = { ...active.box, xPx: active.box.xPx + dx, yPx: active.box.yPx + dy };
    const snap = snapMove(moved, active.targets, SNAP_SCREEN_PX / viewRef.current.scale);
    for (const entry of active.starts) {
      placeFree(entry.element, entry.leftPx + dx + snap.dxPx, entry.topPx + dy + snap.dyPx);
    }
    setMarks((current) => ({
      ...current,
      guides: snap.guides.map((guide) => ({ frame: active.frame.id, guide })),
      gaps: snap.gaps.map((gap) => ({ frame: active.frame.id, gap })),
    }));
  }

  function dragResize(active: Extract<Gesture, { readonly kind: 'resize' }>, local: Point, keys: Modifiers): void {
    const keepRatio = keys.shiftKey;
    let dx = local.xPx - active.start.xPx;
    let dy = local.yPx - active.start.yPx;
    // The edges being dragged snap to the neighbours' lines.
    const threshold = SNAP_SCREEN_PX / viewRef.current.scale;
    const xs = active.targets.flatMap((box) => [box.xPx, box.xPx + box.widthPx / 2, box.xPx + box.widthPx]);
    const ys = active.targets.flatMap((box) => [box.yPx, box.yPx + box.heightPx / 2, box.yPx + box.heightPx]);
    if (active.handle.includes('e')) {
      dx += nearestShift([active.box.xPx + active.box.widthPx + dx], xs, threshold) ?? 0;
    } else if (active.handle.includes('w')) {
      dx += nearestShift([active.box.xPx + dx], xs, threshold) ?? 0;
    }
    if (active.handle.includes('s')) {
      dy += nearestShift([active.box.yPx + active.box.heightPx + dy], ys, threshold) ?? 0;
    } else if (active.handle.includes('n')) {
      dy += nearestShift([active.box.yPx + dy], ys, threshold) ?? 0;
    }
    const next = resizeBox(active.box, active.handle, dx, dy, keepRatio ? 'ratio' : 'free');
    setInlineStyle(active.element, 'width', px(next.widthPx));
    setInlineStyle(active.element, 'height', px(next.heightPx));
    if (active.free) {
      placeFree(active.element, active.origin.leftPx + next.xPx - active.box.xPx, active.origin.topPx + next.yPx - active.box.yPx);
    }
    setMarks((current) => ({ ...current, guides: [], gaps: [] }));
  }

  const onResizeStart = (frame: DesignFrameRecord, element: Element, handle: ResizeHandle, event: ReactPointerEvent) => {
    event.stopPropagation();
    capturePointer(host.current ?? undefined, event.pointerId);
    if (!beginLive(frame.id)) {
      return;
    }
    const point = pointOf(event);
    const free = isFree(element);
    const origin = free
      ? { leftPx: pixels(inlineStyleOf(element, 'left')) || offset(element).leftPx, topPx: pixels(inlineStyleOf(element, 'top')) || offset(element).topPx }
      : { leftPx: 0, topPx: 0 };
    gesture.current = {
      kind: 'resize',
      frame,
      element,
      handle,
      start: { xPx: point.xPx - frame.xPx, yPx: point.yPx - frame.yPx },
      box: boxOf(element),
      free,
      origin,
      targets: snapTargets(element, [element]),
    };
  };

  function insertText(frame: DesignFrameRecord, target: Element, local: Point, keys: Modifiers): void {
    const freely = keys.metaKey || keys.ctrlKey;
    const parent = containerFor(target);
    const html = `<p>${escapeHTML(words('element.newText'))}</p>`;
    const drop = flowDropAt(target, local, [], parent);
    const made = insertMarkup(frame.id, drop?.parent ?? parent, drop?.before, html, 'text', (tops) => {
      const top = tops[0];
      if (freely && top !== undefined) {
        const box = (drop?.parent ?? parent).getBoundingClientRect();
        makeFree(top, {
          leftPx: local.xPx - box.left,
          topPx: local.yPx - box.top,
          widthPx: Math.max(120, top.getBoundingClientRect().width),
          heightPx: top.getBoundingClientRect().height,
        });
        setInlineStyle(top, 'height', '');
      }
    });
    setTool('move');
    const first = made[0];
    if (first !== undefined) {
      onTextEdit(frame.id, first);
    }
  }

  function finishDraw(active: Extract<Gesture, { readonly kind: 'draw' }>, local: Point): void {
    const drawn = drawnBox(active.start, local);
    const box = drawn.widthPx < 4 && drawn.heightPx < 4 ? { ...drawn, widthPx: 100, heightPx: 100 } : drawn;
    const parentBox = active.parent.getBoundingClientRect();
    insertMarkup(active.frame.id, active.parent, undefined, '<div></div>', 'box', (tops) => {
      const top = tops[0];
      if (top !== undefined) {
        makeFree(top, {
          leftPx: box.xPx - parentBox.left - active.parent.clientLeft,
          topPx: box.yPx - parentBox.top - active.parent.clientTop,
          widthPx: box.widthPx,
          heightPx: box.heightPx,
        });
        setInlineStyle(top, 'background', '#d9d9d9');
      }
    });
    setTool('move');
  }

  return (
    <div
      ref={host}
      className={`dm-canvas${spaceHeld || state.tool === 'hand' ? ' is-panning' : ''}${state.tool === 'text' ? ' is-text-tool' : ''}${state.tool === 'box' ? ' is-box-tool' : ''}`}
      tabIndex={-1}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={() => setMarks((current) => (current.hover === undefined ? current : { ...current, hover: undefined }))}
      onDoubleClick={onDoubleClick}
      onScroll={() => keepUnscrolled(host.current ?? undefined)}
    >
      <div className="dm-world" style={{ transform: `translate(${String(view.xPx)}px, ${String(view.yPx)}px) scale(${String(view.scale)})` }}>
        {state.frames.map((frame) => (
          <div key={frame.id} className="dm-frame" style={{ left: frame.xPx, top: frame.yPx, width: frame.widthPx, height: frameHeightPx(frame) }}>
            <DesignFrameHeader
              frame={frame}
              scale={view.scale}
              words={words}
              selected={state.frameSelected === frame.id || state.selection?.frame === frame.id}
            />
            <DesignFrameView frame={frame} editing={state.editingText?.frame === frame.id} peeking={state.peek === frame.id} />
          </div>
        ))}
        <DesignSelectionLayer marks={marks} scale={view.scale} onResizeStart={onResizeStart} />
      </div>
    </div>
  );
}

/** The element a tool puts something into at a pressed element: itself when it can hold children, else its parent. */
function containerFor(target: Element): Element {
  if (!isTextLeaf(target) && !['IMG', 'INPUT', 'BUTTON', 'A', 'SVG', 'svg', 'VIDEO', 'BR', 'HR'].includes(target.tagName)) {
    return target;
  }
  return target.parentElement ?? target;
}

function drawnBox(from: Point, to: Point): Box {
  return { xPx: Math.min(from.xPx, to.xPx), yPx: Math.min(from.yPx, to.yPx), widthPx: Math.abs(to.xPx - from.xPx), heightPx: Math.abs(to.yPx - from.yPx) };
}

export type { SnapGuide, GapHint };
