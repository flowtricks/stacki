// What the canvas frame says about a drag (electron/preload/frameDrag.ts), parsed at the boundary.
//
// The frame runs inside the project's page, so a message from it is input like any other: a page script can post
// anything with the same `type`. Each message is checked whole and refused whole: a coordinate that is not a
// finite number of pixels within reach, a path that is not a node path, a level list past the tree's depth or a
// child list past one probe's bound is no drag message at all. A refused message changes nothing; the next good
// one carries the whole state again.

import { LIMITS } from '../../../shared/core/limits';
import { DROP_FLOWS, type DropFlow, type DropRect } from '../../editor/canvasDrop';

export const CANVAS_DRAG_LIMITS = {
  /** A coordinate past this is not a point on any page (APP_RPC_LIMITS.coordinatePxMax). */
  coordinatePxMax: 1_000_000,
  /** Levels in one probe: the tree's depth, plus the file's root list. */
  levelsMax: LIMITS.treeDepthMax + 1,
  /** Children of one level, and boxes of the dragged node, in one probe (frameDrag.ts FRAME_DRAG_LIMITS.childrenMax). */
  childrenMax: 256,
  /** Characters in a node path: a file's namespace and the indexes under it. */
  pathCharsMax: LIMITS.ipcPathCharsMax,
} as const satisfies Record<string, number>;

export interface CanvasDragLevel {
  /** The node's path; '' for the open file's root list. */
  readonly path: string;
  readonly box: DropRect;
  readonly content: DropRect;
  readonly flow: DropFlow;
  readonly children: readonly { readonly path: string; readonly box: DropRect }[] | undefined;
}

export type CanvasDragSource = 'pointer' | 'native';

export type CanvasDragMessage =
  | { readonly kind: 'drag-start'; readonly path: string; readonly occurrence: number; readonly x: number; readonly y: number }
  | {
      readonly kind: 'drag-over';
      readonly source: CanvasDragSource;
      readonly x: number;
      readonly y: number;
      readonly outside: boolean;
      readonly levels: readonly CanvasDragLevel[];
      readonly dragged: readonly DropRect[];
    }
  | { readonly kind: 'drag-end'; readonly source: CanvasDragSource; readonly x: number; readonly y: number; readonly outside: boolean }
  | { readonly kind: 'drag-cancel'; readonly reason: 'escape' | 'interrupted' };

const NODE_PATH = /^(?:[^|\0]{1,512}\|)?\d+(?:\.\d+)*$/;

/** The drag message `value` holds, or undefined for anything else, including a malformed one. Total. */
export function parseCanvasDragMessage(value: Readonly<Record<string, unknown>>): CanvasDragMessage | undefined {
  switch (value['type']) {
    case 'avb:drag-start': {
      const path = nodePath(value['path']);
      const occurrence = value['occurrence'];
      const x = coordinate(value['x']);
      const y = coordinate(value['y']);
      if (path === undefined || x === undefined || y === undefined) {
        return undefined;
      }
      if (typeof occurrence !== 'number' || !Number.isSafeInteger(occurrence) || occurrence < 0) {
        return undefined;
      }
      return { kind: 'drag-start', path, occurrence, x, y };
    }
    case 'avb:drag-over':
      return parseOver(value);
    case 'avb:drag-end': {
      const source = sourceOf(value['source']);
      const x = coordinate(value['x']);
      const y = coordinate(value['y']);
      const outside = value['outside'];
      if (source === undefined || x === undefined || y === undefined || typeof outside !== 'boolean') {
        return undefined;
      }
      return { kind: 'drag-end', source, x, y, outside };
    }
    case 'avb:drag-cancel': {
      const reason = value['reason'];
      return reason === 'escape' || reason === 'interrupted' ? { kind: 'drag-cancel', reason } : undefined;
    }
    default:
      return undefined;
  }
}

function parseOver(value: Readonly<Record<string, unknown>>): CanvasDragMessage | undefined {
  const source = sourceOf(value['source']);
  const x = coordinate(value['x']);
  const y = coordinate(value['y']);
  const outside = value['outside'];
  const levels = boundedArray(value['levels'], CANVAS_DRAG_LIMITS.levelsMax);
  const dragged = boundedArray(value['dragged'], CANVAS_DRAG_LIMITS.childrenMax);
  if (source === undefined || x === undefined || y === undefined || typeof outside !== 'boolean' || levels === undefined || dragged === undefined) {
    return undefined;
  }
  const parsedLevels: CanvasDragLevel[] = [];
  for (const level of levels) {
    const parsed = parseLevel(level);
    if (parsed === undefined) {
      return undefined;
    }
    parsedLevels.push(parsed);
  }
  const parsedDragged: DropRect[] = [];
  for (const box of dragged) {
    const parsed = rect(box);
    if (parsed === undefined) {
      return undefined;
    }
    parsedDragged.push(parsed);
  }
  return { kind: 'drag-over', source, x, y, outside, levels: parsedLevels, dragged: parsedDragged };
}

function parseLevel(input: unknown): CanvasDragLevel | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return undefined;
  }
  const rawPath: unknown = Reflect.get(input, 'path');
  const path = rawPath === '' ? '' : nodePath(rawPath);
  const box = rect(Reflect.get(input, 'box'));
  const content = rect(Reflect.get(input, 'content'));
  const flow = flowOf(Reflect.get(input, 'flow'));
  if (path === undefined || box === undefined || content === undefined || flow === undefined) {
    return undefined;
  }
  const rawChildren: unknown = Reflect.get(input, 'children');
  if (rawChildren === undefined) {
    return { path, box, content, flow, children: undefined };
  }
  const items = boundedArray(rawChildren, CANVAS_DRAG_LIMITS.childrenMax);
  if (items === undefined) {
    return undefined;
  }
  const children: { readonly path: string; readonly box: DropRect }[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) {
      return undefined;
    }
    const childPath = nodePath(Reflect.get(item, 'path'));
    const childBox = rect(Reflect.get(item, 'box'));
    if (childPath === undefined || childBox === undefined) {
      return undefined;
    }
    children.push({ path: childPath, box: childBox });
  }
  return { path, box, content, flow, children };
}

function boundedArray(input: unknown, max: number): readonly unknown[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  return input.length <= max ? input : undefined;
}

function sourceOf(input: unknown): CanvasDragSource | undefined {
  return input === 'pointer' || input === 'native' ? input : undefined;
}

function flowOf(input: unknown): DropFlow | undefined {
  return DROP_FLOWS.find((flow) => flow === input);
}

function nodePath(input: unknown): string | undefined {
  if (typeof input !== 'string') {
    return undefined;
  }
  if (input.length > CANVAS_DRAG_LIMITS.pathCharsMax) {
    return undefined;
  }
  return NODE_PATH.test(input) ? input : undefined;
}

function coordinate(input: unknown): number | undefined {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return undefined;
  }
  return Math.abs(input) <= CANVAS_DRAG_LIMITS.coordinatePxMax ? input : undefined;
}

function rect(input: unknown): DropRect | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  const x = coordinate(Reflect.get(input, 'x'));
  const y = coordinate(Reflect.get(input, 'y'));
  const width = coordinate(Reflect.get(input, 'w'));
  const height = coordinate(Reflect.get(input, 'h'));
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  if (width < 0 || height < 0) {
    return undefined;
  }
  return { x, y, w: width, h: height };
}
