// The last canvas clicks and what became of each, kept in memory only: no
// disk, no network, no telemetry. When someone hits a canvas that will not
// select, the notice they see offers "Copy details", which copies this log as
// text, so they can paste it into a message and the cause is in front of us
// instead of guessed at (docs/canvas-click.md).
//
// Module state on purpose: one renderer has one canvas log, written by the
// click ladder (canvasClickRetry.ts) and read by the notice. Bounded: past
// CANVAS_CLICK_LOG_ENTRIES_MAX the oldest entry goes.
import { assert } from '../../../shared/core/assert';

export const CANVAS_CLICK_LOG_ENTRIES_MAX = 64;

/** How one click ended, or the step it took on the way. Stable codes. */
export const CANVAS_CLICK_OUTCOMES = [
  'selected',
  'retrying',
  'reloaded',
  'selected-page',
  'dropped',
  'gave-up',
  'replaced',
  'render-problem',
  'refused',
] as const;
export type CanvasClickOutcome = (typeof CANVAS_CLICK_OUTCOMES)[number];

export interface CanvasClickEntry {
  /** Milliseconds since the renderer started (performance.now), so entries compare without a wall clock. */
  readonly atMs: number;
  readonly outcome: CanvasClickOutcome;
  /** The problem's stable code (canvasClickProblemCode), or what the frame reported. */
  readonly code: string | undefined;
  /** Fresh looks taken before this entry. */
  readonly attempt: number;
}

const entries: CanvasClickEntry[] = [];

export function recordCanvasClick(entry: CanvasClickEntry): void {
  assert(Number.isFinite(entry.atMs), 'A click is logged at a finite time');
  assert(Number.isSafeInteger(entry.attempt), 'A click counts its attempts in whole numbers');
  entries.push(entry);
  if (CANVAS_CLICK_LOG_ENTRIES_MAX < entries.length) {
    entries.splice(0, entries.length - CANVAS_CLICK_LOG_ENTRIES_MAX);
  }
  assert(entries.length <= CANVAS_CLICK_LOG_ENTRIES_MAX, 'The click log stays inside its bound');
}

export function canvasClickEntries(): readonly CanvasClickEntry[] {
  return [...entries];
}

/** The log as plain text, oldest first: one line per entry. Names no file, path or page content. */
export function canvasClickLogText(): string {
  const lines = entries.map(
    (entry) => `${Math.round(entry.atMs)}ms ${entry.outcome}${entry.code === undefined ? '' : ` ${entry.code}`} attempt=${entry.attempt}`,
  );
  return ['Stacki canvas clicks (most recent last)', ...lines].join('\n');
}

/** Empties the log (tests, and nothing else). */
export function clearCanvasClickLog(): void {
  entries.length = 0;
}
