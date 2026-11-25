// Design mode's drafts: the frames of a page, kept so leaving by accident loses nothing. They live in the app's
// own browser storage (IndexedDB, database `stacki-design-mode`, in Stacki's user data folder: on macOS
// ~/Library/Application Support/Stacki/IndexedDB/), never in the project: nothing here can name a project file.
// A draft is keyed by project folder and page; the oldest are dropped past DRAFTS_MAX, and a draft past
// DRAFT_CHARS_MAX is not kept. Reading a draft parses it: storage is a boundary like any other.
import type { DesignFrameRecord, DesignInstanceInfo, DesignNodeSource, DesignPage } from '../model/designTypes';
import { DESIGN_LIMITS, FRAME_ID_PATTERN, toFrameId } from '../model/designTypes';

const DATABASE = 'stacki-design-mode';
const STORE = 'drafts';
const VERSION = 1;
const DRAFTS_MAX = 24;
const DRAFT_CHARS_MAX = 400_000_000;

export interface DesignDraft {
  readonly savedAtMs: number;
  readonly baselines: readonly {
    readonly id: string;
    readonly html: string;
    readonly url: string;
    readonly instances: readonly (readonly [string, DesignInstanceInfo])[];
    readonly sources: readonly (readonly [string, DesignNodeSource])[];
  }[];
  readonly frames: readonly { readonly record: DesignFrameRecord; readonly baseline: string; readonly html: string }[];
}

export function draftKey(page: DesignPage): string {
  return page.projectPath + '\n' + (page.file ?? page.route);
}

function open(): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DATABASE, VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

function done<T>(request: IDBRequest<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => resolve(undefined));
  });
}

/** The draft saved for this page, or undefined (none, unreadable, or storage unavailable). */
export async function loadDraft(page: DesignPage): Promise<DesignDraft | undefined> {
  const database = await open();
  if (database === undefined) {
    return undefined;
  }
  try {
    const raw: unknown = await done(database.transaction(STORE, 'readonly').objectStore(STORE).get(draftKey(page)));
    return parseDraft(raw);
  } finally {
    database.close();
  }
}

/** Saves the page's draft, or forgets it when `draft` is undefined. Failures are quiet: a draft is a convenience. */
export async function saveDraft(page: DesignPage, draft: DesignDraft | undefined): Promise<void> {
  const database = await open();
  if (database === undefined) {
    return;
  }
  try {
    const store = database.transaction(STORE, 'readwrite').objectStore(STORE);
    if (draft === undefined || draft.frames.length === 0) {
      await done(store.delete(draftKey(page)));
      return;
    }
    const chars = draft.frames.reduce((sum, frame) => sum + frame.html.length, 0) + draft.baselines.reduce((sum, baseline) => sum + baseline.html.length, 0);
    if (chars > DRAFT_CHARS_MAX) {
      return;
    }
    await done(store.put({ key: draftKey(page), ...draft }));
    await prune(database);
  } catch {
    // Storage full or unavailable: the session goes on; only the draft is lost.
  } finally {
    database.close();
  }
}

async function prune(database: IDBDatabase): Promise<void> {
  const store = database.transaction(STORE, 'readwrite').objectStore(STORE);
  const all: unknown = await done(store.getAll());
  if (!Array.isArray(all) || all.length <= DRAFTS_MAX) {
    return;
  }
  const dated = all
    .map((entry: unknown) => ({ key: field(entry, 'key'), savedAtMs: field(entry, 'savedAtMs') }))
    .filter((entry): entry is { readonly key: string; readonly savedAtMs: number } => typeof entry.key === 'string' && typeof entry.savedAtMs === 'number')
    .sort((first, second) => first.savedAtMs - second.savedAtMs);
  for (const old of dated.slice(0, dated.length - DRAFTS_MAX)) {
    await done(store.delete(old.key));
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A stored draft, checked: anything that is not one reads as no draft. */
export function parseDraft(raw: unknown): DesignDraft | undefined {
  const savedAtMs = finite(field(raw, 'savedAtMs'));
  const baselinesRaw = field(raw, 'baselines');
  const framesRaw = field(raw, 'frames');
  if (savedAtMs === undefined || !Array.isArray(baselinesRaw) || !Array.isArray(framesRaw)) {
    return undefined;
  }
  if (framesRaw.length === 0 || framesRaw.length > DESIGN_LIMITS.framesMax) {
    return undefined;
  }
  const baselines: DesignDraft['baselines'][number][] = [];
  for (const entry of baselinesRaw.slice(0, DESIGN_LIMITS.framesMax)) {
    const id = text(field(entry, 'id'));
    const html = text(field(entry, 'html'));
    const url = text(field(entry, 'url'));
    const instances = field(entry, 'instances');
    const sources = field(entry, 'sources');
    if (id === undefined || html === undefined || url === undefined || !Array.isArray(instances) || !Array.isArray(sources)) {
      return undefined;
    }
    // Written by this module from the same shapes; checked as pairs, the values kept as written.
    const instancePairs = instances.filter(
      (pair): pair is [string, DesignInstanceInfo] => Array.isArray(pair) && typeof pair[0] === 'string' && isInstance(pair[1]),
    );
    const sourcePairs = sources.filter((pair): pair is [string, DesignNodeSource] => Array.isArray(pair) && typeof pair[0] === 'string' && isSource(pair[1]));
    baselines.push({ id, html, url, instances: instancePairs, sources: sourcePairs });
  }
  const frames: DesignDraft['frames'][number][] = [];
  for (const entry of framesRaw) {
    const record = parseRecord(field(entry, 'record'));
    const baseline = text(field(entry, 'baseline'));
    const html = text(field(entry, 'html'));
    if (record === undefined || baseline === undefined || html === undefined || !baselines.some((candidate) => candidate.id === baseline)) {
      return undefined;
    }
    frames.push({ record, baseline, html });
  }
  return { savedAtMs, baselines, frames };
}

function isInstance(value: unknown): value is DesignInstanceInfo {
  return (
    typeof field(value, 'path') === 'string' &&
    typeof field(value, 'name') === 'string' &&
    typeof field(value, 'component') === 'string' &&
    typeof field(value, 'props') === 'object' &&
    typeof field(value, 'codeProps') === 'object' &&
    Array.isArray(field(value, 'slots'))
  );
}

function isSource(value: unknown): value is DesignNodeSource {
  return typeof field(value, 'path') === 'string' && typeof field(value, 'name') === 'string' && typeof field(value, 'kind') === 'string';
}

function parseRecord(value: unknown): DesignFrameRecord | undefined {
  const id = text(field(value, 'id'));
  const name = text(field(value, 'name'));
  const widthPx = finite(field(value, 'widthPx'));
  const viewportHeightPx = finite(field(value, 'viewportHeightPx'));
  const xPx = finite(field(value, 'xPx'));
  const yPx = finite(field(value, 'yPx'));
  if (id === undefined || !FRAME_ID_PATTERN.test(id) || name === undefined || widthPx === undefined || viewportHeightPx === undefined) {
    return undefined;
  }
  if (xPx === undefined || yPx === undefined) {
    return undefined;
  }
  return { id: toFrameId(id), name: name.slice(0, DESIGN_LIMITS.frameNameCharsMax), widthPx, viewportHeightPx, xPx, yPx };
}
