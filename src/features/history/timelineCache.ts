// The history timeline's first page per project, branch and head, in its own
// module so the app can fill it before the Git panel first opens
// (panelPrefetch.ts), and so tests that stub the timeline still reach it.
import { createPanelCache, prewarmPanelCache } from '../../lib/usePanelData';
import { readHistoryLog, type HistoryLog } from './historyBridge';

export const timelineCache = createPanelCache<HistoryLog>();

/** The cache entry for one view of the timeline: `reference` undefined is every branch. */
export function timelineKey(projectPath: string, branch: string | undefined, head: string | undefined, reference: string | undefined): string {
  return JSON.stringify([projectPath, branch, head, reference]);
}

/** Reads the newest commits on every branch, the view the panel opens on. */
export function prewarmTimeline(projectPath: string, branch: string | undefined, head: string | undefined): Promise<void> {
  return prewarmPanelCache(timelineCache, timelineKey(projectPath, branch, head, undefined), () => readHistoryLog(projectPath, 0));
}
