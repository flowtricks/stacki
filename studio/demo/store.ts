// Where a visitor's edits live: one IndexedDB database per bake, one record per
// file, holding the room's document. Every failure here is expected, because a
// browser may block or fill storage at any moment, so nothing in this file throws
// to its caller. The demo keeps working and says edits will not survive a reload.
import { err, ok, type Result } from '../vendor/stacki/shared/core/result';

export type StorageState = 'saving' | 'blocked' | 'full';

const STORE = 'rooms';
const OPEN_TIMEOUT_MS = 3_000;
const DATABASES_MAX = 2_000;
/** Saved settings files and uploads, together. Uploads are capped well below this. */
const FILES_MAX = 500;

export interface EditStore {
  readonly state: () => StorageState;
  readonly load: () => Promise<ReadonlyMap<string, Uint8Array>>;
  readonly save: (file: string, update: Uint8Array) => Promise<void>;
  /** Files with no room: project settings the bake did not have, and uploads. */
  readonly loadFiles: () => Promise<SavedFiles>;
  readonly saveFile: (file: string, value: string | Blob) => Promise<void>;
}

export interface SavedFiles {
  readonly texts: ReadonlyMap<string, string>;
  readonly blobs: ReadonlyMap<string, Blob>;
}

// Room records are keyed by the bare path, which never holds a colon, so these keys
// cannot collide with them, and `load` skips them because their values are not updates.
const FILE_KEY = 'file:';

function databaseName(snapshot: string): string {
  return `stacki-demo-${snapshot}`;
}

function promised<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Storage request failed'));
  });
}

function open(name: string): Promise<Result<IDBDatabase, string>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(err('Storage did not answer')), OPEN_TIMEOUT_MS);
    try {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => {
        clearTimeout(timer);
        // Reset in another tab deletes this database, and the delete waits for every
        // open connection. Closing here lets it finish instead of wedging later opens.
        request.result.onversionchange = () => request.result.close();
        resolve(ok(request.result));
      };
      request.onerror = () => {
        clearTimeout(timer);
        resolve(err(String(request.error)));
      };
    } catch (error: unknown) {
      clearTimeout(timer);
      resolve(err(String(error)));
    }
  });
}

function isQuota(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'QuotaExceededError';
}

interface NullRequest {
  result: unknown;
  onsuccess: ((event: { readonly target: NullRequest }) => void) | null;
  onerror: null;
  onupgradeneeded: null;
}

function nullRequest(result: unknown): NullRequest {
  const request: NullRequest = { result, onsuccess: null, onerror: null, onupgradeneeded: null };
  setTimeout(() => request.onsuccess?.({ target: request }), 0);
  return request;
}

// The client's document cache waits on IndexedDB before it connects, and never hears
// back when the browser refuses. So a refusal gets a store that keeps nothing: the
// client starts, and the document lives in memory until the visitor leaves.
function installNullStorage(): void {
  const store = {
    add: () => nullRequest(1),
    put: () => nullRequest(1),
    get: () => nullRequest(undefined),
    getAll: () => nullRequest([]),
    getAllKeys: () => nullRequest([]),
    count: () => nullRequest(0),
    delete: () => nullRequest(undefined),
    openKeyCursor: () => nullRequest(null),
    openCursor: () => nullRequest(null),
  };
  const database = { transaction: () => ({ objectStore: () => store }), createObjectStore: () => store, close: () => undefined };
  const factory = { open: () => nullRequest(database), deleteDatabase: () => nullRequest(undefined), databases: () => Promise.resolve([]) };
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: factory });
}

export async function openEditStore(snapshot: string, stateChanged: (state: StorageState) => void): Promise<EditStore> {
  const opened = await open(databaseName(snapshot));
  if (!opened.ok) {
    installNullStorage();
  }
  let state: StorageState = opened.ok ? 'saving' : 'blocked';
  const database = opened.ok ? opened.value : undefined;
  const fail = (next: StorageState) => {
    if (state !== next) {
      state = next;
      stateChanged(next);
    }
  };
  return {
    state: () => state,
    load: async () => {
      const files = new Map<string, Uint8Array>();
      if (database === undefined) {
        return files;
      }
      try {
        const store = database.transaction(STORE).objectStore(STORE);
        const [keys, values] = await Promise.all([promised(store.getAllKeys()), promised(store.getAll())]);
        keys.forEach((key, index) => {
          const value: unknown = values[index];
          if (typeof key === 'string' && value instanceof Uint8Array) {
            files.set(key, value);
          }
        });
      } catch {
        fail('blocked');
      }
      return files;
    },
    save: async (file, update) => {
      if (database === undefined) {
        return;
      }
      try {
        const transaction = database.transaction(STORE, 'readwrite');
        await promised(transaction.objectStore(STORE).put(update, file));
      } catch (error: unknown) {
        fail(isQuota(error) ? 'full' : 'blocked');
      }
    },
    loadFiles: async () => {
      const texts = new Map<string, string>();
      const blobs = new Map<string, Blob>();
      if (database === undefined) {
        return { texts, blobs };
      }
      try {
        const store = database.transaction(STORE).objectStore(STORE);
        const range = IDBKeyRange.bound(FILE_KEY, `${FILE_KEY}\uffff`);
        const [keys, values] = await Promise.all([promised(store.getAllKeys(range, FILES_MAX)), promised(store.getAll(range, FILES_MAX))]);
        keys.forEach((key, index) => {
          const value: unknown = values[index];
          if (typeof key === 'string') {
            const file = key.slice(FILE_KEY.length);
            if (typeof value === 'string') {
              texts.set(file, value);
            } else if (value instanceof Blob) {
              blobs.set(file, value);
            }
          }
        });
      } catch {
        fail('blocked');
      }
      return { texts, blobs };
    },
    saveFile: async (file, value) => {
      if (database === undefined) {
        return;
      }
      try {
        const transaction = database.transaction(STORE, 'readwrite');
        await promised(transaction.objectStore(STORE).put(value, `${FILE_KEY}${file}`));
      } catch (error: unknown) {
        fail(isQuota(error) ? 'full' : 'blocked');
      }
    },
  };
}

/** Removes every saved edit of this bake, and the client's own document caches. The
 * deletes queue behind this page's open connections, which close with the reload. */
export async function forgetEdits(snapshot: string, files: readonly string[], documentName: (file: string) => string): Promise<void> {
  const names = new Set([databaseName(snapshot), ...files.map(documentName)]);
  try {
    const listed = await indexedDB.databases();
    for (const entry of listed.slice(0, DATABASES_MAX)) {
      if (entry.name?.startsWith('astro-studio:') === true || entry.name?.startsWith('stacki-demo-') === true) {
        names.add(entry.name);
      }
    }
  } catch {
    /* Listing is optional: the known names above are enough. */
  }
  for (const name of names) {
    try {
      indexedDB.deleteDatabase(name);
    } catch {
      /* Blocked storage holds nothing to forget. */
    }
  }
}
