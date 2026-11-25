// The CMS panel's remote views read and write through here: a saved
// connection's calls go to its CMS (cmsConnectionsBridge.ts, Studio's HTTP
// client in its place), and the project's Astro content collections, named by
// their fixed id (astroContent.ts), go to the content handlers through the CMS
// transport both hosts provide. The views stay the same for both.
import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import { ASTRO_CONTENT_ID, type AstroRemoteEdit, type AstroRemoteRead } from '../../shared/properties/astroContent';
import {
  parseRemoteCollections,
  parseRemoteDocument,
  parseRemoteDocumentList,
  parseRemoteDocuments,
  parseRemoteResult,
  type RemoteCollection,
  type RemoteDocument,
  type RemoteDocumentList,
  type RemoteDocumentSummary,
  type RemoteResult,
  type RemoteWrite,
} from '../../shared/properties/cmsRemote';
import * as connections from './cmsConnectionsBridge';
import { parseCollectionSettings, type CollectionSettings, type SettingsChange } from '../../shared/properties/collectionSettings';
import { cmsTransport } from './editorEnvironment';
import { described } from '../../shared/properties/i18n/messageRef';

export function remoteCollections(projectPath: string, connectionId: string): Promise<RemoteResult<readonly RemoteCollection[]>> {
  return connectionId === ASTRO_CONTENT_ID
    ? read(projectPath, { operation: 'collections' }, parseRemoteCollections)
    : connections.remoteCollections(projectPath, connectionId);
}

export function remoteDocuments(
  projectPath: string,
  connectionId: string,
  collection: string,
  columns: readonly string[] = [],
): Promise<RemoteResult<RemoteDocumentList>> {
  return connectionId === ASTRO_CONTENT_ID
    ? read(projectPath, { operation: 'documents', collection, columns }, parseRemoteDocumentList)
    : connections.remoteDocuments(projectPath, connectionId, collection, columns);
}

export function remoteDocument(projectPath: string, connectionId: string, id: string): Promise<RemoteResult<RemoteDocument>> {
  return connectionId === ASTRO_CONTENT_ID
    ? read(projectPath, { operation: 'document', id }, parseRemoteDocument)
    : connections.remoteDocument(projectPath, connectionId, id);
}

/** A collection's fields with no values: what a new item is edited as before it is created. */
export function remoteTemplate(projectPath: string, connectionId: string, collection: string): Promise<RemoteResult<RemoteDocument>> {
  return connectionId === ASTRO_CONTENT_ID
    ? read(projectPath, { operation: 'template', collection }, parseRemoteDocument)
    : connections.remoteTemplate(projectPath, connectionId, collection);
}

export function writeRemoteDocument(projectPath: string, connectionId: string, write: RemoteWrite): Promise<RemoteResult<RemoteDocument>> {
  return connectionId === ASTRO_CONTENT_ID
    ? edit(projectPath, { operation: 'write', write }, parseRemoteDocument)
    : connections.writeRemoteDocument(projectPath, connectionId, write);
}

/** Renames an Astro content entry's id to `slug`, with its file and every reference to it. */
export function renameContentEntry(projectPath: string, id: string, slug: string): Promise<RemoteResult<RemoteDocument>> {
  return edit(projectPath, { operation: 'rename', id, slug }, parseRemoteDocument);
}

export function createRemoteDocument(projectPath: string, connectionId: string, collection: string): Promise<RemoteResult<RemoteDocumentSummary>> {
  return connectionId === ASTRO_CONTENT_ID
    ? edit(projectPath, { operation: 'create', collection }, parseSummary)
    : connections.createRemoteDocument(projectPath, connectionId, collection);
}

export function deleteRemoteDocuments(projectPath: string, connectionId: string, ids: readonly string[]): Promise<RemoteResult<number>> {
  return connectionId === ASTRO_CONTENT_ID
    ? edit(projectPath, { operation: 'delete', ids }, parseRemoved)
    : connections.deleteRemoteDocuments(projectPath, connectionId, ids);
}

/** A content collection's settings: its name and fields as its config states them. */
export function collectionSettings(projectPath: string, collection: string): Promise<RemoteResult<CollectionSettings>> {
  return read(projectPath, { operation: 'settings', collection }, parseCollectionSettings);
}

/** Changes a content collection's settings, its entries and the code that names it. */
export function changeCollectionSettings(projectPath: string, collection: string, change: SettingsChange): Promise<RemoteResult<CollectionSettings>> {
  return edit(projectPath, { operation: 'settings', collection, change }, parseCollectionSettings);
}

/** Adds a content collection named from `label` (a typed name) to the content config. */
export function createContentCollection(projectPath: string, label: string): Promise<RemoteResult<RemoteCollection>> {
  return edit(projectPath, { operation: 'createCollection', name: label }, (value) => {
    const [collection] = parseRemoteCollections([value]);
    if (collection === undefined) {
      throw new Error('Expected the new collection.');
    }
    return collection;
  });
}

async function read<T>(projectPath: string, request: AstroRemoteRead, parse: (value: unknown) => T): Promise<RemoteResult<T>> {
  return attempt(async () => {
    const payload = parseIpcPayload('content:remoteRead', { projectPath, request });
    return parseRemoteResult(await cmsTransport.contentRemoteRead(payload), parse);
  });
}

async function edit<T>(projectPath: string, request: AstroRemoteEdit, parse: (value: unknown) => T): Promise<RemoteResult<T>> {
  return attempt(async () => {
    // The payload parser checks the request, a typed collection name included.
    const payload = parseIpcPayload('content:remoteEdit', { projectPath, request });
    return parseRemoteResult(await cmsTransport.contentRemoteEdit(payload), parse);
  });
}

// A request refused at this boundary (an unusable name) or one the host could
// not complete is the panel's to show, as a CMS's own failures are.
async function attempt<T>(run: () => Promise<RemoteResult<T>>): Promise<RemoteResult<T>> {
  try {
    return await run();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // The browser's or host's own text wins when there is one; it is not ours to translate.
    return message === '' ? { ok: false, ...described('error.bridge.contentRequestFailed') } : { ok: false, message: message.slice(0, 900) };
  }
}

function parseSummary(value: unknown): RemoteDocumentSummary {
  const [summary] = parseRemoteDocuments([value]);
  if (summary === undefined) {
    throw new Error('Expected the new entry.');
  }
  return summary;
}

function parseRemoved(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Expected how many entries were deleted.');
  }
  return value;
}
