import { list, pathText, record } from '../core/boundary';
import { assert } from '../core/assert';
import { CANVAS_TEXT_LIMIT } from './canvasText';

// The host receives editing state only; the browser owns the text and caret.
export type CanvasTextOverlayEvent =
  | {
      readonly type: 'avb:text-active';
      readonly session: string;
      readonly key: string;
      /** The editing element's box in the frame's own pixels, so the host can anchor a cue to it. Absent from an older frame. */
      readonly rect?: CanvasTextBox;
      /** The block editor, which draws its own cue in the page (frameTextEditing.ts). */
      readonly blocks?: true;
    }
  | { readonly type: 'avb:text-inactive'; readonly session: string };

/** A box in the frame's viewport pixels. */
export interface CanvasTextBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export function parseCanvasTextOverlay(input: unknown): CanvasTextOverlayEvent | undefined {
  const data = record(input);
  if (data['type'] === 'avb:text-active') {
    return {
      type: 'avb:text-active',
      session: pathText(data['session']),
      key: pathText(data['key']),
      ...(data['rect'] === undefined ? {} : { rect: parseBox(data['rect']) }),
      ...(data['blocks'] === true ? { blocks: true as const } : {}),
    };
  }
  if (data['type'] === 'avb:text-inactive') {
    return { type: 'avb:text-inactive', session: pathText(data['session']) };
  }
  return undefined;
}

// The selected node's page path. Text a page hands to a component instance
// (its slot content, its props) is marked as editable only while that
// instance is the selection — not while something inside it is.
export interface CanvasTextFocus {
  readonly type: 'avb:text-focus';
  readonly paths: readonly string[];
  /** The selected copy of the node, for one in a loop: the same number the selection outline is drawn on. Undefined means every copy. */
  readonly occurrence?: number;
}

// A selection is never deeper than this; a longer list is not a selection.
export const CANVAS_FOCUS_PATHS_MAX = 256;

// A copy's number is its place among a node's copies on the page, which the page's node count bounds.
const CANVAS_FOCUS_COPY_MAX = 100_000;

function isCopyIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= CANVAS_FOCUS_COPY_MAX;
}

export function canvasTextFocus(paths: readonly string[], occurrence?: number): CanvasTextFocus {
  assert(paths.length <= CANVAS_FOCUS_PATHS_MAX, 'Canvas text focus stays within its bound');
  assert(!paths.includes(''), 'Canvas text focus names real paths');
  if (occurrence === undefined) {
    return { type: 'avb:text-focus', paths };
  }
  assert(isCopyIndex(occurrence), 'Canvas text focus names a whole copy from the first');
  return { type: 'avb:text-focus', paths, occurrence };
}

export function parseCanvasTextFocus(input: unknown): CanvasTextFocus | undefined {
  const data = record(input);
  if (data['type'] !== 'avb:text-focus') {
    return undefined;
  }
  const paths = list(pathText)(data['paths']);
  if (paths.length > CANVAS_FOCUS_PATHS_MAX) {
    throw new Error('Canvas text focus exceeds limit');
  }
  const focus = { type: 'avb:text-focus', paths: paths.filter((path) => path !== '') } as const;
  const occurrence = data['occurrence'];
  if (occurrence === undefined) {
    return focus;
  }
  if (!isCopyIndex(occurrence)) {
    throw new Error('Canvas text focus names no copy');
  }
  return { ...focus, occurrence };
}

export function parseCanvasTextClose(input: unknown) {
  const data = record(input);
  if (data['type'] !== 'avb:text-close') {
    return undefined;
  }
  if (data['action'] !== 'apply' && data['action'] !== 'cancel') {
    throw new Error('Expected text editing close action');
  }
  return { session: pathText(data['session']), action: data['action'] } as const;
}

// The words selected in an open canvas text editor, so the host can offer the
// same formatting as the Settings Content field. Offsets index the editor's
// text value; the box is in the frame's viewport pixels. No range means
// nothing is selected (a bare caret, or the selection left the text).
export interface CanvasTextSelectionRange {
  readonly start: number;
  readonly end: number;
  readonly rect: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  };
}
export interface CanvasTextSelection {
  readonly type: 'avb:text-selection';
  readonly session: string;
  readonly key: string;
  readonly range: CanvasTextSelectionRange | undefined;
}

// A frame is at most this many pixels in any direction; anything past it is
// not a box on the page.
const SELECTION_PIXELS_MAX = 1_000_000;

export function parseCanvasTextSelection(input: unknown): CanvasTextSelection | undefined {
  const data = record(input);
  if (data['type'] !== 'avb:text-selection') {
    return undefined;
  }
  const session = pathText(data['session']);
  const key = pathText(data['key']);
  if (data['range'] === undefined) {
    return { type: 'avb:text-selection', session, key, range: undefined };
  }
  return { type: 'avb:text-selection', session, key, range: parseSelectionRange(data['range']) };
}

function parseSelectionRange(input: unknown): CanvasTextSelectionRange {
  const data = record(input);
  const start = selectionOffset(data['start']);
  const end = selectionOffset(data['end']);
  if (start >= end) {
    throw new Error('Expected a non-empty text selection');
  }
  const rect = record(data['rect']);
  return {
    start,
    end,
    rect: {
      x: selectionPixels(rect['x']),
      y: selectionPixels(rect['y']),
      w: selectionSize(rect['w']),
      h: selectionSize(rect['h']),
    },
  };
}

function parseBox(input: unknown): CanvasTextBox {
  const data = record(input);
  return { x: selectionPixels(data['x']), y: selectionPixels(data['y']), w: selectionSize(data['w']), h: selectionSize(data['h']) };
}

function selectionOffset(input: unknown): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input)) {
    throw new Error('Expected a text offset');
  }
  if (input < 0 || input > CANVAS_TEXT_LIMIT) {
    throw new Error('Text offset is outside the editing limit');
  }
  return input;
}

function selectionPixels(input: unknown): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    throw new Error('Expected a selection coordinate');
  }
  if (Math.abs(input) > SELECTION_PIXELS_MAX) {
    throw new Error('Selection coordinate is off the page');
  }
  return input;
}

function selectionSize(input: unknown): number {
  const size = selectionPixels(input);
  if (size < 0) {
    throw new Error('Expected a non-negative selection size');
  }
  return size;
}
