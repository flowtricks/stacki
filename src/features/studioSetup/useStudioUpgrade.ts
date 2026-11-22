import { useEffect, useReducer, useRef } from 'react';
import { cleanError } from '../../lib/cleanError';
import { onStudioProgress, readStudioUpgradeCheck, restoreStudio, upgradeStudio } from './studioBridge';
import { UPGRADE_INITIAL, canStartUpgrade, reduceUpgrade, restorableNote } from './upgradeState';

// Reads whether a newer Studio exists and runs the upgrade or the restore. `onChanged` lets the box refresh the installed version.
export function useStudioUpgrade(projectPath: string, installedVersion: string, onChanged: () => void) {
  const [state, dispatch] = useReducer(reduceUpgrade, UPGRADE_INITIAL);
  const activeRequest = useRef<string | undefined>(undefined);
  const unsubscribe = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    let live = true;
    readStudioUpgradeCheck(projectPath).then(
      (check) => live && dispatch({ type: 'checked', check }),
      // A failed check is quiet: the box simply offers nothing.
      () => live && dispatch({ type: 'checked', check: { kind: 'unavailable' } }),
    );
    return () => {
      live = false;
    };
  }, [projectPath, installedVersion]);
  useEffect(
    () => () => {
      unsubscribe.current?.();
      activeRequest.current = undefined;
    },
    [],
  );
  const start = async () => {
    if (!canStartUpgrade(state) || activeRequest.current !== undefined) {
      return;
    }
    const requestId = crypto.randomUUID();
    activeRequest.current = requestId;
    dispatch({ type: 'start', requestId, progress: { projectPath, requestId, stage: 'release', output: '' } });
    // Subscribe before invoking so an immediate first snapshot cannot be missed.
    unsubscribe.current = onStudioProgress((progress) => {
      if (progress.projectPath === projectPath) {
        dispatch({ type: 'progress', progress });
      }
    });
    try {
      const result = await upgradeStudio(projectPath, requestId);
      dispatch({ type: 'finished', result });
      if (result.kind === 'upgraded') {
        onChanged();
      }
    } catch (error: unknown) {
      dispatch({ type: 'finished', result: { kind: 'error', message: cleanError(error) } });
    } finally {
      unsubscribe.current?.();
      unsubscribe.current = undefined;
      activeRequest.current = undefined;
    }
  };
  // Restoring is a folder swap, quick enough to need no progress; it is refused while an upgrade runs.
  const restore = async () => {
    if (restorableNote(state) === undefined || activeRequest.current !== undefined) {
      return;
    }
    activeRequest.current = 'restore';
    dispatch({ type: 'restore' });
    try {
      const result = await restoreStudio(projectPath);
      dispatch({ type: 'restoreFinished', result });
      if (result.kind === 'restored') {
        onChanged();
      }
    } catch (error: unknown) {
      dispatch({ type: 'restoreFinished', result: { kind: 'error', message: cleanError(error) } });
    } finally {
      activeRequest.current = undefined;
    }
  };
  return { state, start, restore };
}
