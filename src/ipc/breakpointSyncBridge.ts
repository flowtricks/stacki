// The renderer's side of the breakpoint sync (Settings > Breakpoints): scan the project for the media queries that equal a breakpoint's
// old value, write the places the person kept, and put a sync back or forward again. Only Desktop has the project's files in reach
// of Settings; where the preload does not offer the calls (Studio) every function answers that it is unavailable, never throws.
import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import {
  parseSyncApplied,
  parseSyncRestored,
  parseSyncScanAnswer,
  type BreakpointSyncApplied,
  type BreakpointSyncApply,
  type BreakpointSyncScanAnswer,
  type SyncRestoreDirection,
} from '../../shared/properties/breakpointSyncPlan';
import type { Breakpoint } from '../../shared/properties/projectBreakpoints';

const UNAVAILABLE = 'Syncing media queries is only available in the desktop app.';

/** Whether this window can scan and write the project's files. */
export function breakpointSyncAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.avb?.scanBreakpointSync === 'function';
}

export async function scanBreakpointSyncRequest(
  projectPath: string,
  request: { readonly key: string; readonly old: Pick<Breakpoint, 'direction' | 'setting'>; readonly next: Pick<Breakpoint, 'direction' | 'setting'> },
): Promise<BreakpointSyncScanAnswer> {
  if (!breakpointSyncAvailable()) {
    return { ok: false, error: UNAVAILABLE };
  }
  const payload = parseIpcPayload('breakpointSync:scan', {
    projectPath,
    id: request.key,
    old: { direction: request.old.direction, ...request.old.setting },
    next: { direction: request.next.direction, ...request.next.setting },
  });
  return parseSyncScanAnswer(await window.avb.scanBreakpointSync(payload));
}

export async function applyBreakpointSyncRequest(request: BreakpointSyncApply): Promise<BreakpointSyncApplied> {
  if (!breakpointSyncAvailable()) {
    return { ok: false, places: 0, files: 0, skipped: [], journalId: undefined, error: UNAVAILABLE };
  }
  return parseSyncApplied(await window.avb.applyBreakpointSync(parseIpcPayload('breakpointSync:apply', request)));
}

export async function restoreBreakpointSyncRequest(
  projectPath: string,
  journalId: string,
  direction: SyncRestoreDirection,
): Promise<{ readonly ok: boolean; readonly error?: string | undefined }> {
  if (!breakpointSyncAvailable()) {
    return { ok: false, error: UNAVAILABLE };
  }
  const answer = parseSyncRestored(await window.avb.restoreBreakpointSync(parseIpcPayload('breakpointSync:restore', { projectPath, journalId, direction })));
  return { ok: answer.ok, error: answer.error };
}
