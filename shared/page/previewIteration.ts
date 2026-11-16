// The iteration markers of the dev preview: which item of a loop each rendered
// pass is.
//
// A node inside `cards.map((card) => …)` is rendered once per card, and a
// condition inside the loop can leave the node out of all but one pass. Counting
// copies of the node (the occurrence) then says nothing about which card it is
// in: the lone Image in the third card is copy 0 of 1. So the marked copy of a
// page writes, at the start of every pass of a loop, one comment
// `<!--avb-i:<index>:<loop path>-->` naming the loop (the path its own
// `avb-s:`/`avb-e:` pair carries) and the index of the pass's item in the list
// the loop reads (`cards`), found at render time by looking the item up in that
// list. Looked up, not counted: a loop over `cards.filter(…).sort(…).slice(…)`
// renders its passes in a new order, and the binding picker lists `cards`, so
// the index that matters is the item's place in `cards`. An item that cannot be
// told apart (it appears twice, or is not in the list at all) says -1, which
// reads as "unknown", never as a guess.
//
// This module writes and reads the comment; the frame reads it
// (electron/preload/frameRegions.ts) and the editor maps it onto the loops the
// selected node sits in (src/editor/loopSelection.ts).

import { assert } from '../core/assert';
import { LIMITS } from '../core/limits';
import { loopSourcePath, parseLoopHead } from './loopSource';

/** Comment data that opens an iteration marker. The node markers are `avb-s:` and `avb-e:`. */
export const ITERATION_MARKER_PREFIX = 'avb-i:';

export const ITERATION_LIMITS = {
  /** The most iteration markers a page is read for. */
  marksMax: 20_000,
  /** The most loops one click names, outermost to innermost. */
  loopsMax: 16,
} as const;

/** The item `index` of the list the loop at `path` reads; -1 when the render could not say. */
export interface PreviewIteration {
  readonly path: string;
  readonly index: number;
}

const MARKER = /^avb-i:(-?\d{1,9}):([\s\S]+)$/;

/** The iteration a comment says, or undefined when it is not an iteration marker. */
export function parseIterationMarker(data: string): PreviewIteration | undefined {
  assert(data.length <= LIMITS.attrCharsMax, 'parseIterationMarker: comment data is bounded');
  const match = MARKER.exec(data);
  const index = match?.[1];
  const path = match?.[2];
  if (index === undefined || path === undefined) {
    return undefined;
  }
  const parsed = Number(index);
  if (!Number.isSafeInteger(parsed) || parsed < -1) {
    return undefined;
  }
  return { path, index: parsed };
}

/** The comment text for an iteration, as `parseIterationMarker` reads it back. */
export function iterationMarkerData(path: string, index: number): string {
  assert(path.length > 0, 'iterationMarkerData: a loop has a path');
  assert(Number.isSafeInteger(index), 'iterationMarkerData: an index is an integer');
  assert(index >= -1, 'iterationMarkerData: an index is an item place, or -1');
  return `${ITERATION_MARKER_PREFIX}${index}:${path}`;
}

/**
 * The JavaScript expression, for the marked page's `set:html` of a loop's
 * pass, that renders the iteration comment. Undefined when the loop's list is
 * not a value the page names (a call, a literal): there is no list to find the
 * item in, and so nothing the editor could point at.
 *
 * The lookup runs in the page's own render, inside the loop's callback where
 * the item is in scope, and cannot throw into it: whatever goes wrong says -1.
 */
export function iterationMarkerExpression(loopHead: string, loopPath: string): string | undefined {
  assert(loopPath.length > 0, 'iterationMarkerExpression: a loop has a path');
  const head = parseLoopHead(loopHead);
  if (head === undefined) {
    return undefined;
  }
  const source = loopSourcePath(head.source);
  if (source === undefined) {
    return undefined;
  }
  const list = source.kind === 'values' ? `Object.values(${source.path})` : source.path;
  const tail = JSON.stringify(`:${loopPath}-->`);
  // A list the item appears in twice is not told apart by position.
  const lookup = `(() => { try { const list = ${list}; const at = list.indexOf(${head.item}); return at === list.lastIndexOf(${head.item}) ? at : -1; } catch { return -1; } })()`;
  const expression = `${JSON.stringify(`<!--${ITERATION_MARKER_PREFIX}`)} + ${lookup} + ${tail}`;
  assert(expression.length < LIMITS.attrCharsMax, 'iterationMarkerExpression: the expression is bounded');
  return expression;
}
