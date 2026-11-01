// Electron passes untyped structured-clone data. Parse before side effects and
// check each producer's result at compile time without changing wire errors.
import type { IpcMainInvokeEvent } from 'electron';
import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import type { IpcChannel, IpcPayloads } from '../../shared/ipc/ipcPayloads';
import type { IpcResults } from '../../shared/ipc/ipcResults';

export function createIpcRegistrar(ipcMain: Pick<Electron.IpcMain, 'handle'>) {
  return function handle<K extends IpcChannel>(
    channel: K,
    listener: (event: IpcMainInvokeEvent, payload: IpcPayloads[K]) => IpcResults[K] | Promise<IpcResults[K]>,
  ): void {
    ipcMain.handle(channel, (event, input: unknown) => listener(event, parseIpcPayload(channel, input)));
  };
}
