// Extracted without behavioral changes from Stacki PreviewPane.tsx.
import { assert } from '../../../shared/core/assert';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePointerDrag } from '../../ui/usePointerDrag';
import { activeDeviceFor, deviceForShortcut, deviceWidth, type PreviewDevice } from './breakpointDevices';
import type { ResolvedBreakpoint } from '../../../shared/properties/projectBreakpoints';
import { PREVIEW_WIDTH_LIMITS, previewViewport } from './previewViewport';
import { panelDragPhase, setPanelDragPhase, subscribePanelDragPhase, usePanelDragPhase, type PanelDragPhase } from '../../ui/panelDragPhase';
/** A width asked of the canvas from outside it (the style panel picking a media
 *  query). `serial` counts the asks, so the same width asked again still applies. */
export type CanvasWidthRequest = { readonly widthPx: number; readonly serial: number };

export function usePreviewDimensions() {
  const [customWidth, setCustomWidth] = useState<number | undefined>(undefined);
  const [customHeight, setCustomHeight] = useState<number | undefined>(undefined);
  return { customWidth, setCustomWidth, customHeight, setCustomHeight };
}
export type PreviewDimensions = ReturnType<typeof usePreviewDimensions>;
export type PreviewSizing = ReturnType<typeof usePreviewSizing>;

/** How a sized frame takes part in the window. `deviceShortcuts` listens for the device
 *  keys (1 to 5): only one frame per window does, so a second frame over the canvas (the
 *  preview mode) does not set the same device twice for one key. */
export interface PreviewSizingOptions {
  readonly deviceShortcuts: boolean;
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
  const width = previewFrameWidth(device, customWidth, breakpoints);
  // A fluid frame fills the canvas by CSS, so it follows a side-panel drag without React.
  useMeasuredSize(wrapRef, { fluid: width === undefined }, setAvailable);
  useDeviceShortcuts(breakpoints, options, onDevice);
  useEffect(() => {
    if (device !== 'custom') {
      setCustomWidth(undefined);
    }
    if (device === 'desktop' || device === 'canvas') {
      setCustomHeight(undefined);
    }
  }, [device, setCustomWidth, setCustomHeight]);
  const panelSettling = usePanelSettling(usePanelDragPhase());
  const viewport = previewViewport(width, available, customHeight);
  // A fluid Desktop frame has no width of its own: the pane's (0 before the first measure, which keeps Desktop pressed) is the one it draws at.
  const activeDevice = activeDeviceFor(device, width ?? available.width, breakpoints);
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
  return {
    wrapRef,
    frameRef,
    wrapWidth: available.width,
    viewport,
    setWidth,
    customHeight,
    resizing,
    // True from a side-panel drag's start until the frame after release: the frame skips its size transition.
    panelSettling,
    width,
    activeDevice,
    startResize,
  };
}

/**
 * The width the frame draws the page at, or undefined to fill the canvas by CSS. A custom
 * width belongs to the custom device: read on any other, it drew one frame at the old custom
 * width after a device button was pressed, until the effect in usePreviewSizing cleared it.
 * Desktop has no width of its own: it fills the pane, so a narrow pane draws the page at the pane's width (scale 1) and the
 * page's media queries switch to the laptop, tablet or phone layout, as they would in a browser window that size.
 */
export function previewFrameWidth(device: PreviewDevice, customWidth: number | undefined, breakpoints: readonly ResolvedBreakpoint[]): number | undefined {
  if (device === 'custom') {
    return customWidth ?? deviceWidth(device, breakpoints);
  }
  if (device === 'desktop') {
    return undefined;
  }
  return deviceWidth(device, breakpoints);
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
