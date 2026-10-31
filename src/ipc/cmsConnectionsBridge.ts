// CMS connections from the renderer. Desktop asks the main process; Stacki
// Studio replaces this module with its HTTP client (studio/scripts/shared-source.json).
import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import { parseOkResult } from '../../shared/ipc/ipcContract';
import {
  parseCmsConnectionList,
  parseCmsSaveResult,
  parseSanityLoginState,
  parseSanityLoginURL,
  type CmsConnectionDraft,
  type CmsConnectionList,
  type CmsSaveResult,
  type SanityLoginRequest,
  type SanityLoginState,
} from '../../shared/properties/cmsConnections';
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
} from '../../shared/properties/cmsRemote';

/** What this host can offer: Desktop signs in to Sanity in the browser. */
export interface CmsConnectionHost {
  /** How "Log in with Sanity" works here, or 'none' when only keys can be added. */
  readonly sanityLogin: 'browser' | 'oauth' | 'none';
}
export const CMS_CONNECTION_HOST: CmsConnectionHost = { sanityLogin: 'browser' };

export async function listCmsConnections(projectPath: string): Promise<CmsConnectionList> {
  const input = parseIpcPayload('cmsConnections:list', { projectPath });
  return parseCmsConnectionList(await window.avb.cmsConnections(input));
}

export async function saveCmsConnection(
  projectPath: string,
  draft: CmsConnectionDraft,
): Promise<CmsSaveResult> {
  const input = parseIpcPayload('cmsConnections:save', { projectPath, draft });
  return parseCmsSaveResult(await window.avb.saveCmsConnection(input));
}

export async function removeCmsConnection(
  projectPath: string,
  id: string,
): Promise<CmsConnectionList> {
  const input = parseIpcPayload('cmsConnections:remove', { projectPath, id });
  return parseCmsConnectionList(await window.avb.removeCmsConnection(input));
}

export async function sanityLogin(
  projectPath: string,
  request: SanityLoginRequest,
): Promise<SanityLoginState> {
  const input = parseIpcPayload('cmsConnections:sanityLogin', { projectPath, request });
  let result: unknown;
  try {
    result = await window.avb.sanityLogin(input);
  } catch {
    return { kind: 'failed', message: 'Could not reach Sanity sign-in. Please try again.' };
  }
  return parseSanityLoginState(result);
}

export async function openSanitySignIn(url: string): Promise<void> {
  const input = parseIpcPayload('shell:openExternal', parseSanityLoginURL(url));
  parseOkResult(await window.avb.openExternal(input));
}

// The CMS panel's reads and draft writes against one connection.

export async function remoteCollections(
  projectPath: string,
  connectionId: string,
): Promise<RemoteResult<readonly RemoteCollection[]>> {
  const input = parseIpcPayload('cmsRemote:collections', { projectPath, connectionId });
  return parseRemoteResult(await window.avb.remoteCollections(input), parseRemoteCollections);
}

export async function remoteDocuments(
  projectPath: string,
  connectionId: string,
  collection: string,
): Promise<RemoteResult<RemoteDocumentList>> {
  const input = parseIpcPayload('cmsRemote:documents', { projectPath, connectionId, collection });
  return parseRemoteResult(await window.avb.remoteDocuments(input), parseRemoteDocumentList);
}

export async function createRemoteDocument(
  projectPath: string,
  connectionId: string,
  collection: string,
): Promise<RemoteResult<RemoteDocumentSummary>> {
  const input = parseIpcPayload('cmsRemote:create', { projectPath, connectionId, collection });
  return parseRemoteResult(await window.avb.createRemoteDocument(input), (value) => {
    const [summary] = parseRemoteDocuments([value]);
    if (summary === undefined) {
      throw new Error('Expected the new document.');
    }
    return summary;
  });
}

export async function deleteRemoteDocuments(
  projectPath: string,
  connectionId: string,
  ids: readonly string[],
): Promise<RemoteResult<number>> {
  const input = parseIpcPayload('cmsRemote:delete', { projectPath, connectionId, ids });
  return parseRemoteResult(await window.avb.deleteRemoteDocuments(input), (value) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error('Expected how many documents were deleted.');
    }
    return value;
  });
}

export async function moveRemoteDocument(
  projectPath: string,
  connectionId: string,
  move: RemoteMove,
): Promise<RemoteResult<RemoteDocumentList>> {
  const input = parseIpcPayload('cmsRemote:move', { projectPath, connectionId, move });
  return parseRemoteResult(await window.avb.moveRemoteDocument(input), parseRemoteDocumentList);
}

export async function remoteDocument(
  projectPath: string,
  connectionId: string,
  id: string,
): Promise<RemoteResult<RemoteDocument>> {
  const input = parseIpcPayload('cmsRemote:document', { projectPath, connectionId, id });
  return parseRemoteResult(await window.avb.remoteDocument(input), parseRemoteDocument);
}

export async function writeRemoteDocument(
  projectPath: string,
  connectionId: string,
  write: RemoteWrite,
): Promise<RemoteResult<RemoteDocument>> {
  const input = parseIpcPayload('cmsRemote:write', { projectPath, connectionId, write });
  return parseRemoteResult(await window.avb.writeRemoteDocument(input), parseRemoteDocument);
}

export async function remoteReferenceOptions(
  projectPath: string,
  connectionId: string,
  types: readonly string[],
): Promise<RemoteResult<readonly RemoteReferenceOption[]>> {
  const input = parseIpcPayload('cmsRemote:references', { projectPath, connectionId, types });
  return parseRemoteResult(
    await window.avb.remoteReferenceOptions(input),
    parseRemoteReferenceOptions,
  );
}

/** Asks for a file in the system dialog and stores it in the CMS; undefined when cancelled. */
export async function uploadRemoteAsset(
  projectPath: string,
  connectionId: string,
  kind: RemoteAssetKind,
): Promise<RemoteResult<RemoteAsset | undefined>> {
  const input = parseIpcPayload('cmsRemote:upload', { projectPath, connectionId, kind });
  return parseRemoteResult(await window.avb.uploadRemoteAsset(input), (value) =>
    value === undefined ? undefined : parseRemoteAsset(value),
  );
}

export async function actOnRemoteDocument(
  projectPath: string,
  connectionId: string,
  request: { readonly id: string; readonly action: RemoteDocumentAction },
): Promise<RemoteResult<RemoteDocument | undefined>> {
  const input = parseIpcPayload('cmsRemote:act', { projectPath, connectionId, ...request });
  return parseRemoteResult(await window.avb.actOnRemoteDocument(input), parseRemoteActedDocument);
}

export async function remoteHistory(
  projectPath: string,
  connectionId: string,
  id: string,
): Promise<RemoteResult<readonly RemoteRevision[]>> {
  const input = parseIpcPayload('cmsRemote:history', { projectPath, connectionId, id });
  return parseRemoteResult(await window.avb.remoteHistory(input), parseRemoteRevisions);
}

export async function restoreRemoteRevision(
  projectPath: string,
  connectionId: string,
  request: { readonly id: string; readonly revision: string },
): Promise<RemoteResult<RemoteDocument>> {
  const input = parseIpcPayload('cmsRemote:restore', { projectPath, connectionId, ...request });
  return parseRemoteResult(await window.avb.restoreRemoteRevision(input), parseRemoteDocument);
}
