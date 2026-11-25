// Fetches a sample of an external data source for the template form. It runs in
// the main process so a secret read from .env never reaches the renderer, and
// every request has a deadline, a size limit and no redirect: a redirect could
// carry a custom key header to a host the designer never typed.

import { DescribedError } from '../../shared/properties/describedError';
import { described, type Described } from '../../shared/properties/i18n/messageRef';
import { assert } from '../../shared/core/assert';
import { toArray, toRecord } from '../../shared/core/record';
import {
  ADDRESS_LIMITS,
  PAGE_TEMPLATE_LIMITS,
  SANITY_API_VERSION,
  addressFitOf,
  type DataSample,
  type DataSampleRequest,
  type DatasetAccess,
  type SampleField,
  type SampleFieldKind,
  type SampleList,
  type SourceHeader,
} from '../../shared/properties/pageTemplate';

export const DATA_SAMPLE_FETCH = {
  timeoutMs: 15_000,
  bytesMax: 8 * 1024 * 1024,
  /** Items read for a list's fields: enough to find one that leaves a field out. */
  itemsReadMax: 20,
  listDepthMax: 4,
  fieldDepthMax: 3,
  nodesVisitedMax: 20_000,
} as const satisfies Record<string, number>;

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface SanityTarget {
  readonly projectId: string;
  readonly dataset: string;
  /** The connection's key. It stays in this process. */
  readonly token: string;
}

export interface DataSampleHost {
  readonly fetch: Fetch;
  /** The project's env variables (projectEnv.ts). */
  readonly env: ReadonlyMap<string, string>;
  /** A connection's project, dataset and key; it throws when the connection cannot be used. */
  readonly sanityConnection: (connectionId: string) => SanityTarget;
  /** The data of each entry of a project's collection. */
  readonly readCollection: (collection: string) => Promise<readonly unknown[]>;
}

const TYPES_QUERY = 'array::unique(*[]._type)';
const SYSTEM_TYPE = /^(?:sanity|system)\./;
// Documents read to learn a type's fields and judge them as addresses. A build
// sees them all, which is why a slugified template still checks for itself.
const SANITY_DOCUMENTS_READ = 200;

export async function sampleData(request: DataSampleRequest, host: DataSampleHost): Promise<DataSample> {
  switch (request.kind) {
    case 'content-collection': {
      const items = await host.readCollection(request.collection);
      return { kind: 'lists', lists: [{ path: '', count: items.length, fields: fieldsOf(items) }] };
    }
    case 'http-json': {
      const reply = await sampleDataJSON(request.url, headersOf(request.headers, host.env), host.fetch);
      const lists = listsIn(reply);
      if (lists.length === 0) {
        throw new Error('That address didn’t return a list. Check it’s the right link, and that opening it in a browser shows your items.');
      }
      return { kind: 'lists', lists };
    }
    case 'sanity-types': {
      const target = host.sanityConnection(request.connectionId);
      const url = sanityQueryURL(target, 'token', { query: TYPES_QUERY, parameters: {} });
      const reply = await sampleDataJSON(url, sanityHeaders(target), host.fetch);
      return { kind: 'types', types: sanityTypes(toRecord(reply)?.['result']), access: await sanityAccess(target, host.fetch) };
    }
    case 'sanity-documents': {
      const target = host.sanityConnection(request.connectionId);
      const query = `*[_type == $type][0...${SANITY_DOCUMENTS_READ}]`;
      const url = sanityQueryURL(target, 'token', { query, parameters: { type: request.documentType } });
      const reply = await sampleDataJSON(url, sanityHeaders(target), host.fetch);
      const items = toArray(toRecord(reply)?.['result']) ?? [];
      if (items.length === 0) {
        throw new Error(`Sanity has no “${request.documentType}” documents to read.`);
      }
      return { kind: 'lists', lists: [{ path: '', count: items.length, fields: fieldsOf(items) }] };
    }
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}

/** The query address: Sanity's CDN for a public read, the live API with a token. */
export function sanityQueryURL(
  target: Pick<SanityTarget, 'projectId' | 'dataset'>,
  access: 'public' | 'token',
  input: { readonly query: string; readonly parameters: Readonly<Record<string, string>> },
): string {
  const host = access === 'public' ? 'apicdn' : 'api';
  const url = new URL(`https://${target.projectId}.${host}.sanity.io/${SANITY_API_VERSION}/data/query/${target.dataset}`);
  url.searchParams.set('query', input.query);
  for (const [name, value] of Object.entries(input.parameters)) {
    url.searchParams.set(`$${name}`, JSON.stringify(value));
  }
  return url.href;
}

function sanityHeaders(target: SanityTarget): Readonly<Record<string, string>> {
  // i18n-ignore: HTTP header value, not interface text.
  return { Authorization: `Bearer ${target.token}` };
}

// Asked without the key, because that is how a built site without one would
// ask. A private dataset refuses, or answers with nothing it can show.
async function sanityAccess(target: SanityTarget, fetcher: Fetch): Promise<DatasetAccess> {
  try {
    const reply = await sampleDataJSON(sanityQueryURL(target, 'public', { query: TYPES_QUERY, parameters: {} }), {}, fetcher);
    return sanityTypes(toRecord(reply)?.['result']).length > 0 ? 'public' : 'private';
  } catch {
    return 'private';
  }
}

function headersOf(headers: readonly SourceHeader[], env: ReadonlyMap<string, string>): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const header of headers) {
    const value = required(header.env, env);
    out[header.name] = header.scheme === 'bearer' ? `Bearer ${value}` : value;
  }
  return out;
}

function required(name: string, env: ReadonlyMap<string, string>): string {
  const value = env.get(name);
  if (value === undefined || value.length === 0) {
    throw new Error(`Set ${name} in .env first: enter its value in the form and save it.`);
  }
  return value;
}

function sanityTypes(input: unknown): readonly string[] {
  const types = (toArray(input) ?? []).filter((type): type is string => typeof type === 'string' && /^[A-Za-z][\w.-]{0,127}$/.test(type));
  return types
    .filter((type) => !SYSTEM_TYPE.test(type))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, PAGE_TEMPLATE_LIMITS.typesMax);
}

async function sampleDataJSON(url: string, headers: Readonly<Record<string, string>>, fetcher: Fetch): Promise<unknown> {
  const response = await sampleDataResponse(url, headers, fetcher);
  if (response.status >= 300 && response.status < 400) {
    const target = response.headers.get('location');
    throw new Error(
      target === null ? 'That address redirects somewhere else.' : `That address redirects to ${target.slice(0, 300)}. Use that address instead.`,
    );
  }
  const bytes = await sampleDataBytes(response);
  if (!response.ok) {
    throw new DescribedError(failureMessage(response.status, bytes));
  }
  try {
    const reply: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return reply;
  } catch {
    throw new Error('That address didn’t return data Stacki can read. Check it’s the link to your data, not a web page.');
  }
}

async function sampleDataResponse(url: string, headers: Readonly<Record<string, string>>, fetcher: Fetch): Promise<Response> {
  try {
    return await fetcher(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { Accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(DATA_SAMPLE_FETCH.timeoutMs),
    });
  } catch (error: unknown) {
    const name = toRecord(error)?.['name'];
    if (name === 'TimeoutError') {
      throw new Error(`That address did not answer within ${Math.round(DATA_SAMPLE_FETCH.timeoutMs / 1000)} seconds.`);
    }
    throw new Error('Could not reach that address. Check it, and that this computer is online.');
  }
}

async function sampleDataBytes(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return new Uint8Array();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Each read yields bytes until done, so the size bound ends the loop.
  while (size <= DATA_SAMPLE_FETCH.bytesMax) {
    const chunk = await reader.read();
    if (chunk.done) {
      return Buffer.concat(chunks);
    }
    const value: unknown = chunk.value;
    assert(value instanceof Uint8Array, 'A response body streams bytes');
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel();
  throw new DescribedError(described('cmsBackend.sample.tooLarge', { size: Math.floor(DATA_SAMPLE_FETCH.bytesMax / (1024 * 1024)) }));
}

function failureMessage(status: number, bytes: Uint8Array): Described {
  if (status === 401 || status === 403) {
    return described('cmsBackend.sample.refused', { status });
  }
  if (status === 404) {
    return described('cmsBackend.sample.notFound');
  }
  // Sanity says what was wrong, such as a dataset that does not exist.
  const detail = sanityErrorText(bytes);
  return detail === undefined ? described('cmsBackend.sample.answered', { status }) : described('cmsBackend.sample.answeredWith', { status, detail });
}

function sanityErrorText(bytes: Uint8Array): string | undefined {
  try {
    const reply: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const error = toRecord(toRecord(reply)?.['error']);
    const message = error?.['description'] ?? toRecord(reply)?.['message'];
    return typeof message === 'string' ? message.slice(0, 200) : undefined;
  } catch {
    // Not JSON: the status says enough.
    return undefined;
  }
}

/** Every list of records in a reply, breadth first, longest paths last. */
export function listsIn(reply: unknown): readonly SampleList[] {
  const lists: SampleList[] = [];
  const queue: { readonly value: unknown; readonly path: string; readonly depth: number }[] = [{ value: reply, path: '', depth: 0 }];
  // The visit count bounds the walk however wide the reply is.
  for (let visited = 0; visited < queue.length && visited < DATA_SAMPLE_FETCH.nodesVisitedMax; visited += 1) {
    const node = queue[visited];
    assert(node !== undefined, 'listsIn: the cursor stays inside the queue');
    const items = toArray(node.value);
    if (items !== undefined) {
      const fields = fieldsOf(items);
      if (fields.length > 0 && lists.length < PAGE_TEMPLATE_LIMITS.listsMax) {
        lists.push({ path: node.path, count: items.length, fields });
      }
    } else if (node.depth < DATA_SAMPLE_FETCH.listDepthMax) {
      for (const [name, value] of Object.entries(toRecord(node.value) ?? {})) {
        if (isFieldName(name) && node.path.length + name.length < PAGE_TEMPLATE_LIMITS.dataPathCharsMax) {
          queue.push({ value, path: node.path === '' ? name : `${node.path}.${name}`, depth: node.depth + 1 });
        }
      }
    }
  }
  assert(lists.length <= PAGE_TEMPLATE_LIMITS.listsMax, 'listsIn: the lists are bounded');
  return lists;
}

/** The fields the first items of a list hold, nested ones by dotted path. */
export function fieldsOf(items: readonly unknown[]): readonly SampleField[] {
  const fields = new Map<string, SampleField>();
  for (const item of items.slice(0, DATA_SAMPLE_FETCH.itemsReadMax)) {
    collectFields(item, fields);
  }
  const shown = items.slice(0, PAGE_TEMPLATE_LIMITS.itemsPreviewMax);
  return [...fields.values()].slice(0, PAGE_TEMPLATE_LIMITS.fieldsMax).map((field) => {
    const examples = shown.map((item) => {
      const value = valueAt(item, field.path);
      const kind = kindOf(value);
      return kind === undefined ? '' : exampleOf(value, kind);
    });
    if (field.kind === 'string' || field.kind === 'number') {
      return { ...field, examples, address: addressFitOf(items.slice(0, ADDRESS_LIMITS.valuesReadMax).map((item) => valueAt(item, field.path))) };
    }
    return { ...field, examples };
  });
}

function valueAt(item: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, step) => toRecord(value)?.[step], item);
}

function collectFields(item: unknown, fields: Map<string, SampleField>): void {
  const pending: { readonly value: unknown; readonly base: string; readonly depth: number }[] = [{ value: item, base: '', depth: 0 }];
  // Every pass takes one object and adds only deeper ones, stopping at the depth bound.
  for (let at = 0; at < pending.length && at < DATA_SAMPLE_FETCH.nodesVisitedMax; at += 1) {
    const node = pending[at];
    assert(node !== undefined, 'collectFields: the cursor stays inside the list');
    for (const [name, field] of Object.entries(toRecord(node.value) ?? {})) {
      const path = node.base === '' ? name : `${node.base}.${name}`;
      const kind = kindOf(field);
      if (kind !== undefined && isFieldName(name) && path.length <= PAGE_TEMPLATE_LIMITS.dataPathCharsMax && fields.size < PAGE_TEMPLATE_LIMITS.fieldsMax) {
        if (!fields.has(path)) {
          fields.set(path, { path, kind, example: exampleOf(field, kind) });
        }
        if (kind === 'object' && node.depth + 1 < DATA_SAMPLE_FETCH.fieldDepthMax) {
          pending.push({ value: field, base: path, depth: node.depth + 1 });
        }
      }
    }
  }
}

function isFieldName(name: string): boolean {
  return /^[A-Za-z_$][\w$-]{0,127}$/.test(name);
}

function kindOf(value: unknown): SampleFieldKind | undefined {
  if (typeof value === 'string') {
    return 'string';
  }
  if (typeof value === 'number') {
    return 'number';
  }
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (toArray(value) !== undefined) {
    return 'list';
  }
  return toRecord(value) === undefined ? undefined : 'object';
}

function exampleOf(value: unknown, kind: SampleFieldKind): string {
  if (kind === 'list') {
    return `${toArray(value)?.length ?? 0} items`;
  }
  if (kind === 'object') {
    return 'object';
  }
  const text = String(value);
  const charsMax = PAGE_TEMPLATE_LIMITS.exampleCharsMax;
  return text.length > charsMax ? `${text.slice(0, charsMax - 1)}…` : text;
}
