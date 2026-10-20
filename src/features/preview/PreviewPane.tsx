import React from 'react';
import { usePreviewSource } from './usePreviewSource';
import { usePreviewDimensions, usePreviewSizing } from './usePreviewSizing';
import CanvasView from './CanvasView';
import type { DevDiagnosis } from './DevOffline';
import type { OverlayInfo, PinOverlay, SpacingHover } from './PreviewOverlays';
import type { PreviewCrumb, PreviewDevice } from './PreviewToolbar';
import { DevOffline } from './DevOffline';
import { PreviewOverlays } from './PreviewOverlays';
import { PreviewToolbar } from './PreviewToolbar';
import {
  usePreviewRuntime,
  type JudgeCanvasEvent,
  type PreviewRuntimeProps,
} from './previewRuntime';
import type { PreviewVerdict } from '../../../shared/page/previewToken';
import type { PreviewReloadReason } from './previewMessages';
import './previewViewport.css';
import type { LiveValue } from '../../ui/liveValue';
import { GuideOverlay } from './GuideOverlay';
import { useColumnGuide, type ShownGuide } from './guideSettings';

export { deviceForWidth } from './PreviewToolbar';

interface PreviewPaneProps {
  readonly spacingHover?: SpacingHover | undefined;
  readonly devUrl?: string | undefined;
  readonly devStatus?: string;
  readonly devLog?: LiveValue<string> | undefined;
  readonly devDiag?: DevDiagnosis | undefined;
  readonly pathScope?: string;
  readonly route?: string | undefined;
  readonly refreshKey?: string | number;
  readonly crumbs?: readonly PreviewCrumb[];
  readonly onCrumb?: (id: string | undefined) => void;
  readonly onRefresh?: () => void;
  readonly onPreviewLoaded?: () => void;
  readonly onRestart?: () => void;
  readonly selPath?: string | undefined;
  readonly navigatorSelectionTick?: number;
  readonly navHoverPath?: string | undefined;
  readonly overlayInfo?: (path: string) => OverlayInfo | undefined;
  readonly pins?: readonly PinOverlay[];
  readonly onSelectPin?: (pin: PinOverlay) => void;
  readonly onSelectPath?: (path: string | undefined, info: { readonly outside: boolean }) => void;
  readonly onContextPath?: NonNullable<PreviewRuntimeProps['onContextPath']>;
  readonly onOpenPath?: (path: string | undefined, occurrence: number) => void;
  readonly judgeEvent: JudgeCanvasEvent;
  readonly onStaleEvent: (verdict: Extract<PreviewVerdict, { readonly tag: 'stale' }>) => void;
  readonly onPreviewReload?: (reason: PreviewReloadReason) => void;
  readonly onSelectedClasses?: (classes: readonly string[]) => void;
  readonly onRenderedPaths?: (paths: readonly string[]) => void;
  readonly onNodeStates?: (states: {
    readonly hidden: readonly string[];
    readonly inert: readonly string[];
  }) => void;
  readonly onNodeClasses?: (classes: Readonly<Record<string, readonly string[]>>) => void;
  readonly focusPath?: string | undefined;
  readonly focusOcc?: number | undefined;
  readonly focusWhole?: boolean;
  readonly device: PreviewDevice;
  readonly onDevice: (device: PreviewDevice) => void;
  /** The open project: the column guide's settings are kept per project. */
  readonly projectPath?: string | undefined;
}

export default function PreviewPane(props: PreviewPaneProps) {
  const url = props.devUrl && props.route ? props.devUrl + props.route : undefined;
  const runtime = usePreviewRuntime({ ...props, selPath: props.selPath }, url);
  const source = usePreviewSource(url, runtime.post);
  const dimensions = usePreviewDimensions();
  const sizing = usePreviewSizing(props.device, dimensions, props.onDevice);
  const columnGuide = useColumnGuide({
    projectKey: props.projectPath,
    metrics: runtime.guide,
    available: props.device !== 'canvas',
    frame: runtime,
  });
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
        guide={columnGuide.menu}
      />
      <div className="preview-frame-wrap" ref={sizing.wrapRef}>
        <PreviewContent
          props={props}
          url={props.device === 'canvas' ? url : source.url}
          runtime={{
            ...runtime,
            registerFrame: () => {
              runtime.registerFrame();
              source.loaded();
            },
          }}
          sizing={sizing}
          shownGuide={columnGuide.shown}
        />
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
  shownGuide,
}: {
  readonly props: PreviewPaneProps;
  readonly url: string | undefined;
  readonly runtime: Runtime;
  readonly sizing: Sizing;
  readonly shownGuide: ShownGuide | undefined;
}) {
  if (url && props.device === 'canvas') {
    return (
      <CanvasView
        url={url}
        refreshKey={props.refreshKey ?? 0}
        {...(props.onPreviewLoaded === undefined ? {} : { onPreviewLoaded: props.onPreviewLoaded })}
      />
    );
  }
  if (url) {
    return (
      <DesignPreview
        props={props}
        url={url}
        runtime={runtime}
        sizing={sizing}
        shownGuide={shownGuide}
      />
    );
  }
  return <PreviewPlaceholder props={props} />;
}

function DesignPreview({
  props,
  url,
  runtime,
  sizing,
  shownGuide,
}: {
  readonly props: PreviewPaneProps;
  readonly url: string;
  readonly runtime: Runtime;
  readonly sizing: Sizing;
  readonly shownGuide: ShownGuide | undefined;
}) {
  const width = sizing.width;
  const scale = sizing.viewport.scale;
  return (
    <>
      <div
        ref={sizing.frameRef}
        className={`frame-sized ${width ? '' : 'full'} ${sizing.resizing ? 'resizing' : ''}`}
        style={{
          width: sizing.viewport.width,
          height: sizing.viewport.height,
          bottom: 'auto',
          transform: `translateX(-50%) scale(${scale})`,
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
              props.onPreviewLoaded?.();
            }}
          />
        </div>
        <ResizeHandles sizing={sizing} />
      </div>
      <OverlayLayer props={props} runtime={runtime} sizing={sizing} shownGuide={shownGuide} />
    </>
  );
}

// The outlines, spacing bands, guide and pins, in screen coordinates over the scaled frame.
function OverlayLayer({
  props,
  runtime,
  sizing,
  shownGuide,
}: {
  readonly props: PreviewPaneProps;
  readonly runtime: Runtime;
  readonly sizing: Sizing;
  readonly shownGuide: ShownGuide | undefined;
}) {
  const width = sizing.width;
  const scale = sizing.viewport.scale;
  return (
    <div
      className={`preview-overlay-layer ${width ? '' : 'full'}`}
      style={{
        width: sizing.viewport.width * scale,
        height: sizing.viewport.height * scale,
        borderRadius: width ? 10 * scale : 0,
      }}
    >
      {/* First in the layer, so the outlines and spacing bands paint over it. */}
      {shownGuide && <GuideOverlay {...shownGuide} scale={scale} />}
      <PreviewOverlays
        rects={runtime.rects}
        spacing={runtime.spacing}
        scale={scale}
        {...(props.spacingHover === undefined ? {} : { spacingHover: props.spacingHover })}
        selPath={props.selPath}
        selOcc={runtime.selOcc}
        hoverPath={runtime.hoverPath}
        hoverOcc={runtime.hoverOcc}
        focusPath={props.focusPath}
        focusWhole={props.focusWhole ?? false}
        {...(props.overlayInfo === undefined ? {} : { overlayInfo: props.overlayInfo })}
        pins={props.pins}
        onSelectPin={props.onSelectPin}
      />
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
