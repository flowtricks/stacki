// Milestones of the main process's start, as durations since the process began: when the app was
// ready, when the window existed, when its first frame painted. One debug line says them all, so a
// slow start can be told apart from a slow machine without a profiler (docs/startup.md).
//
// Durations only, in whole milliseconds: no paths, names or other person-specific values. The marks
// are bounded (STARTUP_MARKS_MAX) and each name is recorded once, so the table cannot grow.
import { assert } from '../../shared/core/assert';

/** The most milestones one process records; a start has about eight. */
export const STARTUP_MARKS_MAX = 24;

export type StartupMark = 'appReady' | 'settingsRead' | 'menuBuilt' | 'windowCreated' | 'rendererLoading' | 'windowShown' | 'rendererLoaded';

const marks = new Map<StartupMark, number>();

/** Records `name` once, as milliseconds since the process started. Later calls for the same name are ignored. */
export function markStartup(name: StartupMark): void {
  assert(marks.size < STARTUP_MARKS_MAX, 'startupTiming: the milestone table is bounded');
  if (marks.has(name)) {
    return;
  }
  const sinceStartMs = Math.round(process.uptime() * 1000);
  assert(Number.isFinite(sinceStartMs), 'startupTiming: process uptime is a number');
  marks.set(name, sinceStartMs);
}

/** The milestones so far, in the order they happened. */
export function startupMarks(): ReadonlyArray<readonly [StartupMark, number]> {
  return [...marks.entries()];
}

/** One line of durations, for the debug log. */
export function describeStartup(): string {
  return `[startup] ${startupMarks()
    .map(([name, ms]) => `${name}=${ms}ms`)
    .join(' ')}`;
}
