// CMS connections from the Studio editor: the same calls as Desktop's bridge
// (src/ipc/cmsConnectionsBridge.ts, which this module replaces in Studio), over
// HTTP. Connections are kept by the Worker, or by a local Studio's server
// (cmsConnectionRoutes.ts, cmsRemoteServer.ts); a connected-CMS call names its
// connection in a header and never carries a key. Studio connects by pasted
// key; signing in with Sanity is not offered here yet.
import {
  parseCmsConnectionList,
  parseCmsSaveResult,
  type CmsConnectionDraft,
  type CmsConnectionList,
  type CmsSaveResult,
  type SanityLoginRequest,
  type SanityLoginState,
} from '../../../vendor/stacki/shared/properties/cmsConnections';
import {
  parseRemoteActedDocument,
  parseRemoteAsset,
  parseRemoteCollections,
  parseRemoteDocument,
  parseRemoteDocumentList,
  parseRemoteDocuments,
  parseRemoteReferenceOptions,
  parseRemoteResult,
  parseRemoteRevisions,
  type RemoteAsset,
  type RemoteAssetKind,
  type RemoteCollection,
  type RemoteDocument,
  type RemoteDocumentAction,
  type RemoteDocumentList,
  type RemoteDocumentSummary,
  type RemoteMove,
  type RemoteReferenceOption,
  type RemoteResult,
  type RemoteRevision,
  type RemoteWrite,
} from '../../../vendor/stacki/shared/properties/cmsRemote';
import { CMS_CONNECTION_HEADER } from './cmsConnectionBook';
import { request } from '../project/projectClient';

/** What this host can offer: keys only, for now. */
export interface CmsConnectionHost {
  readonly sanityLogin: 'browser' | 'oauth' | 'none';
}
export const CMS_CONNECTION_HOST: CmsConnectionHost = { sanityLogin: 'none' };

export async function listCmsConnections(_projectPath: string): Promise<CmsConnectionList> {
  return parseCmsConnectionList(await request('/studio/api/cms-connections'));
}

export async function saveCmsConnection(
  _projectPath: string,
  draft: CmsConnectionDraft,
): Promise<CmsSaveResult> {
  return parseCmsSaveResult(await post('/studio/api/cms-connections/save', { draft }));
}

export async function removeCmsConnection(
  _projectPath: string,
  id: string,
): Promise<CmsConnectionList> {
  return parseCmsConnectionList(await post('/studio/api/cms-connections/remove', { id }));
}

export async function sanityLogin(
  _projectPath: string,
  _request: SanityLoginRequest,
): Promise<SanityLoginState> {
  return { kind: 'failed', message: 'Paste a Sanity key to connect from Studio.' };
}

export async function openSanitySignIn(_url: string): Promise<void> {
  // Not offered in Studio (CMS_CONNECTION_HOST.sanityLogin is 'none').
}

export async function remoteCollections(
  _projectPath: string,
  connectionId: string,
): Promise<RemoteResult<readonly RemoteCollection[]>> {
  return remote(connectionId, 'collections', {}, parseRemoteCollections);
}

export async function remoteDocuments(
  _projectPath: string,
  connectionId: string,
  collection: string,
): Promise<RemoteResult<RemoteDocumentList>> {
  return remote(connectionId, 'documents', { collection }, parseRemoteDocumentList);
}

export async function createRemoteDocument(
  _projectPath: string,
  connectionId: string,
  collection: string,
): Promise<RemoteResult<RemoteDocumentSummary>> {
  return remote(connectionId, 'create', { collection }, (value) => {
    const [summary] = parseRemoteDocuments([value]);
    if (!summary) {
      throw new Error('Expected the new document.');
    }
    return summary;
  });
}

export async function deleteRemoteDocuments(
  _projectPath: string,
  connectionId: string,
  ids: readonly string[],
): Promise<RemoteResult<number>> {
  return remote(connectionId, 'delete', { ids }, (value) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error('Expected how many documents were deleted.');
    }
    return value;
  });
}

export async function moveRemoteDocument(
  _projectPath: string,
  connectionId: string,
  move: RemoteMove,
): Promise<RemoteResult<RemoteDocumentList>> {
  return remote(connectionId, 'move', { move }, parseRemoteDocumentList);
}

export async function remoteDocument(
  _projectPath: string,
  connectionId: string,
  id: string,
): Promise<RemoteResult<RemoteDocument>> {
  return remote(connectionId, 'document', { id }, parseRemoteDocument);
}

export async function writeRemoteDocument(
  _projectPath: string,
  connectionId: string,
  write: RemoteWrite,
): Promise<RemoteResult<RemoteDocument>> {
  return remote(connectionId, 'write', { write }, parseRemoteDocument);
}

export async function remoteReferenceOptions(
  _projectPath: string,
  connectionId: string,
  types: readonly string[],
): Promise<RemoteResult<readonly RemoteReferenceOption[]>> {
  return remote(connectionId, 'references', { types }, parseRemoteReferenceOptions);
}

export async function actOnRemoteDocument(
  _projectPath: string,
  connectionId: string,
  input: { readonly id: string; readonly action: RemoteDocumentAction },
): Promise<RemoteResult<RemoteDocument | undefined>> {
  return remote(connectionId, 'act', input, parseRemoteActedDocument);
}

export async function remoteHistory(
  _projectPath: string,
  connectionId: string,
  id: string,
): Promise<RemoteResult<readonly RemoteRevision[]>> {
  return remote(connectionId, 'history', { id }, parseRemoteRevisions);
}

export async function restoreRemoteRevision(
  _projectPath: string,
  connectionId: string,
  input: { readonly id: string; readonly revision: string },
): Promise<RemoteResult<RemoteDocument>> {
  return remote(connectionId, 'restore', input, parseRemoteDocument);
}

/** Asks for a file in the browser and stores it in the CMS; undefined when cancelled. */
export async function uploadRemoteAsset(
  _projectPath: string,
  connectionId: string,
  kind: RemoteAssetKind,
): Promise<RemoteResult<RemoteAsset | undefined>> {
  const file = await chooseFile(kind === 'image' ? 'image/*' : '');
  if (file === undefined) {
    return { ok: true, value: undefined };
  }
  const query = new URLSearchParams({ kind, filename: file.name });
  return attempt(async () =>
    parseRemoteResult(
      await request(`/studio/api/cms-remote/upload?${query}`, {
        method: 'POST',
        headers: { [CMS_CONNECTION_HEADER]: connectionId },
        body: file,
      }),
      parseRemoteAsset,
    ),
  );
}

async function remote<T>(
  connectionId: string,
  operation: string,
  input: object,
  parse: (value: unknown) => T,
): Promise<RemoteResult<T>> {
  return attempt(async () =>
    parseRemoteResult(
      await request(`/studio/api/cms-remote/${operation}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [CMS_CONNECTION_HEADER]: connectionId },
        body: JSON.stringify(input),
      }),
      parse,
    ),
  );
}

// A request Studio could not complete (offline, signed out) is the panel's to show.
async function attempt<T>(run: () => Promise<RemoteResult<T>>): Promise<RemoteResult<T>> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: message.slice(0, 900) || 'The CMS request failed.' };
  }
}

async function post(url: string, input: object): Promise<unknown> {
  return request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

// The browser's own file chooser; a dismissed chooser is no file.
function chooseFile(accept: string): Promise<File | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => resolve(input.files?.[0] ?? undefined), { once: true });
    input.addEventListener('cancel', () => resolve(undefined), { once: true });
    input.click();
  });
}
