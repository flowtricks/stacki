// The "Move styles" journal IPC (shared/properties/styleMoveJournal.ts, electron/content/styleMoveJournals.ts): the
// window records the plan before Create component writes anything and clears it once the move is whole; when a
// project opens it asks whether a move was left part way, and the person's choice finishes or undoes it here, in main.

import type { StyleMoveJournals } from '../content/styleMoveJournals';
import type { MainHost } from './mainHost';

export function registerStyleMoveHandlers(host: Pick<MainHost, 'assertInProject' | 'ipcMain' | 'noteAppWrite'>, journals: StyleMoveJournals): void {
  host.ipcMain.handle('styleMove:record', (_event, { projectPath, journal }) => {
    // Every file a journal names must be the open project's: resolving it later writes them.
    for (const file of journal.files) {
      host.assertInProject(file.path);
    }
    journals.record(projectPath, journal);
    return { ok: true as const };
  });
  host.ipcMain.handle('styleMove:clear', (_event, { projectPath, id }) => {
    journals.clear(projectPath, id);
    return { ok: true as const };
  });
  host.ipcMain.handle('styleMove:pending', (_event, { projectPath }) => ({ pending: journals.pending(projectPath) }));
  host.ipcMain.handle('styleMove:resolve', (_event, { projectPath, id, target }) => {
    host.noteAppWrite();
    return journals.resolve(projectPath, id, target);
  });
}
