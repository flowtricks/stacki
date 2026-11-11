// Electron passes untyped structured-clone data. Parse before side effects and
// check each producer's result at compile time without changing wire errors.
// An optional gate runs after parsing and before the handler: main uses it to
// refuse write paths the project's role does not allow (handlers/roleAccess.ts).
// It returns undefined for a channel it does not guard, so ungated handlers keep
// their synchronous path.
import type { IpcMainInvokeEvent } from 'electron';
import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import type { IpcChannel, IpcPayloads } from '../../shared/ipc/ipcPayloads';
import type { IpcResults } from '../../shared/ipc/ipcResults';

export type IpcGate = (channel: IpcChannel, payload: unknown) => Promise<void> | undefined;

export function createIpcRegistrar(ipcMain: Pick<Electron.IpcMain, 'handle'>, gate?: () => IpcGate | undefined) {
  return function handle<K extends IpcChannel>(
    channel: K,
    listener: (event: IpcMainInvokeEvent, payload: IpcPayloads[K]) => IpcResults[K] | Promise<IpcResults[K]>,
  ): void {
    ipcMain.handle(channel, (event, input: unknown) => {
      const payload = parseIpcPayload(channel, input);
      const pending = gate?.()?.(channel, payload);
      if (pending === undefined) {
        return listener(event, payload);
      }
      return pending.then(() => listener(event, payload));
    });
  };
}
