import React from 'react';
import { usePreviewSource } from './usePreviewSource';
import { PreviewFrame } from './PreviewFrame';
import { parsePreviewMessage } from './previewMessages';
import { usePointerDrag } from '../../ui/usePointerDrag';

const BREAKPOINTS = [
  { key: 'desktop', label: 'Desktop', width: 1_440, viewportHeight: 900 },
  { key: 'tablet', label: 'Tablet', width: 768, viewportHeight: 1_024 },
  { key: 'phone', label: 'Phone', width: 375, viewportHeight: 812 },
] as const;
const GAP_PX = 120;
const PAGE_HEIGHT_PX_MAX = 30_000;
const PAGE_HEIGHT_PX_MIN = 200;
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 4;
type BreakpointKey = (typeof BREAKPOINTS)[number]['key'];
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
  readonly url: string;
  readonly refreshKey: string | number;
  readonly onPreviewLoaded?: () => void;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export default function CanvasView({
  url: renderURL,
  refreshKey,
  onPreviewLoaded,
}: CanvasViewProps) {
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
  const frames = React.useMemo(() => layoutFrames(heights), [heights]);
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
  useFrameHeights(iframesRef, setHeights);
  useStudioPatches(iframesRef, url);
  const fit = useFitCanvas(wrapRef, worldRef, setView);
  useCanvasFit(wrapRef, userMovedRef, world.width, world.height, fit);
  React.useEffect(() => setHeights({}), [refreshKey, url]);
  useCanvasWheel(wrapRef, viewRef, userMovedRef, setView);
  const onPointerDown = useCanvasPointer(startDrag, viewRef, userMovedRef, setView, setPanning);
  const zoomTo = (scale: number): void =>
    zoomCanvas(wrapRef.current ?? undefined, viewRef.current, scale, userMovedRef, setView);
  return (
    <div
      ref={wrapRef}
      className={`canvas-view ${panning ? 'panning' : ''}`}
      onPointerDown={onPointerDown}
    >
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
    userMovedRef.current = true;
    setPanning(true);
    const { clientX, clientY } = event;
    startDrag(event, {
      onMove: (next) =>
        setView({
          ...start,
          x: start.x + next.clientX - clientX,
          y: start.y + next.clientY - clientY,
        }),
      onEnd: () => setPanning(false),
    });
  };
}

function layoutFrames(heights: FrameHeights) {
  let x = 0;
  return BREAKPOINTS.map((breakpoint) => {
    // The frame freezes viewport units to viewportHeight before growing. Its
    // visible height can therefore follow the full page without enlarging heroes.
    const height = clamp(
      heights[breakpoint.key] ?? breakpoint.viewportHeight,
      PAGE_HEIGHT_PX_MIN,
      PAGE_HEIGHT_PX_MAX,
    );
    const frame = { ...breakpoint, x, height };
    x += breakpoint.width + GAP_PX;
    return frame;
  });
}

function useFrameHeights(
  iframesRef: React.MutableRefObject<FrameElements>,
  setHeights: React.Dispatch<React.SetStateAction<FrameHeights>>,
): void {
  React.useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>): void => {
      const match = Object.entries(iframesRef.current).find(
        ([, iframe]) => iframe?.contentWindow === event.source,
      );
      const key = match?.[0];
      if (!isBreakpointKey(key)) {
        return;
      }
      if (isFrameReady(event.data)) {
        const breakpoint = BREAKPOINTS.find((entry) => entry.key === key);
        const iframe = iframesRef.current[key];
        if (breakpoint && iframe) {
          // Ready precedes window.load when images are slow. Freeze before the
          // first height report can stretch an unfrozen viewport-sized section.
          iframe.contentWindow?.postMessage(
            { type: 'avb:set-vh', px: breakpoint.viewportHeight },
            new URL(iframe.src).origin,
          );
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
  }, [iframesRef, setHeights]);
}

function isFrameReady(input: unknown): boolean {
  if (parsePreviewMessage(input)?.kind === 'canvas-ready') {
    return true;
  }
  // Studio canvas copies do not install the editable selection tracker, so
  // their preview client announces document readiness independently.
  return (
    typeof input === 'object' &&
    input !== null &&
    'type' in input &&
    input.type === 'studio:preview-ready'
  );
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

function isBreakpointKey(value: string | undefined): value is BreakpointKey {
  return BREAKPOINTS.some((breakpoint) => breakpoint.key === value);
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
    const scale = clamp(
      Math.min(
        (element.clientWidth - paddingPx * 2) / width,
        (element.clientHeight - paddingPx * 2) / height,
      ),
      ZOOM_MIN,
      1,
    );
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
    const observer = new ResizeObserver(() => {
      if (!userMovedRef.current) {
        fit();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
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
      setView((view) =>
        wheelView(view, event, event.clientX - bounds.left, event.clientY - bounds.top),
      );
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
  const scale = clamp(view.scale * Math.exp(-event.deltaY * 0.01), ZOOM_MIN, ZOOM_MAX);
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
  return (
    <div
      className="canvas-world"
      style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
    >
      {frames.map((frame) => (
        <div
          key={frame.key}
          className="canvas-frame"
          style={{ left: frame.x, top: 0, width: frame.width, height: frame.height }}
        >
          <div
            className="canvas-frame-label"
            style={{ fontSize: 13 / view.scale, paddingBottom: 8 / view.scale }}
          >
            {frame.label} · {frame.width}px
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
            title={`${frame.label} preview`}
            onLoad={(event) => {
              event.currentTarget.contentWindow?.postMessage(
                { type: 'avb:set-vh', px: frame.viewportHeight },
                new URL(url, window.location.href).origin,
              );
              onPreviewLoaded?.();
            }}
          />
          <div className="canvas-frame-cover" />
        </div>
      ))}
    </div>
  );
}

function CanvasControls({
  view,
  onZoom,
  onFit,
}: {
  readonly view: ViewState;
  readonly onZoom: (scale: number) => void;
  readonly onFit: () => void;
}) {
  return (
    <div className="canvas-controls" onPointerDown={(event) => event.stopPropagation()}>
      <button title="Zoom out" onClick={() => onZoom(view.scale / 1.25)}>
        −
      </button>
      <button className="pct" title="Zoom to 100%" onClick={() => onZoom(1)}>
        {Math.round(view.scale * 100)}%
      </button>
      <button title="Zoom in" onClick={() => onZoom(view.scale * 1.25)}>
        +
      </button>
      <button title="Fit all breakpoints" onClick={onFit}>
        Fit
      </button>
    </div>
  );
}

// Browser Studio uses authenticated preview frames rather than Electron's preload.
function useStudioPatches(frames: React.MutableRefObject<FrameElements>, url: string): void {
  React.useEffect(() => {
    const origin = new URL(url, window.location.href).origin;
    const patch = (event?: Event) => {
      const message =
        event instanceof CustomEvent && event.detail === 'structure'
          ? { type: 'avb:patch-now', immediate: true }
          : { type: 'avb:patch-now' };
      for (const frame of Object.values(frames.current)) {
        frame?.contentWindow?.postMessage(message, origin);
      }
    };
    const receive = (event: MessageEvent<unknown>) => {
      if (
        event.origin !== origin ||
        !Object.values(frames.current).some((frame) => frame?.contentWindow === event.source)
      ) {
        return;
      }
      if (
        event.data &&
        typeof event.data === 'object' &&
        'type' in event.data &&
        event.data.type === 'studio:invalidate'
      ) {
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
