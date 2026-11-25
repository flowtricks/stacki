// The stage trace for edits made in the app (shared/core/stageTrace.ts), off unless asked for.
// Turn it on from the console with `localStorage.setItem('stacki.trace', 'edits')` and reload; read it
// with `window.stackiEditTrace()`. Off, every call is the shared no-op and costs a call.

import { createStageTrace, stageDurations, STAGE_TRACE_OFF, type StageTrace } from '../../shared/core/stageTrace';

function requested(): boolean {
  try {
    return window.localStorage.getItem('stacki.trace') === 'edits';
  } catch {
    return false;
  }
}

const epochMs = (): number => performance.timeOrigin + performance.now();

export const editTrace: StageTrace = requested() ? createStageTrace({ enabled: true, clock: epochMs }) : STAGE_TRACE_OFF;

if (editTrace.enabled) {
  Object.defineProperty(window, 'stackiEditTrace', {
    configurable: true,
    value: () => editTrace.runs().map((run) => ({ label: run.label, stages: stageDurations(run) })),
  });
}
