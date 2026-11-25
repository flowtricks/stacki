import { evictionOrder, PREVIEW_CACHE_BUDGETS, type CacheEntryInfo } from '../../../shared/properties/previewLru';
import type { PreviewAttemptLabel, SnapshotBox } from '../../../shared/properties/previewSnapshot';

// Where finished snapshots are kept between sessions: the browser profile's IndexedDB, which lives in the
// app's own data folder (Desktop's userData, Studio's browser profile), never in the project. Bounded by a
// byte budget with least-recently-used eviction (previewLru.ts), so a long-lived profile cannot grow without
// limit. Everything fails soft: with no IndexedDB, or when it errors, snapshots simply last the session.

/** One finished snapshot as it is kept. `html` has the dev server's origin as a token the host replaces. */
export interface HeldSnapshot {
  readonly key: string;
  readonly html: string;
  readonly box: SnapshotBox;
  readonly attempt: PreviewAttemptLabel;
  readonly bytes: number;
}

export interface SnapshotPersistence {
  readonly read: (id: string) => Promise<HeldSnapshot | undefined>;
  readonly write: (id: string, held: HeldSnapshot) => Promise<void>;
  readonly remove: (id: string) => Promise<void>;
}

/** A persistence that keeps nothing, for hosts without IndexedDB and for tests that want none. */
export const NO_PERSISTENCE: SnapshotPersistence = {
  read: () => Promise.resolve(undefined),
  write: () => Promise.resolve(),
  remove: () => Promise.resolve(),
};

const DATABASE_NAME = 'stacki-preview-snapshots';
const DATABASE_VERSION = 1;
const SNAPSHOTS = 'snapshots';
const META = 'meta';

interface Meta extends CacheEntryInfo {
  readonly id: string;
}

function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    source.addEventListener('success', () => resolve(source.result));
    source.addEventListener('error', () => reject(source.error ?? new Error('IndexedDB request failed')));
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve());
    transaction.addEventListener('error', () => reject(transaction.error ?? new Error('IndexedDB transaction failed')));
    transaction.addEventListener('abort', () => reject(transaction.error ?? new Error('IndexedDB transaction aborted')));
  });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = factory.open(DATABASE_NAME, DATABASE_VERSION);
    opening.onupgradeneeded = () => {
      opening.result.createObjectStore(SNAPSHOTS, { keyPath: 'id' });
      opening.result.createObjectStore(META, { keyPath: 'id' });
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error ?? new Error('IndexedDB open failed'));
  });
}

/** A named field of a stored value, as unknown: a record read back from disk is not yet trusted. */
function readField(value: object, name: string): unknown {
  const field: unknown = Reflect.get(value, name);
  return field;
}

function parseHeld(value: unknown): HeldSnapshot | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const key = readField(value, 'key');
  const html = readField(value, 'html');
  const box = readField(value, 'box');
  const attempt = readField(value, 'attempt');
  const bytes = readField(value, 'bytes');
  if (typeof key !== 'string' || typeof html !== 'string' || typeof bytes !== 'number' || typeof attempt !== 'string') {
    return undefined;
  }
  if (typeof box !== 'object' || box === null) {
    return undefined;
  }
  const left = readField(box, 'left');
  const top = readField(box, 'top');
  const width = readField(box, 'width');
  const height = readField(box, 'height');
  if (typeof left !== 'number' || typeof top !== 'number' || typeof width !== 'number' || typeof height !== 'number') {
    return undefined;
  }
  // A stored snapshot is parsed like a fresh one: whatever an older build left behind is dropped if it does not fit.
  const label = attempt === 'authored' || attempt === 'sample' || attempt === 'sample-minimal' || attempt === 'sample-bare' ? attempt : undefined;
  return label === undefined ? undefined : { key, html, box: { left, top, width, height }, attempt: label, bytes };
}

/** IndexedDB-backed persistence, or none when the host has no IndexedDB. */
export function indexedDBPersistence(factory: IDBFactory | undefined): SnapshotPersistence {
  if (factory === undefined) {
    return NO_PERSISTENCE;
  }
  let database: Promise<IDBDatabase> | undefined;
  const open = (): Promise<IDBDatabase> => {
    database ??= openDatabase(factory);
    return database;
  };
  const touched = new Set<string>();
  let trimming = false;
  const trim = async (): Promise<void> => {
    if (trimming) {
      return;
    }
    trimming = true;
    try {
      const db = await open();
      const metas: readonly unknown[] = await request(db.transaction(META, 'readonly').objectStore(META).getAll());
      const entries: Meta[] = metas.flatMap((meta) => {
        const id = typeof meta === 'object' && meta !== null ? readField(meta, 'id') : undefined;
        const bytes = typeof meta === 'object' && meta !== null ? readField(meta, 'bytes') : undefined;
        const usedAtMs = typeof meta === 'object' && meta !== null ? readField(meta, 'usedAtMs') : undefined;
        return typeof id === 'string' && typeof bytes === 'number' && typeof usedAtMs === 'number' ? [{ id, bytes, usedAtMs }] : [];
      });
      const drop = evictionOrder(entries, PREVIEW_CACHE_BUDGETS.diskBytes);
      if (drop.length > 0) {
        const transaction = db.transaction([SNAPSHOTS, META], 'readwrite');
        for (const id of drop) {
          transaction.objectStore(SNAPSHOTS).delete(id);
          transaction.objectStore(META).delete(id);
        }
        await done(transaction);
      }
    } catch {
      // A cache that cannot trim is still a cache.
    } finally {
      trimming = false;
    }
  };
  return {
    read: async (id) => {
      try {
        const db = await open();
        const held = parseHeld(await request(db.transaction(SNAPSHOTS, 'readonly').objectStore(SNAPSHOTS).get(id)));
        if (held !== undefined && !touched.has(id)) {
          touched.add(id);
          const transaction = db.transaction(META, 'readwrite');
          transaction.objectStore(META).put({ id, bytes: held.bytes, usedAtMs: Date.now() });
        }
        return held;
      } catch {
        return undefined;
      }
    },
    write: async (id, held) => {
      try {
        const db = await open();
        const transaction = db.transaction([SNAPSHOTS, META], 'readwrite');
        transaction.objectStore(SNAPSHOTS).put({ id, ...held });
        transaction.objectStore(META).put({ id, bytes: held.bytes, usedAtMs: Date.now() });
        await done(transaction);
        touched.add(id);
        await trim();
      } catch {
        // Not kept: the snapshot still serves this session from memory.
      }
    },
    remove: async (id) => {
      try {
        const db = await open();
        const transaction = db.transaction([SNAPSHOTS, META], 'readwrite');
        transaction.objectStore(SNAPSHOTS).delete(id);
        transaction.objectStore(META).delete(id);
        await done(transaction);
      } catch {
        // Nothing to remove that could be reached.
      }
    },
  };
}
