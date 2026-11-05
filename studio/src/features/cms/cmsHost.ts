import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { IpcChannel, IpcPayloads } from '../../../vendor/stacki/shared/ipc/ipcPayloads';
import { parseIpcPayload } from '../../../vendor/stacki/shared/ipc/ipcPayloads';
import type { IpcResults } from '../../../vendor/stacki/shared/ipc/ipcResults';
import { registerCmsHandlers } from '../../../vendor/stacki/electron/handlers/cmsHandlers';
import { registerContentHandlers } from '../../../vendor/stacki/electron/handlers/contentHandlers';
import { string } from '../../shared/validation';

export interface MainHost {
  readonly ipcMain: {
    readonly handle: <K extends IpcChannel>(channel: K, handler: (event: unknown, payload: IpcPayloads[K]) => Promise<IpcResults[K]>) => void;
  };
  readonly send: (channel: string, payload?: unknown) => void;
  readonly noteAppWrite: () => void;
  readonly shell: { readonly trashItem: (file: string) => Promise<void> };
}
export function cmsHandlers() {
  const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
  const host: MainHost = {
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, (payload) => handler(undefined, parseIpcPayload(channel, payload)));
      },
    },
    send: () => {},
    noteAppWrite: () => {},
    shell: {
      trashItem: async (file) => {
        rmSync(file);
      },
    },
  };
  registerCmsHandlers(host);
  // Studio's dev server is not Desktop's DevServers; it has no restart here.
  registerContentHandlers(host, { restartForNewContentConfig: async () => false });
  return handlers;
}
// Only imported by the upstream engine running in an isolated staging directory.
export function writeProjectText(file: string, text: string, expectedSource?: string) {
  if (expectedSource !== undefined && readFileSync(file, 'utf8') !== expectedSource) {
    throw new Error('Content changed before it could be saved');
  }
  writeFileSync(file, string(text), 'utf8');
}
export function createProjectText(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, string(text), { encoding: 'utf8', flag: 'wx' });
}
