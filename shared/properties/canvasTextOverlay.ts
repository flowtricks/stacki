import { pathText, record } from '../core/boundary';
import { CANVAS_TEXT_LIMIT } from './canvasText';

// The host receives editing state only; the browser owns the text and caret.
export type CanvasTextOverlayEvent =
  | { readonly type: 'avb:text-active'; readonly session: string; readonly key: string }
  | { readonly type: 'avb:text-inactive'; readonly session: string };

export function parseCanvasTextOverlay(input: unknown): CanvasTextOverlayEvent | undefined {
  const data = record(input);
  if (data['type'] === 'avb:text-active') {
    return {
      type: 'avb:text-active',
      session: pathText(data['session']),
      key: pathText(data['key']),
    };
  }
  if (data['type'] === 'avb:text-inactive') {
    return { type: 'avb:text-inactive', session: pathText(data['session']) };
  }
  return undefined;
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
