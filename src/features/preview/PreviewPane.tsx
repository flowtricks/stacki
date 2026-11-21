import { useCanvasText, type CanvasTextDocument } from './useCanvasText';
import type { PseudoLayer } from '../../../shared/page/pseudoPath';
import React, { useSyncExternalStore } from 'react';
import { canvasDragActive, subscribeCanvasDrag } from '../../editor/canvasDragSession';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { useCanvasInteraction } from './useCanvasInteraction';
import { usePreviewSource } from './usePreviewSource';
import { PreviewFrame } from './PreviewFrame';
import { useCanvasWidthRequest, usePreviewDimensions, usePreviewSizing, type CanvasWidthRequest, type PreviewDimensions } from './usePreviewSizing';
import { SizedFrame } from './SizedFrame';
import CanvasView from './CanvasView';
import type { DevDiagnosis } from './DevOffline';
import type { OverlayInfo, RectMap, SpacingHover } from './PreviewOverlays';
import type { PreviewCrumb, PreviewDevice } from './PreviewToolbar';
import { DevOffline } from './DevOffline';
import { PreviewOverlays } from './PreviewOverlays';
import { CanvasDropOverlay } from './CanvasDropOverlay';
import { PreviewToolbar } from './PreviewToolbar';
import type { ResolvedBreakpoint } from '../../../shared/properties/projectBreakpoints';
import { useProjectBreakpoints } from '../../ipc/useProjectBreakpoints';
import { usePreviewRuntime, type CanvasSelectInfo, type JudgeCanvasEvent, type PreviewRuntimeProps } from './previewRuntime';
import type { CanvasNoticeEvent } from './canvasClickRetry';
import type { PreviewReloadReason } from './previewMessages';
import './previewViewport.css';
import type { LiveValue } from '../../ui/liveValue';
import { GuideOverlay } from './GuideOverlay';
import { useColumnGuide, type ShownGuide } from './guideSettings';

export { deviceForWidth } from './PreviewToolbar';

interface PreviewPaneProps {
  /** The project's page routes: in interact mode a link to any other path on the site opens in the browser. */
  readonly pageRoutes?: readonly string[] | undefined;
  readonly textDocument?: CanvasTextDocument | undefined;
  readonly spacingHover?: SpacingHover | undefined;
  readonly devUrl?: string | undefined;
  readonly devStatus?: string;
  readonly coveredByBusyOverlay?: boolean;
  readonly devLog?: LiveValue<string> | undefined;
  readonly devDiag?: DevDiagnosis | undefined;
  readonly pathScope?: string;
  readonly route?: string | undefined;
  readonly refreshKey?: string | number;
  readonly crumbs?: readonly PreviewCrumb[];
  readonly onEditRoute: (route: string) => void;
  readonly onCrumb?: (id: string | undefined) => void;
  readonly onRefresh?: () => void;
  readonly onPreviewLoaded?: () => void;
  readonly onRestart?: () => void;
  readonly selPath?: string | undefined;
  readonly navigatorSelectionTick?: number;
  readonly navHoverPath?: string | undefined;
  /** The ::before or ::after row hovered in the navigator, of `navHoverPath`. */
  readonly navHoverPseudo?: PseudoLayer | undefined;
  /** The selection's ::before or ::after layer, when one is picked. */
  readonly selPseudo?: PseudoLayer | undefined;
  readonly overlayInfo?: (path: string) => OverlayInfo | undefined;
  readonly onSelectPath?: (path: string | undefined, info: CanvasSelectInfo) => void;
  readonly onContextPath?: NonNullable<PreviewRuntimeProps['onContextPath']>;
  readonly onOpenPath?: (path: string | undefined, occurrence: number) => void;
  readonly onEditImage?: PreviewRuntimeProps['onEditImage'];
  readonly onCloseImage?: PreviewRuntimeProps['onCloseImage'];
  readonly judgeEvent: JudgeCanvasEvent;
  /** A click the canvas could not recover by itself, or its recovery (canvasClickRetry.ts). */
  readonly onCanvasNotice: (event: CanvasNoticeEvent) => void;
  readonly onPreviewReload?: (reason: PreviewReloadReason) => void;
  readonly onSelectedClasses?: (classes: readonly string[]) => void;
  readonly onRenderedPaths?: (paths: readonly string[]) => void;
  readonly onNodeStates?: (states: {
    readonly hidden: readonly string[];
    readonly inert: readonly string[];
    readonly before: readonly string[];
    readonly after: readonly string[];
  }) => void;
  readonly onNodeClasses?: (classes: Readonly<Record<string, readonly string[]>>) => void;
  readonly focusPath?: string | undefined;
  readonly focusOcc?: number | undefined;
  /** The copy of a repeated component the user opened, for the selection to outline alone (previewRuntime.ts). */
  readonly openedOcc?: number | undefined;
  readonly focusWhole?: boolean;
  readonly device: PreviewDevice;
  readonly onDevice: (device: PreviewDevice) => void;
  /** The custom width and height, when the host holds them: Desktop's preview mode draws the
   *  page at the same size (AppShell PreviewModeView), so a resize in either mode is kept by
   *  the other. A host without a preview mode leaves them to the pane. */
  readonly dimensions?: PreviewDimensions | undefined;
  /** A width asked of the canvas from outside (the style panel's media query
   *  pick), applied as a typed width is: a `custom` device at that width. */
  readonly canvasWidthRequest?: CanvasWidthRequest | undefined;
  /** Told the width the canvas is drawn at, in CSS pixels, whenever it changes (undefined: no canvas, or not measured yet). */
  readonly onViewportWidth?: ((widthPx: number | undefined) => void) | undefined;
  /** The open project: the column guide's settings are kept per project. */
  readonly projectPath?: string | undefined;
  /** More paths for the canvas to measure (the elements app overlays anchor to). */
  readonly extraTrackPaths?: readonly string[] | undefined;
  /** A drag on the canvas, or one crossing into it (src/app/state/appCanvasDrag.ts decides the drop). */
  readonly onCanvasDrag?: PreviewRuntimeProps['onCanvasDrag'];
  /** Draws over the canvas, above the outlines, from the same measurements (Stacki Apps' overlays). */
  readonly overlayLayer?: ((frame: { readonly rects: RectMap; readonly scale: number }) => React.ReactNode) | undefined;
}

export default function PreviewPane(props: PreviewPaneProps) {
  const url = props.devUrl && props.route ? props.devUrl + props.route : undefined;
  const runtime = usePreviewRuntime({ ...props, selPath: props.selPath }, url);
  useCanvasText({ document: props.textDocument, frame: runtime.iframeRef, url, ...runtime });
  const interaction = useCanvasInteraction({
    projectKey: props.projectPath,
    url,
    available: props.device !== 'canvas',
    frame: runtime.iframeRef,
    post: runtime.post,
    subscribeLoad: runtime.subscribeLoad,
    editRoute: props.onEditRoute,
    // The dev server serves every page at the site root.
    pages: props.pageRoutes === undefined ? undefined : { base: '', routes: props.pageRoutes },
  });
  const source = usePreviewSource(url, runtime.post);
  const ownDimensions = usePreviewDimensions();
  const dimensions = props.dimensions ?? ownDimensions;
  const { resolved: breakpoints, desktopFramePx } = useProjectBreakpoints(props.projectPath);
  const sizing = usePreviewSizing(props.device, dimensions, breakpoints, { deviceShortcuts: true, desktopFramePx }, props.onDevice);
  useCanvasWidthRequest(props.canvasWidthRequest, dimensions.setCustomWidth);
  // A fluid canvas is 1px wide until its container is measured: that is not a width to follow.
  const measured = props.device !== 'canvas' && (sizing.width !== undefined || sizing.wrapWidth > 0);
  useReportedWidth(measured ? sizing.viewport.width : undefined, props.onViewportWidth);
  const columnGuide = useColumnGuide({
    projectKey: props.projectPath,
    metrics: runtime.guide,
    available: props.device !== 'canvas',
    frame: runtime,
  });
  return (
    <>
      <PreviewToolbar
        breakpoints={breakpoints}
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
        interaction={interaction}
      />
      {/* `dir="ltr"`: the person's own site and the overlays drawn over it never mirror when Stacki is in Arabic or Hebrew. */}
      <div className="preview-frame-wrap" dir="ltr" data-canvas-interactive={interaction.active} ref={sizing.wrapRef}>
        <PreviewContent
          props={props}
          url={props.device === 'canvas' ? url : source.url}
          runtime={{
            ...runtime,
            registerFrame: () => {
              runtime.registerFrame();
              if (!interaction.active) {
                source.loaded();
              }
            },
          }}
          sizing={sizing}
          breakpoints={breakpoints}
          desktopFramePx={desktopFramePx}
          shownGuide={columnGuide.shown}
        />
      </div>
    </>
  );
}

// Apply each new width request once, as the width field would.
type Runtime = ReturnType<typeof usePreviewRuntime>;
type Sizing = ReturnType<typeof usePreviewSizing>;

function PreviewContent({
  props,
  url,
  runtime,
  sizing,
  shownGuide,
  breakpoints,
  desktopFramePx,
}: {
  readonly breakpoints: readonly ResolvedBreakpoint[];
  /** The width of the Desktop frame in the side-by-side view. */
  readonly desktopFramePx: number;
  readonly props: PreviewPaneProps;
  readonly url: string | undefined;
  readonly runtime: Runtime;
  readonly sizing: Sizing;
  readonly shownGuide: ShownGuide | undefined;
}) {
  if (props.devStatus === 'off' || props.devStatus === 'starting') {
    return <PreviewPlaceholder props={props} />;
  }
  if (url && props.device === 'canvas') {
    return (
      <CanvasView
        breakpoints={breakpoints}
        desktopFramePx={desktopFramePx}
        url={url}
        refreshKey={props.refreshKey ?? 0}
        {...(props.onPreviewLoaded === undefined ? {} : { onPreviewLoaded: props.onPreviewLoaded })}
      />
    );
  }
  if (url) {
    return <DesignPreview props={props} url={url} runtime={runtime} sizing={sizing} shownGuide={shownGuide} />;
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
  const translate = useTranslate();
  const width = sizing.width;
  const scale = sizing.viewport.scale;
  // While a drag is over the canvas the drop's own outline names the target: a hover outline beside it was a second,
  // different name jumping from element to element under the pointer.
  const dragging = useSyncExternalStore(subscribeCanvasDrag, canvasDragActive);
  return (
    <>
      <SizedFrame sizing={sizing}>
        <PreviewFrame
          refreshKey={props.refreshKey ?? ''}
          frameRef={runtime.iframeRef}
          url={url}
          title={translate('preview.pane.title')}
          onLoad={() => {
            runtime.registerFrame();
            runtime.sendTrack();
            props.onPreviewLoaded?.();
          }}
        />
      </SizedFrame>
      <div
        className={`preview-overlay-layer ${width && sizing.fit === 'framed' ? '' : 'full'}`}
        style={
          width
            ? { width: sizing.viewport.width * scale, height: sizing.viewport.height * scale, borderRadius: sizing.fit === 'framed' ? 10 * scale : 0 }
            : { width: '100%', height: '100%', borderRadius: 0 }
        }
      >
        {/* First in the layer, so the outlines and spacing bands paint over it. */}
        {shownGuide && <GuideOverlay {...shownGuide} scale={scale} />}
        <PreviewOverlays
          {...measuredOutlines(runtime)}
          {...(dragging ? { hoverPath: undefined } : {})}
          scale={scale}
          viewport={{ w: sizing.viewport.width, h: sizing.viewport.height }}
          {...(props.spacingHover === undefined ? {} : { spacingHover: props.spacingHover })}
          selPath={runtime.pendingSelection?.path ?? props.selPath}
          selPseudo={runtime.pendingSelection === undefined ? props.selPseudo : runtime.pendingSelection.pseudo}
          hoverPseudo={runtime.hoverPseudo}
          focusPath={props.focusPath}
          focusWhole={props.focusWhole ?? false}
          {...(props.overlayInfo === undefined ? {} : { overlayInfo: props.overlayInfo })}
          onOpenComponent={props.onOpenPath}
          pathScope={props.pathScope ?? ''}
        />
        <CanvasDropOverlay scale={scale} overlayInfo={props.overlayInfo} />
        {props.overlayLayer?.({ rects: runtime.rects, scale })}
      </div>
    </>
  );
}

// What the frame measured and reports, as the outlines draw it.
function measuredOutlines(runtime: Runtime) {
  return {
    rects: runtime.rects,
    spacing: runtime.spacing,
    // A click being judged is drawn as the selection already (previewRuntime.ts PendingSelection).
    selOcc: runtime.pendingSelection === undefined ? runtime.selOcc : runtime.pendingSelection.occurrence,
    hoverPath: runtime.hoverPath,
    hoverOcc: runtime.hoverOcc,
    textMarks: runtime.textMarks,
  };
}

function PreviewPlaceholder({ props }: { readonly props: PreviewPaneProps }) {
  const translate = useTranslate();
  // The app overlay owns progress while visible; another status would show through it.
  if (props.coveredByBusyOverlay) {
    return undefined;
  }
  return (
    <div className="preview-placeholder">
      {props.devStatus === 'starting' ? (
        <>
          <div className="spinner" />
          <div>{translate('preview.pane.starting')}</div>
        </>
      ) : props.devStatus === 'on' ? (
        <div className="offline-title">{translate('preview.pane.empty')}</div>
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

// Tells the host the canvas width when it changes, and that there is none once the pane goes.
// The callback is read through a ref, so a host that passes a new function each render
// reports nothing extra.
function useReportedWidth(widthPx: number | undefined, report: ((widthPx: number | undefined) => void) | undefined): void {
  const reportRef = React.useRef(report);
  reportRef.current = report;
  React.useEffect(() => {
    reportRef.current?.(widthPx);
  }, [widthPx]);
  React.useEffect(() => () => reportRef.current?.(undefined), []);
}
