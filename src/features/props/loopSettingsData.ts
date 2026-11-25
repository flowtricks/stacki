// What the loop's list settings load and write outside the page: the project's
// collections and their fields, a reference's choices, and a query traced into
// another file, rewritten there (LoopSettings.tsx).

import { useEffect, useMemo, useState } from 'react';
import { groqQueryText, isItemId, type LoopQuery, type LoopSource } from '../../editor/loopQuery';
import { assert } from '../../../shared/core/assert';
import { described, type Described, type TypedMessageRef } from '../../../shared/properties/i18n/messageRef';
import { toRecord } from '../../../shared/core/record';
import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import { cmsTransport } from '../../ipc/editorEnvironment';
import { remoteDocument, remoteDocuments } from '../../ipc/remoteSource';
import { loadCatalog, loadFields, loadReferenceChoices, LOOP_CATALOG_LIMITS, type CatalogField, type LoopCatalog } from './loopCatalog';
import { parseSourceKey, sourceKey } from './loopSettingsModel';
import { type TracedCollection } from './LoopLineage';
import { rewrittenGroqLiteral, type GroqLiteral } from '../../editor/loopTrace';
import { readText, writeText } from '../../ipc/bridge';
import type { ChoiceContext } from './LoopFilters';
/** A traced GROQ query as list settings, when the trace found its literal and could read it. */
export function editableTrace(traced: TracedCollection): { readonly query: LoopQuery; readonly literal: GroqLiteral; readonly file: string } | undefined {
  const groq = traced.groq;
  const literal = traced.literal;
  if (groq === undefined || literal === undefined || traced.source.kind !== 'sanity') {
    return undefined;
  }
  // No projection stays none (`''`): one would change what each item holds.
  const query: LoopQuery = {
    source: traced.source,
    match: groq.match,
    conditions: groq.conditions,
    sorts: groq.sorts,
    random: false,
    offset: groq.offset,
    limit: groq.limit,
    projection: groq.projection ?? '',
    parameter: { kind: 'data' },
  };
  return { query, literal, file: traced.file };
}

export async function writeTracedQuery(
  projectPath: string,
  literal: GroqLiteral,
  change: { readonly file: string; readonly query: LoopQuery },
): Promise<{ readonly ok: true } | ({ readonly ok: false } & Described & { readonly messageRef: TypedMessageRef })> {
  try {
    const text = await readText(projectPath, change.file);
    const next = rewrittenGroqLiteral(text, literal, groqQueryText(change.query, []));
    if (next === undefined) {
      return { ok: false, ...described('props.loop.save.changed', { file: change.file }) };
    }
    await writeText(projectPath, change.file, next);
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, ...described('props.loop.save.failed', { file: change.file, detail: error instanceof Error ? error.message : String(error) }) };
  }
}

// ---------------------------------------------------------------------------
// Loading.
// ---------------------------------------------------------------------------

// One catalog per project, kept while the app runs and refreshed each time a
// loop is opened: the menu opens on what was known, then catches up.
const catalogs = new Map<string, LoopCatalog>();

export function useLoopCatalog(projectPath: string | undefined): LoopCatalog | undefined {
  const [catalog, setCatalog] = useState<LoopCatalog | undefined>(projectPath ? catalogs.get(projectPath) : undefined);
  useEffect(() => {
    if (!projectPath) {
      return undefined;
    }
    let live = true;
    void loadCatalog(projectPath).then((loaded) => {
      if (catalogs.size >= LOOP_CATALOG_LIMITS.projectsCachedMax && !catalogs.has(projectPath)) {
        catalogs.clear();
      }
      catalogs.set(projectPath, loaded);
      if (live) {
        setCatalog(loaded);
      }
    });
    return () => {
      live = false;
    };
  }, [projectPath]);
  return catalog;
}

export function useCatalogFields(
  projectPath: string | undefined,
  catalog: LoopCatalog | undefined,
  source: LoopSource | undefined,
): readonly CatalogField[] | undefined {
  const key = source === undefined ? '' : sourceKey(source);
  const [loaded, setLoaded] = useState<{ readonly key: string; readonly fields: readonly CatalogField[] } | undefined>(undefined);
  useEffect(() => {
    // Read back from the key, so the effect depends on what names the source
    // rather than on an object rebuilt every render.
    const parsed = parseSourceKey(key);
    if (!projectPath || !catalog || parsed?.kind !== 'collection') {
      return undefined;
    }
    let live = true;
    void loadFields(projectPath, catalog, parsed.source).then((fields) => {
      if (live) {
        setLoaded({ key, fields: fields ?? [] });
      }
    });
    return () => {
      live = false;
    };
  }, [projectPath, catalog, key]);
  return loaded?.key === key ? loaded.fields : undefined;
}

export function useReferenceChoices(context: ChoiceContext, field: CatalogField | undefined): readonly { readonly title: string; readonly value: string }[] {
  const types = field?.references ?? [];
  const typesKey = types.join(',');
  const [loaded, setLoaded] = useState<{ readonly key: string; readonly choices: readonly { readonly title: string; readonly value: string }[] } | undefined>(
    undefined,
  );
  const { projectPath, catalog } = context;
  const sourceName = sourceKey(context.query.source);
  const key = `${sourceName}|${typesKey}`;
  useEffect(() => {
    const parsed = parseSourceKey(sourceName);
    if (!projectPath || !catalog || typesKey === '' || parsed?.kind !== 'collection') {
      return undefined;
    }
    let live = true;
    void loadReferenceChoices(projectPath, catalog, parsed.source, typesKey.split(',')).then((choices) => {
      if (live) {
        setLoaded({ key, choices });
      }
    });
    return () => {
      live = false;
    };
  }, [projectPath, catalog, key, sourceName, typesKey]);
  return useMemo(() => (loaded?.key === key ? loaded.choices : []), [loaded, key]);
}

/** An item a selected list can pick: the id the list's code matches, and its title. */
export interface PickableItem {
  readonly id: string;
  readonly title: string;
  /** Its first picture, when it has one: a project file, or a CMS's address for it. */
  readonly picture?: ItemPicture;
}

export type ItemPicture = { readonly kind: 'file'; readonly file: string } | { readonly kind: 'url'; readonly url: string };

// A picture path is a project file a thumbnail can be read from: relative, inside, bounded.
const PICTURE_PATH_CHARS_MAX = 1024;

// A collection's items to pick from. Astro entries are read with their data,
// so a builder export's lists, whose items are named by the CMS's `_id` where
// they have one, get the id their code compares; a plain list gets the entry id.
const PICKABLE_ITEMS_MAX = 500;

export async function loadItems(
  projectPath: string,
  catalog: LoopCatalog,
  target: { readonly source: LoopSource; readonly ids: 'entry' | 'export' },
): Promise<readonly PickableItem[]> {
  const { source } = target;
  if (source.kind === 'sanity') {
    const connectionId = catalog.sanity.kind === 'connected' ? catalog.sanity.connectionId : undefined;
    const listed = connectionId === undefined ? undefined : await remoteDocuments(projectPath, connectionId, source.collection).catch(() => undefined);
    return listed?.ok
      ? listed.value.documents.slice(0, PICKABLE_ITEMS_MAX).map((document) => ({
          id: document.id,
          title: document.title,
          ...(document.imageURL === undefined ? {} : { picture: { kind: 'url' as const, url: document.imageURL } }),
        }))
      : [];
  }
  const payload = parseIpcPayload('content:entries', { projectPath, name: source.collection });
  const answer: unknown = await cmsTransport.contentEntries(payload).catch(() => undefined);
  const entries = toRecord(answer)?.['entries'];
  const items: PickableItem[] = [];
  for (const entry of Array.isArray(entries) ? entries.slice(0, PICKABLE_ITEMS_MAX) : []) {
    const item = pickableEntry(entry, target.ids);
    if (item !== undefined) {
      items.push(item);
    }
  }
  assert(items.length <= PICKABLE_ITEMS_MAX, 'Pickable items are bounded');
  return items;
}

/**
 * One document of a Sanity type, as field name to value, so the Source picker
 * can show what its documents hold and which of their fields are lists.
 * Undefined when there is no connection, no document, or it can't be read.
 */
export async function loadSanitySample(projectPath: string, catalog: LoopCatalog, type: string): Promise<Readonly<Record<string, unknown>> | undefined> {
  const connectionId = catalog.sanity.kind === 'connected' ? catalog.sanity.connectionId : undefined;
  if (connectionId === undefined) {
    return undefined;
  }
  const listed = await remoteDocuments(projectPath, connectionId, type).catch(() => undefined);
  const first = listed?.ok ? listed.value.documents[0] : undefined;
  const read = first === undefined ? undefined : await remoteDocument(projectPath, connectionId, first.id).catch(() => undefined);
  if (read === undefined || !read.ok) {
    return undefined;
  }
  // A document's fields come from the CMS: shown up to the catalog's bound.
  return Object.fromEntries(read.value.fields.slice(0, LOOP_CATALOG_LIMITS.fieldsMax).map((field) => [field.name, field.value]));
}

// One `content:entries` entry: its id (or its data's `_id`) and its title.
function pickableEntry(input: unknown, ids: 'entry' | 'export'): PickableItem | undefined {
  const entry = toRecord(input);
  const id = entry?.['id'];
  const title = entry?.['title'];
  const known = toRecord(entry?.['data'])?.['_id'];
  const chosen = ids === 'export' && typeof known === 'string' ? known : id;
  if (typeof chosen !== 'string' || !isItemId(chosen)) {
    return undefined;
  }
  const picture = pictureFile(entry?.['imageFile']);
  return { id: chosen, title: typeof title === 'string' && title !== '' ? title : chosen, ...(picture === undefined ? {} : { picture }) };
}

// The entry's picture as main found it (content:entries), when it is a usable project path.
function pictureFile(input: unknown): ItemPicture | undefined {
  if (typeof input !== 'string' || input === '' || input.length > PICTURE_PATH_CHARS_MAX) {
    return undefined;
  }
  if (input.startsWith('/') || input.split('/').includes('..')) {
    return undefined;
  }
  return { kind: 'file', file: input };
}

/**
 * One item of a collection, as its fields, so the Field pickers can show what
 * each field holds: a Sanity document read through the CMS connection, or an
 * Astro entry's `data`. Undefined until it is read, or when there is none.
 */
export function useCollectionSample(projectPath: string | undefined, catalog: LoopCatalog | undefined, source: LoopSource): unknown {
  const key = sourceKey(source);
  const [loaded, setLoaded] = useState<{ readonly key: string; readonly sample: unknown } | undefined>(undefined);
  useEffect(() => {
    const parsed = parseSourceKey(key);
    if (projectPath === undefined || catalog === undefined || parsed?.kind !== 'collection') {
      return undefined;
    }
    let live = true;
    void collectionSample(projectPath, catalog, parsed.source).then((sample) => {
      if (live) {
        setLoaded({ key, sample });
      }
    });
    return () => {
      live = false;
    };
  }, [projectPath, catalog, key]);
  return loaded?.key === key ? loaded.sample : undefined;
}

async function collectionSample(projectPath: string, catalog: LoopCatalog, source: LoopSource): Promise<unknown> {
  if (source.kind === 'sanity') {
    return loadSanitySample(projectPath, catalog, source.collection).catch(() => undefined);
  }
  const payload = parseIpcPayload('content:entries', { projectPath, name: source.collection });
  const answer: unknown = await cmsTransport.contentEntries(payload).catch(() => undefined);
  const entries = toRecord(answer)?.['entries'];
  const first: unknown = Array.isArray(entries) ? entries[0] : undefined;
  // An entry keeps its fields under `data`, the paths a field names.
  return toRecord(first)?.['data'];
}
