// The demo manifest: everything a browser needs to answer Studio's requests with
// no server. It is written at bake time and read over the network, so it is parsed
// and bounded like any other boundary value. Runs in Node and in the browser.
import { BAKE_PROTOCOL } from './bakeProtocol';
import { parseEntryProps } from '../pages/entryPropsSample';
import { parseComponentCatalog, type ComponentCatalog } from './componentTemplates';

const CONTENT_FIELDS_MAX = 20_000;

export const CONTENT_LIMITS = {
  collectionsMax: 64,
  /** Entries are files the page's rooms open, so they count against the source limit. */
  entriesMax: 2_000,
} as const satisfies Record<string, number>;

/** Where one entry field's text shows, as written, on a baked page. */
export interface ContentFieldPages {
  readonly file: string;
  readonly locator: readonly (string | number)[];
  readonly field: string;
  readonly pages: readonly string[];
}
import { MAX_SOURCE, record, sourcePath, string } from '../../shared/validation';

export const BAKE_LIMITS = {
  /** The snapshot is one request; past this the demo would be slow to open at all. */
  snapshotBytesMax: 24_000_000,
  sourceFilesMax: 2_000,
  pagesMax: 200,
  /** Entries baked per template page. The rest stay on the site as built, with no editor. */
  templateEntriesMax: 64,
  sectionsMax: 2_000,
  sectionURLsMax: 200,
  urlCharsMax: 4_000_000,
} as const satisfies Record<string, number>;

export interface BakePage {
  readonly file: string;
  /** The route Studio asks for, always with a leading slash. */
  readonly route: string;
  /** The built file, relative to the baked site's root. */
  readonly document: string;
  /**
   * For one entry of a template page (`src/pages/docs/[...slug].astro`), what the entry
   * picker calls it. The entries share the template's file; each has its own route and
   * document, so the canvas shows one entry and an edit to the template shows on all.
   */
  readonly entry?: string | undefined;
  /** For a template entry, a sample of its props (entryPropsSample.ts), for the binding picker. */
  readonly entryProps?: unknown;
}

export interface BakeSection {
  /** `src/styles/global.css`, or `src/pages/index.astro#0` for a `<style>` block. */
  readonly id: string;
  readonly file: string;
  /** Astro's scope for a scoped block, or undefined when the rules are global. */
  readonly scope: string | undefined;
  /** Each authored `url()` and what the build turned it into. */
  readonly urls: Readonly<Record<string, string>>;
}

export interface BakeSnapshot {
  readonly protocol: number;
  /** Identifies this bake. Edits saved against another bake are never replayed. */
  readonly id: string;
  readonly studioVersion: string;
  /** The URL prefix of the baked site, with a trailing slash. */
  readonly base: string;
  /** `/studio/api/project` as Studio's own scanner produced it. */
  readonly project: Readonly<Record<string, unknown>>;
  /** `/studio/api/assets` as Studio's own scanner produced it. */
  readonly assets: unknown;
  /** `/studio/api/variables` as Studio's own scanner produced it. */
  readonly variables: unknown;
  readonly sources: Readonly<Record<string, string>>;
  readonly pages: readonly BakePage[];
  readonly sections: readonly BakeSection[];
  /** How each component instance and insertion recipe renders without Astro. */
  readonly components: ComponentCatalog;
  /** The site's content collections, when it has any the bake could read. */
  readonly content: SnapshotContent | undefined;
}

export interface SnapshotContent {
  /** `content:collections` as Studio's handler answered it; the client parses it. */
  readonly collections: Readonly<Record<string, unknown>>;
  /** `content:entries` per collection name; the client parses each. */
  readonly entries: Readonly<Record<string, unknown>>;
  /** Where each entry's text fields show as written. */
  readonly fields: readonly ContentFieldPages[];
  /** The CMS panel's reads, answered at bake time. */
  readonly remote: SnapshotRemote;
}

export interface SnapshotRemote {
  readonly collections: unknown;
  readonly documents: Readonly<Record<string, unknown>>;
  readonly templates: Readonly<Record<string, unknown>>;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly document: Readonly<Record<string, unknown>>;
  readonly files: Readonly<Record<string, { readonly file: string; readonly locator: readonly (string | number)[]; readonly collection: string }>>;
}

/** Parses the snapshot's text. Throws on any shape, bound or version it cannot trust. */
export function parseBakeSnapshot(text: string): BakeSnapshot {
  if (text.length > BAKE_LIMITS.snapshotBytesMax) {
    throw new Error('Snapshot exceeds its size limit');
  }
  const input: unknown = JSON.parse(text);
  const data = record(input);
  if (data['protocol'] !== BAKE_PROTOCOL) {
    throw new Error('Snapshot uses another bake protocol');
  }
  const id = string(data['id'], 32);
  if (!/^[a-f0-9]{32}$/.test(id)) {
    throw new Error('Snapshot id is not a digest');
  }
  const base = string(data['base'], 500);
  if (!base.startsWith('/') || !base.endsWith('/') || base.startsWith('//') || base.includes('..')) {
    throw new Error('Snapshot base is not a site path');
  }
  const pages = list(data['pages'], BAKE_LIMITS.pagesMax, parsePage);
  if (pages.length === 0) {
    throw new Error('Snapshot has no pages');
  }
  return {
    protocol: BAKE_PROTOCOL,
    id,
    studioVersion: string(data['studioVersion'], 50),
    base,
    project: record(data['project']),
    assets: data['assets'],
    variables: data['variables'],
    sources: parseSources(data['sources']),
    pages,
    sections: list(data['sections'], BAKE_LIMITS.sectionsMax, parseSection),
    components: parseComponentCatalog(data['components']),
    content: data['content'] === undefined ? undefined : parseContent(data['content']),
  };
}

function list<T>(input: unknown, maximum: number, parse: (item: unknown) => T): readonly T[] {
  if (!Array.isArray(input)) {
    throw new Error('Snapshot list is missing');
  }
  if (input.length > maximum) {
    throw new Error('Snapshot list exceeds its limit');
  }
  return input.map((item: unknown) => parse(item));
}

function parseSources(input: unknown): Readonly<Record<string, string>> {
  const entries = Object.entries(record(input));
  if (entries.length > BAKE_LIMITS.sourceFilesMax) {
    throw new Error('Snapshot has too many source files');
  }
  const sources: Record<string, string> = {};
  for (const [file, source] of entries) {
    sources[sourcePath(file)] = string(source, MAX_SOURCE);
  }
  return sources;
}

function parsePage(input: unknown): BakePage {
  const data = record(input);
  const route = string(data['route'], 500);
  if (!route.startsWith('/') || route.startsWith('//')) {
    throw new Error('Snapshot page route is not a path');
  }
  const document = string(data['document'], 500);
  if (document.startsWith('/') || document.split('/').includes('..') || !document.endsWith('.html')) {
    throw new Error('Snapshot page document is outside the site');
  }
  const file = sourcePath(data['file']);
  if (data['entry'] === undefined) {
    return { file, route, document };
  }
  if (!file.startsWith('src/pages/') || !file.includes('[') || route.includes('[')) {
    throw new Error('Snapshot page entry is not a template entry');
  }
  const entry = string(data['entry'], 1_000);
  const entryProps = parseEntryProps(data['entryProps']);
  return entryProps === undefined ? { file, route, document, entry } : { file, route, document, entry, entryProps };
}

function parseSection(input: unknown): BakeSection {
  const data = record(input);
  const scope = data['scope'] === undefined ? undefined : string(data['scope'], 50);
  if (scope !== undefined && !/^[a-z0-9]+$/.test(scope)) {
    throw new Error('Snapshot section scope is not an Astro scope');
  }
  const urls = Object.entries(record(data['urls']));
  if (urls.length > BAKE_LIMITS.sectionURLsMax) {
    throw new Error('Snapshot section has too many URLs');
  }
  return {
    id: string(data['id'], 520),
    file: sourcePath(data['file']),
    scope,
    urls: Object.fromEntries(urls.map(([from, to]) => [string(from, 2_000), string(to, BAKE_LIMITS.urlCharsMax)])),
  };
}

function parseContent(input: unknown): SnapshotContent {
  const data = record(input);
  const entries = record(data['entries']);
  if (Object.keys(entries).length > CONTENT_LIMITS.collectionsMax) {
    throw new Error('Snapshot has too many collections');
  }
  const fields = list(data['fields'], CONTENT_FIELDS_MAX, (item) => {
    const field = record(item);
    const locator = list(field['locator'], 16, (step) => {
      if (typeof step === 'number' && Number.isSafeInteger(step) && step >= 0) {
        return step;
      }
      return string(step, 500);
    });
    return {
      file: sourcePath(field['file']),
      locator,
      field: string(field['field'], 200),
      pages: list(field['pages'], BAKE_LIMITS.pagesMax, (page) => sourcePath(page)),
    };
  });
  const remote = record(data['remote']);
  const files: Record<string, { file: string; locator: readonly (string | number)[]; collection: string }> = {};
  const fileEntries = Object.entries(record(remote['files']));
  if (fileEntries.length > CONTENT_LIMITS.entriesMax) {
    throw new Error('Snapshot has too many content documents');
  }
  for (const [id, value] of fileEntries) {
    const entry = record(value);
    files[string(id, 200)] = {
      file: sourcePath(entry['file']),
      locator: list(entry['locator'], 16, (step) => (typeof step === 'number' && Number.isSafeInteger(step) ? step : string(step, 500))),
      collection: string(entry['collection'], 200),
    };
  }
  return {
    collections: record(data['collections']),
    entries,
    fields,
    remote: {
      collections: remote['collections'],
      documents: record(remote['documents']),
      templates: record(remote['templates']),
      settings: record(remote['settings']),
      document: record(remote['document']),
      files,
    },
  };
}
