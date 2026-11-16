// What to do when the app window fails: reload it, or stop and show the recovery screen.
//
// A window that fails to load, loses its renderer process or hangs is a black or frozen window unless something acts.
// Reloading fixes the transient causes (a dev server that was not up yet, a one-off crash). Reloading forever hides the
// permanent ones behind a flicker, so the reload is bounded: at most `reloadsMax` reloads inside `reloadWindowMs`, and
// the next failure shows the recovery screen instead. This module is the decision, pure and clock-free (the caller
// passes the time), so the loop guard is tested without a window. electron/app/windowRecovery.ts connects it to Electron.
import { assert } from '../../shared/core/assert';
import type { CrashRecord } from './crashLog';

export const WINDOW_HEALTH_LIMITS = {
  /** Automatic reloads allowed inside one window of time before the recovery screen takes over. */
  reloadsMax: 3,
  /** The span the reloads are counted over. A window that then ran healthy for longer starts again with a full allowance. */
  reloadWindowMs: 60_000,
  /** How long the window may stay unresponsive before it is restarted. Long enough for a heavy page, short of a stuck app. */
  unresponsiveMsMax: 30_000,
} as const satisfies Record<string, number>;

export type HealthEvent =
  | { readonly kind: 'load-failed'; readonly code: number; readonly description: string; readonly url: string }
  | { readonly kind: 'renderer-gone'; readonly reason: string; readonly exitCode: number }
  | { readonly kind: 'unresponsive' }
  | { readonly kind: 'responsive' }
  | { readonly kind: 'unresponsive-too-long' }
  | { readonly kind: 'child-gone'; readonly processType: string; readonly reason: string; readonly exitCode: number }
  | { readonly kind: 'reload-requested' };

/** What failed, without the loop guard around it. */
export type RecoveryCause =
  { readonly kind: 'load-failed'; readonly code: number; readonly description: string } | { readonly kind: 'renderer-gone'; readonly reason: string };

export type RecoveryReason = RecoveryCause | { readonly kind: 'loop-guard'; readonly reloads: number; readonly cause: RecoveryCause };

export type HealthDecision =
  | { readonly action: 'ignore' }
  | { readonly action: 'record-only' }
  | { readonly action: 'reload' }
  | { readonly action: 'restart-renderer' }
  | { readonly action: 'show-recovery'; readonly reason: RecoveryReason };

export interface HealthState {
  /** When each automatic reload inside the window happened. */
  readonly reloadsAtMs: readonly number[];
  /** True once the recovery screen is up: further failures are recorded, not acted on, until the person reloads. */
  readonly recovering: boolean;
}

export interface HealthStep {
  readonly state: HealthState;
  readonly decision: HealthDecision;
  /** What the crash log keeps for this event, when it is worth keeping. */
  readonly record: Pick<CrashRecord, 'source' | 'reason' | 'detail'> | undefined;
}

export const HEALTHY: HealthState = { reloadsAtMs: [], recovering: false };

/** Chromium's "this navigation was replaced by another one" (a page switch), which is not a failure. */
const NAVIGATION_ABORTED = -3;

/** The next state and decision for `event` at `nowMs`. Pure. */
export function decideHealth(state: HealthState, event: HealthEvent, nowMs: number): HealthStep {
  assert(Number.isFinite(nowMs), 'Window health is judged at a time');
  assert(state.reloadsAtMs.length <= WINDOW_HEALTH_LIMITS.reloadsMax, 'The reload history stays inside its bound');
  switch (event.kind) {
    case 'load-failed': {
      if (event.code === NAVIGATION_ABORTED) {
        return { state, decision: { action: 'ignore' }, record: undefined };
      }
      return failure(
        state,
        { kind: 'load-failed', code: event.code, description: event.description },
        { source: 'load-failed', reason: `${event.description} (${event.code})`, detail: event.url },
        nowMs,
      );
    }
    case 'renderer-gone': {
      // A renderer that exited cleanly was closed on purpose (the window is going away).
      if (event.reason === 'clean-exit') {
        return { state, decision: { action: 'ignore' }, record: undefined };
      }
      return failure(
        state,
        { kind: 'renderer-gone', reason: event.reason },
        { source: 'renderer-gone', reason: event.reason, detail: `exit code ${event.exitCode}` },
        nowMs,
      );
    }
    case 'unresponsive':
      return { state, decision: { action: 'record-only' }, record: { source: 'unresponsive', reason: 'unresponsive', detail: '' } };
    case 'responsive':
      return { state, decision: { action: 'record-only' }, record: undefined };
    case 'unresponsive-too-long':
      // Restarting the renderer makes it report `renderer-gone`, which goes through the loop guard like any crash.
      return state.recovering
        ? { state, decision: { action: 'ignore' }, record: undefined }
        : { state, decision: { action: 'restart-renderer' }, record: undefined };
    case 'child-gone':
      // Electron restarts a helper process (the GPU process, a utility) itself; the window keeps working.
      return {
        state,
        decision: { action: 'record-only' },
        record: { source: 'child-gone', reason: `${event.processType}: ${event.reason}`, detail: `exit code ${event.exitCode}` },
      };
    case 'reload-requested':
      // The person pressed Reload on the recovery screen: a fresh allowance.
      return { state: HEALTHY, decision: { action: 'reload' }, record: undefined };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

// A failure that needs the window back: reload while the allowance lasts, then recover.
function failure(state: HealthState, cause: RecoveryCause, record: NonNullable<HealthStep['record']>, nowMs: number): HealthStep {
  if (state.recovering) {
    return { state, decision: { action: 'record-only' }, record };
  }
  const recent = state.reloadsAtMs.filter((at) => nowMs - at < WINDOW_HEALTH_LIMITS.reloadWindowMs);
  if (recent.length < WINDOW_HEALTH_LIMITS.reloadsMax) {
    const reloads = [...recent, nowMs];
    assert(reloads.length <= WINDOW_HEALTH_LIMITS.reloadsMax, 'A reload is only allowed inside the bound');
    return { state: { reloadsAtMs: reloads, recovering: false }, decision: { action: 'reload' }, record };
  }
  const reason: RecoveryReason = { kind: 'loop-guard', reloads: recent.length, cause };
  return {
    state: { reloadsAtMs: recent, recovering: true },
    decision: { action: 'show-recovery', reason },
    record: { source: 'reload-loop', reason: `${recent.length} reloads in ${WINDOW_HEALTH_LIMITS.reloadWindowMs} ms`, detail: record.reason },
  };
}
