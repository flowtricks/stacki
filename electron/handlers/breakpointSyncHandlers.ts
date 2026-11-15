// The Breakpoints settings' sync IPC: scan a project for the media queries that equal a breakpoint's old value, write the places
// the person kept, and put a sync back or forward again (electron/project/breakpointSync.ts).
import * as path from 'node:path';
import { errorMessage } from '../lib/mainHelpers';
import { applyBreakpointSync, restoreBreakpointSync, scanBreakpointSync, validSetting } from '../project/breakpointSync';
import { announceVariableWrite } from './cssVariableHandlers';
import type { MainHost } from './mainHost';

export function registerBreakpointSyncHandlers({ ipcMain, send }: Pick<MainHost, 'ipcMain' | 'send'>): void {
  ipcMain.handle('breakpointSync:scan', async (_event, request) => {
    const old = validSetting(request.old);
    const next = validSetting(request.next);
    if (!old.ok) {
      return { ok: false, error: old.error.message };
    }
    if (!next.ok) {
      return { ok: false, error: next.error.message };
    }
    try {
      return {
        ok: true,
        scan: await scanBreakpointSync(request.projectPath, {
          key: request.id,
          old: { direction: request.old.direction, setting: old.value },
          next: next.value,
        }),
      };
    } catch (error: unknown) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  ipcMain.handle('breakpointSync:apply', async (_event, request) => {
    try {
      const result = applyBreakpointSync(request.projectPath, request);
      if (result.files > 0) {
        // The app's own writes are silent to the watcher; the canvas and any open page are told here.
        announceVariableWrite(
          send,
          request.files.map((file) => path.join(request.projectPath, ...file.rel.split('/'))),
        );
      }
      return result;
    } catch (error: unknown) {
      return { ok: false, places: 0, files: 0, skipped: [], journalId: undefined, error: errorMessage(error) };
    }
  });

  ipcMain.handle('breakpointSync:restore', async (_event, request) => {
    const result = restoreBreakpointSync(request.projectPath, request);
    if (!result.ok) {
      return { ok: false, error: result.error.message };
    }
    announceVariableWrite(send, result.value.paths);
    return { ok: true, restored: result.value.restored, skipped: result.value.skipped };
  });
}
