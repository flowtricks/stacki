// A connected Sanity dataset, as the CMS panel reads and writes it.
//
//   Collections  the document types in the dataset, with a count each. Sanity
//                does not serve a project's schema over its API (a schema lives
//                in the Studio's code), so types are read from the documents.
//   Documents    the newest of one type. Read raw, so a draft and its published
//                document are told apart: a draft alone is "draft", both is
//                "changed", the published alone is "published".
//   Fields       one document's fields, the draft's where there is one, typed
//                by the site's schema code (sanitySchema.ts, sanityFields.ts),
//                with the addresses of the images and files they point at.
//   Writes       Sanity's own "edit" action, which creates the draft from the
//                published document when there is none and sets or removes one
//                field. Nothing is published (docs/contracts.md, "CMS
//                connections"). Uploads store an asset; a write then points at it.

import { assert } from '../../shared/core/assert';
import { isRank } from './sanityRank';
import { assetRefs, documentFields } from './sanityFields';
import type { SanityDocumentSchema, SanityPreview } from './sanitySchema';
import { previewOf, previewProjection } from './sanityPreview';
import {
  CMS_REMOTE_LIMITS,
  type RemoteCollection,
  type RemoteDocument,
  type RemoteDocumentList,
  type RemoteDocumentSummary,
  type RemoteAsset,
  type RemoteReferenceOption,
  type RemoteStatus,
  type RemoteWrite,
} from '../../shared/properties/cmsRemote';

export const SANITY_API_VERSION = 'v2025-02-19';
export const SANITY_TIMEOUT_MS = 15_000;

export interface SanityDataset {
  readonly projectId: string;
  readonly dataset: string;
  readonly token: string;
}

// A type a person made: a valid name, not one of Sanity's own (also excluded by
// the query; checked here too, so a change there cannot list them).
function userType(name: string): boolean {
  if (!/^[A-Za-z_][\w.-]{0,127}$/.test(name)) {
    return false;
  }
  return !name.startsWith('sanity.') && !name.startsWith('system.');
}

// Documents Sanity keeps for itself: system types, and ids in the `_.` namespace.
const USER_DOCUMENTS =
  '!(_id in path("_.**")) && !(_type match "sanity.*") && !(_type match "system.*")';

export async function sanityCollections(target: SanityDataset): Promise<RemoteCollection[]> {
  const types = await sanityQuery(target, `array::unique(*[${USER_DOCUMENTS}]._type)`, {}, 'raw');
  if (!Array.isArray(types)) {
    throw new Error('Sanity returned an unexpected type list.');
  }
  const names = types
    .filter((name): name is string => typeof name === 'string' && userType(name))
    .slice(0, CMS_REMOTE_LIMITS.collectionsMax)
    .sort((left, right) => left.localeCompare(right));
  if (names.length === 0) {
    return [];
  }
  // One request for every count: {"c0": count(*[_type == $t0 …]), …}.
  const params = Object.fromEntries(names.map((name, index) => [`t${index}`, name]));
  const counts = names
    .map((_name, index) => `"c${index}": count(*[_type == $t${index} && ${USER_DOCUMENTS}])`)
    .join(', ');
  const result = await sanityQuery(target, `{${counts}}`, params, 'published');
  return names.map((name, index) => ({
    name,
    count: countOf(result, `c${index}`),
    icon: undefined,
  }));
}

export async function sanityDocuments(
  target: SanityDataset,
  type: string,
  preview?: SanityPreview,
): Promise<RemoteDocumentList> {
  const rows = await sanityQuery(
    target,
    `*[_type == $type && ${USER_DOCUMENTS}] | order(_updatedAt desc) [0...$limit]` +
      `{_id, _updatedAt, orderRank, ${previewProjection(preview)}}`,
    { type, limit: CMS_REMOTE_LIMITS.documentsMax * 2 },
    'raw',
  );
  if (!Array.isArray(rows)) {
    throw new Error('Sanity returned an unexpected document list.');
  }
  const summaries = summarise(rows);
  // Ordered where every document carries a rank (the orderable plugin's list);
  // otherwise newest first, as the query returned them.
  const orderable = summaries.length > 0 && summaries.every((entry) => entry.rank !== undefined);
  const ordered = orderable
    ? [...summaries].sort((left, right) => ((left.rank ?? '') < (right.rank ?? '') ? -1 : 1))
    : summaries;
  return { orderable, documents: ordered.map(({ rank: _rank, ...summary }) => summary) };
}

export async function sanityDocument(
  target: SanityDataset,
  id: string,
  schemaOf: (type: string) => SanityDocumentSchema | undefined,
): Promise<RemoteDocument> {
  const result = await sanityQuery(target, '*[_id in [$id, "drafts." + $id]]', { id }, 'raw');
  if (!Array.isArray(result)) {
    throw new Error('Sanity returned an unexpected document.');
  }
  const both: readonly unknown[] = result;
  const draft = both.find((entry) => idOf(entry) === `drafts.${id}`);
  const published = both.find((entry) => idOf(entry) === id);
  const shown: unknown = draft ?? published;
  if (typeof shown !== 'object' || shown === null) {
    throw new Error('This document no longer exists.');
  }
  const type: unknown = Reflect.get(shown, '_type');
  if (typeof type !== 'string') {
    throw new Error('This document has no type.');
  }
  const fields = documentFields(shown, schemaOf(type));
  const refs = fields.flatMap((field) => assetRefs(field.value));
  return {
    id,
    type,
    status: statusOf({ draft: draft !== undefined, published: published !== undefined }),
    fields,
    assets: refs.length === 0 ? [] : await sanityAssets(target, refs),
    editedAt: draft === undefined ? undefined : stringAt(draft, '_updatedAt'),
    publishedAt: published === undefined ? undefined : stringAt(published, '_updatedAt'),
    editURL: undefined,
  };
}

// The stored files behind asset references: their addresses and file names.
async function sanityAssets(target: SanityDataset, ids: readonly string[]): Promise<RemoteAsset[]> {
  const bounded = ids.slice(0, CMS_REMOTE_LIMITS.assetsMax);
  const rows = await sanityQuery(
    target,
    '*[_id in $ids]{_id, url, originalFilename}',
    { ids: bounded },
    'raw',
  );
  const out: RemoteAsset[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = idOf(row);
    const url = stringAt(row, 'url');
    if (id !== undefined && url !== undefined && url.startsWith('https://')) {
      out.push({ id, url, filename: stringAt(row, 'originalFilename') ?? id });
    }
  }
  assert(out.length <= bounded.length, 'Each asset is found at most once');
  return out;
}

/** Sets one field on the document's draft, or removes it; the draft is made when needed. */
export async function sanityWriteDraft(target: SanityDataset, write: RemoteWrite): Promise<void> {
  assert(!write.id.startsWith('drafts.'), 'A write names the published id');
  assert(!write.field.startsWith('_'), 'A write never touches system keys');
  const patch =
    write.value === undefined ? { unset: [write.field] } : { set: { [write.field]: write.value } };
  const action = {
    actionType: 'sanity.action.document.edit',
    publishedId: write.id,
    draftId: `drafts.${write.id}`,
    patch,
  };
  await sanityRequest(target, `actions/${target.dataset}`, { actions: [action] });
}

/** Published documents of these types, to pick one for a reference. */
export async function sanityReferenceOptions(
  target: SanityDataset,
  types: readonly string[],
): Promise<RemoteReferenceOption[]> {
  if (types.length === 0) {
    return [];
  }
  const rows = await sanityQuery(
    target,
    `*[_type in $types && ${USER_DOCUMENTS}] | order(_updatedAt desc) [0...$limit]` +
      `{_id, _type, "title": coalesce(title, name, heading, label, slug.current, _id)}`,
    { types, limit: CMS_REMOTE_LIMITS.documentsMax },
    'published',
  );
  const options = (Array.isArray(rows) ? rows : []).flatMap((row): RemoteReferenceOption[] => {
    const id = idOf(row);
    const type = stringAt(row, '_type');
    if (id === undefined || type === undefined || !/^[\w][\w.-]{0,127}$/.test(id)) {
      return [];
    }
    return [{ id, type, title: (stringAt(row, 'title') ?? id).slice(0, 200) }];
  });
  return options.sort((left, right) => left.title.localeCompare(right.title));
}

// Raw rows hold drafts and published documents side by side; one summary each.
type RankedSummary = RemoteDocumentSummary & { readonly rank: string | undefined };

function summarise(rows: readonly unknown[]): RankedSummary[] {
  const byId = new Map<string, { draft?: unknown; published?: unknown }>();
  for (const row of rows) {
    const raw = idOf(row);
    if (raw === undefined || raw.startsWith('versions.')) {
      continue;
    }
    const id = raw.startsWith('drafts.') ? raw.slice('drafts.'.length) : raw;
    const entry = byId.get(id) ?? {};
    byId.set(
      id,
      raw.startsWith('drafts.') ? { ...entry, draft: row } : { ...entry, published: row },
    );
  }
  const out: RankedSummary[] = [];
  for (const [id, entry] of byId) {
    const shown: unknown = entry.draft ?? entry.published;
    if (out.length >= CMS_REMOTE_LIMITS.documentsMax || !/^[\w][\w.-]{0,127}$/.test(id)) {
      continue;
    }
    const shownPreview = previewOf(shown);
    out.push({
      id,
      title: shownPreview.title ?? id,
      subtitle: shownPreview.subtitle,
      imageURL: shownPreview.imageURL,
      status: statusOf({
        draft: entry.draft !== undefined,
        published: entry.published !== undefined,
      }),
      updatedAt: stringAt(shown, '_updatedAt') ?? '',
      rank: rankOf(entry.published) ?? rankOf(entry.draft),
    });
  }
  return out;
}

function rankOf(document: unknown): string | undefined {
  const rank = stringAt(document, 'orderRank');
  return isRank(rank) ? rank : undefined;
}

function statusOf(has: { readonly draft: boolean; readonly published: boolean }): RemoteStatus {
  if (!has.draft) {
    return 'published';
  }
  return has.published ? 'changed' : 'draft';
}

function isPlainObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function idOf(value: unknown): string | undefined {
  return stringAt(value, '_id');
}

function stringAt(value: unknown, key: string): string | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const found: unknown = Reflect.get(value, key);
  return typeof found === 'string' ? found : undefined;
}

function countOf(result: unknown, key: string): number {
  const found: unknown = isPlainObject(result) ? Reflect.get(result, key) : undefined;
  return typeof found === 'number' && Number.isSafeInteger(found) && found >= 0 ? found : 0;
}

export async function sanityQuery(
  target: SanityDataset,
  query: string,
  params: Readonly<Record<string, string | number | readonly string[]>>,
  perspective: 'raw' | 'published',
): Promise<unknown> {
  // A POST query takes its perspective in the address, its query and params in the body.
  const body = await sanityRequest(target, `query/${target.dataset}?perspective=${perspective}`, {
    query,
    params,
  });
  return isPlainObject(body) ? Reflect.get(body, 'result') : undefined;
}

export async function sanityRequest(
  target: SanityDataset,
  path: string,
  body: object,
): Promise<unknown> {
  assert(/^[a-z0-9]{1,64}$/.test(target.projectId), 'A Sanity project id is lower-case');
  const url = `https://${target.projectId}.api.sanity.io/${SANITY_API_VERSION}/data/${path}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${target.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(SANITY_TIMEOUT_MS),
  });
  const text = await response.text();
  const parsed: unknown = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const message: unknown = isPlainObject(parsed) ? Reflect.get(parsed, 'message') : undefined;
    throw new Error(
      typeof message === 'string' && message
        ? message.slice(0, 300)
        : `Sanity answered ${response.status}.`,
    );
  }
  return parsed;
}

/** A GET against the dataset's API (history), its answer as text; NDJSON is the caller's. */
export async function sanityGet(target: SanityDataset, url: string): Promise<string> {
  assert(url.startsWith('https://'), 'A Sanity read is over https');
  assert(/^[a-z0-9]{1,64}$/.test(target.projectId), 'A Sanity project id is lower-case');
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${target.token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(SANITY_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Sanity answered ${response.status}.`);
  }
  return text;
}
