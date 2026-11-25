// The clip-path editor's shapes: points and bounds, each kind of clip shape
// and its raw editable form, handles and drag targets, the shape() model,
// snap guides, highlights and the editor's option types (ClipPath.tsx).

import type { MessageKey } from '../../../../shared/properties/i18n/messageRef';
import type { BreakpointId } from './webflowDesigner';

export type Point = { x: number; y: number };
export type CornerName = 'topLeft' | 'topRight' | 'bottomRight' | 'bottomLeft';
export type CornerRadius = { x: number; y: number };
export type CornerRadii = Record<CornerName, CornerRadius>;
export type PolygonShape = { kind: 'polygon'; points: Point[] };
export type CircleShape = { kind: 'circle'; radius: number; cx: number; cy: number };
export type EllipseShape = { kind: 'ellipse'; rx: number; ry: number; cx: number; cy: number };
export type InsetShape = {
  kind: 'inset';
  top: number;
  right: number;
  bottom: number;
  left: number;
  radii: CornerRadii;
};
export type ShapeFunctionShape = {
  kind: 'shape';
  value: string;
  fillRule?: 'evenodd' | 'nonzero';
  pathData?: string;
};
export type CssUnitValue = { value: number; unit: string };
export type CssCoordinateValue = CssUnitValue | { expression: string };
export type CssCoordinatePoint = { x: CssCoordinateValue; y: CssCoordinateValue };
export type RawEditableClipPath =
  | { kind: 'polygon'; points: CssCoordinatePoint[]; fillRule?: 'evenodd' | 'nonzero' }
  | { kind: 'circle'; radius: CssUnitValue; cx: CssUnitValue; cy: CssUnitValue }
  | { kind: 'ellipse'; rx: CssUnitValue; ry: CssUnitValue; cx: CssUnitValue; cy: CssUnitValue }
  | {
      kind: 'inset';
      top: CssUnitValue;
      right: CssUnitValue;
      bottom: CssUnitValue;
      left: CssUnitValue;
      radii?: { horizontal: CssUnitValue[]; vertical?: CssUnitValue[] };
    };
export type RawClipPathShape = {
  kind: 'raw';
  value: string;
  preset?: string;
  editable?: RawEditableClipPath;
};
export type NoneShape = { kind: 'none' };
export type ClipShape = NoneShape | PolygonShape | CircleShape | EllipseShape | InsetShape | ShapeFunctionShape | RawClipPathShape;
export type InsetSide = 'top' | 'right' | 'bottom' | 'left';
export type InsetSideMode = 'single' | 'opposite' | 'all';
export type InsetRadiusMode = 'single' | 'all' | 'opposite';
export type InsetModifierMode = 'single' | 'opposite' | 'all';
export type KeyboardModifiers = { altKey: boolean; shiftKey: boolean; radiusUnlocked?: boolean };
export type ArrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

export type HandleTarget =
  | { kind: 'polygon-point'; index: number }
  | { kind: 'circle-center' }
  | { kind: 'circle-radius' }
  | { kind: 'ellipse-center' }
  | { kind: 'ellipse-rx' }
  | { kind: 'ellipse-ry' }
  | { kind: 'inset-top' }
  | { kind: 'inset-right' }
  | { kind: 'inset-bottom' }
  | { kind: 'inset-left' }
  | { kind: 'inset-radius'; corner: CornerName };

export type DragTarget = HandleTarget & {
  before: ClipShape;
  polygonPointIndexes?: number[];
  optionDuplicated?: boolean;
  dragOrigin?: { pointer: Point; handle: Point };
};

export type StylePropertyRead = { value: string; breakpoint: BreakpointId };
export type StyleLookupDiagnostic = {
  candidate: string | string[];
  source: 'getStyleByName' | 'getAllStyles';
  timedOut?: boolean;
  found: boolean;
  path?: string[];
  id?: string | undefined;
};
export type CanvasSize = { width: number; height: number };
export type CanvasHandleBounds = { minX: number; maxX: number; minY: number; maxY: number };
export type BoundsSide = 'left' | 'right' | 'top' | 'bottom';
export type PolygonDisplayEdge = 'prev' | 'next';
export type PolygonDisplayProjection = { side: BoundsSide; edge: PolygonDisplayEdge };
export type SelectionRect = { left: number; top: number; width: number; height: number };
export type SnapGuides = { x: number[]; y: number[] };
export type SnapAxisResult = { value: number; guide: number | undefined };
export type SnapPointResult = { point: Point; guides: SnapGuides };
export type ShapeResizeCorner = CornerName;
export type PolygonSelectionDrag = {
  pointerId: number;
  start: Point;
  current: Point;
  startClient: Point;
  didMove: boolean;
  additive: boolean;
  baseHandles: Array<Extract<HandleTarget, { kind: 'polygon-point' }>>;
};
export type ShapeTransformDrag = {
  pointerId: number;
  mode: 'move' | 'resize';
  corner?: ShapeResizeCorner;
  start: Point;
  before: ShapeFunctionShape;
  bounds: SelectionRect;
  fitMode: ShapeFitMode;
  scaleOptions: ShapeScaleOptions;
};
export type SvgViewBox = { x: number; y: number; width: number; height: number };
export type SvgBoundaryEdge = { from: string; to: string; fromPoint: Point; toPoint: Point };
export type SvgLoopPair = {
  sourceIndex: number;
  targetLoopIndex: number;
  targetIndex: number;
  distance: number;
};
export type SvgLoopPoint = { targetLoopIndex: number; targetIndex: number; distance: number };
export type SvgClipPathOutline = { points: Point[]; loops: Point[][] };
export type SvgShapeCommand = { kind: 'line'; to: Point } | { kind: 'curve'; to: Point; control1: Point; control2?: Point } | { kind: 'close' };
export type SvgShapeSubpath = { start: Point; commands: SvgShapeCommand[] };
export type ShapeFitMode = 'stretch' | 'contain';
export type ShapeScaleOptions = {
  useVariable: boolean;
  variableName: string;
  offsetLeftVariableName?: string;
  offsetTopVariableName?: string;
};
export type ShapeScaleOptionOverrides = {
  readonly useVariable?: boolean;
  readonly variableName?: string;
  readonly offsetLeftVariableName?: string;
  readonly offsetTopVariableName?: string;
};
export type ShapeOffsetCoordinate = {
  axis: 'x' | 'y';
  u: number;
  size: number;
  offset: number;
  span: number;
  sizeVar: string;
  offsetVar: string;
};
export type ShapeContainModel = {
  points: Array<{ ux: number; uy: number }>;
  wu: number;
  hu: number;
  size: number;
  ol: number;
  ot: number;
  sizeVar: string;
  offsetLeftVar: string;
  offsetTopVar: string;
};
export type ShapeCssPoint = { x: string; y: string };
export type ShapeCssCommand =
  { kind: 'line'; to: ShapeCssPoint } | { kind: 'curve'; to: ShapeCssPoint; control1: ShapeCssPoint; control2?: ShapeCssPoint } | { kind: 'close' };
export type ShapeCssSubpath = { start: ShapeCssPoint; commands: ShapeCssCommand[] };
export type ClipPathStyleOrigin = 'none' | 'current' | 'inherited';
export type SelectionReadOptions = {
  force?: boolean;
  resetStyle?: boolean;
};
export type SvgShapeBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
};
export type PastedShapeSvgCache = {
  source: string;
  stretch: ShapeFunctionShape;
  contain: ShapeFunctionShape;
};
// A shortcut's keys: a plain chord (`Cmd/Ctrl + Z`: key names are not translated) or a message when the chord holds words (`drag/arrow keys`).
export type ShortcutKeys = { readonly literal: string } | { readonly message: MessageKey };
export type ShortcutHelpItem = { readonly keys: ShortcutKeys; readonly descriptionKey: MessageKey };
export type ShortcutHelpGroup = { readonly titleKey: MessageKey; readonly items: readonly ShortcutHelpItem[] };
