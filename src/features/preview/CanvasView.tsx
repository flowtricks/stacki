import React from 'react';
import { assert } from '../../../shared/core/assert';
import { usePreviewSource } from './usePreviewSource';
import { PreviewFrame } from './PreviewFrame';
import { CanvasScrollbar } from './CanvasScrollbar';
import { parsePreviewMessage } from './previewMessages';
import { usePointerDrag } from '../../ui/usePointerDrag';
import { panelDragPhase, subscribePanelDragPhase } from '../../ui/panelDragPhase';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';
import type { ResolvedBreakpoint } from '../../../shared/properties/projectBreakpoints';
import { barDevices } from './breakpointDevices';
import { breakpointLabel } from '../../lib/breakpointLabel';

interface CanvasBreakpoint {
  /** `desktop`, or a breakpoint's id. */
  readonly key: string;
  readonly label: string;
  readonly width: number;
  readonly viewportHeight: number;
}
// The all-breakpoints canvas draws Desktop at the project's Desktop frame width (90rem, 1440px, unless set in Settings: never a media
// query) and every breakpoint at its width (`.stacki/breakpoints.json`), in the preview bar's order: the wider ones, Desktop, the narrower ones.
function canvasBreakpoints(resolved: readonly ResolvedBreakpoint[], desktopFramePx: number, translate: Translator): readonly CanvasBreakpoint[] {
  const frames: CanvasBreakpoint[] = [];
  for (const device of barDevices(resolved)) {
    if (device.breakpoint !== undefined) {
      const width = device.breakpoint.widthPx;
      frames.push({ key: device.key, label: breakpointLabel(device.breakpoint, translate), width, viewportHeight: viewportHeightFor(device.breakpoint) });
    } else if (device.key === 'desktop') {
      frames.push({ key: 'desktop', label: translate('preview.canvas.desktop'), width: desktopFramePx, viewportHeight: 900 });
    }
  }
  return frames;
}

// A typical window height for the width: wide screens 1080, laptops 768, tablets 1024, phones 812, watches 400.
function viewportHeightFor(breakpoint: ResolvedBreakpoint): number {
  if (breakpoint.direction === 'up') {
    return 1_080;
  }
  if (breakpoint.widthPx >= 895) {
    return 768;
  }
  if (breakpoint.widthPx >= 623) {
    return 1_024;
  }
  return breakpoint.widthPx >= 400 ? 812 : 400;
}
const GAP_PX = 120;
const PAGE_HEIGHT_PX_MAX = 30_000;
const PAGE_HEIGHT_PX_MIN = 200;
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 4;
// A press that travels less than this is a click: it moves nothing, and the canvas goes on zooming to fit.
const PAN_START_PX = 3;
// The most one wheel event zooms by: one step of the zoom buttons. A mouse wheel's notch reports a delta of 100 or more
// (about 2.7 times at once); a trackpad pinch's deltas stay under this, and zoom as they come.
const WHEEL_ZOOM_DELTA_MAX = Math.log(1.25) / 0.01;
type BreakpointKey = string;
// Per-breakpoint lookups that fill in as frames mount and report: a frame that
// has not reported yet has no entry. Sparse maps, not update types, so absence
// is part of the type.
type FrameHeights = Partial<Record<BreakpointKey, number>>;
type FrameElements = Partial<Record<BreakpointKey, HTMLIFrameElement>>;
interface ViewState {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}
interface CanvasViewProps {
  /** The project's breakpoints: one frame each is drawn at its canvas width. */
  readonly breakpoints: readonly ResolvedBreakpoint[];
  /** The width of the Desktop frame, in pixels. */
  readonly desktopFramePx: number;
  readonly url: string;
  readonly refreshKey: string | number;
  readonly onPreviewLoaded?: () => void;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export default function CanvasView({ url: renderURL, refreshKey, onPreviewLoaded, breakpoints, desktopFramePx }: CanvasViewProps) {
  const startDrag = usePointerDrag();
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const iframesRef = React.useRef<FrameElements>({});
  const source = useCanvasSource(renderURL, iframesRef);
  const url = source.url ?? renderURL;
  const [view, setView] = React.useState<ViewState | undefined>(undefined);
  const [panning, setPanning] = React.useState(false);
  const [heights, setHeights] = React.useState<FrameHeights>({});
  const viewRef = React.useRef<ViewState | undefined>(undefined);
  viewRef.current = view;
  const translate = useTranslate();
  const frames = React.useMemo(
    () => layoutFrames(heights, canvasBreakpoints(breakpoints, desktopFramePx, translate)),
    [heights, breakpoints, desktopFramePx, translate],
  );
  const lastFrame = frames.at(-1);
  if (!lastFrame) {
    throw new Error('Canvas requires at least one breakpoint');
  }
  const world = {
    width: lastFrame.x + lastFrame.width,
    height: Math.max(...frames.map((frame) => frame.height)),
  };
  const worldRef = React.useRef(world);
  worldRef.current = world;
  const userMovedRef = React.useRef(false);
  useFrameHeights(iframesRef, setHeights, frames);
  useStudioPatches(iframesRef, url);
  const fit = useFitCanvas(wrapRef, worldRef, setView);
  useCanvasFit(wrapRef, userMovedRef, world.width, world.height, fit);
  React.useEffect(() => setHeights({}), [refreshKey, url]);
  useCanvasWheel(wrapRef, viewRef, userMovedRef, setView);
  const onPointerDown = useCanvasPointer(startDrag, viewRef, userMovedRef, setView, setPanning);
  const zoomTo = (scale: number): void => zoomCanvas(wrapRef.current ?? undefined, viewRef.current, scale, userMovedRef, setView);
  return (
    <div ref={wrapRef} className={`canvas-view ${panning ? 'panning' : ''}`} onPointerDown={onPointerDown}>
      {view && (
        <CanvasFrames
          frames={frames}
          view={view}
          url={url}
          refreshKey={refreshKey}
          iframesRef={iframesRef}
          onPreviewLoaded={() => {
            source.loaded();
            onPreviewLoaded?.();
          }}
        />
      )}
      {view && (
        <CanvasControls
          view={view}
          onZoom={zoomTo}
          onFit={() => {
            userMovedRef.current = false;
            fit();
          }}
        />
      )}
    </div>
  );
}

function useCanvasPointer(
  startDrag: ReturnType<typeof usePointerDrag>,
  viewRef: React.MutableRefObject<ViewState | undefined>,
  userMovedRef: React.MutableRefObject<boolean>,
  setView: React.Dispatch<React.SetStateAction<ViewState | undefined>>,
  setPanning: React.Dispatch<React.SetStateAction<boolean>>,
) {
  return (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 && event.button !== 1) {
      return;
    }
    const start = viewRef.current;
    if (!start) {
      return;
    }
    event.preventDefault();
    setPanning(true);
    const { clientX, clientY } = event;
    let moved = false;
    startDrag(event, {
      onMove: (next) => {
        moved ||= Math.hypot(next.clientX - clientX, next.clientY - clientY) >= PAN_START_PX;
        if (!moved) {
          return;
        }
        userMovedRef.current = true;
        setView({
          ...start,
          x: start.x + next.clientX - clientX,
          y: start.y + next.clientY - clientY,
        });
      },
      onEnd: () => setPanning(false),
    });
  };
}

function layoutFrames(heights: FrameHeights, breakpoints: readonly CanvasBreakpoint[]) {
  let x = 0;
  return breakpoints.map((breakpoint) => {
    // The frame freezes viewport units to viewportHeight before growing. Its
    // visible height can therefore follow the full page without enlarging heroes.
    const height = clamp(heights[breakpoint.key] ?? breakpoint.viewportHeight, PAGE_HEIGHT_PX_MIN, PAGE_HEIGHT_PX_MAX);
    const frame = { ...breakpoint, x, height };
    x += breakpoint.width + GAP_PX;
    return frame;
  });
}

function useFrameHeights(
  iframesRef: React.MutableRefObject<FrameElements>,
  setHeights: React.Dispatch<React.SetStateAction<FrameHeights>>,
  frames: Frames,
): void {
  React.useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>): void => {
      const match = Object.entries(iframesRef.current).find(([, iframe]) => iframe?.contentWindow === event.source);
      const key = match?.[0];
      if (key === undefined || !frames.some((entry) => entry.key === key)) {
        return;
      }
      if (isFrameReady(event.data)) {
        const breakpoint = frames.find((entry) => entry.key === key);
        const iframe = iframesRef.current[key];
        if (breakpoint && iframe) {
          // Ready precedes window.load when images are slow. Freeze before the
          // first height report can stretch an unfrozen viewport-sized section.
          iframe.contentWindow?.postMessage({ type: 'avb:set-vh', px: breakpoint.viewportHeight }, new URL(iframe.src).origin);
        }
      }
      const height = parsePageHeight(event.data);
      if (height === undefined) {
        return;
      }
      setHeights((current) => (current[key] === height ? current : { ...current, [key]: height }));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [iframesRef, setHeights, frames]);
}

function isFrameReady(input: unknown): boolean {
  if (parsePreviewMessage(input)?.kind === 'canvas-ready') {
    return true;
  }
  // Studio canvas copies do not install the editable selection tracker, so
  // their preview client announces document readiness independently.
  return typeof input === 'object' && input !== null && 'type' in input && input.type === 'studio:preview-ready';
}

export function parsePageHeight(input: unknown): number | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  if (!('type' in input) || input.type !== 'avb:page-height') {
    return undefined;
  }
  if (!('height' in input) || typeof input.height !== 'number' || !Number.isFinite(input.height)) {
    return undefined;
  }
  return clamp(Math.round(input.height), PAGE_HEIGHT_PX_MIN, PAGE_HEIGHT_PX_MAX);
}

function useFitCanvas(
  wrapRef: React.RefObject<HTMLDivElement>,
  worldRef: React.MutableRefObject<{ readonly width: number; readonly height: number }>,
  setView: React.Dispatch<React.SetStateAction<ViewState | undefined>>,
) {
  return React.useCallback((): void => {
    const element = wrapRef.current;
    if (!element) {
      return;
    }
    const { width, height } = worldRef.current;
    const paddingPx = 56;
    const scale = clamp(Math.min((element.clientWidth - paddingPx * 2) / width, (element.clientHeight - paddingPx * 2) / height), ZOOM_MIN, 1);
    setView({
      scale,
      x: (element.clientWidth - width * scale) / 2,
      y: Math.max((element.clientHeight - height * scale) / 2, paddingPx * 0.75),
    });
  }, [setView, worldRef, wrapRef]);
}

function useCanvasFit(
  wrapRef: React.RefObject<HTMLDivElement>,
  userMovedRef: React.MutableRefObject<boolean>,
  worldWidth: number,
  worldHeight: number,
  fit: () => void,
): void {
  React.useLayoutEffect(() => {
    const element = wrapRef.current;
    if (!element) {
      return;
    }
    fit();
    // A side-panel drag resizes the canvas each frame; the zoom to fit (a render of every
    // frame on the canvas) runs once, on release, instead of at each step.
    let pending = false;
    const observer = new ResizeObserver(() => {
      if (userMovedRef.current) {
        return;
      }
      if (panelDragPhase() === 'dragging') {
        pending = true;
      } else {
        fit();
      }
    });
    observer.observe(element);
    const stopPhase = subscribePanelDragPhase(() => {
      if (pending && panelDragPhase() === 'idle') {
        pending = false;
        if (!userMovedRef.current) {
          fit();
        }
      }
    });
    return () => {
      stopPhase();
      observer.disconnect();
    };
  }, [fit, userMovedRef, wrapRef]);
  React.useEffect(() => {
    if (!userMovedRef.current) {
      fit();
    }
  }, [fit, userMovedRef, worldHeight, worldWidth]);
}

function useCanvasWheel(
  wrapRef: React.RefObject<HTMLDivElement>,
  viewRef: React.MutableRefObject<ViewState | undefined>,
  userMovedRef: React.MutableRefObject<boolean>,
  setView: React.Dispatch<React.SetStateAction<ViewState | undefined>>,
): void {
  React.useEffect(() => {
    const element = wrapRef.current;
    if (!element) {
      return;
    }
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      userMovedRef.current = true;
      const bounds = element.getBoundingClientRect();
      setView((view) => wheelView(view, event, event.clientX - bounds.left, event.clientY - bounds.top));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [setView, userMovedRef, viewRef, wrapRef]);
}

function wheelView(view: ViewState | undefined, event: WheelEvent, x: number, y: number) {
  if (!view) {
    return view;
  }
  if (!event.ctrlKey && !event.metaKey) {
    return { ...view, x: view.x - event.deltaX, y: view.y - event.deltaY };
  }
  const delta = clamp(event.deltaY, -WHEEL_ZOOM_DELTA_MAX, WHEEL_ZOOM_DELTA_MAX);
  const scale = clamp(view.scale * Math.exp(-delta * 0.01), ZOOM_MIN, ZOOM_MAX);
  const ratio = scale / view.scale;
  return { scale, x: x - (x - view.x) * ratio, y: y - (y - view.y) * ratio };
}

function zoomCanvas(
  element: HTMLDivElement | undefined,
  view: ViewState | undefined,
  nextScale: number,
  userMovedRef: React.MutableRefObject<boolean>,
  setView: React.Dispatch<React.SetStateAction<ViewState | undefined>>,
): void {
  if (!element || !view) {
    return;
  }
  userMovedRef.current = true;
  const scale = clamp(nextScale, ZOOM_MIN, ZOOM_MAX);
  const centerX = element.clientWidth / 2;
  const centerY = element.clientHeight / 2;
  const ratio = scale / view.scale;
  setView({
    scale,
    x: centerX - (centerX - view.x) * ratio,
    y: centerY - (centerY - view.y) * ratio,
  });
}

type Frames = ReturnType<typeof layoutFrames>;
function CanvasFrames({
  frames,
  view,
  url,
  refreshKey,
  iframesRef,
  onPreviewLoaded,
}: {
  readonly frames: Frames;
  readonly view: ViewState;
  readonly url: string;
  readonly refreshKey: string | number;
  readonly iframesRef: React.MutableRefObject<FrameElements>;
  readonly onPreviewLoaded?: () => void;
}) {
  const translate = useTranslate();
  return (
    <div className="canvas-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
      {frames.map((frame) => (
        <CanvasFrame key={frame.key} frame={frame} scale={view.scale}>
          <div className="canvas-frame-label" style={{ fontSize: 13 / view.scale, paddingBottom: 8 / view.scale }}>
            {translate('preview.canvas.frameLabel', { device: frame.label, width: frame.width })}
          </div>
          <PreviewFrame
            refreshKey={refreshKey}
            frameRef={(element) => {
              if (element) {
                iframesRef.current[frame.key] = element;
              } else {
                delete iframesRef.current[frame.key];
              }
            }}
            url={url}
            title={translate('preview.canvas.frameTitle', { device: frame.label })}
            onLoad={(event) => {
              event.currentTarget.contentWindow?.postMessage({ type: 'avb:set-vh', px: frame.viewportHeight }, new URL(url, window.location.href).origin);
              onPreviewLoaded?.();
            }}
          />
          <div className="canvas-frame-cover" />
        </CanvasFrame>
      ))}
    </div>
  );
}

// One breakpoint's frame on the canvas, with the canvas's own scrollbar beside it (CanvasScrollbar.tsx), as every sized
// frame has: the frame is told to hide its own bar, so the page gets the breakpoint's whole width here too. The frame
// grows to its page's height, so the bar shows only for a page taller than PAGE_HEIGHT_PX_MAX.
function CanvasFrame({ frame, scale, children }: { readonly frame: Frames[number]; readonly scale: number; readonly children: React.ReactNode }) {
  const frameRef = React.useRef<HTMLDivElement>(null);
  assert(frame.width > 0, 'CanvasFrame: a frame has a width');
  return (
    <div ref={frameRef} className="canvas-frame" style={{ left: frame.x, top: 0, width: frame.width, height: frame.height }}>
      {children}
      <CanvasScrollbar frameRef={frameRef} scale={scale} />
    </div>
  );
}

function CanvasControls({ view, onZoom, onFit }: { readonly view: ViewState; readonly onZoom: (scale: number) => void; readonly onFit: () => void }) {
  const translate = useTranslate();
  return (
    <div className="canvas-controls" onPointerDown={(event) => event.stopPropagation()}>
      <button title={translate('preview.canvas.zoomOut')} onClick={() => onZoom(view.scale / 1.25)}>
        −
      </button>
      <button className="pct" title={translate('preview.canvas.zoomReset')} onClick={() => onZoom(1)}>
        {Math.round(view.scale * 100)}%
      </button>
      <button title={translate('preview.canvas.zoomIn')} onClick={() => onZoom(view.scale * 1.25)}>
        +
      </button>
      <button title={translate('preview.canvas.fitAll')} onClick={onFit}>
        {translate('preview.canvas.fit')}
      </button>
    </div>
  );
}

// Browser Studio uses authenticated preview frames rather than Electron's preload.
function useStudioPatches(frames: React.MutableRefObject<FrameElements>, url: string): void {
  React.useEffect(() => {
    const origin = new URL(url, window.location.href).origin;
    const patch = (event?: Event) => {
      const message = event instanceof CustomEvent && event.detail === 'structure' ? { type: 'avb:patch-now', immediate: true } : { type: 'avb:patch-now' };
      for (const frame of Object.values(frames.current)) {
        frame?.contentWindow?.postMessage(message, origin);
      }
    };
    const receive = (event: MessageEvent<unknown>) => {
      if (event.origin !== origin || !Object.values(frames.current).some((frame) => frame?.contentWindow === event.source)) {
        return;
      }
      if (event.data && typeof event.data === 'object' && 'type' in event.data && event.data.type === 'studio:invalidate') {
        patch();
      }
    };
    window.addEventListener('studio:source-updated', patch);
    window.addEventListener('message', receive);
    return () => {
      window.removeEventListener('studio:source-updated', patch);
      window.removeEventListener('message', receive);
    };
  }, [frames, url]);
}

function useCanvasSource(url: string, frames: React.MutableRefObject<FrameElements>) {
  return usePreviewSource(url, (message) => {
    // Exactly the three breakpoint frames share this render source.
    for (const frame of Object.values(frames.current)) {
      frame?.contentWindow?.postMessage(message, new URL(url).origin);
    }
  });
}
