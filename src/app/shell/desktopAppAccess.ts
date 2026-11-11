// Desktop's project files and sign-ins for apps (src/features/apps/appAccessRpc.ts):
// both run in the main process (electron/handlers/appAccessHandlers.ts). A file
// change lands as one undo step in the editor's history, the same history ⌘Z
// walks for a click: undo puts back the states the change found, redo the
// states it left, through the same channel as the person's own step, so it is
// not counted against the app's write budget. A change too large to hold
// (APP_FILE_LIMITS.undoSnapshotCharsMax) is made without a step, and the
// editor says so.
import type React from 'react';
import { assert } from '../../../shared/core/assert';
import { APP_FILE_LIMITS, type AppFileChange, type AppFileState } from '../../../shared/properties/appFiles';
import type { AppHostAuth, AppHostFiles, AppHostNet } from '../../features/apps/appAccessRpc';
import {
  connectAppAuth,
  disconnectAppAuth,
  onAppAuthChanged,
  readAppAccessToken,
  readAppAuthStatus,
  runAppFileCall,
  runAppNetFetch,
} from '../../ipc/appAccessBridge';
import type { ShellView } from '../App';

export function desktopAppFiles(appRef: React.MutableRefObject<ShellView>): AppHostFiles {
  const projectPath = () => appRef.current.project.path;
  return {
    run: async (appId, operation, label) => {
      const answer = await runAppFileCall(projectPath(), appId, operation);
      if (!answer.ok || answer.value.kind !== 'changed') {
        return answer;
      }
      const change = answer.value.change;
      if (change.paths.length === 0) {
        return answer;
      }
      if (snapshotChars(change) > APP_FILE_LIMITS.undoSnapshotCharsMax) {
        appRef.current.showToast(`${label}: too large to undo`, 'info');
        return answer;
      }
      const restore = (states: readonly AppFileState[]) => async (): Promise<void> => {
        const restored = await runAppFileCall(projectPath(), appId, { kind: 'restore', states });
        if (!restored.ok) {
          throw new Error(restored.message);
        }
      };
      appRef.current.pushCommand({ label, undo: restore(change.before), redo: restore(change.after) });
      return answer;
    },
  };
}

export function desktopAppNet(appRef: React.MutableRefObject<ShellView>): AppHostNet {
  return { fetch: (appId, request) => runAppNetFetch(appRef.current.project.path, appId, request) };
}

export function desktopAppAuth(appRef: React.MutableRefObject<ShellView>): AppHostAuth {
  const projectPath = () => appRef.current.project.path;
  return {
    connect: (appId, provider) => connectAppAuth(projectPath(), appId, provider),
    token: (appId, provider) => readAppAccessToken(projectPath(), appId, provider),
    disconnect: (appId, provider) => disconnectAppAuth(projectPath(), appId, provider),
    status: (appId) => readAppAuthStatus(projectPath(), appId),
    watch: (listener) => onAppAuthChanged(listener),
  };
}

// The characters an undo step would hold: every before and after file's base64.
function snapshotChars(change: AppFileChange): number {
  let chars = 0;
  for (const state of [...change.before, ...change.after]) {
    if (state.kind === 'file') {
      chars += state.base64.length;
    }
  }
  assert(chars >= 0, 'A snapshot has a size');
  assert(change.before.length === change.after.length, 'A change records each path before and after');
  return chars;
}
