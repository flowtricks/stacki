import { useTranslate } from '../../../vendor/stacki/src/lib/i18n/useTranslate';
import { useFrameAddress } from './frameAddress';
import type { CanvasSitePages } from '../../../vendor/stacki/shared/properties/canvasInteraction';
import { useCanvasText } from '../../../vendor/stacki/src/features/preview/useCanvasText';
import { studioCanvasText } from './studioCanvasText';
import { CanvasTextFormatBar } from '../../../vendor/stacki/src/app/shell/CanvasTextFormatBar';
import { CanvasTextSourceCue } from '../../../vendor/stacki/src/app/shell/CanvasTextSourceCue';
import { useCanvasInteraction } from '../../../vendor/stacki/src/features/preview/useCanvasInteraction';
import './previewToolbar.css';
import { PreviewLoading, usePreviewLoading } from './PreviewLoading';
import { useStartupView } from '../startup/useStartupView';
import { CollaboratorOutlines } from '../collaboration/CollaboratorOutlines';
import { useCursorChatShortcut, useCursorScale } from '../collaboration/cursorChat';
import type { Peer } from '../collaboration/presence';
import { spacingHover } from './spacingHover';
import { useLiveValue } from '../../../vendor/stacki/src/ui/liveValue';
import { PreviewOverlays } from '../../../vendor/stacki/src/features/preview/PreviewOverlays';
import { StudioAppOverlays } from '../apps/StudioApps';
import { GuideOverlay } from '../../../vendor/stacki/src/features/preview/GuideOverlay';
import { studioGuideSubject, useColumnGuide, type ShownGuide } from '../../../vendor/stacki/src/features/preview/guideSettings';
import { outlineInfo, outlineNode } from './outlineInfo';
import { useMemo, useRef, type CSSProperties } from 'react';
import { PreviewToolbar, type PreviewDevice, type PreviewInspectorActions } from '../../../vendor/stacki/src/features/preview/PreviewToolbar';
import CanvasView from '../../../vendor/stacki/src/features/preview/CanvasView';
import { useProjectBreakpoints } from '../../../vendor/stacki/src/ipc/useProjectBreakpoints';
import { usePreviewSizing } from '../../../vendor/stacki/src/features/preview/usePreviewSizing';
import type { usePreviewDimensions } from '../../../vendor/stacki/src/features/preview/usePreviewSizing';
import '../../../vendor/stacki/src/features/preview/previewViewport.css';
import { SizedFrame } from '../../../vendor/stacki/src/features/preview/SizedFrame';
import { CollectionEditor } from '../collections/CollectionEditor';
import type { SharedDocument } from '../collaboration/useDocument';
import { nodeId, type ParserNode } from '../source/source';
import type { usePreview } from './usePreview';
import type { Component } from '../project/projectClient';
interface Props {
  readonly focusPath?: string | undefined;
  readonly dimensions: ReturnType<typeof usePreviewDimensions>;
  readonly file: string;
  /** The folder name identifies this project's legacy local guide settings for migration. */
  readonly projectName: string;
  readonly pageLabel?: string | undefined;
  readonly editRoute: (route: string) => void;
  /** The project's pages: in interact mode a link to any other path on the site opens in a new tab. */
  readonly sitePages?: CanvasSitePages | undefined;
  readonly collaborators: readonly Peer[];
  readonly collection: boolean;
  readonly document: SharedDocument | undefined;
  readonly preview: ReturnType<typeof usePreview>;
  readonly selected: string;
  readonly select: (id: string) => void;
  readonly restoreSelection: () => void;
  readonly nodes: readonly ParserNode[];
  /** The project's components: text their props show is editable on the canvas. */
  readonly components: readonly Component[];
  readonly device: PreviewDevice;
  readonly onDevice: (device: PreviewDevice) => void;
  readonly inspector: PreviewInspectorActions | undefined;
  readonly openComponent?: ((name: string, id: string, occurrence: number) => void) | undefined;
}
export function PreviewCanvas(props: Props) {
  useStudioCanvasText(props);
  const interaction = useCanvasInteraction({
    projectKey: props.projectName,
    url: props.preview.url,
    available: props.device !== 'canvas' && !props.collection,
    frame: props.preview.frame,
    post: props.preview.send,
    subscribeLoad: props.preview.subscribeLoad,
    editRoute: props.editRoute,
    offSite: { clearOverlays: props.preview.clearOverlays },
    pages: props.sitePages,
  });
  const { resolved: breakpoints, desktopFramePx } = useProjectBreakpoints(props.projectName);
  const viewKey = `${props.projectName}\n${props.file}`;
  const sizing = usePreviewSizing(props.device, props.dimensions, breakpoints, { deviceShortcuts: true, desktopFramePx, viewKey }, props.onDevice);
  useCursorScale(props.preview, sizing.viewport.scale);
  useCursorChatShortcut({
    preview: props.preview,
    disabled: props.collection || props.device === 'canvas',
  });
  // This key locates legacy preferences; subsequent reads and saves use .stacki/guide.json.
  const columnGuide = useColumnGuide({
    projectKey: `${location.origin} ${props.projectName}`,
    metrics: props.preview.guide,
    available: props.device !== 'canvas' && !props.collection,
    frame: { post: props.preview.send, subscribeLoad: props.preview.subscribeLoad },
    subject: studioGuideSubject(props.file),
  });
  return (
    <main className="studio-center" data-canvas-interactive={interaction.active}>
      <div className="studio-preview-toolbar">
        <PreviewToolbar
          breakpoints={breakpoints}
          crumbs={[...(props.pageLabel ? [{ id: undefined, label: props.pageLabel }] : []), ...crumbsFor(props.nodes, props.selected)]}
          onCrumb={(id) => props.select(id ?? 'layout')}
          activeDevice={sizing.activeDevice}
          onDevice={sizing.pickDevice}
          {...(props.device === 'canvas'
            ? {}
            : {
                sizing: {
                  width: sizing.viewport.width,
                  scale: sizing.viewport.scale,
                  onWidth: sizing.setWidth,
                  onFit: () => sizing.pickDevice('desktop'),
                },
              })}
          guide={columnGuide.menu}
          interaction={interaction}
          inspector={props.collection ? undefined : props.inspector}
        />
      </div>
      {props.collection && props.document ? (
        <CollectionEditor document={props.document} />
      ) : (
        <PreviewSurface interactive={interaction.active} props={props} sizing={sizing} shownGuide={columnGuide.shown} />
      )}
      {/* Desktop's bar over words selected on the canvas; it portals to the body. */}
      <CanvasTextFormatBar />
      <CanvasTextSourceCue />
    </main>
  );
}
// Text editing on the canvas, with the text the selected instance's props and
// slot show marked and editable as on the page itself.
function useStudioCanvasText(props: Props) {
  const components = useSameComponents(props.components);
  const translate = useTranslate();
  useCanvasText({
    document: studioCanvasText(
      props.file,
      props.document,
      props.nodes,
      {
        components,
        selected: props.selected,
      },
      translate,
    ),
    frame: props.preview.frame,
    url: props.preview.url,
    post: props.preview.send,
    subscribeLoad: props.preview.subscribeLoad,
  });
}

// The project reloads whenever the window regains focus, as it does when the
// format bar's link field takes focus from the canvas, and each load is a new
// component list. A new list restarts the canvas text session, which closes
// the bar mid-link; so a list equal to the last one is the last one.
function useSameComponents(components: readonly Component[]): readonly Component[] {
  const last = useRef<{ readonly signature: string; readonly components: readonly Component[] }>();
  return useMemo(() => {
    const signature = JSON.stringify(components);
    if (last.current?.signature === signature) {
      return last.current.components;
    }
    last.current = { signature, components };
    return components;
  }, [components]);
}

function PreviewSurface({
  interactive,
  props,
  sizing,
  shownGuide,
}: {
  readonly props: Props;
  readonly sizing: ReturnType<typeof usePreviewSizing>;
  readonly shownGuide: ShownGuide | undefined;
  readonly interactive?: boolean;
}) {
  const loading = usePreviewLoading(props.preview.url, sizing.wrapRef, props.device === 'canvas', props.preview.retry);
  const { resolved: breakpoints, desktopFramePx } = useProjectBreakpoints(props.projectName);
  // A page that is already ready costs no request: the first read waits long enough for it to arrive.
  const startup = useStartupView(!loading.ready, 1500);
  // `dir="ltr"`: the canvas shows the person's own site and the overlays drawn over it in page coordinates, so it never mirrors
  // when Stacki's own interface is in Arabic or Hebrew.
  return (
    <div dir="ltr" className="preview-frame-wrap" ref={sizing.wrapRef} data-preview-loading={!loading.ready} aria-busy={!loading.ready}>
      {props.preview.url &&
        (props.device === 'canvas' ? (
          <CanvasView
            breakpoints={breakpoints}
            desktopFramePx={desktopFramePx}
            key={loading.attempt}
            url={props.preview.renderURL ?? props.preview.url}
            refreshKey={loading.attempt}
          />
        ) : (
          <DesignFrame key={loading.attempt} interactive={interactive ?? false} props={props} sizing={sizing} shownGuide={shownGuide} />
        ))}
      {!loading.ready && (
        <PreviewLoading
          slow={loading.slow}
          wait={loading.wait}
          frameError={loading.frameError}
          retry={loading.retry}
          attempt={loading.attempt}
          startup={startup}
        />
      )}
    </div>
  );
}
function DesignFrame({
  interactive,
  props,
  sizing,
  shownGuide,
}: {
  readonly props: Props;
  readonly sizing: ReturnType<typeof usePreviewSizing>;
  readonly shownGuide: ShownGuide | undefined;
  readonly interactive?: boolean;
}) {
  const translate = useTranslate();
  // Later pages replace the frame's history entry: the canvas never adds back steps (frameAddress.ts).
  const frameAddress = useFrameAddress(props.preview.frame, props.preview.url);
  return (
    <>
      <SizedFrame sizing={sizing}>
        <iframe
          ref={props.preview.frame}
          title={translate('preview.pane.title')}
          src={frameAddress}
          onLoad={() => {
            props.preview.loaded({ preserveNavigation: interactive ?? false });
            // Interact mode selects too, so the frame needs its scope, labels and selection.
            props.restoreSelection();
            // The render subscription catches edits made during navigation. A load-time
            // pull races that render and repeats work for every page switch.
          }}
        />
      </SizedFrame>
      <CanvasOverlays props={props} sizing={sizing} shownGuide={shownGuide} />
    </>
  );
}
function CanvasOverlays({
  props,
  sizing,
  shownGuide,
}: {
  readonly props: Props;
  readonly sizing: ReturnType<typeof usePreviewSizing>;
  readonly shownGuide: ShownGuide | undefined;
}) {
  const spacing = useLiveValue(spacingHover);
  const style: CSSProperties = sizing.width
    ? {
        width: sizing.viewport.width * sizing.viewport.scale,
        height: sizing.viewport.height * sizing.viewport.scale,
        borderRadius: 10 * sizing.viewport.scale,
      }
    : { ...sizing.fillStyle, height: '100%', borderRadius: 0 };
  // The overlays are drawn in the page's own coordinates over the user's site, which never mirrors, so they stay left to right.
  return (
    <div dir="ltr" className={`preview-overlay-layer ${sizing.width ? '' : 'full'}`} style={style}>
      {/* First in the layer, so the outlines and spacing bands paint over it. */}
      {shownGuide && <GuideOverlay {...shownGuide} scale={sizing.viewport.scale} />}
      <CollaboratorOutlines
        peers={props.collaborators}
        nodes={props.nodes}
        file={props.file}
        rects={props.preview.outlines.rects}
        scale={sizing.viewport.scale}
      />
      <PreviewOverlays
        spacingHover={spacing}
        rects={props.preview.outlines.rects}
        spacing={props.preview.outlines.spacing}
        scale={sizing.viewport.scale}
        selPath={props.preview.outlines.selected?.id}
        selOcc={props.preview.outlines.selected?.occurrence}
        hoverPath={props.preview.outlines.hovered?.id}
        hoverOcc={props.preview.outlines.hovered?.occurrence}
        focusPath={props.focusPath}
        focusWhole={false}
        textMarks={props.preview.textMarks}
        overlayInfo={(path) => outlineInfo(props.nodes, path)}
        onOpenComponent={
          props.openComponent
            ? (path, occurrence) => {
                const node = outlineNode(props.nodes, path);
                if (node?.kind === 'component') {
                  props.openComponent?.(node.name, nodeId(node), occurrence);
                }
              }
            : undefined
        }
      />
      <StudioAppOverlays rects={props.preview.outlines.rects} scale={sizing.viewport.scale} file={props.file} />
    </div>
  );
}
function crumbsFor(nodes: readonly ParserNode[], selected: string): { id: string; label: string }[] {
  for (const node of nodes) {
    if (!node.id) {
      continue;
    }
    const crumb = { id: node.id, label: node.name ?? node.kind };
    if (node.id === selected) {
      return [crumb];
    }
    const children = crumbsFor(node.children ?? [], selected);
    if (children.length) {
      return [crumb, ...children];
    }
  }
  return [];
}
