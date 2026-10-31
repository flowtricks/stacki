import { useCanvasText } from '../../../vendor/stacki/src/features/preview/useCanvasText';
import { studioCanvasText } from './studioCanvasText';
import { useCanvasInteraction } from '../../../vendor/stacki/src/features/preview/useCanvasInteraction';
import './previewToolbar.css';
import { PreviewLoading, usePreviewLoading } from './PreviewLoading';
import { CollaboratorOutlines } from '../collaboration/CollaboratorOutlines';
import { useCursorChatShortcut, useCursorScale } from '../collaboration/cursorChat';
import type { Peer } from '../collaboration/presence';
import { spacingHover } from './spacingHover';
import { useLiveValue } from '../../../vendor/stacki/src/ui/liveValue';
import { PreviewOverlays } from '../../../vendor/stacki/src/features/preview/PreviewOverlays';
import { GuideOverlay } from '../../../vendor/stacki/src/features/preview/GuideOverlay';
import {
  useColumnGuide,
  type ShownGuide,
} from '../../../vendor/stacki/src/features/preview/guideSettings';
import { outlineInfo, outlineNode } from './outlineInfo';
import type { CSSProperties } from 'react';
import {
  PreviewToolbar,
  type PreviewDevice,
  type PreviewInspectorActions,
} from '../../../vendor/stacki/src/features/preview/PreviewToolbar';
import CanvasView from '../../../vendor/stacki/src/features/preview/CanvasView';
import { usePreviewSizing } from '../../../vendor/stacki/src/features/preview/usePreviewSizing';
import type { usePreviewDimensions } from '../../../vendor/stacki/src/features/preview/usePreviewSizing';
import '../../../vendor/stacki/src/features/preview/previewViewport.css';
import { CollectionEditor } from '../collections/CollectionEditor';
import type { SharedDocument } from '../collaboration/useDocument';
import { nodeId, type ParserNode } from '../source/source';
import type { usePreview } from './usePreview';
interface Props {
  readonly focusPath?: string | undefined;
  readonly dimensions: ReturnType<typeof usePreviewDimensions>;
  readonly file: string;
  /** The folder name identifies this project's legacy local guide settings for migration. */
  readonly projectName: string;
  readonly pageLabel?: string | undefined;
  readonly editRoute: (route: string) => void;
  readonly collaborators: readonly Peer[];
  readonly collection: boolean;
  readonly document: SharedDocument | undefined;
  readonly preview: ReturnType<typeof usePreview>;
  readonly selected: string;
  readonly select: (id: string) => void;
  readonly restoreSelection: () => void;
  readonly nodes: readonly ParserNode[];
  readonly device: PreviewDevice;
  readonly onDevice: (device: PreviewDevice) => void;
  readonly inspector: PreviewInspectorActions | undefined;
  readonly openComponent?: ((name: string, id: string, occurrence: number) => void) | undefined;
}
export function PreviewCanvas(props: Props) {
  useCanvasText({
    document: studioCanvasText(props.file, props.document, props.nodes),
    frame: props.preview.frame,
    url: props.preview.url,
    post: props.preview.send,
    subscribeLoad: props.preview.subscribeLoad,
  });
  const interaction = useCanvasInteraction({
    projectKey: props.projectName,
    url: props.preview.url,
    available: props.device !== 'canvas' && !props.collection,
    frame: props.preview.frame,
    post: props.preview.send,
    subscribeLoad: props.preview.subscribeLoad,
    editRoute: props.editRoute,
  });
  const sizing = usePreviewSizing(props.device, props.dimensions, props.onDevice);
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
  });
  return (
    <main className="studio-center" data-canvas-interactive={interaction.active}>
      <div className="studio-preview-toolbar">
        <PreviewToolbar
          crumbs={[
            ...(props.pageLabel ? [{ id: undefined, label: props.pageLabel }] : []),
            ...crumbsFor(props.nodes, props.selected),
          ]}
          onCrumb={(id) => props.select(id ?? 'layout')}
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
          inspector={props.collection ? undefined : props.inspector}
        />
      </div>
      {props.collection && props.document ? (
        <CollectionEditor document={props.document} />
      ) : (
        <PreviewSurface
          interactive={interaction.active}
          props={props}
          sizing={sizing}
          shownGuide={columnGuide.shown}
        />
      )}
    </main>
  );
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
  const loading = usePreviewLoading(
    props.preview.url,
    sizing.wrapRef,
    props.device === 'canvas',
    props.preview.retry,
  );
  return (
    <div
      className="preview-frame-wrap"
      ref={sizing.wrapRef}
      data-preview-loading={!loading.ready}
      aria-busy={!loading.ready}
    >
      {props.preview.url &&
        (props.device === 'canvas' ? (
          <CanvasView
            key={loading.attempt}
            url={props.preview.renderURL ?? props.preview.url}
            refreshKey={loading.attempt}
          />
        ) : (
          <DesignFrame
            key={loading.attempt}
            interactive={interactive ?? false}
            props={props}
            sizing={sizing}
            shownGuide={shownGuide}
          />
        ))}
      {!loading.ready && <PreviewLoading slow={loading.slow} retry={loading.retry} />}
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
  return (
    <>
      <div
        ref={sizing.frameRef}
        className={`frame-sized ${sizing.width ? '' : 'full'} ${sizing.resizing ? 'resizing' : ''}`}
        style={{
          width: sizing.viewport.width,
          height: sizing.viewport.height,
          bottom: 'auto',
          transform: `translateX(-50%) scale(${sizing.viewport.scale})`,
        }}
      >
        <div className="frame-clip">
          <iframe
            ref={props.preview.frame}
            title="Site preview"
            src={props.preview.url}
            onLoad={() => {
              props.preview.loaded({ preserveNavigation: interactive ?? false });
              if (!interactive) {
                props.restoreSelection();
              }
              // The render subscription catches edits made during navigation. A load-time
              // pull races that render and repeats work for every page switch.
            }}
          />
        </div>
        {(['w', 'e', 's'] as const).map((edge) => (
          <div
            key={edge}
            className={`rz-handle rz-${edge}`}
            onPointerDown={sizing.startResize(edge)}
          />
        ))}
        {sizing.resizing && (
          <div className="rz-readout">
            {Math.round(sizing.viewport.width)} × {Math.round(sizing.viewport.height)}
          </div>
        )}
      </div>
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
  const style: CSSProperties = {
    width: sizing.viewport.width * sizing.viewport.scale,
    height: sizing.viewport.height * sizing.viewport.scale,
    borderRadius: sizing.width ? 10 * sizing.viewport.scale : 0,
  };
  return (
    <div className={`preview-overlay-layer ${sizing.width ? '' : 'full'}`} style={style}>
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
    </div>
  );
}
function crumbsFor(
  nodes: readonly ParserNode[],
  selected: string,
): { id: string; label: string }[] {
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
