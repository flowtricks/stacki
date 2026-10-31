// CMS connections over IPC: list, save (with a pasted key), remove, and the
// "Log in with Sanity" steps. Keys come in once, with a save, and never go back
// out: every reply is the public half of a connection.

import path from 'node:path';
import fs, { realpathSync } from 'node:fs';
import type { MainHost } from './mainHost';
import type { CmsConnectionStore } from '../content/cmsConnectionStore';
import type { SanityLogin } from '../content/sanityLogin';
import type { CmsSaveResult } from '../../shared/properties/cmsConnections';
import type { RemoteResult } from '../../shared/properties/cmsRemote';
import { cmsFailureMessage, cmsRemoteService } from '../content/cmsRemoteService';
import { IMAGE_EXTENSIONS, SANITY_UPLOAD_BYTES_MAX } from '../content/sanityUpload';

export function registerCmsConnectionHandlers(
  host: Pick<MainHost, 'ipcMain' | 'assertInProject' | 'showOpenDialog'>,
  store: CmsConnectionStore,
  login: SanityLogin,
): void {
  // The open project only, by its real path: connections are keyed by it.
  const root = (projectPath: string) => {
    const canonical = realpathSync(projectPath);
    host.assertInProject(path.join(canonical, 'package.json'));
    return canonical;
  };
  host.ipcMain.handle('cmsConnections:list', (_event, input) =>
    store.list(root(input.projectPath)),
  );
  host.ipcMain.handle('cmsConnections:save', (_event, input): CmsSaveResult => {
    const project = root(input.projectPath);
    try {
      store.save(project, input.draft);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: message.slice(0, 900) || 'Could not save the connection.' };
    }
    return { ok: true, list: store.list(project) };
  });
  host.ipcMain.handle('cmsConnections:remove', (_event, input) => {
    const project = root(input.projectPath);
    store.remove(project, input.id);
    return store.list(project);
  });
  host.ipcMain.handle('cmsConnections:sanityLogin', (_event, input) =>
    login.request(root(input.projectPath), input.request),
  );
  registerCmsRemoteHandlers(host, store, root);
}

// The CMS panel's reads and draft writes, against one saved connection
// (cmsRemoteService.ts). Its key is decrypted here, for the request, and never
// returned.
function registerCmsRemoteHandlers(
  host: Pick<MainHost, 'ipcMain' | 'showOpenDialog'>,
  store: CmsConnectionStore,
  root: (projectPath: string) => string,
): void {
  const service = connectionService(store, root);
  const { ipcMain } = host;
  ipcMain.handle('cmsRemote:collections', (_event, input) =>
    remote(() => service(input.projectPath, input.connectionId).collections()),
  );
  ipcMain.handle('cmsRemote:documents', (_event, input) =>
    remote(() => service(input.projectPath, input.connectionId).documents(input.collection)),
  );
  ipcMain.handle('cmsRemote:create', (_event, input) =>
    remote(() => service(input.projectPath, input.connectionId).create(input.collection)),
  );
  ipcMain.handle('cmsRemote:delete', (_event, input) =>
    remote(() => service(input.projectPath, input.connectionId).remove(input.ids)),
  );
  ipcMain.handle('cmsRemote:move', (_event, input) =>
    remote(() => service(input.projectPath, input.connectionId).move(input.move)),
  );
  ipcMain.handle('cmsRemote:document', (_event, input) =>
    remote(() => service(input.projectPath, input.connectionId).document(input.id)),
  );
  ipcMain.handle('cmsRemote:write', (_event, input) =>
    remote(() => service(input.projectPath, input.connectionId).write(input.write)),
  );
  ipcMain.handle('cmsRemote:act', (_event, input) =>
    remote(() => service(input.projectPath, input.connectionId).act(input.id, input.action)),
  );
  ipcMain.handle('cmsRemote:history', (_event, input) =>
    remote(() => service(input.projectPath, input.connectionId).history(input.id)),
  );
  ipcMain.handle('cmsRemote:restore', (_event, input) =>
    remote(() => service(input.projectPath, input.connectionId).restore(input.id, input.revision)),
  );
  ipcMain.handle('cmsRemote:references', (_event, input) =>
    remote(() => service(input.projectPath, input.connectionId).references(input.types)),
  );
  // The person picks the file in the system dialog; a cancel is no asset, not a failure.
  ipcMain.handle('cmsRemote:upload', (_event, input) =>
    remote(async () => {
      const target = service(input.projectPath, input.connectionId);
      const picked = await host.showOpenDialog({
        title: input.kind === 'image' ? 'Choose an image' : 'Choose a file',
        properties: ['openFile'],
        filters: input.kind === 'image' ? [{ name: 'Images', extensions: IMAGE_EXTENSIONS }] : [],
      });
      const file = picked.filePaths[0];
      if (picked.canceled || file === undefined) {
        return undefined;
      }
      if (fs.statSync(file).size > SANITY_UPLOAD_BYTES_MAX) {
        throw new Error('This file is larger than 100 MB.');
      }
      return target.upload(input.kind, { name: path.basename(file), bytes: fs.readFileSync(file) });
    }),
  );
}

// The service for one saved connection, its key decrypted for this request only.
function connectionService(store: CmsConnectionStore, root: (projectPath: string) => string) {
  return (projectPath: string, connectionId: string) => {
    const project = root(projectPath);
    const connection = store.list(project).connections.find((entry) => entry.id === connectionId);
    if (!connection) {
      throw new Error('This CMS connection was removed. Reconnect it in Settings.');
    }
    if (connection.kind !== 'sanity') {
      throw new Error('Browsing this CMS in Stacki is not available yet.');
    }
    const token = store.secret(project, connection.id);
    if (token === undefined) {
      throw new Error('Stacki could not read this connection’s key. Reconnect it in Settings.');
    }
    return cmsRemoteService(project, {
      projectId: connection.projectId,
      dataset: connection.dataset,
      token,
    });
  };
}

// Expected failures — offline, a revoked key, a removed document — are answers,
// not crashes: the panel shows them where the person is looking.
async function remote<T>(run: () => Promise<T>): Promise<RemoteResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error: unknown) {
    return { ok: false, message: failureMessage(error).slice(0, 900) };
  }
}

/** A failure as the panel says it (cmsRemoteService.ts). */
export const failureMessage = cmsFailureMessage;
