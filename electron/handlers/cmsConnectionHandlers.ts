// CMS connections over IPC: list, save (with a pasted key), remove, and the
// "Log in with Sanity" steps. Keys come in once, with a save, and never go back
// out: every reply is the public half of a connection.

import path from 'node:path';
import fs, { realpathSync } from 'node:fs';
import type { MainHost } from './mainHost';
import type { CmsConnectionStore } from '../content/cmsConnectionStore';
import type { SanityLogin } from '../content/sanityLogin';
import type { CmsCheckRequest, CmsCheckResult, CmsSaveResult } from '../../shared/properties/cmsConnections';
import type { RemoteResult } from '../../shared/properties/cmsRemote';
import { cmsFailureMessage, cmsFailureProblem, cmsRemoteService } from '../content/cmsRemoteService';
import { fetchLinkPreview } from '../content/linkPreview';
import { forgetPayloadSession, PayloadError } from '../content/payloadClient';
import { checkPayload, payloadTargetOf } from '../content/payloadAccess';
import { clearPayloadSchemas } from '../content/payloadSchema';
import { payloadRemoteService } from '../content/payloadService';
import { IMAGE_EXTENSIONS, SANITY_UPLOAD_BYTES_MAX } from '../content/sanityUpload';
import { translateMain } from '../lib/mainLocale';
import { described } from '../../shared/properties/i18n/messageRef';

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
  host.ipcMain.handle('cmsConnections:list', (_event, input) => store.list(root(input.projectPath)));
  host.ipcMain.handle('cmsConnections:save', async (_event, input): Promise<CmsSaveResult> => {
    const project = root(input.projectPath);
    // A Payload account is tried against the server first: a wrong address, key or password is told now.
    if (input.draft.kind === 'payload') {
      const check = await checkPayload(input.draft, input.draft.secret);
      if (!check.ok) {
        return check;
      }
      // A saved-again connection starts a fresh login and a fresh look at the server.
      forgetPayloadSession(payloadTargetOf(input.draft, input.draft.secret));
      clearPayloadSchemas();
    }
    try {
      store.save(project, input.draft);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: message.slice(0, 900) || translateMain('error.cms.connectionSaveFailed') };
    }
    return { ok: true, list: store.list(project) };
  });
  host.ipcMain.handle('cmsConnections:remove', (_event, input) => {
    const project = root(input.projectPath);
    // A removed Payload connection leaves no login behind in memory.
    const removed = store.list(project).connections.find((entry) => entry.id === input.id);
    const secret = removed?.kind === 'payload' ? store.secret(project, removed.id) : undefined;
    if (removed?.kind === 'payload' && secret !== undefined) {
      forgetPayloadSession(payloadTargetOf(removed, secret));
    }
    store.remove(project, input.id);
    clearPayloadSchemas();
    return store.list(project);
  });
  host.ipcMain.handle('cmsConnections:check', (_event, input) => checkConnection(store, root(input.projectPath), input.request));
  host.ipcMain.handle('cmsConnections:sanityLogin', (_event, input) => login.request(root(input.projectPath), input.request));
  registerCmsRemoteHandlers(host, store, root);
  // A video link's card in a CMS field; the payload parser admits video host links only.
  host.ipcMain.handle('cmsRemote:linkPreview', (_event, input) => remote(() => fetchLinkPreview(input.url)));
}

// The CMS panel's reads and draft writes, against one saved connection
// (cmsRemoteService.ts). Its key is decrypted here, for the request, and never
// returned.
function registerCmsRemoteHandlers(host: Pick<MainHost, 'ipcMain' | 'showOpenDialog'>, store: CmsConnectionStore, root: (projectPath: string) => string): void {
  const service = connectionService(store, root);
  const { ipcMain } = host;
  ipcMain.handle('cmsRemote:collections', (_event, input) => remote(() => service(input.projectPath, input.connectionId).collections()));
  ipcMain.handle('cmsRemote:documents', (_event, input) =>
    remote(() => service(input.projectPath, input.connectionId).documents(input.collection, input.columns ?? [])),
  );
  ipcMain.handle('cmsRemote:create', (_event, input) => remote(() => service(input.projectPath, input.connectionId).create(input.collection)));
  ipcMain.handle('cmsRemote:delete', (_event, input) => remote(() => service(input.projectPath, input.connectionId).remove(input.ids)));
  ipcMain.handle('cmsRemote:move', (_event, input) => remote(() => service(input.projectPath, input.connectionId).move(input.move)));
  ipcMain.handle('cmsRemote:document', (_event, input) => remote(() => service(input.projectPath, input.connectionId).document(input.id)));
  ipcMain.handle('cmsRemote:template', (_event, input) => remote(() => service(input.projectPath, input.connectionId).template(input.collection)));
  ipcMain.handle('cmsRemote:write', (_event, input) => remote(() => service(input.projectPath, input.connectionId).write(input.write)));
  ipcMain.handle('cmsRemote:act', (_event, input) => remote(() => service(input.projectPath, input.connectionId).act(input.id, input.action)));
  ipcMain.handle('cmsRemote:history', (_event, input) => remote(() => service(input.projectPath, input.connectionId).history(input.id)));
  ipcMain.handle('cmsRemote:restore', (_event, input) => remote(() => service(input.projectPath, input.connectionId).restore(input.id, input.revision)));
  ipcMain.handle('cmsRemote:references', (_event, input) => remote(() => service(input.projectPath, input.connectionId).references(input.types)));
  // The person picks the file in the system dialog; a cancel is no asset, not a failure.
  ipcMain.handle('cmsRemote:upload', (_event, input) =>
    remote(async () => {
      const target = service(input.projectPath, input.connectionId);
      const picked = await host.showOpenDialog({
        title: translateMain(input.kind === 'image' ? 'dialog.open.cmsImage.title' : 'dialog.open.cmsFile.title'),
        properties: ['openFile'],
        filters: input.kind === 'image' ? [{ name: translateMain('dialog.open.cmsImage.filter'), extensions: IMAGE_EXTENSIONS }] : [],
      });
      const file = picked.filePaths[0];
      if (picked.canceled || file === undefined) {
        return undefined;
      }
      if (fs.statSync(file).size > (target.uploadBytesMax ?? SANITY_UPLOAD_BYTES_MAX)) {
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
    if (connection.kind === 'custom') {
      // A custom CMS saves canvas edits to its own endpoint; it has no content to browse.
      throw new Error('Browsing this CMS in Stacki is not available yet.');
    }
    const token = store.secret(project, connection.id);
    if (token === undefined) {
      throw new Error('Stacki could not read this connection’s key. Reconnect it in Settings.');
    }
    if (connection.kind === 'payload') {
      return payloadRemoteService(payloadTargetOf(connection, token), { named: connection.collections });
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
    if (error instanceof PayloadError) {
      return { ok: false, message: error.message.slice(0, 900), messageRef: error.messageRef };
    }
    const problem = cmsFailureProblem(error);
    return { ok: false, message: problem.message.slice(0, 900), ...(problem.messageRef === undefined ? {} : { messageRef: problem.messageRef }) };
  }
}

// Test connection (a saved Payload connection) or Detect (the form's, not yet saved).
async function checkConnection(store: CmsConnectionStore, project: string, request: CmsCheckRequest): Promise<CmsCheckResult> {
  if (request.action === 'detect') {
    return checkPayload(request.draft, request.draft.secret);
  }
  const connection = store.list(project).connections.find((entry) => entry.id === request.id);
  if (connection?.kind !== 'payload') {
    return { ok: false, ...described('cmsBackend.connection.cannotTest') };
  }
  const secret = store.secret(project, connection.id);
  if (secret === undefined) {
    return { ok: false, ...described('settings.cms.payload.noSecrets') };
  }
  return checkPayload(connection, secret);
}

/** A failure as the panel says it (cmsRemoteService.ts). */
export const failureMessage = cmsFailureMessage;
