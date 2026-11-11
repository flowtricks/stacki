// Extracted without behavioral changes from Stacki PreviewPane.tsx.
import { assert } from '../../../shared/core/assert';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePointerDrag } from '../../ui/usePointerDrag';
import { deviceForWidth, deviceWidth, type PreviewDevice } from './PreviewToolbar';
import { PREVIEW_WIDTH_LIMITS, previewViewport } from './previewViewport';
import { panelDragPhase, subscribePanelDragPhase, usePanelDragPhase, type PanelDragPhase } from '../../ui/panelDragPhase';
/** A width asked of the canvas from outside it (the style panel picking a media
 *  query). `serial` counts the asks, so the same width asked again still applies. */
export type CanvasWidthRequest = { readonly widthPx: number; readonly serial: number };

export function usePreviewDimensions() {
  const [customWidth, setCustomWidth] = useState<number | undefined>(undefined);
  const [customHeight, setCustomHeight] = useState<number | undefined>(undefined);
  return { customWidth, setCustomWidth, customHeight, setCustomHeight };
}
export function usePreviewSizing(device: PreviewDevice, dimensions: ReturnType<typeof usePreviewDimensions>, onDevice: (device: PreviewDevice) => void) {
  const startDrag = usePointerDrag();
  const wrapRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState({ width: 0, height: 0 });
  const { customWidth, setCustomWidth, customHeight, setCustomHeight } = dimensions;
  const [resizing, setResizing] = useState(false);
  const width = customWidth ?? deviceWidth(device);
  // A fluid frame fills the canvas by CSS, so it follows a side-panel drag without React.
  useMeasuredSize(wrapRef, { fluid: width === undefined }, setAvailable);
  useDeviceShortcuts(onDevice);
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
  const activeDevice = device === 'canvas' ? 'canvas' : (deviceForWidth(viewport.width) ?? device);
  const setWidth = (next: number): void => {
    setCustomWidth(next);
    onDevice('custom');
  };
  // Read by an effect that applies a width asked from outside, which must not
  // re-run each render because this closure is new.
  const setWidthRef = useRef(setWidth);
  setWidthRef.current = setWidth;
  const startResize = useResizeHandler({
    wrapRef,
    frameRef,
    startDrag,
    onDevice,
    setCustomWidth,
    setCustomHeight,
    setResizing,
    scale: viewport.scale,
  });
  return {
    wrapRef,
    frameRef,
    wrapWidth: available.width,
    setWidthRef,
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

function useDeviceShortcuts(onDevice: (device: PreviewDevice) => void): void {
  const onDeviceRef = useRef(onDevice);
  onDeviceRef.current = onDevice;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target ?? undefined)) {
        return;
      }
      const device = deviceFromKey(event.key);
      if (device) {
        onDeviceRef.current(device);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function isTypingTarget(target: EventTarget | undefined): boolean {
  return target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable);
}

function deviceFromKey(key: string): PreviewDevice | undefined {
  switch (key) {
    case '1':
      return 'desktop';
    case '2':
      return 'tablet';
    case '3':
      return 'phone';
    case '4':
      return 'canvas';
    default:
      return undefined;
  }
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
        context.setResizing(true);
        context.startDrag(event, {
          cursor: edge === 's' ? 'row-resize' : 'col-resize',
          onMove: (next) => resizeFrame(edge, start, next, wrap, context),
          onEnd: () => context.setResizing(false),
        });
      },
    [context],
  );
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
): void {
  if (edge === 's') {
    const height = Math.round(start.height + (event.clientY - start.y) / context.scale);
    const maximum = Math.max(160, (wrap.clientHeight - 32) / context.scale);
    context.setCustomHeight(clamp(height, 160, maximum));
    return;
  }
  const direction = edge === 'e' ? 2 : -2;
  const width = Math.round(start.width + (direction * (event.clientX - start.x)) / context.scale);
  context.setCustomWidth(clamp(width, PREVIEW_WIDTH_LIMITS.minimum, PREVIEW_WIDTH_LIMITS.maximum));
  context.onDevice('custom');
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
