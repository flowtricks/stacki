import { useEffect, useRef, useState } from 'react';
import { UNKNOWN_PUBLISH_AVAILABILITY, type DesktopPublishState, type PublishAvailability } from '../../../shared/properties/publishState';
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
  const [availability, setAvailability] = useState<PublishAvailability>(UNKNOWN_PUBLISH_AVAILABILITY);
  const requestRefresh = useRef<() => void>(() => undefined);
  useEffect(() => {
    let active = true;
    const coordinator = createCoalescedRun(async () => {
      if (!active) {
        return;
      }
      const result = await readPublishAvailability(projectPath);
      // A failed check cannot prove that either destination is current.
      const next = result.ok ? result.value : UNKNOWN_PUBLISH_AVAILABILITY;
      if (active && !coordinator.superseded()) {
        setAvailability(next);
      }
    });
    const refresh = () => void coordinator.request();
    const invalidate = () => {
      setAvailability(UNKNOWN_PUBLISH_AVAILABILITY);
      refresh();
    };
    requestRefresh.current = invalidate;
    const stopFiles = onFilesChanged(invalidate);
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
      stopFiles();
      stopAssets();
      stopContent();
      stopStyles();
      stopReturn();
    };
  }, [projectPath]);
  useEffect(() => {
    requestRefresh.current();
  }, [projectPath, phase, saveState, repository, settingsRevision]);
  // A draft not yet on disk must not inherit a previous successful status check.
  if (saveState !== undefined && saveState.tag !== 'clean') {
    return {
      github: 'pending',
      hosting: availability.hosting === 'unconfigured' ? 'unconfigured' : 'pending',
    };
  }
  return availability;
}
