// Extracted without behavioral changes from Stacki PreviewPane.tsx.
import { assert } from '../../../shared/core/assert';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePointerDrag } from '../../ui/usePointerDrag';
import { activeDeviceFor, deviceForShortcut, deviceWidth, type PreviewDevice } from './breakpointDevices';
import type { ResolvedBreakpoint } from '../../../shared/properties/projectBreakpoints';
import { FILL_UNBOUNDED, fluidFrameStyle, fluidFrameWidthPx, PREVIEW_WIDTH_LIMITS, previewViewport, type FillBounds } from './previewViewport';
import { panelDragPhase, setPanelDragPhase, subscribePanelDragPhase, usePanelDragPhase, type PanelDragPhase } from '../../ui/panelDragPhase';
/** A width asked of the canvas from outside it (the style panel picking a media
 *  query). `serial` counts the asks, so the same width asked again still applies. */
export type CanvasWidthRequest = { readonly widthPx: number; readonly serial: number };

/** The canvas pane's size, as measured. */
export interface PaneSize {
  readonly width: number;
  readonly height: number;
}

/** How long after a pick the pane may still move without ending it: the pick's own layout (the style panel moving to
 *  Base, a toolbar that changes) settles inside it. */
export const DESKTOP_PICK_SETTLE_MS = 400;

/** The most a held pick's pane may differ, in pixels either way, and still be the same pane: rounding and a
 *  scrollbar's jitter, not a resize. Measured from the size held, so many small steps add up. */
export const DESKTOP_PICK_JITTER_PX = 4;

/** Whether the pane is no longer the size a pick was held at. Nothing held, or a pane not measured, has not moved. */
export function paneResized(held: PaneSize | undefined, pane: PaneSize): boolean {
  if (held === undefined || pane.width === 0) {
    return false;
  }
  if (Math.abs(pane.width - held.width) > DESKTOP_PICK_JITTER_PX) {
    return true;
  }
  return Math.abs(pane.height - held.height) > DESKTOP_PICK_JITTER_PX;
}

/**
 * What an explicit pick of Desktop has left to do. `none` is the ordinary editing canvas: the pane's own width at
 * 100%, reflowing as the window and panels move. `asked` is a pick the canvas has not measured yet. A pick made
 * where filling would not show the desktop layout holds the canvas until the pane can: `narrow` draws the Desktop
 * width, framed and scaled to fit, as typing it would; `wide` (the pane reaches an `up` breakpoint) stops short of it.
 * Either is one look: the next resize of the pane ends it (paneResized).
 */
export type DesktopPick = 'none' | 'asked' | 'narrow' | 'wide';

export function usePreviewDimensions() {
  const [customWidth, setCustomWidth] = useState<number | undefined>(undefined);
  const [customHeight, setCustomHeight] = useState<number | undefined>(undefined);
  const [desktopPick, setDesktopPick] = useState<DesktopPick>('none');
  // The pane a held pick is being looked at in, once the pick has settled; absent while it settles.
  const [pickPane, setPickPane] = useState<PaneSize | undefined>(undefined);
  // The page and rendering the pick was made on: another one opens on the ordinary canvas.
  const pickViewRef = useRef<string | undefined>(undefined);
  return { customWidth, setCustomWidth, customHeight, setCustomHeight, desktopPick, setDesktopPick, pickPane, setPickPane, pickViewRef };
}
export type PreviewDimensions = ReturnType<typeof usePreviewDimensions>;
export type PreviewSizing = ReturnType<typeof usePreviewSizing>;

/** How a sized frame takes part in the window. `deviceShortcuts` listens for the device
 *  keys (1 to 5): only one frame per window does, so a second frame over the canvas (the
 *  preview mode) does not set the same device twice for one key. */
export interface PreviewSizingOptions {
  readonly deviceShortcuts: boolean;
  /** The project's Desktop width in pixels (Settings, `useProjectBreakpoints`). */
  readonly desktopFramePx: number;
  /** What the canvas shows (project, page, reload count): a change drops a held Desktop pick. Only the frame that
   *  listens for the device keys owns the pick; a second frame (the preview mode) leaves this out and only reads it. */
  readonly viewKey?: string;
}

export function usePreviewSizing(
  device: PreviewDevice,
  dimensions: PreviewDimensions,
  breakpoints: readonly ResolvedBreakpoint[],
  options: PreviewSizingOptions,
  onDevice: (device: PreviewDevice) => void,
) {
  const startDrag = usePointerDrag();
  const wrapRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState({ width: 0, height: 0 });
  const { customWidth, setCustomWidth, customHeight, setCustomHeight } = dimensions;
  const [resizing, setResizing] = useState(false);
  // The frame that owns the pick reads a resized pane as the pick's end in the same render, so no frame is drawn
  // rescaled in between. A second frame has a pane of its own and only reads what the owner decided.
  const resized = options.deviceShortcuts && paneResized(dimensions.pickPane, available);
  const pick: DesktopPick = resized ? 'none' : dimensions.desktopPick;
  const room = { desktopFramePx: options.desktopFramePx, paneWidthPx: available.width, pick };
  const width = previewFrameWidth(device, customWidth, breakpoints, room);
  // A fluid frame fills the canvas by CSS, so it follows a side-panel drag without React.
  useMeasuredSize(wrapRef, { fluid: width === undefined }, setAvailable);
  // Every explicit choice of a device goes through here: the buttons, their keys and Fit.
  const pickDevice = (next: PreviewDevice): void => {
    if (next === 'desktop') {
      dimensions.setPickPane(undefined);
      dimensions.setDesktopPick('asked');
    }
    onDevice(next);
  };
  useDeviceShortcuts(breakpoints, options, pickDevice);
  useDesktopPickOwner(device, dimensions, breakpoints, available, options);
  useEffect(() => {
    if (device !== 'custom') {
      setCustomWidth(undefined);
    }
    if (device === 'desktop' || device === 'canvas') {
      setCustomHeight(undefined);
    }
  }, [device, setCustomWidth, setCustomHeight]);
  const panelSettling = usePanelSettling(usePanelDragPhase());
  const fill = previewFillBounds(device, breakpoints, room);
  const viewport = previewViewport(width, available, customHeight, fill);
  // A filling Desktop frame has no width of its own: the pane's less its gutters (0 before the first measure, which keeps Desktop pressed) is the one it draws at.
  const activeDevice = activeDeviceFor(device, width ?? fluidFrameWidthPx(available.width, fill), breakpoints);
  const setWidth = (next: number): void => {
    setCustomWidth(next);
    onDevice('custom');
  };
  const startResize = useResizeHandler({
    wrapRef,
    frameRef,
    startDrag,
    onDevice,
    setCustomWidth,
    setCustomHeight,
    setResizing,
    scale: viewport.scale,
    available,
    customHeight,
    device,
  });
  // A filling frame's CSS, for it and its overlay layer.
  const fillStyle = fluidFrameStyle(fill);
  return {
    wrapRef,
    frameRef,
    wrapWidth: available.width,
    viewport,
    fillStyle,
    setWidth,
    pickDevice,
    customHeight,
    resizing,
    // True from a side-panel drag's start until the frame after release: the frame skips its size transition.
    panelSettling,
    width,
    activeDevice,
    startResize,
  };
}

/** What decides how the Desktop device is drawn: the project's Desktop width, the canvas pane's (0 before it is
 *  measured) and what an explicit pick of Desktop has left to do. */
export interface DesktopRoom {
  readonly desktopFramePx: number;
  readonly paneWidthPx: number;
  readonly pick: DesktopPick;
}

/**
 * The width the frame draws the page at, or undefined to fill the canvas by CSS. A custom
 * width belongs to the custom device: read on any other, it drew one frame at the old custom
 * width after a device button was pressed, until the effect in usePreviewSizing cleared it.
 * Desktop fills the pane, at 100% and with no frame, unless a pick of it is held in a pane too narrow for the desktop
 * layout. Resizing never scales the page: it ends a pick, and the page reflows, as in a browser window that size.
 */
export function previewFrameWidth(
  device: PreviewDevice,
  customWidth: number | undefined,
  breakpoints: readonly ResolvedBreakpoint[],
  room: DesktopRoom,
): number | undefined {
  if (device === 'custom') {
    return customWidth ?? deviceWidth(device, breakpoints);
  }
  if (device === 'desktop') {
    assert(Number.isSafeInteger(room.desktopFramePx), 'The Desktop width is whole pixels');
    assert(room.desktopFramePx > 0, 'The Desktop width is positive');
    return resolveDesktopPick(room.pick, room.paneWidthPx, desktopRange(breakpoints)) === 'narrow' ? room.desktopFramePx : undefined;
  }
  return deviceWidth(device, breakpoints);
}

/**
 * "Desktop" as a range of widths: from one pixel past the widest `down` canvas (a `width < X` canvas is the last whole
 * pixel inside it) to one pixel short of the narrowest `up` one.
 */
export function desktopRange(breakpoints: readonly ResolvedBreakpoint[]): FillBounds {
  const downs = breakpoints.filter((breakpoint) => breakpoint.direction === 'down').map((breakpoint) => breakpoint.widthPx);
  const ups = breakpoints.filter((breakpoint) => breakpoint.direction === 'up').map((breakpoint) => breakpoint.widthPx);
  return {
    widthPxMin: downs.length === 0 ? 0 : Math.max(...downs) + 1,
    widthPxMax: ups.length === 0 ? undefined : Math.min(...ups) - 1,
  };
}

/**
 * Where a pick stands in a pane this wide. A pane in the range needs no help, so the pick is over, and it does not
 * come back when the pane changes again. The pane is judged by its own width, before any gutter; a wider breakpoint by
 * the width the page would be filled at. An unmeasured pane leaves the pick as it is.
 */
export function resolveDesktopPick(pick: DesktopPick, paneWidthPx: number, range: FillBounds): DesktopPick {
  if (paneWidthPx === 0) {
    return pick;
  }
  const narrow = paneWidthPx < range.widthPxMin;
  const wide = range.widthPxMax !== undefined && fluidFrameWidthPx(paneWidthPx, FILL_UNBOUNDED) > range.widthPxMax;
  switch (pick) {
    case 'none':
      return 'none';
    case 'asked':
      return narrow ? 'narrow' : wide ? 'wide' : 'none';
    case 'narrow':
      return narrow ? 'narrow' : 'none';
    case 'wide':
      return wide ? 'wide' : 'none';
    default: {
      const exhaustive: never = pick;
      return exhaustive;
    }
  }
}

/**
 * The widths a filling frame may draw at. A Desktop frame in a pane that has the desktop range keeps the page in it
 * (the scrollbar's gutters give way first), and one holding a `wide` pick stops short of the wider breakpoint.
 * Everything else takes the pane as it is, at any width.
 */
export function previewFillBounds(device: PreviewDevice, breakpoints: readonly ResolvedBreakpoint[], room: DesktopRoom): FillBounds {
  if (device !== 'desktop') {
    return FILL_UNBOUNDED;
  }
  const range = desktopRange(breakpoints);
  return {
    widthPxMin: room.paneWidthPx >= range.widthPxMin ? range.widthPxMin : 0,
    widthPxMax: resolveDesktopPick(room.pick, room.paneWidthPx, range) === 'wide' ? range.widthPxMax : undefined,
  };
}

// The frame that listens for the device keys keeps the pick: it stores where it stands in its own pane, drops it for
// another device, a resize of that pane, or a change of what the canvas shows. Opening a page is not choosing Desktop.
function useDesktopPickOwner(
  device: PreviewDevice,
  dimensions: PreviewDimensions,
  breakpoints: readonly ResolvedBreakpoint[],
  pane: PaneSize,
  options: PreviewSizingOptions,
): void {
  const { desktopPick, setDesktopPick, pickPane, setPickPane, pickViewRef } = dimensions;
  const owns = options.deviceShortcuts;
  const viewKey = options.viewKey;
  useLayoutEffect(() => {
    if (!owns || viewKey === undefined) {
      return;
    }
    if (pickViewRef.current !== undefined && pickViewRef.current !== viewKey) {
      setDesktopPick('none');
    }
    pickViewRef.current = viewKey;
  }, [owns, viewKey, pickViewRef, setDesktopPick]);
  const stands = device === 'desktop' ? resolveDesktopPick(desktopPick, pane.width, desktopRange(breakpoints)) : 'none';
  const resolved: DesktopPick = paneResized(pickPane, pane) ? 'none' : stands;
  const held = resolved === 'narrow' || resolved === 'wide';
  useLayoutEffect(() => {
    if (!owns) {
      return;
    }
    if (resolved !== desktopPick) {
      setDesktopPick(resolved);
    }
    // A pick that is over holds no pane; `asked` has not been measured yet.
    if (!held && resolved !== 'asked' && pickPane !== undefined) {
      setPickPane(undefined);
    }
  }, [owns, resolved, held, desktopPick, setDesktopPick, pickPane, setPickPane]);
  // Once the pick's own layout has settled, the pane as it then stands is the one the pick is held in.
  const latest = useRef(pane);
  latest.current = pane;
  const settling = owns && held && pickPane === undefined;
  useEffect(() => {
    if (!settling) {
      return undefined;
    }
    const timer = setTimeout(() => setPickPane(latest.current), DESKTOP_PICK_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [settling, setPickPane]);
}

// Measures the canvas. During a side-panel drag the canvas follows the panel live, by CSS
// (the wrap is flex: 1). A fluid frame fills it by CSS too, so its measure (a render of the
// whole preview and its overlays) waits for release and runs once; a fixed-width frame keeps
// measuring each frame, at the observer's own once-per-frame pace, so its scale follows live.
function useMeasuredSize(
  ref: React.RefObject<HTMLDivElement>,
  options: { readonly fluid: boolean },
  setSize: React.Dispatch<React.SetStateAction<{ width: number; height: number }>>,
): void {
  const { fluid } = options;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    let pending = false;
    const measure = (): void => {
      pending = false;
      const next = { width: element.clientWidth, height: element.clientHeight };
      assert(Number.isFinite(next.width), 'The canvas width is finite');
      setSize((previous) => (previous.width === next.width && previous.height === next.height ? previous : next));
    };
    const observed = (): void => {
      if (fluid && panelDragPhase() === 'dragging') {
        pending = true;
      } else {
        measure();
      }
    };
    measure();
    const observer = new ResizeObserver(observed);
    observer.observe(element);
    const stopPhase = subscribePanelDragPhase(() => {
      if (pending && panelDragPhase() === 'idle') {
        measure();
      }
    });
    return () => {
      stopPhase();
      observer.disconnect();
    };
  }, [ref, fluid, setSize]);
}

// From a side-panel drag's start until the frame after release, the frame skips its width
// transition, so it tracks the panel instead of easing behind it.
type PanelSettling = 'live' | 'dragging' | 'releasing';

function usePanelSettling(phase: PanelDragPhase): boolean {
  const [settling, setSettling] = useState<PanelSettling>('live');
  useLayoutEffect(() => {
    if (phase === 'dragging') {
      setSettling('dragging');
    } else {
      setSettling((current) => (current === 'dragging' ? 'releasing' : current));
    }
  }, [phase]);
  useEffect(() => {
    if (settling !== 'releasing') {
      return undefined;
    }
    const frame = requestAnimationFrame(() => setSettling('live'));
    return () => cancelAnimationFrame(frame);
  }, [settling]);
  return phase === 'dragging' || settling !== 'live';
}

function useDeviceShortcuts(breakpoints: readonly ResolvedBreakpoint[], options: PreviewSizingOptions, onDevice: (device: PreviewDevice) => void): void {
  const onDeviceRef = useRef(onDevice);
  onDeviceRef.current = onDevice;
  const breakpointsRef = useRef(breakpoints);
  breakpointsRef.current = breakpoints;
  const listening = options.deviceShortcuts;
  useEffect(() => {
    if (!listening) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target ?? undefined)) {
        return;
      }
      const device = deviceForShortcut(event.key, breakpointsRef.current);
      if (device) {
        onDeviceRef.current(device);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [listening]);
}

function isTypingTarget(target: EventTarget | undefined): boolean {
  return target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable);
}

interface ResizeContext {
  readonly scale: number;
  readonly wrapRef: React.RefObject<HTMLDivElement>;
  readonly frameRef: React.RefObject<HTMLDivElement>;
  readonly startDrag: ReturnType<typeof usePointerDrag>;
  readonly onDevice: (device: PreviewDevice) => void;
  readonly setCustomWidth: React.Dispatch<React.SetStateAction<number | undefined>>;
  readonly setCustomHeight: React.Dispatch<React.SetStateAction<number | undefined>>;
  readonly setResizing: React.Dispatch<React.SetStateAction<boolean>>;
  readonly available: { readonly width: number; readonly height: number };
  readonly customHeight: number | undefined;
  readonly device: PreviewDevice;
}

type ResizeEdge = 'w' | 'e' | 's';

function useResizeHandler(context: ResizeContext) {
  return useCallback(
    (edge: ResizeEdge) =>
      (event: React.PointerEvent<HTMLDivElement>): void => {
        if (event.button !== 0) {
          return;
        }
        event.preventDefault();
        const frame = context.frameRef.current;
        const wrap = context.wrapRef.current;
        if (!frame || !wrap) {
          return;
        }
        const start = {
          x: event.clientX,
          y: event.clientY,
          width: frame.offsetWidth,
          height: frame.offsetHeight,
        };
        // Pointer capture keeps the move events on the handle, not the page under the pointer, so a fast drag over the
        // canvas iframe (another process) never loses a move.
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // A synthetic or already-released pointer has nothing to capture: the window listeners still carry the drag.
        }
        const live = new LiveResize();
        context.setResizing(true);
        // The same hold a side-panel drag takes: measures that render React wait for release (panelDragPhase.ts).
        setPanelDragPhase('dragging');
        context.startDrag(event, {
          cursor: edge === 's' ? 'row-resize' : 'col-resize',
          onMove: (next) => resizeFrame(edge, start, next, wrap, context, live),
          onEnd: () => {
            commitResize(context, live);
            context.setResizing(false);
            setPanelDragPhase('idle');
          },
        });
      },
    [context],
  );
}

// What a drag has drawn so far, in the frame's own DOM. React hears of it when the drag leaves Desktop and at release: a render of the whole preview, toolbar and overlays for every pointer frame was what made a drag jitter.
class LiveResize {
  // Whether React has been told the drag left the Desktop device (once, at the first width move).
  private leftDesktopOnce = false;
  private widthNow: number | undefined = undefined;
  private heightNow: number | undefined = undefined;

  get widthPx(): number | undefined {
    return this.widthNow;
  }

  get heightPx(): number | undefined {
    return this.heightNow;
  }

  setWidth(widthPx: number): void {
    this.widthNow = widthPx;
  }

  setHeight(heightPx: number): void {
    this.heightNow = heightPx;
  }

  /** True the first time it is asked, false after: the one commit that leaves Desktop's flush look. */
  takeLeftDesktop(): boolean {
    const first = !this.leftDesktopOnce;
    this.leftDesktopOnce = true;
    return first;
  }
}

// Writes the drag's size straight to the frame, once per animation frame (usePointerDrag coalesces moves), so the iframe
// reflows to the pointer's own position with no React in between.
function drawFrame(context: ResizeContext, live: LiveResize): void {
  const frame = context.frameRef.current;
  if (!frame) {
    return;
  }
  const readout = frame.querySelector('.rz-readout');
  if (live.widthPx === undefined) {
    // A height drag: the width, and so the scale, stay the frame's own (a fluid frame keeps filling the canvas).
    assert(live.heightPx !== undefined, 'A drag with no width is a height drag');
    frame.style.height = `${live.heightPx}px`;
    if (readout) {
      readout.textContent = `${Math.round(frame.offsetWidth)} × ${Math.round(live.heightPx)}`;
    }
    return;
  }
  const viewport = previewViewport(live.widthPx, context.available, live.heightPx ?? context.customHeight);
  frame.style.width = `${viewport.width}px`;
  frame.style.height = `${viewport.height}px`;
  frame.style.transform = `translateX(-50%) scale(${viewport.scale})`;
  if (readout) {
    readout.textContent = `${Math.round(viewport.width)} × ${Math.round(viewport.height)}`;
  }
}

function commitResize(context: ResizeContext, live: LiveResize): void {
  if (live.heightPx !== undefined) {
    context.setCustomHeight(live.heightPx);
  }
  if (live.widthPx !== undefined) {
    context.setCustomWidth(live.widthPx);
    context.onDevice('custom');
  }
}

function resizeFrame(
  edge: ResizeEdge,
  start: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
  event: PointerEvent,
  wrap: HTMLDivElement,
  context: ResizeContext,
  live: LiveResize,
): void {
  if (edge === 's') {
    const height = Math.round(start.height + (event.clientY - start.y) / context.scale);
    const maximum = Math.max(160, (wrap.clientHeight - 32) / context.scale);
    live.setHeight(clamp(height, 160, maximum));
    drawFrame(context, live);
    return;
  }
  const direction = edge === 'e' ? 2 : -2;
  const width = Math.round(start.width + (direction * (event.clientX - start.x)) / context.scale);
  live.setWidth(clamp(width, PREVIEW_WIDTH_LIMITS.minimum, PREVIEW_WIDTH_LIMITS.maximum));
  drawFrame(context, live);
  // Desktop is drawn flush and every other width framed, so leaving Desktop is the one change React must draw mid-drag. Every
  // other pixel stays in the frame; the toolbar, the style panel's followed query and the overlays catch up at release.
  if (context.device === 'desktop' && live.takeLeftDesktop()) {
    context.setCustomWidth(live.widthPx ?? width);
    context.onDevice('custom');
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

// A width asked from outside (the style panel's query or Base pick). Applied while
// rendering, not in an effect: the app moves the device to `custom` in the same update as
// the request, and an effect would paint one frame with the custom device at the old
// width (the readout and the frame a step behind the toolbar). The serial makes it apply
// once per request, so a later hand resize is not undone by a re-render.
export function useCanvasWidthRequest(request: CanvasWidthRequest | undefined, setCustomWidth: (width: number | undefined) => void): void {
  const [appliedSerial, setAppliedSerial] = useState<number | undefined>(undefined);
  if (request !== undefined && request.serial !== appliedSerial) {
    const clamped = Math.min(PREVIEW_WIDTH_LIMITS.maximum, Math.max(PREVIEW_WIDTH_LIMITS.minimum, Math.round(request.widthPx)));
    setAppliedSerial(request.serial);
    setCustomWidth(clamped);
  }
}
