// Extracted without behavioral changes from Stacki PreviewPane.tsx.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePointerDrag } from '../../ui/usePointerDrag';
import { deviceForWidth, deviceWidth, type PreviewDevice } from './PreviewToolbar';
import { PREVIEW_WIDTH_LIMITS, previewViewport } from './previewViewport';
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
  useMeasuredSize(wrapRef, setAvailable);
  useDeviceShortcuts(onDevice);
  useEffect(() => {
    if (device !== 'custom') {
      setCustomWidth(undefined);
    }
    if (device === 'desktop' || device === 'canvas') {
      setCustomHeight(undefined);
    }
  }, [device, setCustomWidth, setCustomHeight]);
  const width = customWidth ?? deviceWidth(device);
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
    width,
    activeDevice,
    startResize,
  };
}

function useMeasuredSize(ref: React.RefObject<HTMLDivElement>, setSize: React.Dispatch<React.SetStateAction<{ width: number; height: number }>>): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const measure = (): void => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, setSize]);
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
