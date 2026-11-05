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
// The code field's id: the view renders it, and the paste listener knows a paste
// into it by it (clipPathPointerActions.ts).
export const CLIP_PATH_CODE_ID = 'clip-path_css-output';
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
// Bounds on pasted SVG (svgContours.ts): a megabyte of text is far beyond any icon
// or logo a clip path is built from, and five thousand elements far beyond any
// shape the canvas can usefully show handles for.
export const SVG_PASTE_TEXT_LENGTH_MAX = 1_000_000;
export const SVG_PASTE_ELEMENTS_MAX = 5_000;
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
// The Shape preset: the shape choosing Shape starts from, which is exactly what
// pasting this SVG writes (ClipPath's presetChoiceActions converts it through the
// paste path, under the default Fit and Size). It is one path of two subpaths: a
// rounded square, and inside it a cut-out of two rounded squares joined at a
// corner. The cut-out winds against the outline, so under the nonzero fill rule
// (the SVG names none, and nonzero is shape()'s default too) it is a hole; the
// converter keeps each subpath's direction, joined by `move to`, so the hole stays.
export const DEFAULT_SHAPE_SVG = [
  '<svg width="83" height="83" viewBox="0 0 83 83" fill="none" xmlns="http://www.w3.org/2000/svg">',
  '<path d="M60.207 0C72.2984 7.10764e-05 82.1006 9.8022 82.1006 21.8936V60.207C82.1005 72.2983 72.2983 82.1005 60.207 82.1006H21.8936C9.80221 82.1006 7.90154e-05 72.2984 0 60.207V21.8936C0 9.80216 9.80216 0 21.8936 0H60.207ZM24.7324 19.293C21.7285 19.293 19.293 21.7285 19.293 24.7324V35.6104C19.293 38.6143 21.7285 41.0498 24.7324 41.0498H35.6104C38.5992 41.0498 41.0254 43.4604 41.0498 46.4434V57.3672C41.0499 60.3709 43.4846 62.8064 46.4883 62.8066H57.3672C60.371 62.8066 62.8066 60.371 62.8066 57.3672V46.4883C62.8064 43.4846 60.3709 41.0499 57.3672 41.0498H46.4766C43.4786 41.0428 41.0498 38.61 41.0498 35.6104V24.7324C41.0498 21.7285 38.6143 19.293 35.6104 19.293H24.7324Z" fill="white"/>',
  '</svg>',
].join('\n');
// DEFAULT_SHAPE_SVG converted with Stretch: the stored form of the preset, from
// which the canvas draws it and Scale is derived. Precomputed, because the converter
// needs a DOM parser that a module may load without; clipPathPaste.test.js pins
// these to the conversion, so they cannot drift from the SVG above.
export const DEFAULT_SHAPE_PATH_DATA =
  'M72.53855421686747 0C87.10650602409639 0.00008563421686746988 98.91638554216867 11.80987951807229 98.91638554216867 26.377831325301205L98.91638554216867 72.53855421686747C98.91626506024096 87.10638554216868 87.10638554216868 98.91626506024096 72.53855421686747 98.91638554216867L26.377831325301205 98.91638554216867C11.809891566265062 98.91638554216867 0.00009519927710843374 87.10650602409639 0 72.53855421686747L0 26.377831325301205C0 11.809831325301205 11.809831325301205 0 26.377831325301205 0L72.53855421686747 0ZM29.798072289156625 23.24457831325301C26.178915662650603 23.24457831325301 23.24457831325301 26.178915662650603 23.24457831325301 29.798072289156625L23.24457831325301 42.90409638554217C23.24457831325301 46.523253012048194 26.178915662650603 49.45759036144578 29.798072289156625 49.45759036144578L42.90409638554217 49.45759036144578C46.50506024096386 49.45759036144578 49.42819277108433 52.36192771084337 49.45759036144578 55.955903614457824L49.45759036144578 69.11710843373493C49.45771084337349 72.73602409638555 52.391084337349405 75.67036144578313 56.010000000000005 75.67060240963855L69.11710843373493 75.67060240963855C72.73614457831326 75.67060240963855 75.67060240963855 72.73614457831326 75.67060240963855 69.11710843373493L75.67060240963855 56.010000000000005C75.67036144578313 52.391084337349405 72.73602409638555 49.45771084337349 69.11710843373493 49.45759036144578L55.99590361445783 49.45759036144578C52.38385542168674 49.449156626506024 49.45759036144578 46.51807228915663 49.45759036144578 42.90409638554217L49.45759036144578 29.798072289156625C49.45759036144578 26.178915662650603 46.523253012048194 23.24457831325301 42.90409638554217 23.24457831325301L29.798072289156625 23.24457831325301Z';
export const DEFAULT_SHAPE_VALUE = [
  'from 72.5% 0%',
  'curve to 98.9% 26.4% with 87.1% 0% / 98.9% 11.8%',
  'line to 98.9% 72.5%',
  'curve to 72.5% 98.9% with 98.9% 87.1% / 87.1% 98.9%',
  'line to 26.4% 98.9%',
  'curve to 0% 72.5% with 11.8% 98.9% / 0% 87.1%',
  'line to 0% 26.4%',
  'curve to 26.4% 0% with 0% 11.8% / 11.8% 0%',
  'line to 72.5% 0%',
  'close',
  'move to 29.8% 23.2%',
  'curve to 23.2% 29.8% with 26.2% 23.2% / 23.2% 26.2%',
  'line to 23.2% 42.9%',
  'curve to 29.8% 49.5% with 23.2% 46.5% / 26.2% 49.5%',
  'line to 42.9% 49.5%',
  'curve to 49.5% 56% with 46.5% 49.5% / 49.4% 52.4%',
  'line to 49.5% 69.1%',
  'curve to 56% 75.7% with 49.5% 72.7% / 52.4% 75.7%',
  'line to 69.1% 75.7%',
  'curve to 75.7% 69.1% with 72.7% 75.7% / 75.7% 72.7%',
  'line to 75.7% 56%',
  'curve to 69.1% 49.5% with 75.7% 52.4% / 72.7% 49.5%',
  'line to 56% 49.5%',
  'curve to 49.5% 42.9% with 52.4% 49.4% / 49.5% 46.5%',
  'line to 49.5% 29.8%',
  'curve to 42.9% 23.2% with 49.5% 26.2% / 46.5% 23.2%',
  'line to 29.8% 23.2%',
  'close',
].join(', ');
