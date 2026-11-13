// What the CMS panel can do with one connected Payload server: the same answers
// as cmsRemoteService.ts gives for Sanity, from Payload's REST API. Desktop
// calls it from its IPC handlers with a key (or password) it decrypted itself.
//
// The rules that matter, each verified against a real Payload 3.93 server
// (docs/cms-testing.md):
//
//   * Every write sends `draft=true`. Without it a PATCH on a collection with
//     drafts PUBLISHES. A collection without drafts ignores the parameter, so
//     its edits are live: its documents say so (`appliesLive`).
//   * A list is read a page at a time (`limit=100`, `page`), never `limit=0`
//     (which returns every document), and stops at 500.
//   * Reads use `depth=0` for lists and `depth=1` for one document, so related
//     documents come back as ids (or, for files, with their address) and no
//     account details travel into the panel.
//   * A document's status is `published` when the latest version is published,
//     `changed` when it has a newer draft over a published version, `draft` when
//     it was never published (or was unpublished).

import { assert } from '../../shared/core/assert';
import { described } from '../../shared/properties/i18n/messageRef';
import type { PayloadSummary } from '../../shared/properties/cmsConnections';
import {
  CMS_REMOTE_LIMITS,
  REMOTE_TEMPLATE_ID,
  remoteCell,
  type RemoteAsset,
  type RemoteAssetKind,
  type RemoteCell,
  type RemoteCollection,
  type RemoteDocument,
  type RemoteDocumentAction,
  type RemoteDocumentField,
  type RemoteDocumentList,
  type RemoteDocumentSummary,
  type RemoteMove,
  type RemoteReferenceOption,
  type RemoteRevision,
  type RemoteStatus,
  type RemoteWrite,
} from '../../shared/properties/cmsRemote';
import type { CmsRemoteService } from './cmsRemoteService';
import { absoluteUrl, PAYLOAD_LIMITS, payloadRequest, PayloadError, type PayloadTarget } from './payloadClient';
import { documentsOf, loadPayloadSchema, type PayloadCollection, type PayloadSchema } from './payloadSchema';
import {
  assetKind,
  boundValue,
  decodeId,
  encodeId,
  lexicalEditable,
  remoteSchemaField,
  toPayloadValue,
  toRemoteValue,
  titleOf,
  type ValueContext,
} from './payloadValues';
import { remoteObject, type RemoteValue } from '../../shared/properties/cmsRemoteSchema';

export const PAYLOAD_PAGE_SIZE = 100;
export const PAYLOAD_PAGES_MAX = Math.ceil(CMS_REMOTE_LIMITS.documentsMax / PAYLOAD_PAGE_SIZE);
// The fields a document is titled by, first match wins; Payload has no way to ask for `useAsTitle`.
const TITLE_FIELDS = ['title', 'name', 'label', 'heading', 'headline', 'slug', 'filename', 'email', 'alt'] as const;

export interface PayloadServiceOptions {
  /** Collections the connection names, used when the server will not list them. */
  readonly named: readonly string[];
}

export type PayloadService = CmsRemoteService & { readonly uploadBytesMax: number };

export function payloadRemoteService(target: PayloadTarget, options: PayloadServiceOptions): PayloadService {
  assert(target.baseUrl.length > 0, 'A Payload service has an address');
  const schema = (reuse: 'allowed' | 'never' = 'allowed') => loadPayloadSchema(target, { named: options.named, reuse });
  const service = new Content(target, schema);
  return {
    uploadBytesMax: PAYLOAD_LIMITS.uploadBytesMax,
    collections: () => service.collections(),
    documents: (collection, columns = []) => service.documents(collection, columns),
    create: (collection) => service.create(collection),
    remove: (ids) => service.remove(ids),
    move: (move) => service.move(move),
    document: (id) => service.document(id),
    template: (collection) => service.template(collection),
    write: (write) => service.write(write),
    act: (id, action) => service.act(id, action),
    history: (id) => service.history(id),
    restore: (id, revision) => service.restore(id, revision),
    references: (types, query) => service.references(types, query ?? ''),
    upload: (kind, file) => service.upload(kind, file),
  };
}

// A Payload id, the collection it is in, and what the schema says about that collection.
interface Located {
  readonly collection: PayloadCollection;
  readonly id: string | number;
  readonly schema: PayloadSchema;
}

class Content {
  constructor(
    private readonly target: PayloadTarget,
    private readonly schemaOf: (reuse?: 'allowed' | 'never') => Promise<PayloadSchema>,
  ) {}

  async collections(): Promise<RemoteCollection[]> {
    const schema = await this.schemaOf();
    const out: RemoteCollection[] = [];
    for (const collection of schema.collections.values()) {
      if (/^[A-Za-z_][\w.-]{0,127}$/.test(collection.slug)) {
        out.push({ name: collection.slug, count: collection.count, icon: undefined });
      }
    }
    return out.slice(0, CMS_REMOTE_LIMITS.collectionsMax);
  }

  async documents(slug: string, columns: readonly string[]): Promise<RemoteDocumentList> {
    const { collection } = await this.collectionOf(slug);
    const docs: Record<string, unknown>[] = [];
    // At most five pages of a hundred: the panel lists 500, and the loop ends there.
    for (let page = 1; page <= PAYLOAD_PAGES_MAX; page += 1) {
      const reply = await payloadRequest(this.target, {
        method: 'GET',
        path: `/api/${slug}`,
        query: { limit: PAYLOAD_PAGE_SIZE, page, depth: 0, sort: '-updatedAt', ...(collection.drafts ? { draft: true } : {}) },
      });
      docs.push(...documentsOf(reply));
      const more: unknown = typeof reply === 'object' && reply !== null ? Reflect.get(reply, 'hasNextPage') : undefined;
      if (more !== true || docs.length >= CMS_REMOTE_LIMITS.documentsMax) {
        break;
      }
    }
    const shown = docs.slice(0, CMS_REMOTE_LIMITS.documentsMax);
    const published = collection.drafts ? await this.publishedIds(slug, shown) : new Set<string>();
    const summaries = shown.map((document) => this.summaryOf(collection, document, columns, published));
    assert(summaries.length <= CMS_REMOTE_LIMITS.documentsMax, 'A list stays within its bound');
    return { documents: summaries, orderable: false };
  }

  // The ids, among a page, whose live (published) copy is published: a draft over one is `changed`.
  private async publishedIds(slug: string, docs: readonly Record<string, unknown>[]): Promise<ReadonlySet<string>> {
    const out = new Set<string>();
    const latestDrafts = docs.filter((document) => document['_status'] === 'draft');
    for (let start = 0; start < latestDrafts.length; start += PAYLOAD_PAGE_SIZE) {
      const ids = latestDrafts.slice(start, start + PAYLOAD_PAGE_SIZE).map((document) => String(document['id']));
      const reply = await payloadRequest(this.target, {
        method: 'GET',
        path: `/api/${slug}`,
        query: { 'where[id][in]': ids.join(','), limit: PAYLOAD_PAGE_SIZE, depth: 0, 'select[_status]': true },
      });
      for (const live of documentsOf(reply)) {
        if (live['_status'] === 'published') {
          out.add(String(live['id']));
        }
      }
    }
    return out;
  }

  private summaryOf(
    collection: PayloadCollection,
    document: Record<string, unknown>,
    columns: readonly string[],
    published: ReadonlySet<string>,
  ): RemoteDocumentSummary {
    const id = idString(document['id']);
    const titleField = TITLE_FIELDS.find((name) => nonEmpty(document[name]));
    const title = titleField === undefined ? `${titleOf(collection.slug)} ${id}` : String(document[titleField]);
    const slug = document['slug'];
    const cells: Record<string, RemoteCell> = {};
    for (const column of columns) {
      const cell = remoteCell(document[column]);
      if (cell !== undefined) {
        cells[column] = cell;
      }
    }
    const picture = collection.upload ? (document['thumbnailURL'] ?? document['url']) : undefined;
    return {
      id: encodeId(collection.slug, id),
      title,
      subtitle: titleField !== 'slug' && typeof slug === 'string' && slug.length > 0 ? slug : undefined,
      imageURL: typeof picture === 'string' && picture.length > 0 ? absoluteUrl(this.target.baseUrl, picture) : undefined,
      ...(columns.length === 0 ? {} : { cells }),
      status: statusOf(collection, document['_status'], { published: published.has(id) }),
      updatedAt: typeof document['updatedAt'] === 'string' ? document['updatedAt'] : '',
    };
  }

  async create(slug: string): Promise<RemoteDocumentSummary> {
    const { collection } = await this.collectionOf(slug);
    // A draft needs no required field; a collection without drafts validates, and says what is missing.
    const reply = await payloadRequest(this.target, {
      method: 'POST',
      path: `/api/${slug}`,
      query: { depth: 0, draft: true },
      body: collection.drafts ? { _status: 'draft' } : {},
    });
    const created = recordOf(typeof reply === 'object' && reply !== null ? Reflect.get(reply, 'doc') : undefined);
    if (created === undefined) {
      throw new PayloadError('malformed', 201, described('settings.cms.payload.error.malformed', { address: this.target.baseUrl }));
    }
    return this.summaryOf(collection, created, [], new Set());
  }

  async remove(ids: readonly string[]): Promise<number> {
    let removed = 0;
    for (const composite of ids) {
      const located = await this.locate(composite);
      try {
        await payloadRequest(this.target, { method: 'DELETE', path: `/api/${located.collection.slug}/${located.id}`, query: { depth: 0 } });
        removed += 1;
      } catch (error: unknown) {
        // Already gone is what was asked for.
        if (!(error instanceof PayloadError) || error.failure !== 'notFound') {
          throw error;
        }
      }
    }
    return removed;
  }

  move(_move: RemoteMove): Promise<RemoteDocumentList> {
    return Promise.reject(new PayloadError('invalid', undefined, described('cmsBackend.payload.notOrdered')));
  }

  async document(composite: string): Promise<RemoteDocument> {
    const located = await this.locate(composite);
    const { collection, schema } = located;
    const localized = schema.locales.length > 0;
    const latest = await this.read(located, { draft: collection.drafts, depth: 1, locale: localized ? 'all' : undefined });
    const live = collection.drafts ? await this.read(located, { draft: false, depth: 0, locale: undefined }).catch(ignoreMissing) : undefined;
    const status = statusOf(collection, latest['_status'], { published: live?.['_status'] === 'published' });
    const context = this.context(schema);
    return this.build(located, latest, live, status, context);
  }

  private build(
    located: Located,
    latest: Record<string, unknown>,
    live: Record<string, unknown> | undefined,
    status: RemoteStatus,
    context: ValueContext,
  ): RemoteDocument {
    const { collection } = located;
    const fields: RemoteDocumentField[] = [...this.fileFields(collection, latest)];
    for (const field of collection.fields) {
      const raw = latest[field.name];
      const schemaField = remoteSchemaField(field, context.locales);
      const converted = boundValue(toRemoteValue(field, raw, context));
      // Rich text with formatting Stacki cannot rebuild, and a value cut to fit, are shown and not written.
      const locked = (field.kind === 'richText' && !lexicalEditable(raw)) || converted.cut;
      fields.push({ ...schemaField, ...(locked ? { readOnly: 'always' as const } : {}), value: converted.value });
    }
    const updated = typeof latest['updatedAt'] === 'string' ? latest['updatedAt'] : undefined;
    const liveUpdated = typeof live?.['updatedAt'] === 'string' ? live['updatedAt'] : undefined;
    return {
      id: encodeId(collection.slug, idString(latest['id'])),
      type: collection.slug,
      status,
      fields,
      assets: [...context.assets.values()].slice(0, CMS_REMOTE_LIMITS.assetsMax),
      editedAt: status === 'published' || !collection.drafts ? undefined : updated,
      publishedAt: status === 'draft' || !collection.drafts ? (collection.drafts ? undefined : updated) : (liveUpdated ?? updated),
      editURL: `${this.target.baseUrl}/admin/collections/${collection.slug}/${idString(latest['id'])}`,
      ...(collection.drafts ? {} : { appliesLive: true }),
    };
  }

  // An upload collection's file, named and addressed, above the fields it holds itself.
  private fileFields(collection: PayloadCollection, latest: Record<string, unknown>): readonly RemoteDocumentField[] {
    if (!collection.upload) {
      return [];
    }
    return (['filename', 'mimeType', 'url'] as const).flatMap((name): RemoteDocumentField[] => {
      const value = latest[name];
      if (typeof value !== 'string') {
        return [];
      }
      const shown = name === 'url' ? absoluteUrl(this.target.baseUrl, value) : value;
      return [
        { name, title: titleOf(name), description: '', required: false, rules: [], type: { kind: 'string', options: [] }, readOnly: 'always', value: shown },
      ];
    });
  }

  async template(slug: string): Promise<RemoteDocument> {
    const { collection, schema } = await this.collectionOf(slug);
    const fields = collection.fields.map((field): RemoteDocumentField => ({ ...remoteSchemaField(field, schema.locales), value: undefined }));
    return {
      id: REMOTE_TEMPLATE_ID,
      type: slug,
      status: 'draft',
      fields,
      assets: [],
      editedAt: undefined,
      publishedAt: undefined,
      editURL: undefined,
      ...(collection.drafts ? {} : { appliesLive: true }),
    };
  }

  async write(write: RemoteWrite): Promise<RemoteDocument> {
    const located = await this.locate(write.id);
    const { collection, schema } = located;
    const field = collection.fields.find((candidate) => candidate.name === write.field);
    if (field === undefined) {
      throw new PayloadError('invalid', undefined, described('cmsBackend.schema.noField', { name: write.field }));
    }
    const latest = await this.read(located, { draft: collection.drafts, depth: 0, locale: schema.locales.length > 0 ? 'all' : undefined });
    const context = this.context(schema);
    const rowIds = rowIdsOf(latest[field.name]);
    if (field.localized && schema.locales.length > 0) {
      await this.writeLocales(located, field, write, latest, context, rowIds);
    } else {
      const previous = latest[field.name];
      const body = { [field.name]: toPayloadValue(field, write.value, { rowIds, previous }) };
      await this.patch(located, body, undefined);
    }
    return this.document(write.id);
  }

  // A localized field is written one locale at a time, and only the locales that changed.
  private async writeLocales(
    located: Located,
    field: PayloadCollection['fields'][number],
    write: RemoteWrite,
    latest: Record<string, unknown>,
    context: ValueContext,
    rowIds: ReadonlySet<string>,
  ): Promise<void> {
    const wanted = remoteObject(write.value) ?? {};
    const stored = recordOf(latest[field.name]) ?? {};
    for (const locale of context.locales) {
      const value = wanted[locale];
      const current = toRemoteValue({ ...field, localized: false }, stored[locale], context, 1);
      if (JSON.stringify(value) === JSON.stringify(current)) {
        continue;
      }
      const previous = stored[locale];
      const body = { [field.name]: toPayloadValue(field, value, { rowIds, previous }) };
      await this.patch(located, body, locale);
    }
  }

  // The only place a document is written. `draft=true` is never left out: without it a PATCH publishes.
  private async patch(located: Located, body: Record<string, unknown>, locale: string | undefined): Promise<void> {
    const query = writeQuery(locale);
    assert(query['draft'] === true, 'A write is a draft');
    await payloadRequest(this.target, { method: 'PATCH', path: `/api/${located.collection.slug}/${located.id}`, query, body });
  }

  async act(composite: string, action: RemoteDocumentAction): Promise<RemoteDocument | undefined> {
    const located = await this.locate(composite);
    const { collection } = located;
    if (!collection.drafts) {
      throw new PayloadError('invalid', undefined, described('cmsBackend.payload.noDrafts', { collection: collection.slug }));
    }
    const path = `/api/${collection.slug}/${located.id}`;
    switch (action) {
      case 'publish':
        // No `draft=true` here: the point is to publish the latest draft.
        await payloadRequest(this.target, { method: 'PATCH', path, query: { depth: 0 }, body: { _status: 'published' } });
        return this.document(composite);
      case 'unpublish':
        await payloadRequest(this.target, { method: 'PATCH', path, query: { depth: 0 }, body: { _status: 'draft' } });
        return this.document(composite);
      case 'discard':
        return this.discard(located, composite);
      default: {
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  }

  // Throwing the draft away is putting the newest published version back, which leaves the live
  // content as it was and ends the draft; a document never published has only its draft, so it goes.
  private async discard(located: Located, composite: string): Promise<RemoteDocument | undefined> {
    const { collection } = located;
    const versions = await payloadRequest(this.target, {
      method: 'GET',
      path: `/api/${collection.slug}/versions`,
      query: { 'where[parent][equals]': located.id, 'where[version._status][equals]': 'published', sort: '-updatedAt', limit: 1, depth: 0 },
    });
    const newest = documentsOf(versions)[0];
    if (newest === undefined) {
      await payloadRequest(this.target, { method: 'DELETE', path: `/api/${collection.slug}/${located.id}`, query: { depth: 0 } });
      return undefined;
    }
    await payloadRequest(this.target, { method: 'POST', path: `/api/${collection.slug}/versions/${idString(newest['id'])}`, query: { depth: 0 } });
    return this.document(composite);
  }

  async history(composite: string): Promise<RemoteRevision[]> {
    const located = await this.locate(composite);
    if (!located.collection.drafts) {
      return [];
    }
    const reply = await payloadRequest(this.target, {
      method: 'GET',
      path: `/api/${located.collection.slug}/versions`,
      query: { 'where[parent][equals]': located.id, sort: '-updatedAt', limit: CMS_REMOTE_LIMITS.revisionsMax, depth: 0 },
    });
    return documentsOf(reply)
      .slice(0, CMS_REMOTE_LIMITS.revisionsMax)
      .map((version) => {
        const inner = recordOf(version['version']);
        return {
          id: idString(version['id']),
          timestamp: typeof version['updatedAt'] === 'string' ? version['updatedAt'] : '',
          author: typeof inner?.['_status'] === 'string' ? inner['_status'] : '',
        };
      });
  }

  async restore(composite: string, revision: string): Promise<RemoteDocument> {
    const located = await this.locate(composite);
    // Restoring as a draft: the live content stays as it is until someone publishes.
    await payloadRequest(this.target, {
      method: 'POST',
      path: `/api/${located.collection.slug}/versions/${revision}`,
      query: { draft: true, depth: 0 },
    });
    return this.document(composite);
  }

  async references(types: readonly string[], query: string): Promise<RemoteReferenceOption[]> {
    const schema = await this.schemaOf();
    const perType = Math.max(10, Math.floor(CMS_REMOTE_LIMITS.documentsMax / Math.max(types.length, 1)));
    const out: RemoteReferenceOption[] = [];
    for (const slug of types) {
      const collection = schema.collections.get(slug);
      if (collection === undefined) {
        continue;
      }
      const titleField = titleFieldOf(collection);
      const search = query.length > 0 && titleField !== undefined ? { [`where[${titleField}][like]`]: query } : {};
      const reply = await payloadRequest(this.target, {
        method: 'GET',
        path: `/api/${slug}`,
        query: { limit: Math.min(perType, PAYLOAD_PAGE_SIZE), depth: 0, sort: '-updatedAt', ...search },
      });
      for (const document of documentsOf(reply)) {
        const summary = this.summaryOf(collection, document, [], new Set());
        out.push({ id: summary.id, type: slug, title: summary.title, imageURL: summary.imageURL });
      }
    }
    return out.slice(0, CMS_REMOTE_LIMITS.documentsMax);
  }

  async upload(kind: RemoteAssetKind, file: { readonly name: string; readonly bytes: Uint8Array }): Promise<RemoteAsset> {
    if (file.bytes.byteLength > PAYLOAD_LIMITS.uploadBytesMax) {
      throw new PayloadError('tooLarge', undefined, described('settings.cms.payload.error.tooLarge', { limit: '50 MB' }));
    }
    const schema = await this.schemaOf();
    const uploads = [...schema.collections.values()].filter((collection) => collection.upload);
    const home = uploads.find((collection) => assetKind(collection.slug) === kind) ?? uploads[0];
    if (home === undefined) {
      throw new PayloadError('invalid', undefined, described('cmsBackend.payload.noUpload'));
    }
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file.bytes)]), file.name);
    // Most upload collections require an `alt`; the file's name is a fair first one, and any other required field is reported.
    form.append('_payload', JSON.stringify({ alt: file.name.replace(/\.[^.]+$/, '') }));
    const reply = await payloadRequest(this.target, {
      method: 'POST',
      path: `/api/${home.slug}`,
      query: { depth: 0 },
      form,
      timeoutMs: PAYLOAD_LIMITS.uploadTimeoutMs,
    });
    const created = recordOf(typeof reply === 'object' && reply !== null ? Reflect.get(reply, 'doc') : undefined);
    const id = created === undefined ? undefined : created['id'];
    const url = created === undefined ? undefined : created['url'];
    if (created === undefined || (typeof id !== 'string' && typeof id !== 'number') || typeof url !== 'string') {
      throw new PayloadError('malformed', 201, described('settings.cms.payload.error.malformed', { address: this.target.baseUrl }));
    }
    const prefix = assetKind(home.slug);
    return {
      id: `${prefix}-${home.slug}-${id}`,
      url: absoluteUrl(this.target.baseUrl, url),
      filename: typeof created['filename'] === 'string' ? created['filename'] : file.name,
    };
  }

  // The helpers below build values and requests for the methods above.

  private context(schema: PayloadSchema): ValueContext {
    return { baseUrl: this.target.baseUrl, locales: schema.locales, assets: new Map() };
  }

  private async collectionOf(
    slug: string,
  ): Promise<Located extends never ? never : { readonly collection: PayloadCollection; readonly schema: PayloadSchema }> {
    const schema = await this.schemaOf();
    const collection = schema.collections.get(slug);
    if (collection === undefined) {
      throw new PayloadError('notFound', 404, described('settings.cms.payload.error.notFound'));
    }
    return { collection, schema };
  }

  private async locate(composite: string): Promise<Located> {
    const decoded = decodeId(composite);
    if (decoded === undefined) {
      throw new PayloadError('notFound', 404, described('settings.cms.payload.error.notFound'));
    }
    const { collection, schema } = await this.collectionOf(decoded.slug);
    return { collection, schema, id: decoded.id };
  }

  private async read(
    located: Located,
    options: { readonly draft: boolean; readonly depth: number; readonly locale: string | undefined },
  ): Promise<Record<string, unknown>> {
    const reply = await payloadRequest(this.target, {
      method: 'GET',
      path: `/api/${located.collection.slug}/${located.id}`,
      query: { depth: options.depth, ...(options.draft ? { draft: true } : {}), ...(options.locale === undefined ? {} : { locale: options.locale }) },
    });
    const found = recordOf(reply);
    if (found === undefined) {
      throw new PayloadError('malformed', 200, described('settings.cms.payload.error.malformed', { address: this.target.baseUrl }));
    }
    return found;
  }
}

/** The query of a write: always a draft, in one locale when the field is localized. */
export function writeQuery(locale: string | undefined): Record<string, string | number | boolean> {
  return { draft: true, depth: 0, ...(locale === undefined ? {} : { locale }) };
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

function ignoreMissing(error: unknown): undefined {
  if (error instanceof PayloadError && error.failure === 'notFound') {
    return undefined;
  }
  throw error;
}

function statusOf(collection: PayloadCollection, latest: unknown, live: { readonly published: boolean }): RemoteStatus {
  if (!collection.drafts) {
    return 'published';
  }
  if (latest === 'published') {
    return 'published';
  }
  return live.published ? 'changed' : 'draft';
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Object.fromEntries(Object.keys(value).map((key): [string, unknown] => [key, Reflect.get(value, key)]));
}

function idString(value: unknown): string {
  assert(typeof value === 'string' || typeof value === 'number', 'A Payload document has an id');
  return String(value);
}

function rowIdsOf(value: unknown): ReadonlySet<string> {
  const out = new Set<string>();
  const rows: unknown[] = Array.isArray(value) ? value : [];
  for (const row of rows.slice(0, 2_000)) {
    const id: unknown = typeof row === 'object' && row !== null ? Reflect.get(row, 'id') : undefined;
    if (typeof id === 'string') {
      out.add(id);
    }
  }
  return out;
}

function titleFieldOf(collection: PayloadCollection): string | undefined {
  return TITLE_FIELDS.find((name) => collection.fields.some((field) => field.name === name && field.kind === 'scalar'));
}

// The check behind "Test connection" and "Detect".

/**
 * Whether the account works, and what it can reach. The `/me` reply is 200 with
 * `{ user: null }` for a key Payload does not accept, so a non-null `user` is required.
 */
export async function checkPayloadAccount(target: PayloadTarget, named: readonly string[]): Promise<PayloadSummary> {
  const reply = await payloadRequest(target, { method: 'GET', path: `/api/${target.collection}/me` });
  const user: unknown = typeof reply === 'object' && reply !== null ? Reflect.get(reply, 'user') : undefined;
  if (typeof user !== 'object' || user === null) {
    throw new PayloadError('noUser', 200, described('settings.cms.payload.error.noUser', { collection: target.collection }));
  }
  const email: unknown = Reflect.get(user, 'email');
  let schema: PayloadSchema | undefined;
  try {
    schema = await loadPayloadSchema(target, { named, reuse: 'never' });
  } catch (error: unknown) {
    // The account works even when the collection list does not: say what was found, the person can name the rest.
    if (error instanceof PayloadError && error.failure === 'network') {
      throw error;
    }
    schema = undefined;
  }
  return {
    user: typeof email === 'string' ? email.slice(0, 200) : target.collection,
    mode: target.auth.kind,
    checkedAt: new Date().toISOString(),
    graphql: schema?.graphql ?? false,
    locales: schema?.locales ?? [],
    collections: [...(schema?.collections.values() ?? [])].map((collection) => ({
      slug: collection.slug,
      drafts: collection.drafts,
      upload: collection.upload,
    })),
  };
}

export type { RemoteValue };
