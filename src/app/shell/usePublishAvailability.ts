import { useCallback, useEffect, useRef } from 'react';
import type { DesktopPublishState, PublishAvailability } from '../../../shared/properties/publishState';
import { PUBLISH_EVENT_QUIET_MS, publishRelevantChange } from '../../../shared/properties/publishAvailabilityMemory';
import { useConfirmedAvailability } from '../../features/publishing/useConfirmedAvailability';
import { readPublishAvailability } from '../../features/publishing/publishBridge';
import { onFilesChanged, onCmsInventoryChanged } from '../../ipc/appBridge';
import { onAssetEntriesChanged } from '../../ipc/assetBridge';
import { onVariablesChanged } from '../../ipc/editorEnvironment';
import { createCoalescedRun } from '../../lib/coalescedRun';
import { onWindowReturn } from '../../lib/windowReturn';
import type { SaveState } from '../../editor/saveState';
import type { IpcResults } from '../../../shared/ipc/ipcResults';

export function usePublishAvailability(
  projectPath: string,
  phase: DesktopPublishState['kind'],
  saveState: SaveState | undefined,
  repository?: IpcResults['git:info'],
  settingsRevision = 0,
): PublishAvailability {
  const requestRefresh = useRef<() => void>(() => undefined);
  const confirmAgain = useCallback(() => requestRefresh.current(), []);
  const { availability, report } = useConfirmedAvailability(confirmAgain);
  useEffect(() => {
    let active = true;
    const coordinator = createCoalescedRun(async () => {
      if (!active) {
        return;
      }
      const result = await readPublishAvailability(projectPath);
      // A failed check proves nothing, and a result a newer check supersedes is never shown.
      if (active && !coordinator.superseded()) {
        report(result.ok ? { kind: 'checked', result: result.value } : { kind: 'failed' });
      }
    });
    const refresh = () => void coordinator.request();
    // An event only asks for a check. The button keeps drawing the last confirmed answer until that check replies.
    requestRefresh.current = refresh;
    // A burst of events costs one check: the check starts once the burst has been quiet for a moment.
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const invalidate = () => {
      clearTimeout(quiet);
      quiet = setTimeout(refresh, PUBLISH_EVENT_QUIET_MS);
    };
    const stopFiles = onFilesChanged((event) => {
      // Generated files and editor scratch files cannot change what Publish sends.
      if (publishRelevantChange(event.files)) {
        invalidate();
      }
    });
    const stopAssets = onAssetEntriesChanged(invalidate);
    const stopContent = onCmsInventoryChanged(invalidate);
    const stopStyles = onVariablesChanged(invalidate);
    const stopReturn = onWindowReturn(invalidate);
    // Also catch commits and pushes made outside the editor; only one check runs at a time.
    const timer = setInterval(refresh, 15_000);
    return () => {
      active = false;
      requestRefresh.current = () => undefined;
      clearInterval(timer);
      clearTimeout(quiet);
      stopFiles();
      stopAssets();
      stopContent();
      stopStyles();
      stopReturn();
    };
  }, [projectPath, report]);
  useEffect(() => {
    requestRefresh.current();
  }, [projectPath, phase, saveState, repository, settingsRevision]);
  return availability;
}
