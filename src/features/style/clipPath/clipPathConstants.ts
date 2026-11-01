// The clip-path editor's constants and Webflow guards: breakpoint labels,
// timing and lookup bounds, shape() variable names and placeholders, keyboard
// steps, snapping and SVG parsing bounds, and the none and custom shapes
// (ClipPath.tsx).

import type { BreakpointId, ElementStyleSource, WebflowApi } from './webflowDesigner';
import { type CornerName, type ShapeFunctionShape, type RawClipPathShape, type NoneShape, type ArrowKey, type ShapeScaleOptions } from './clipPathTypes';

export function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined && value !== undefined;
}

export function parseFillRule(value: string | undefined): ShapeFunctionShape['fillRule'] {
  const normalized = value?.toLowerCase();
  if (normalized === 'evenodd' || normalized === 'nonzero') {
    return normalized;
  }
  return undefined;
}

export function isWebflowApi(candidate: unknown): candidate is WebflowApi {
  if (typeof candidate !== 'object' || candidate === null) {
    return false;
  }
  if (!('getSelectedElement' in candidate)) {
    return false;
  }
  return typeof candidate.getSelectedElement === 'function';
}

export function isElementStyleSource(candidate: unknown): candidate is ElementStyleSource {
  return typeof candidate === 'object' && candidate !== null;
}

export function readWebflowApi(): WebflowApi | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'webflow');
  const candidate: unknown = descriptor?.value;
  return isWebflowApi(candidate) ? candidate : undefined;
}

export const BREAKPOINT_LABELS: Record<BreakpointId, string> = {
  xxl: '1920px and up',
  xl: '1440px and up',
  large: '1280px and up',
  main: 'Desktop',
  medium: 'Tablet',
  small: 'Mobile landscape',
  tiny: 'Mobile portrait',
};

export const WRITE_THROTTLE_MS = 60;
export const STYLE_REFRESH_MS = 500;
export const STYLE_LOOKUP_TIMEOUT_MS = 250;
export const STYLE_PATH_LOOKUP_TIMEOUT_MS = 300;
export const STYLE_PROPERTY_LOOKUP_TIMEOUT_MS = 750;
export const SHAPE_STRETCH_PROPERTY = '--moden-clip-path-shape-stretch';
export const SHAPE_CONTAIN_PROPERTY = '--moden-clip-path-shape-contain';
// All variable names default to empty: an empty name emits the raw value (e.g. 100cqw or 0.5)
// instead of var(--size, 100cqw) / var(--offset-left, 0.5). The placeholders below are only UI
// hints.
export const DEFAULT_SHAPE_SCALE_VARIABLE_NAME = '';
export const DEFAULT_SHAPE_OFFSET_LEFT_VARIABLE_NAME = '';
export const DEFAULT_SHAPE_OFFSET_TOP_VARIABLE_NAME = '';
export const SHAPE_SCALE_VARIABLE_PLACEHOLDER = '--size';
export const SHAPE_OFFSET_LEFT_VARIABLE_PLACEHOLDER = '--offset-left';
export const SHAPE_OFFSET_TOP_VARIABLE_PLACEHOLDER = '--offset-top';
export const DEFAULT_SHAPE_OFFSET_VALUE = 0.5;
export const SHAPE_OFFSET_TRAVEL_EPSILON = 0.0001;
export const DEFAULT_SHAPE_SCALE_OPTIONS: ShapeScaleOptions = {
  useVariable: false,
  variableName: DEFAULT_SHAPE_SCALE_VARIABLE_NAME,
  offsetLeftVariableName: DEFAULT_SHAPE_OFFSET_LEFT_VARIABLE_NAME,
  offsetTopVariableName: DEFAULT_SHAPE_OFFSET_TOP_VARIABLE_NAME,
};
export const HISTORY_LIMIT = 100;
export const HANDLE_SIZE_PX = 12;
export const KEYBOARD_STEP = 1;
export const KEYBOARD_FAST_STEP = 10;
export const KEYBOARD_REPEAT_DELAY_MS = 300;
export const KEYBOARD_REPEAT_MS = 60;
export const EDGE_SNAP_DISTANCE = 2.5;
export const SNAP_GUIDE_ALIGNMENT_EPSILON = 0.1;
export const SELECTION_DRAG_THRESHOLD_PX = 4;
export const DUPLICATE_POINT_OFFSET = 4;
export const SVG_PARSE_CELL_LIMIT = 10000;
export const SVG_POINT_EPSILON = 0.0001;
export const SVG_ARC_KAPPA = 0.5522847498307936;
export const ARROW_KEYS: ArrowKey[] = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
export const CORNERS: CornerName[] = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'];
export const CLIP_PATH_DEBUG = false;
export const NONE_PRESET = 'None';
export const CUSTOM_PRESET = 'Custom';
export const NONE_SHAPE: NoneShape = { kind: 'none' };
export const CUSTOM_SHAPE: RawClipPathShape = {
  kind: 'raw',
  value: 'inherit',
  preset: CUSTOM_PRESET,
};
export const CSS_GLOBAL_CLIP_PATH_VALUES = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);
export const CSS_GEOMETRY_BOX_CLIP_PATH_VALUES = new Set([
  'border-box',
  'content-box',
  'fill-box',
  'half-border-box',
  'margin-box',
  'padding-box',
  'stroke-box',
  'view-box',
]);
export const DEFAULT_SHAPE_PATH_DATA = 'M56.8 43.2H100V56.8C76.2 56.8 56.8 76.2 56.8 100H43.2' + 'V56.8H0V43.2C23.8 43.2 43.2 23.8 43.2 0H56.8V43.2Z';
export const DEFAULT_SHAPE_VALUE = [
  'from 56.8% 43.2%',
  'line to 100% 43.2%',
  'line to 100% 56.8%',
  'curve to 56.8% 100% with 76.2% 56.8% / 56.8% 76.2%',
  'line to 43.2% 100%',
  'line to 43.2% 56.8%',
  'line to 0% 56.8%',
  'line to 0% 43.2%',
  'curve to 43.2% 0% with 23.8% 43.2% / 43.2% 23.8%',
  'line to 56.8% 0%',
  'line to 56.8% 43.2%',
  'close',
].join(', ');
