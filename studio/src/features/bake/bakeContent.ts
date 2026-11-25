// The content collections a baked site's Collections panel shows: what Studio's own
// handlers answer for `content:collections` and `content:entries`, read once at bake
// time and served from the snapshot. The handlers read the project's content config
// through a small runner the config's own zod schemas execute in; that runner is a
// child of the build child (bakeBuild.ts), and ends with it.
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CONTENT_WORKERS_ENV } from '../cms/cmsRuntime';
import { cmsHandlers } from '../cms/cmsHost';
import { documentId } from '../../../vendor/stacki/electron/content/astroRemoteService';
import { record } from '../../shared/validation';
import { CONTENT_LIMITS, type ContentFieldPages } from './bakeSnapshot';

/** The workers' text, embedded by the bundles that ship without the vendor tree. */
declare const __STACKI_CONTENT_WORKERS__: Readonly<Record<string, string>> | undefined;

export interface BakedContent {
  /** `content:collections` as the handler answered it. */
  readonly collections: unknown;
  /** `content:entries` for each collection, by name. */
  readonly entries: Readonly<Record<string, unknown>>;
  /** The CMS panel's reads (`content:remoteRead`), answered once each. */
  readonly remote: BakedRemote;
}

/** What the CMS panel reads, keyed the way it asks. */
export interface BakedRemote {
  readonly collections: unknown;
  /** By collection name: `documents`, `template` and `settings`. */
  readonly documents: Readonly<Record<string, unknown>>;
  readonly templates: Readonly<Record<string, unknown>>;
  readonly settings: Readonly<Record<string, unknown>>;
  /** By document id: the document, and the entry file it is read from. */
  readonly document: Readonly<Record<string, unknown>>;
  readonly files: Readonly<Record<string, { readonly file: string; readonly locator: readonly (string | number)[]; readonly collection: string }>>;
}

/** Writes the embedded workers where the content reader looks, when this bundle has
 * them; source runs find them in the vendor tree. */
async function stageWorkers(): Promise<string | undefined> {
  if (typeof __STACKI_CONTENT_WORKERS__ === 'undefined') {
    return undefined;
  }
  const folder = await mkdtemp(path.join(os.tmpdir(), 'stacki-content-workers-'));
  for (const [name, text] of Object.entries(__STACKI_CONTENT_WORKERS__)) {
    if (/^[a-zA-Z]+\.mjs$/.test(name)) {
      await writeFile(path.join(folder, name), text);
    }
  }
  process.env[CONTENT_WORKERS_ENV] = folder;
  return folder;
}

/** Every collection and its entries, or undefined when the site has none or the config
 * cannot be read: the Collections panel then stays as the demo had it. */
export async function readContent(root: string): Promise<BakedContent | undefined> {
  // The reader stages its runner in the project; the bake leaves no file behind.
  const runner = path.join(root, '.studio-cms-runner');
  const runnerExisted = existsSync(runner);
  const workers = await stageWorkers();
  try {
    const handlers = cmsHandlers();
    const listCollections = handlers.get('content:collections');
    const listEntries = handlers.get('content:entries');
    if (listCollections === undefined || listEntries === undefined) {
      return undefined;
    }
    const collections = record(await listCollections(root));
    const names = (Array.isArray(collections['collections']) ? collections['collections'] : [])
      .slice(0, CONTENT_LIMITS.collectionsMax)
      .flatMap((collection: unknown) => {
        const name = record(collection)['name'];
        return typeof name === 'string' ? [name] : [];
      });
    if (names.length === 0) {
      return undefined;
    }
    const entries: Record<string, unknown> = {};
    for (const name of names) {
      entries[name] = await listEntries({ projectPath: root, name }).catch(() => undefined);
    }
    const remoteRead = handlers.get('content:remoteRead');
    const remote = remoteRead === undefined ? undefined : await readRemote(root, names, entries, remoteRead);
    return remote === undefined ? undefined : { collections, entries, remote };
  } catch {
    return undefined; // A config that does not load leaves Collections as it was.
  } finally {
    if (!runnerExisted) {
      await rm(runner, { recursive: true, force: true });
    }
    if (workers !== undefined) {
      await rm(workers, { recursive: true, force: true });
    }
  }
}

/** The content as it crossed from the build child, or nothing. The snapshot's own
 * parser checks it again on the browser's side. */
export function parseBakedContent(input: unknown): BakedContent | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  const data = record(input);
  const entries = record(data['entries']);
  if (Object.keys(entries).length > CONTENT_LIMITS.collectionsMax) {
    return undefined;
  }
  const remote = record(data['remote']);
  return {
    collections: record(data['collections']),
    entries,
    remote: {
      collections: remote['collections'],
      documents: record(remote['documents']),
      templates: record(remote['templates']),
      settings: record(remote['settings']),
      document: record(remote['document']),
      files: parseRemoteFiles(remote['files']),
    },
  };
}

export function parseRemoteFiles(input: unknown): BakedRemote['files'] {
  const files: Record<string, { file: string; locator: readonly (string | number)[]; collection: string }> = {};
  for (const [id, value] of Object.entries(record(input)).slice(0, CONTENT_LIMITS.entriesMax)) {
    const entry = record(value);
    const locator = Array.isArray(entry['locator'])
      ? entry['locator'].filter((step: unknown): step is string | number => typeof step === 'string' || typeof step === 'number')
      : [];
    if (typeof entry['file'] === 'string' && typeof entry['collection'] === 'string') {
      files[id] = { file: entry['file'], locator, collection: entry['collection'] };
    }
  }
  return files;
}

type Handler = (payload: unknown) => Promise<unknown>;

// Every read the panel makes, made now: the collections, each collection's list, new-entry
// template and settings, and every document by its id.
async function readRemote(root: string, names: readonly string[], entries: Readonly<Record<string, unknown>>, remoteRead: Handler): Promise<BakedRemote> {
  const read = (request: unknown) => remoteRead({ projectPath: root, request });
  const documents: Record<string, unknown> = {};
  const templates: Record<string, unknown> = {};
  const settings: Record<string, unknown> = {};
  const document: Record<string, unknown> = {};
  const files: Record<string, { file: string; locator: readonly (string | number)[]; collection: string }> = {};
  for (const name of names) {
    documents[name] = await read({ operation: 'documents', collection: name });
    templates[name] = await read({ operation: 'template', collection: name });
    settings[name] = await read({ operation: 'settings', collection: name });
    const listing = record(entries[name] ?? {});
    for (const entry of (Array.isArray(listing['entries']) ? listing['entries'] : []).slice(0, CONTENT_LIMITS.entriesMax)) {
      const data = record(entry);
      if (typeof data['id'] === 'string' && typeof data['file'] === 'string') {
        const id = documentId(name, data['id']);
        document[id] = await read({ operation: 'document', id });
        const locator = Array.isArray(data['locator'])
          ? data['locator'].filter((step: unknown): step is string | number => typeof step === 'string' || typeof step === 'number')
          : [];
        files[id] = { file: data['file'], locator, collection: name };
      }
    }
  }
  return { collections: await read({ operation: 'collections' }), documents, templates, settings, document, files };
}

const FIELDS_MAX = 20_000;
const FIELD_CHARS_MIN = 3;
const FIELD_CHARS_MAX = 2_000;

export interface ContentEntryRef {
  readonly file: string;
  readonly locator: readonly (string | number)[];
  readonly data: Readonly<Record<string, unknown>>;
}

/** Each entry in the baked collections, as far as a page patch needs it. */
export function contentEntries(content: BakedContent): readonly ContentEntryRef[] {
  const found: ContentEntryRef[] = [];
  for (const listing of Object.values(content.entries)) {
    const entries = typeof listing === 'object' && listing !== null && 'entries' in listing ? listing.entries : [];
    for (const entry of Array.isArray(entries) ? entries.slice(0, CONTENT_LIMITS.entriesMax) : []) {
      const data = record(entry);
      const locator = Array.isArray(data['locator']) ? data['locator'].filter((step: unknown) => typeof step === 'string' || typeof step === 'number') : [];
      if (typeof data['file'] === 'string') {
        found.push({ file: data['file'], locator, data: record(data['data'] ?? {}) });
      }
    }
  }
  return found;
}

/** For every top-level text field, the pages where it is the whole text of an element or
 * an attribute, escaped as Astro escapes it. A demo edit to that field patches exactly
 * those places on those pages, and nowhere else. */
export function contentFieldPages(content: BakedContent, pages: ReadonlyMap<string, string>, escape: (text: string) => string): readonly ContentFieldPages[] {
  const fields: ContentFieldPages[] = [];
  const entries = contentEntries(content);
  // A value more than one entry holds (a shared group name) is not this entry's text on
  // the page: changing one entry would not change it there, so it is never patched.
  const holders = new Map<string, number>();
  for (const entry of entries) {
    for (const value of new Set(Object.values(entry.data).filter((item) => typeof item === 'string'))) {
      holders.set(value, (holders.get(value) ?? 0) + 1);
    }
  }
  for (const entry of entries) {
    for (const [field, value] of Object.entries(entry.data)) {
      if (typeof value === 'string' && value.length >= FIELD_CHARS_MIN && value.length <= FIELD_CHARS_MAX && fields.length < FIELDS_MAX) {
        // The whole text of an element or of an attribute: a short value such as a
        // group name also appears inside unrelated sentences, which an edit must not touch.
        const shown = escape(value);
        const literal = shown.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const whole = new RegExp(`>\\s*${literal}\\s*<|="${literal}"`);
        const on = (holders.get(value) ?? 0) > 1 ? [] : [...pages].filter(([, html]) => whole.test(html)).map(([page]) => page);
        fields.push({ file: entry.file, locator: entry.locator, field, pages: on });
      }
    }
  }
  return fields;
}
