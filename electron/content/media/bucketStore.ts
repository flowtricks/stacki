// Cloudflare R2 and every S3-compatible host (AWS S3, Backblaze B2, DigitalOcean
// Spaces, MinIO, Wasabi) through the S3 REST API, signed with SigV4
// (sigV4.ts). Folders are key prefixes: a listing with `delimiter=/` names a
// folder's own files and the prefixes one level below it, and an empty folder
// is kept by a zero-byte marker object whose key ends in a slash, as the R2 and
// S3 consoles make them. S3 holds no order of its own; mediaOrder.ts keeps one.

import { assert } from '../../../shared/core/assert';
import { MEDIA_HOSTING_LIMITS, parseMediaName, type BucketAddressing } from '../../../shared/properties/mediaHosting';
import { EMPTY_PAYLOAD_HASH, sha256Hex, signRequest, uriEncode, type SigningKeys } from './sigV4';
import { MEDIA_HTTP_LIMITS, MediaHostError, expectOk, readBounded, readText, send, statusSentence, type MediaRequest } from './mediaHttp';
import { MEDIA_FOLDER_KEYS_MAX, publicURLOf, type MediaStore, type StoreOptions, type StoredFile, type StoredListing } from './mediaStore';

export interface BucketTarget {
  readonly host: string;
  /** The API origin, without a path. */
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly addressing: BucketAddressing;
  readonly publicBaseUrl: string;
}

// S3 returns at most 1,000 keys a page; this many pages cover a folder's bound.
const LIST_PAGE_KEYS = 1000;
const LIST_PAGES_MAX = Math.ceil(MEDIA_HOSTING_LIMITS.entriesPerFolderMax / LIST_PAGE_KEYS) + 1;

export function bucketStore(target: BucketTarget, keys: SigningKeys, options: StoreOptions): MediaStore {
  assert(!target.endpoint.endsWith('/'), 'An endpoint has no trailing slash');
  assert(target.bucket.length > 0, 'A store names its bucket');
  const request = async (method: MediaRequest['method'], url: URL, extra: Readonly<Record<string, string>>, body?: Uint8Array): Promise<Response> => {
    const payloadHash = body === undefined ? EMPTY_PAYLOAD_HASH : sha256Hex(body);
    const headers = signRequest({ method, url, headers: extra, payloadHash }, keys, { region: target.region, service: 's3', date: options.now() });
    // The platform's fetch sets Host itself and refuses to be given one.
    const sent = Object.fromEntries(Object.entries(headers).filter(([name]) => name !== 'host'));
    const timeoutMs = body === undefined ? MEDIA_HTTP_LIMITS.requestTimeoutMs : MEDIA_HTTP_LIMITS.transferTimeoutMs;
    return send(options.fetch, { method, url: url.toString(), headers: sent, body, timeoutMs });
  };
  const objectURL = (key: string): URL => objectAddress(target, key);
  const listPages = async (prefix: string, scope: 'folder' | 'tree', keysMax: number) => {
    const pages: string[] = [];
    let token: string | undefined = undefined;
    for (let page = 0; page < LIST_PAGES_MAX + Math.ceil(keysMax / LIST_PAGE_KEYS); page++) {
      const url = bucketAddress(target, {
        'list-type': '2',
        'max-keys': String(LIST_PAGE_KEYS),
        prefix,
        ...(scope === 'folder' ? { delimiter: '/' } : {}),
        ...(token === undefined ? {} : { 'continuation-token': token }),
      });
      const response = await request('GET', url, {});
      await expectOk(response, (status, body) => describeFailure(target.host, status, body));
      const xml = await readText(response);
      pages.push(xml);
      token = xmlValue(xml, 'NextContinuationToken');
      const keyCount = pages.length * LIST_PAGE_KEYS;
      if (xmlValue(xml, 'IsTruncated') !== 'true' || token === undefined || keyCount > keysMax) {
        return { pages, truncated: xmlValue(xml, 'IsTruncated') === 'true' };
      }
    }
    return { pages, truncated: true };
  };
  return {
    host: target.host,
    async list(folder) {
      const prefix = folder === '' ? '' : `${folder}/`;
      const { pages, truncated } = await listPages(prefix, 'folder', MEDIA_HOSTING_LIMITS.entriesPerFolderMax);
      return listingOf({ pages, prefix, truncated });
    },
    async keysUnder(folder, keysMax) {
      assert(folder !== '', 'A tree is below a folder, never the whole bucket');
      const prefix = `${folder}/`;
      const { pages, truncated } = await listPages(prefix, 'tree', keysMax);
      const keys = pages.flatMap((xml) => xmlBlocks(xml, 'Contents').map((block) => xmlValue(block, 'Key') ?? ''));
      if (truncated || keys.length > keysMax) {
        throw new MediaHostError(`This folder holds more than ${keysMax} files; change it in the host's own dashboard.`, 0);
      }
      return keys
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length))
        .filter((key) => key !== '');
    },
    async read(key, bytesMax) {
      const response = await request('GET', objectURL(key), {});
      if (response.status === 404) {
        await response.body?.cancel();
        return undefined;
      }
      await expectOk(response, (status, body) => describeFailure(target.host, status, body));
      return readBounded(response, bytesMax);
    },
    async write(key, bytes, contentType) {
      assert(bytes.length <= MEDIA_HTTP_LIMITS.fileBytesMax, 'An upload is bounded');
      const response = await request('PUT', objectURL(key), { 'content-type': contentType }, bytes);
      await expectOk(response, (status, body) => describeFailure(target.host, status, body));
      await response.body?.cancel();
    },
    async copy(fromKey, toKey) {
      assert(fromKey !== toKey, 'A copy goes somewhere else');
      const source = `/${target.bucket}/${encodeKey(fromKey)}`;
      const response = await request('PUT', objectURL(toKey), { 'x-amz-copy-source': source });
      await expectOk(response, (status, body) => describeFailure(target.host, status, body));
      // S3 may answer a copy with 200 and an error in the body.
      const body = await readText(response);
      if (body.includes('<Error>')) {
        throw new MediaHostError(describeFailure(target.host, 500, body), 500);
      }
    },
    async remove(key) {
      const response = await request('DELETE', objectURL(key), {});
      if (response.status !== 404) {
        await expectOk(response, (status, body) => describeFailure(target.host, status, body));
      }
      await response.body?.cancel();
    },
    async createFolder(folder) {
      assert(folder !== '', 'The root is not created');
      await this.write(`${folder}/`, new Uint8Array(0), 'application/x-directory');
    },
    async removeFolder(folder) {
      const keysBelow = await this.keysUnder(folder, MEDIA_FOLDER_KEYS_MAX);
      for (const key of keysBelow) {
        await this.remove(`${folder}/${key}`);
      }
      await this.remove(`${folder}/`);
    },
    publicURL: (key) => publicURLOf(target.publicBaseUrl, key),
  };
}

function encodeKey(key: string): string {
  return key.split('/').map(uriEncode).join('/');
}

export function objectAddress(target: Pick<BucketTarget, 'endpoint' | 'bucket' | 'addressing'>, key: string): URL {
  assert(key.length > 0, 'An object has a key');
  const origin = new URL(target.endpoint);
  if (target.addressing === 'virtual') {
    return new URL(`${origin.protocol}//${target.bucket}.${origin.host}/${encodeKey(key)}`);
  }
  return new URL(`${origin.origin}/${target.bucket}/${encodeKey(key)}`);
}

export function bucketAddress(target: Pick<BucketTarget, 'endpoint' | 'bucket' | 'addressing'>, query: Readonly<Record<string, string>>): URL {
  const origin = new URL(target.endpoint);
  const url = target.addressing === 'virtual' ? new URL(`${origin.protocol}//${target.bucket}.${origin.host}/`) : new URL(`${origin.origin}/${target.bucket}`);
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, value);
  }
  return url;
}

// A listing's pages as one folder: its own files (not the marker for the folder
// itself, not the order manifest) and the folders one level below. A key the
// panel cannot name (a control character, a backslash) is left out rather
// than shown as something it cannot act on.
function listingOf(read: { readonly pages: readonly string[]; readonly prefix: string; readonly truncated: boolean }): StoredListing {
  const { pages, prefix, truncated } = read;
  const folders: string[] = [];
  const files: StoredFile[] = [];
  for (const xml of pages) {
    for (const block of xmlBlocks(xml, 'CommonPrefixes')) {
      const name = (xmlValue(block, 'Prefix') ?? '').slice(prefix.length).replace(/\/$/, '');
      if (nameable(name)) {
        folders.push(name);
      }
    }
    for (const block of xmlBlocks(xml, 'Contents')) {
      const name = (xmlValue(block, 'Key') ?? '').slice(prefix.length);
      if (nameable(name)) {
        const size = Number(xmlValue(block, 'Size'));
        const modified = xmlValue(block, 'LastModified');
        files.push({
          name,
          sizeBytes: Number.isSafeInteger(size) && size >= 0 ? size : undefined,
          modified: modified !== undefined && !Number.isNaN(Date.parse(modified)) ? modified : undefined,
        });
      }
    }
  }
  const bound = MEDIA_HOSTING_LIMITS.entriesPerFolderMax;
  return { folders: folders.slice(0, bound), files: files.slice(0, bound), truncated: truncated || folders.length > bound || files.length > bound };
}

function nameable(name: string): boolean {
  if (name === '') {
    return false;
  }
  try {
    parseMediaName(name);
    return true;
  } catch {
    return false;
  }
}

function describeFailure(host: string, status: number, body: string): string {
  const code = xmlValue(body, 'Code');
  const message = xmlValue(body, 'Message');
  const detail = code === undefined ? '' : ` ${host} said ${code}${message === undefined ? '' : `: ${message}`}`;
  return `${statusSentence(status)}${detail}`;
}

// --- The little XML S3 answers in -------------------------------------------
// S3's listing and error bodies are flat, known elements; a full XML parser
// would be a dependency for reading a handful of tags.

export function xmlBlocks(xml: string, tag: string): readonly string[] {
  assert(/^[A-Za-z]+$/.test(tag), 'A tag is a plain name');
  const blocks: string[] = [];
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  for (const match of xml.matchAll(pattern)) {
    blocks.push(match[1] ?? '');
  }
  return blocks;
}

export function xmlValue(xml: string, tag: string): string | undefined {
  const [first] = xmlBlocks(xml, tag);
  return first === undefined ? undefined : decodeEntities(first);
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) {
      return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    }
    if (lower.startsWith('#')) {
      return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    }
    const named: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    return named[lower] ?? whole;
  });
}
