import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePointerDrag } from '../ui/usePointerDrag';
import CanvasView from './CanvasView';
import type { DevDiagnosis } from './DevOffline';
import type { OverlayInfo, SpacingHover } from './PreviewOverlays';
import type { PreviewCrumb, PreviewDevice } from './PreviewToolbar';
import { DevOffline } from './DevOffline';
import { PreviewOverlays } from './PreviewOverlays';
import { PreviewToolbar, deviceForWidth, deviceWidth } from './PreviewToolbar';
import { usePreviewRuntime } from './previewRuntime';
import { PREVIEW_WIDTH_LIMITS, previewViewport } from './previewViewport';
import './previewViewport.css';

export { deviceForWidth } from './PreviewToolbar';

interface PreviewPaneProps {
  readonly spacingHover?: SpacingHover | null;
  readonly devUrl?: string | null;
  readonly devStatus?: string;
  readonly devLog?: string | null;
  readonly devDiag?: DevDiagnosis | null;
  readonly pathScope?: string;
  readonly route?: string | null;
  readonly refreshKey?: string | number;
  readonly crumbs?: readonly PreviewCrumb[];
  readonly onCrumb?: (id: string | null) => void;
  readonly onRefresh?: () => void;
  readonly onRestart?: () => void;
  readonly selPath?: string | null;
  readonly navHoverPath?: string | null;
  readonly overlayInfo?: (path: string) => OverlayInfo | null;
  readonly onSelectPath?: (path: string | null, info: { readonly outside: boolean }) => void;
  readonly onOpenPath?: (path: string | null, occurrence: number) => void;
  readonly onSelectedClasses?: (classes: readonly string[]) => void;
  readonly onRenderedPaths?: (paths: readonly string[]) => void;
  readonly onNodeStates?: (states: {
    readonly hidden: readonly string[];
    readonly inert: readonly string[];
  }) => void;
  readonly onNodeClasses?: (classes: Readonly<Record<string, readonly string[]>>) => void;
  readonly focusPath?: string | null;
  readonly focusOcc?: number | null;
  readonly focusWhole?: boolean;
  readonly device: PreviewDevice;
  readonly onDevice: (device: PreviewDevice) => void;
}

export default function PreviewPane(props: PreviewPaneProps) {
  const url = props.devUrl && props.route ? props.devUrl + props.route : null;
  const runtime = usePreviewRuntime(
    {
      ...props,
      selPath: props.selPath ?? null,
    },
    url,
  );
  const sizing = usePreviewSizing(props.device, props.onDevice);
  return (
    <>
      <PreviewToolbar
        crumbs={props.crumbs ?? []}
        {...(props.onCrumb === undefined ? {} : { onCrumb: props.onCrumb })}
        activeDevice={sizing.activeDevice}
        onDevice={props.onDevice}
        {...(props.device === 'canvas'
          ? {}
          : {
              sizing: {
                width: sizing.viewport.width,
                scale: sizing.viewport.scale,
                onWidth: sizing.setWidth,
                onFit: () => props.onDevice('desktop'),
              },
            })}
      />
      <div className="preview-frame-wrap" ref={sizing.wrapRef}>
        <PreviewContent props={props} url={url} runtime={runtime} sizing={sizing} />
      </div>
    </>
  );
}

type Runtime = ReturnType<typeof usePreviewRuntime>;
type Sizing = ReturnType<typeof usePreviewSizing>;

function PreviewContent({
  props,
  url,
  runtime,
  sizing,
}: {
  readonly props: PreviewPaneProps;
  readonly url: string | null;
  readonly runtime: Runtime;
  readonly sizing: Sizing;
}) {
  if (url && props.device === 'canvas') {
    return <CanvasView url={url} refreshKey={props.refreshKey ?? 0} />;
  }
  if (url) {
    return <DesignPreview props={props} url={url} runtime={runtime} sizing={sizing} />;
  }
  return <PreviewPlaceholder props={props} />;
}

function DesignPreview({
  props,
  url,
  runtime,
  sizing,
}: {
  readonly props: PreviewPaneProps;
  readonly url: string;
  readonly runtime: Runtime;
  readonly sizing: Sizing;
}) {
  const width = sizing.width;
  return (
    <div
      ref={sizing.frameRef}
      className={`frame-sized ${width ? '' : 'full'} ${sizing.resizing ? 'resizing' : ''}`}
      style={{
        width: sizing.viewport.width,
        height: sizing.viewport.height,
        bottom: 'auto',
        transform: `translateX(-50%) scale(${sizing.viewport.scale})`,
      }}
    >
      <div className="frame-clip">
        <iframe
          key={`${url}-${props.refreshKey ?? ''}`}
          ref={runtime.iframeRef}
          src={`${url}#avb-design`}
          title="Site preview"
          onLoad={() => {
            runtime.registerFrame();
            runtime.sendTrack();
          }}
        />
        <PreviewOverlays
          rects={runtime.rects}
          spacing={runtime.spacing}
          {...(props.spacingHover === undefined ? {} : { spacingHover: props.spacingHover })}
          selPath={props.selPath ?? null}
          selOcc={runtime.selOcc}
          hoverPath={runtime.hoverPath}
          hoverOcc={runtime.hoverOcc}
          focusPath={props.focusPath ?? null}
          focusWhole={props.focusWhole ?? false}
          {...(props.overlayInfo === undefined ? {} : { overlayInfo: props.overlayInfo })}
        />
      </div>
      <ResizeHandles sizing={sizing} />
    </div>
  );
}

function ResizeHandles({ sizing }: { readonly sizing: Sizing }) {
  return (
    <>
      <div className="rz-handle rz-w" onPointerDown={sizing.startResize('w')} />
      <div className="rz-handle rz-e" onPointerDown={sizing.startResize('e')} />
      <div className="rz-handle rz-s" onPointerDown={sizing.startResize('s')} />
      {sizing.resizing && (
        <div className="rz-readout">
          {Math.round(sizing.width ?? sizing.wrapWidth ?? 0)} ×{' '}
          {sizing.customHeight ?? sizing.frameRef.current?.offsetHeight ?? ''}
        </div>
      )}
    </>
  );
}

function PreviewPlaceholder({ props }: { readonly props: PreviewPaneProps }) {
  return (
    <div className="preview-placeholder">
      {props.devStatus === 'starting' ? (
        <>
          <div className="spinner" />
          <div>Starting Astro dev server…</div>
        </>
      ) : props.devStatus === 'on' ? (
        <div className="offline-title">Nothing selected to preview. Pick a page on the left.</div>
      ) : (
        <DevOffline
          {...(props.devLog === undefined ? {} : { devLog: props.devLog })}
          {...(props.devDiag === undefined ? {} : { devDiag: props.devDiag })}
          {...(props.onRestart === undefined ? {} : { onRestart: props.onRestart })}
        />
      )}
    </div>
  );
}

function usePreviewSizing(device: PreviewDevice, onDevice: (device: PreviewDevice) => void) {
  const startDrag = usePointerDrag();
  const wrapRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState({ width: 0, height: 0 });
  const [customWidth, setCustomWidth] = useState<number | null>(null);
  const [customHeight, setCustomHeight] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);
  useMeasuredSize(wrapRef, setAvailable);
  useDeviceShortcuts(onDevice);
  useEffect(() => {
    if (device !== 'custom') {
      setCustomWidth(null);
    }
    if (device === 'desktop' || device === 'canvas') {
      setCustomHeight(null);
    }
  }, [device]);
  const width = customWidth ?? deviceWidth(device);
  const viewport = previewViewport(width, available, customHeight);
  const activeDevice = device === 'canvas' ? 'canvas' : deviceForWidth(viewport.width) ?? device;
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
  });
  return {
    wrapRef,
    frameRef,
    wrapWidth: available.width,
    viewport,
    setWidth,
    customHeight,
    resizing,
    width,
    activeDevice,
    startResize,
  };
}

function useMeasuredSize(
  ref: React.RefObject<HTMLDivElement>,
  setSize: React.Dispatch<React.SetStateAction<{ width: number; height: number }>>,
): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const measure = (): void =>
      setSize({ width: element.clientWidth, height: element.clientHeight });
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
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) {
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

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.matches('input, textarea, select') || target.isContentEditable)
  );
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
  readonly setCustomWidth: React.Dispatch<React.SetStateAction<number | null>>;
  readonly setCustomHeight: React.Dispatch<React.SetStateAction<number | null>>;
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
