// The three raw channels of the boot path, outside the typed invoke contract on purpose: the first two must be
// answerable before any other handler, and one of them must be synchronous.
//
//   boot:read         (sendSync) the first render's seed: the project to open and the snapshots (bootStore.ts).
//   boot:save         (send)     a snapshot's JSON text; fire and forget, validated in main.
//   boot:first-frame  (send)     the renderer's real first frame has been handed to the compositor: show the window.
//
// Each is accepted only from the main window's own top frame; a preview iframe or another window is ignored, so a
// previewed site can neither read the snapshot nor trigger the reveal.
import type { IpcMain, IpcMainEvent } from 'electron';
import type { BootStore } from './bootStore';

export interface BootChannelHost {
  readonly ipcMain: Pick<IpcMain, 'on'>;
  readonly store: BootStore;
  readonly pendingProject: () => string | undefined;
  /** Whether the event came from the main window's own top frame. */
  readonly isMainFrame: (event: IpcMainEvent) => boolean;
  readonly onFirstFrame: () => void;
}

export function registerBootChannels(host: BootChannelHost): void {
  host.ipcMain.on('boot:read', (event) => {
    // Electron answers a synchronous message through this property of the event; a local alias names that.
    const reply: { returnValue: unknown } = event;
    reply.returnValue = host.isMainFrame(event) ? host.store.payload(host.pendingProject()) : undefined;
  });
  host.ipcMain.on('boot:save', (event, text: unknown) => {
    if (host.isMainFrame(event) && typeof text === 'string') {
      host.store.save(text);
    }
  });
  host.ipcMain.on('boot:first-frame', (event) => {
    if (host.isMainFrame(event)) {
      host.onFirstFrame();
    }
  });
}
