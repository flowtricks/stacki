import React from 'react';
import type { Box } from './outlineBoxes';
import type { PreviewMessage } from './previewMessages';
import { hoverIsSelection, onePerPlace, outlineBoxPath } from './outlineBoxes';
import { spacingBands, withLiveSpacing } from './spacingBands';
import {
  BranchIcon,
  CodeIcon,
  CommentIcon,
  ComponentEditIcon,
  CornerIcon,
  CustomElementIcon,
  ElementComponentIcon,
  LayoutIcon,
  RepeatIcon,
  TextIcon,
  astroAssetIcon,
  elementIcon,
} from '../../ui/Icons';

export interface OverlayInfo {
  readonly label: string;
  readonly kind: 'component' | 'map' | 'element';
  readonly tag: string | undefined;
  readonly astroAsset: boolean;
  readonly dynamicTag: boolean;
  readonly nodeKind: string;
  readonly isLayout: boolean;
  readonly bound: boolean;
}

export interface SpacingHover {
  readonly kind: 'padding' | 'margin' | 'gap';
  readonly sides?: readonly string[];
  readonly labels?: Readonly<Record<string, string>>;
  /** The values a drag is writing, per side: they size the band ahead of the page. */
  readonly live?: Readonly<Record<string, string>>;
}

// The measurements as the canvas frame reports them (src/features/preview/previewMessages.ts): a
// path it could not measure, and a copy without spacing, are absent.
type RectsMessage = Extract<PreviewMessage, { readonly kind: 'rects' }>;
export type RectMap = RectsMessage['rects'];
export type SpacingMap = RectsMessage['spacing'];

interface PreviewOverlaysProps {
  readonly rects: RectMap;
  readonly spacing: SpacingMap;
  readonly scale: number;
  readonly spacingHover?: SpacingHover | undefined;
  readonly selPath: string | undefined;
  readonly selOcc: number | undefined;
  readonly hoverPath: string | undefined;
  readonly hoverOcc: number | undefined;
  readonly focusPath: string | undefined;
  readonly focusWhole: boolean;
  readonly overlayInfo?: (path: string) => OverlayInfo | undefined;
  readonly onOpenComponent?: ((path: string, occurrence: number) => void) | undefined;
}

export function PreviewOverlays(props: PreviewOverlaysProps) {
  return (
    <>
      {!props.focusWhole && (
        <FocusOverlays path={props.focusPath} rects={props.rects} scale={props.scale} />
      )}
      <SpacingOverlays {...props} />
      <NodeOutlines {...props} />
    </>
  );
}

function FocusOverlays({
  path,
  rects,
  scale,
}: {
  readonly path: string | undefined;
  readonly rects: RectMap;
  readonly scale: number;
}) {
  if (!path) {
    return undefined;
  }
  return onePerPlace(rects[path] ?? undefined).map((box, index) => (
    <div key={`focus-${index}`} className="node-focus" style={boxStyle(box, scale)} />
  ));
}

function SpacingOverlays(props: PreviewOverlaysProps) {
  const { spacingHover, selPath: selectedPath } = props;
  if (!spacingHover || !selectedPath) {
    return undefined;
  }
  const boxes = props.rects[selectedPath] ?? [];
  const measurements = props.spacing[selectedPath] ?? [];
  const box = boxes[props.selOcc ?? 0] ?? boxes[0];
  const measurement = measurements[props.selOcc ?? 0] ?? measurements[0] ?? undefined;
  const sized = withLiveSpacing(measurement, spacingHover.kind, spacingHover.live);
  return spacingBands(box, sized, spacingHover.kind, spacingHover.sides).map((band, index) => (
    <div
      key={`sp-${band.side}-${index}`}
      className={`spacing-band is-${spacingHover.kind}`}
      style={boxStyle(band, props.scale)}
    >
      <span className="spacing-band-label">
        {spacingHover.labels?.[band.side] ?? spacingLabel(band)}
      </span>
    </div>
  ));
}

function NodeOutlines(props: PreviewOverlaysProps) {
  const outlines = outlineTargets(props);
  return outlines.flatMap((outline) => {
    const info = props.overlayInfo?.(outline.path);
    const geometryPath = outlineBoxPath(outline.path, info?.nodeKind);
    const all = props.rects[geometryPath] ?? props.rects[outline.path];
    if (!all || !info) {
      return [];
    }
    // No occurrence means the node, so draw one box per place. A number means
    // the specific repeated copy clicked on the canvas.
    const selected = outline.occ === undefined ? undefined : all[outline.occ];
    const boxes =
      outline.occ === undefined ? onePerPlace(all) : selected ? [selected] : all.slice(0, 1);
    return boxes.map((box, index) => (
      <div
        key={`${outline.type}-${index}`}
        className={`node-outline ${outline.type} ${info.kind}${info.bound ? ' bound' : ''}`}
        style={boxStyle(box, props.scale)}
      >
        <span className={`node-outline-tag ${box.y * props.scale < 20 ? 'inside' : ''}`}>
          {outlineIcon(info)}
          {info.label}
          {outline.type === 'sel' && (
            <ComponentEditButton
              info={info}
              path={outline.path}
              occurrence={all.indexOf(box)}
              onOpen={props.onOpenComponent}
            />
          )}
        </span>
      </div>
    ));
  });
}

function ComponentEditButton({
  info,
  path,
  occurrence,
  onOpen,
}: {
  readonly info: OverlayInfo;
  readonly path: string;
  readonly occurrence: number;
  readonly onOpen: PreviewOverlaysProps['onOpenComponent'];
}) {
  if (info.kind !== 'component') {
    return undefined;
  }
  if (info.astroAsset) {
    return undefined;
  }
  if (info.dynamicTag) {
    return undefined;
  }
  if (!onOpen) {
    return undefined;
  }
  return (
    <button
      type="button"
      className="node-outline-edit"
      aria-label={`Edit ${info.label} component`}
      data-tooltip="Edit component"
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(path, occurrence);
      }}
    >
      <ComponentEditIcon size={14} />
    </button>
  );
}

interface OutlineTarget {
  readonly path: string;
  readonly type: 'hover' | 'sel';
  readonly occ: number | undefined;
}

function outlineTargets(props: PreviewOverlaysProps): readonly OutlineTarget[] {
  const targets: OutlineTarget[] = [];
  if (
    props.hoverPath &&
    !hoverIsSelection(
      { path: props.hoverPath, occ: props.hoverOcc },
      { path: props.selPath, occ: props.selOcc },
    )
  ) {
    targets.push({ path: props.hoverPath, type: 'hover', occ: props.hoverOcc });
  }
  if (props.selPath) {
    targets.push({ path: props.selPath, type: 'sel', occ: props.selOcc });
  }
  return targets;
}

function outlineIcon(info: OverlayInfo): React.ReactNode {
  const size = 11;
  if (info.isLayout) {
    return <LayoutIcon size={size} />;
  }
  if (info.nodeKind === 'component') {
    // Fragments and dynamic tags share element styling and the custom-tag icon.
    if (info.kind === 'element') {
      return <CustomElementIcon size={size} />;
    }
    return info.astroAsset ? (
      astroAssetIcon(info.label, size)
    ) : (
      <ElementComponentIcon size={size} />
    );
  }
  switch (info.nodeKind) {
    case 'map':
      return <RepeatIcon size={size} />;
    case 'cond':
      return <BranchIcon size={size} />;
    case 'branch':
      return <CornerIcon size={size} />;
    case 'text':
      return <TextIcon size={size} />;
    case 'comment':
      return <CommentIcon size={size} />;
    case 'expr':
    case 'raw':
      return <CodeIcon size={size} />;
    default:
      return info.tag ? elementIcon(info.tag, size) : <CustomElementIcon size={size} />;
  }
}

function boxStyle(box: Box, scale: number): React.CSSProperties {
  return {
    left: box.x * scale,
    top: box.y * scale,
    width: box.w * scale,
    height: box.h * scale,
  };
}

function spacingLabel(box: Box & { readonly side: string }): string {
  const horizontal = box.side === 'left' || box.side === 'right';
  return `${Math.round(horizontal ? box.w : box.h)}px`;
}
