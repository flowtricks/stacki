// What the connected-CMS panel has read, kept across opens so it shows at once.
//
// Every read is stale-while-revalidate: a view shows what it last showed (or
// what was prefetched) immediately and asks the CMS again behind it, replacing
// the value only when the answer comes. A failed refresh keeps the last good
// value rather than blanking the view; a failure is shown only when there is
// nothing to show. Reads of the same key share one request. Each cache keeps
// its most recently used entries, up to a stated bound.
//
// Stacki works offline; a connected CMS is the one part that needs the
// network. While the system says it is offline no request is made at all: a
// view keeps what it has, or says it is offline, and refreshes when the
// connection returns (useRemote in remoteCmsShared.tsx).

import { assert } from '../../../shared/core/assert';
import { remoteCollections, remoteDocument, remoteDocuments } from '../../ipc/cmsConnectionsBridge';
import type {
  RemoteCollection,
  RemoteDocument,
  RemoteDocumentList,
  RemoteReferenceOption,
  RemoteResult,
} from '../../../shared/properties/cmsRemote';

export interface RemoteCache<T> {
  readonly get: (key: string) => RemoteResult<T> | undefined;
  readonly set: (key: string, value: T) => void;
  /** Reads `key` afresh (sharing a read in flight), keeping the last good value on failure. */
  readonly load: (key: string, read: () => Promise<RemoteResult<T>>) => Promise<RemoteResult<T>>;
  /** Reads `key` only when nothing is kept or in flight for it. */
  readonly prefetch: (key: string, read: () => Promise<RemoteResult<T>>) => void;
}

export function createRemoteCache<T>(entriesMax: number): RemoteCache<T> {
  assert(Number.isSafeInteger(entriesMax), 'A cache bound is a whole number');
  assert(entriesMax > 0, 'A cache keeps at least one entry');
  const entries = new Map<string, RemoteResult<T>>();
  const reading = new Map<string, Promise<RemoteResult<T>>>();
  const keep = (key: string, result: RemoteResult<T>) => {
    entries.delete(key);
    entries.set(key, result);
    const oldest = entries.size > entriesMax ? entries.keys().next().value : undefined;
    if (oldest !== undefined) {
      entries.delete(oldest);
    }
    assert(entries.size <= entriesMax, 'A remote cache stays within its bound');
  };
  const load = (key: string, read: () => Promise<RemoteResult<T>>) => {
    if (!online()) {
      const kept = entries.get(key);
      return Promise.resolve(kept?.ok ? kept : OFFLINE);
    }
    const inFlight = reading.get(key);
    if (inFlight) {
      return inFlight;
    }
    const request = read()
      .catch((error: unknown): RemoteResult<T> => ({ ok: false, message: String(error) }))
      .then((result) => {
        reading.delete(key);
        const kept = entries.get(key);
        if (result.ok || kept === undefined || !kept.ok) {
          keep(key, result);
          return result;
        }
        return kept;
      });
    reading.set(key, request);
    return request;
  };
  return {
    get: (key) => entries.get(key),
    set: (key, value) => keep(key, { ok: true, value }),
    load,
    prefetch: (key, read) => {
      if (!entries.has(key) && !reading.has(key)) {
        void load(key, read);
      }
    },
  };
}

/** What a view with nothing kept shows while the system is offline. */
export const OFFLINE_MESSAGE = 'You’re offline. This CMS’s content shows when you reconnect.';
const OFFLINE = { ok: false, message: OFFLINE_MESSAGE } as const;

/** False only when the platform knows it has no network; unknown counts as online. */
export function online(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

// One cache per kind of read, so each is typed by what it holds.
export const COLLECTIONS = createRemoteCache<readonly RemoteCollection[]>(16);
export const DOCUMENT_LISTS = createRemoteCache<RemoteDocumentList>(256);
export const DOCUMENTS = createRemoteCache<RemoteDocument>(512);
export const REFERENCE_OPTIONS = createRemoteCache<readonly RemoteReferenceOption[]>(64);

export const listKey = (connectionId: string, collection: string) =>
  `${connectionId}:${collection}`;
export const documentKey = (connectionId: string, id: string) => `${connectionId}:${id}`;

// Reads started before they are asked for, so opening shows what is already kept.

/**
 * A connection's collections, then each collection's documents, read afresh:
 * called once as the CMS panel shows the connection, about twenty small reads.
 */
export function prefetchConnection(projectPath: string, connectionId: string): void {
  if (!online()) {
    return;
  }
  void COLLECTIONS.load(connectionId, () => remoteCollections(projectPath, connectionId)).then(
    (collections) => {
      for (const collection of collections.ok ? collections.value : []) {
        prefetchList(projectPath, connectionId, collection.name);
      }
    },
  );
}

/** One collection's documents; a collection of one also has that document read. */
export function prefetchList(projectPath: string, connectionId: string, collection: string): void {
  const key = listKey(connectionId, collection);
  const read = () => remoteDocuments(projectPath, connectionId, collection);
  void DOCUMENT_LISTS.load(key, read).then((list) => {
    const only = list.ok && list.value.documents.length === 1 ? list.value.documents[0] : undefined;
    if (only) {
      prefetchDocument(projectPath, connectionId, only.id);
    }
  });
}

/** One document, as a row is pointed at: it is usually opened next. */
export function prefetchDocument(projectPath: string, connectionId: string, id: string): void {
  DOCUMENTS.prefetch(documentKey(connectionId, id), () =>
    remoteDocument(projectPath, connectionId, id),
  );
}
