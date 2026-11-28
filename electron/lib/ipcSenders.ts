// Who main listens to. Every IPC channel but the boot ones (boot/bootChannels.ts,
// which asks the same question itself) is registered through this guard, and
// answers only the app window's own top frame: the one page the preload gives
// the bridge to (preload/preload.ts). A preview frame, an app's frame or another
// window runs the previewed site's or the app's code, so a message from one is
// refused before its payload is read, whatever it claims to be.
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron';

type SenderEvent = Pick<IpcMainInvokeEvent, 'sender' | 'processId' | 'frameId'>;

export type AppWindowCheck = (event: SenderEvent) => boolean;

/**
 * Whether a message came from `contents`'s top frame. The frame is named by the process and frame ids the
 * message carries, not by `senderFrame`, which reads as null once that frame has gone: a message the page sent
 * just before a reload is still the page's.
 */
export function isAppWindowSender(event: SenderEvent, contents: WebContents | undefined): boolean {
  if (contents === undefined || event.sender !== contents) {
    return false;
  }
  const top = contents.mainFrame;
  return event.processId === top.processId && event.frameId === top.routingId;
}

/** `ipcMain` as handler modules register on it. */
export interface AppIpc {
  readonly handle: IpcMain['handle'];
  readonly on: (channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void) => void;
}

/** The native `ipcMain` behind the guard: an invoke from anyone but the app's window is rejected, a one-way message dropped. */
export function guardIpcSenders(ipcMain: Pick<IpcMain, 'handle' | 'on'>, fromAppWindow: AppWindowCheck): AppIpc {
  return {
    handle: (channel, listener) => {
      ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        if (!fromAppWindow(event)) {
          throw new Error(`Refused: ${channel} answers only Stacki’s own window`); // i18n-ignore: only a frame that should not be asking sees it.
        }
        const answer: unknown = listener(event, ...args);
        return answer;
      });
    },
    on: (channel, listener) => {
      ipcMain.on(channel, (event: IpcMainEvent, ...args: unknown[]) => {
        if (fromAppWindow(event)) {
          listener(event, ...args);
        } else {
          console.warn(`[ipc] ${channel}: dropped a message from a frame that is not Stacki’s window`);
        }
      });
    },
  };
}
