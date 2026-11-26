import { outsideScope } from '../../../shared/properties/deepOutline';
import { canvasHighlight, deepHoverNode, subscribeCanvasHighlight } from '../../ui/canvasOutlineMode';
import type { CanvasHighlight } from '../../../shared/properties/deepOutline';
import React, { useSyncExternalStore } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { assert } from '../../../shared/core/assert';
import { pseudoPath, type PseudoLayer } from '../../../shared/page/pseudoPath';
import type { Box } from './outlineBoxes';
import type { PreviewMessage } from './previewMessages';
import { outlineKind, type OutlineKind } from '../../../shared/properties/outlineOwnership';
import { NO_TEXT_MARKS, type TextMarkBox, type TextMarks } from './previewMessages';
import { ownerClasses } from './textOwnerState';
import { copiesToDraw, hoverIsSelection, loopChildPaths, collapseKind, onePerPlace, outlineBoxPath, unionBox } from './outlineBoxes';
import { clipBand, spacingBands, withLiveSpacing, type CollapsePartner } from './spacingBands';
import {
  BranchIcon,
  CodeIcon,
  PseudoElementIcon,
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
  /** How many children the node has: a loop's outline wraps every one. */
  readonly childCount: number;
  readonly isLayout: boolean;
  readonly bound: boolean;
  /** A `<slot>`: it renders the host page's content, which cannot be picked from the component that holds it. */
  readonly hostContent?: boolean | undefined;
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
  /** The frame's size in its own px: a spacing band is cut to it so its label stays on what is visible. */
  readonly viewport?: { readonly w: number; readonly h: number } | undefined;
  readonly spacingHover?: SpacingHover | undefined;
  readonly selPath: string | undefined;
  readonly unoutlined?: ((path: string) => boolean) | undefined;
  readonly selOcc: number | undefined;
  readonly hoverPath: string | undefined;
  readonly hoverOcc: number | undefined;
  /** The selection's ::before or ::after layer: its outline is drawn instead of the element's. */
  readonly selPseudo?: PseudoLayer | undefined;
  /** The hovered ::before or ::after layer, of `hoverPath`. */
  readonly hoverPseudo?: PseudoLayer | undefined;
  readonly focusPath: string | undefined;
  readonly focusWhole: boolean;
  /** Hovered or picked text of the selected instance; absent where the canvas reports none. */
  readonly textMarks?: TextMarks | undefined;
  readonly overlayInfo?: (path: string) => OverlayInfo | undefined;
  readonly onOpenComponent?: ((path: string, occurrence: number) => void) | undefined;
  /** The open file's path prefix ('' for a page): a hover outside it is a deep hover (shared/properties/deepOutline.ts). */
  readonly pathScope?: string | undefined;
}

/**
 * A deep hover's outline: the node inside a closed component, drawn as the editor draws it
 * with that component open: an instance green with ⬡ and its name, an element with its first
 * class or tag. Undefined when the frame did not label it, and then nothing is drawn rather
 * than a guess.
 */
export function deepOutlineInfo(path: string): OverlayInfo | undefined {
  const node = deepHoverNode(path);
  if (node === undefined) {
    return undefined;
  }
  return {
    label: node.label,
    kind: node.kind,
    tag: node.tag,
    astroAsset: false,
    dynamicTag: false,
    nodeKind: node.kind,
    childCount: 0,
    isLayout: false,
    bound: false,
  };
}

export function PreviewOverlays(props: PreviewOverlaysProps) {
  const highlight = useSyncExternalStore(subscribeCanvasHighlight, canvasHighlight, canvasHighlight);
  return (
    <>
      {!props.focusWhole && <FocusOverlays path={props.focusPath} rects={props.rects} scale={props.scale} />}
      <SpacingOverlays {...props} />
      <NodeOutlines {...props} />
      <TextMarkOutlines marks={props.textMarks ?? NO_TEXT_MARKS} instances={outlineBoxes(props, highlight)} scale={props.scale} />
    </>
  );
}

function FocusOverlays({ path, rects, scale }: { readonly path: string | undefined; readonly rects: RectMap; readonly scale: number }) {
  if (!path) {
    return undefined;
  }
  return onePerPlace(rects[path] ?? undefined).map((box, index) => <div key={`focus-${index}`} className="node-focus" style={boxStyle(box, scale)} />);
}

// What hovering a side of the Spacing box shows on the canvas: that side's strip, from the page as laid
// out (the used geometry, so a margin the page collapsed is not drawn as if it held space open).
// Drawn in the overlay layer, above the page and in the frame's own coordinates, so no ancestor's
// `overflow: hidden` in the page can cut it. Purely a view: nothing here writes.
function SpacingOverlays(props: PreviewOverlaysProps) {
  const translate = useTranslate();
  const { spacingHover, selPath: selectedPath } = props;
  if (!spacingHover || !selectedPath) {
    return undefined;
  }
  const boxes = props.rects[selectedPath] ?? [];
  const measurements = props.spacing[selectedPath] ?? [];
  const box = boxes[props.selOcc ?? 0] ?? boxes[0];
  if (box?.hidden === true) {
    return undefined;
  }
  const measurement = measurements[props.selOcc ?? 0] ?? measurements[0] ?? undefined;
  const sized = withLiveSpacing(measurement, spacingHover.kind, spacingHover.live);
  return spacingBands(box, sized, spacingHover.kind, spacingHover.sides).flatMap((drawn, index) => {
    const band = clipBand(drawn, props.viewport);
    if (!band) {
      return [];
    }
    const collapsed = band.collapsedInto;
    const label = collapsed === undefined ? (spacingHover.labels?.[band.side] ?? spacingLabel(band)) : translate(collapseKey(collapsed));
    return [
      <div
        key={`sp-${band.side}-${index}`}
        className={`spacing-band is-${spacingHover.kind}${collapsed === undefined ? '' : ` is-collapsed is-${band.side}`}`}
        style={boxStyle(band, props.scale)}
      >
        <span className="spacing-band-label">{label}</span>
      </div>,
    ];
  });
}

function collapseKey(partner: CollapsePartner) {
  switch (partner) {
    case 'previous':
      return 'preview.spacing.collapsedPrevious';
    case 'next':
      return 'preview.spacing.collapsedNext';
    case 'parent':
      return 'preview.spacing.collapsedParent';
    default: {
      const exhaustive: never = partner;
      return exhaustive;
    }
  }
}

function NodeOutlines(props: PreviewOverlaysProps) {
  // An app's highlight (`canvas.highlight`), in its own slot: the real selection and hover are untouched beside it.
  const highlight = useSyncExternalStore(subscribeCanvasHighlight, canvasHighlight, canvasHighlight);
  const targets = outlineTargets(props, highlight);
  // A hovered slot always reads muted, even when it is the selection: its muted hover draws beside the selected outline.
  const slotHover =
    highlight === undefined && props.hoverPath && props.hoverPseudo === undefined && !targets.some((target) => target.slot === 'hover')
      ? props.overlayInfo?.(props.hoverPath)?.hostContent === true
      : false;
  const candidates: readonly OutlineTarget[] = slotHover
    ? [{ path: props.hoverPath ?? '', slot: 'hover', type: 'hover', occ: props.hoverOcc, pseudo: undefined }, ...targets]
    : targets;
  const outlines = candidates.filter((target) => props.unoutlined?.(target.path) !== true);
  return outlines.flatMap((outline) => {
    if (outline.pseudo !== undefined) {
      // Inside a component (an instance, or markup rendered by a component file) the pseudo-element reads as the component's: green.
      const kind = outlineKind({
        insideComponent: outsideScope(outline.path, props.pathScope ?? ''),
        insideSlot: false,
        nodeKind: props.overlayInfo?.(outline.path)?.kind === 'component' ? 'component' : 'element',
      });
      return <PseudoOutline key={`${outline.slot}-pseudo`} outline={outline} rects={props.rects} scale={props.scale} kind={kind} />;
    }
    // A deep hover or a highlight names a node inside a closed component, which the open file's tree cannot label.
    const info =
      outline.slot !== 'sel' && outsideScope(outline.path, props.pathScope ?? '') ? deepOutlineInfo(outline.path) : props.overlayInfo?.(outline.path);
    const geometryPath = outlineBoxPath(outline.path, info?.nodeKind);
    const all = props.rects[geometryPath] ?? props.rects[outline.path];
    if (!all || !info) {
      return [];
    }
    // A loop is every copy; anything else is the copy it names (copiesToDraw).
    const loop = info.nodeKind === 'map' ? loopBox(props.rects, outline.path, info.childCount) : undefined;
    const boxes = loop !== undefined ? [loop] : copiesToDraw(all, outline.occ);
    // Hovering a slot says nothing inside it can be picked: a muted fill, not the accent. Picking the slot itself stays as it was.
    const muted = info.hostContent && outline.type === 'hover';
    // Words the frame reports for this path name it as their component instance (`scope`), whatever the Navigator calls the node
    // (a dynamic tag, a fragment): it is a component. A deep hover names a node as the editor would outline it with the component
    // open, so it is the open view's, not a closed component's own markup.
    const kind = outlineKind({
      insideComponent: false,
      insideSlot: false,
      nodeKind: info.kind === 'element' && ownsMarkedWords(props.textMarks, outline.path) ? 'component' : info.kind,
    });
    return boxes.map((box, index) => {
      const collapse = collapseKind(box);
      return (
        <div
          key={`${outline.slot}-${index}`}
          className={`node-outline ${outline.type} ${kind}${info.bound ? ' bound' : ''}${muted ? ` host-content${props.selPath === outline.path ? ' is-selected' : ''}` : ''}${collapse === 'none' ? '' : ` collapsed is-${collapse}`}${ownerClasses(
            props.textMarks,
            {
              ownable: kind === 'component' && !info.isLayout,
              path: outline.path,
              slot: outline.slot === 'highlight' ? 'highlight' : outline.type === 'sel' ? 'sel' : 'hover',
              pointedAt: props.hoverPath === outline.path,
            },
          )}`}
          style={boxStyle(box, props.scale)}
        >
          <span className={`node-outline-tag ${box.y * props.scale < 20 ? 'inside' : ''}`}>
            {outlineIcon(info)}
            {info.label}
            {outline.slot === 'sel' && <ComponentEditButton info={info} path={outline.path} occurrence={all.indexOf(box)} onOpen={props.onOpenComponent} />}
            {/* A highlight shows the selected chip's component icon, but opens nothing: it is display only. */}
            {outline.slot === 'highlight' && outline.type === 'sel' && info.kind === 'component' && (
              <span className="node-outline-edit" aria-hidden="true">
                <ComponentEditIcon size={12} />
              </span>
            )}
          </span>
        </div>
      );
    });
  });
}

// The kind of outline around words: the element holding them is the component's own unless the page wrote it (a slot child), and
// words the page passes in are inside the instance's slot by construction.
function markKind(box: TextMarkBox): OutlineKind {
  return outlineKind({ insideComponent: true, insideSlot: box.owner === 'slot', nodeKind: 'element' });
}

// Whether hovered or picked words name `path` as the component instance that owns them.
function ownsMarkedWords(marks: TextMarks | undefined, path: string): boolean {
  return marks?.hover?.scope === path || marks?.picked?.scope === path;
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
  const translate = useTranslate();
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
      aria-label={translate('preview.overlay.editComponent', { name: info.label })}
      data-tooltip={translate('preview.overlay.editTip')}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(path, occurrence);
      }}
    >
      <ComponentEditIcon size={12} />
    </button>
  );
}

interface OutlineTarget {
  readonly path: string;
  /** Which outline this is: the hover, the real selection, or an app's highlight. */
  readonly slot: 'hover' | 'sel' | 'highlight';
  /** How it is drawn. */
  readonly type: 'hover' | 'sel';
  readonly occ: number | undefined;
  readonly pseudo: PseudoLayer | undefined;
}

function outlineTargets(props: PreviewOverlaysProps, highlight: CanvasHighlight | undefined): readonly OutlineTarget[] {
  const targets: OutlineTarget[] = [];
  // While an app highlights, the hover gives way to it, as the app's own hover is what moves it.
  if (highlight !== undefined) {
    targets.push({
      path: highlight.path,
      slot: 'highlight',
      type: highlight.style === 'hover' ? 'hover' : 'sel',
      occ: highlight.occurrence,
      pseudo: undefined,
    });
  } else if (props.hoverPath) {
    // The element and its ::before are different layers: hovering one while the other is selected outlines it.
    const samePseudo = props.hoverPseudo === props.selPseudo;
    if (!samePseudo || !hoverIsSelection({ path: props.hoverPath, occ: props.hoverOcc }, { path: props.selPath, occ: props.selOcc })) {
      targets.push({ path: props.hoverPath, slot: 'hover', type: 'hover', occ: props.hoverOcc, pseudo: props.hoverPseudo });
    }
  }
  if (props.selPath) {
    targets.push({ path: props.selPath, slot: 'sel', type: 'sel', occ: props.selOcc, pseudo: props.selPseudo });
  }
  return targets;
}

// A ::before or ::after outline: its own measured box (framePseudo.ts), named
// as its navigator row is, with no component button (it is CSS, not markup).
function PseudoOutline({
  outline,
  rects,
  scale,
  kind,
}: {
  readonly outline: OutlineTarget;
  readonly rects: RectMap;
  readonly scale: number;
  readonly kind: OutlineKind;
}) {
  assert(outline.pseudo !== undefined, 'PseudoOutline: the outline is a pseudo-element');
  const all = rects[pseudoPath(outline.path, outline.pseudo)];
  if (!all) {
    return [];
  }
  const boxes = copiesToDraw(all, outline.occ);
  return boxes.map((box, index) => (
    <div key={`${outline.type}-pseudo-${index}`} className={`node-outline ${outline.type} pseudo ${kind}`} style={boxStyle(box, scale)}>
      <span className={`node-outline-tag ${box.y * scale < 20 ? 'inside' : ''}`}>
        <PseudoElementIcon size={11} />
        ::{outline.pseudo}
      </span>
    </div>
  ));
}

export function outlineIcon(info: OverlayInfo): React.ReactNode {
  const size = 11;
  if (info.isLayout) {
    return <LayoutIcon size={size} />;
  }
  if (info.nodeKind === 'component') {
    // Fragments and dynamic tags share element styling and the custom-tag icon.
    if (info.kind === 'element') {
      return <CustomElementIcon size={size} />;
    }
    return info.astroAsset ? astroAssetIcon(info.label, size, undefined, 'inherit') : <ElementComponentIcon size={size} />;
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

// Text the selected instance shows, hovered or clicked: drawn like an element's
// hover and selection outlines, named for the component (or tag) rendering it.
// While one is picked the instance's own outline steps back to a parent's.
// Text that fills its instance (an Eyebrow that is only its words) would put
// its tag on the instance's own: the instance's tag stays, as it names what is
// edited and carries the edit button, and the text's is left out.
function TextMarkOutlines({ marks, instances, scale }: { readonly marks: TextMarks; readonly instances: readonly Box[]; readonly scale: number }) {
  const drawn = [
    ...(marks.hover && !sameBox(marks.hover, marks.picked) ? [['hover', marks.hover] as const] : []),
    ...(marks.picked ? [['sel', marks.picked] as const] : []),
  ];
  return drawn.map(([type, box]) => (
    <div key={type} className={`node-outline ${type} ${markKind(box)} text-mark`} style={boxStyle(box, scale)}>
      {!instances.some((instance) => tagsCollide(instance, box, scale)) && (
        <span className={`node-outline-tag ${box.y * scale < 20 ? 'inside' : ''}`}>
          {box.kind === 'component' ? <ElementComponentIcon size={11} /> : <TextIcon size={11} />}
          {box.label}
        </span>
      )}
    </div>
  ));
}

// The boxes every node outline of this render is drawn on (hover, selection, highlight), so a text mark never draws its own tag
// over one of theirs: two tags at one corner print over each other ("text" and "heading" garbled into one chip). The node
// outline's tag wins, so a hovered text reads exactly as the same text clicked.
function outlineBoxes(props: PreviewOverlaysProps, highlight: CanvasHighlight | undefined): readonly Box[] {
  const boxes: Box[] = [];
  for (const outline of outlineTargets(props, highlight)) {
    if (outline.pseudo !== undefined) {
      continue;
    }
    const info = props.overlayInfo?.(outline.path);
    const all = props.rects[outlineBoxPath(outline.path, info?.nodeKind)] ?? props.rects[outline.path];
    if (all === undefined) {
      continue;
    }
    const loop = info?.nodeKind === 'map' ? loopBox(props.rects, outline.path, info.childCount) : undefined;
    boxes.push(...(loop !== undefined ? [loop] : copiesToDraw(all, outline.occ)));
  }
  return boxes;
}

// Tags sit on their box's top-left corner, so two boxes whose corners lie
// within a tag's height of each other on screen draw their tags over one another.
function tagsCollide(instance: Box, mark: Box, scale: number): boolean {
  assert(scale > 0, 'Overlay scale must be positive');
  const horizontalPx = Math.abs(instance.x - mark.x) * scale;
  const verticalPx = Math.abs(instance.y - mark.y) * scale;
  if (horizontalPx < TAG_HEIGHT_PX) {
    return verticalPx < TAG_HEIGHT_PX;
  }
  return false;
}

function sameBox(left: Box, right: Box | undefined): boolean {
  if (!right) {
    return false;
  }
  return left.x === right.x && left.y === right.y && left.w === right.w && left.h === right.h;
}

// A tag is 10.5px type with 7px of padding, so 18px rounds it up.
const TAG_HEIGHT_PX = 18;

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

// The box around every copy of every child a loop renders.
function loopBox(rects: RectMap, path: string, childCount: number): Box | undefined {
  return unionBox(loopChildPaths(path, childCount).flatMap((child) => rects[child] ?? []));
}
