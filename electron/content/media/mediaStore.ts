// The shape every media host is driven through. A host adapter (bucketStore.ts for
// R2 and S3-compatible hosts, bunnyStore.ts for Bunny Storage) does only what
// the host's own API does — list a folder, read, write, copy and delete an
// object — and mediaService.ts builds the panel's operations (rename, order,
// unique upload names) on top, once for every host. A new host is one more
// adapter of this interface.

import { assert } from '../../../shared/core/assert';
import type { MediaConnection, MediaSecret } from '../../../shared/properties/mediaHosting';
import type { MediaFetch } from './mediaHttp';
import { bunnyStore } from './bunnyStore';
import { bucketStore } from './bucketStore';

/** Objects a folder rename or delete moves one by one; a bigger tree is the host dashboard's job. */
export const MEDIA_FOLDER_KEYS_MAX = 1000;

export interface StoredFile {
  readonly name: string;
  readonly sizeBytes: number | undefined;
  readonly modified: string | undefined;
}

/** One folder's own entries, as the host lists them. */
export interface StoredListing {
  readonly folders: readonly string[];
  readonly files: readonly StoredFile[];
  readonly truncated: boolean;
}

export interface MediaStore {
  /** The host's name, for messages: "R2", "Bunny Storage". */
  readonly host: string;
  list(folder: string): Promise<StoredListing>;
  /**
   * Every key below a folder, at any depth, up to `keysMax`: files as their
   * keys, folders as their path and a trailing slash. Throws past the bound,
   * so a caller never acts on part of a tree believing it is all of it.
   */
  keysUnder(folder: string, keysMax: number): Promise<readonly string[]>;
  /** An object's bytes, or undefined when it is not there. */
  read(key: string, bytesMax: number): Promise<Uint8Array | undefined>;
  write(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  copy(fromKey: string, toKey: string): Promise<void>;
  /** Deletes one object; an object already gone is not a failure. */
  remove(key: string): Promise<void>;
  createFolder(folder: string): Promise<void>;
  removeFolder(folder: string): Promise<void>;
  publicURL(key: string): string;
}

export interface StoreOptions {
  readonly fetch: MediaFetch;
  /** The clock S3 requests are signed with. */
  readonly now: () => Date;
}

/** The adapter for one saved connection and its keys. */
export function storeFor(connection: MediaConnection, secret: MediaSecret, options: StoreOptions): MediaStore {
  switch (connection.kind) {
    case 'r2':
      assert(secret.kind === 'keyPair', 'R2 signs with a key pair');
      return bucketStore(
        {
          host: 'R2',
          endpoint: `https://${connection.accountId}.r2.cloudflarestorage.com`,
          // R2 takes `auto` for every bucket; its location is chosen at creation.
          region: 'auto',
          bucket: connection.bucket,
          addressing: 'path',
          publicBaseUrl: connection.publicBaseUrl,
        },
        secret,
        options,
      );
    case 's3':
      assert(secret.kind === 'keyPair', 'An S3-compatible host signs with a key pair');
      return bucketStore({ host: 'S3', ...connection }, secret, options);
    case 'bunny':
      assert(secret.kind === 'accessKey', 'Bunny Storage takes its zone password');
      return bunnyStore(connection, secret.accessKey, options.fetch);
    default: {
      const exhaustive: never = connection;
      return exhaustive;
    }
  }
}

/** The public address of a key: the base URL and each path segment encoded. */
export function publicURLOf(publicBaseUrl: string, key: string): string {
  assert(!publicBaseUrl.endsWith('/'), 'A public base URL has no trailing slash');
  assert(key.length > 0, 'A public URL names a file');
  return `${publicBaseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

// The content types a browser needs to play or show a file from its public
// URL; anything else is served as bytes to download.
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  aac: 'audio/aac',
  avif: 'image/avif',
  bmp: 'image/bmp',
  css: 'text/css',
  csv: 'text/csv',
  flac: 'audio/flac',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'text/javascript',
  json: 'application/json',
  m4a: 'audio/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  ogv: 'video/ogg',
  opus: 'audio/opus',
  otf: 'font/otf',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  ttf: 'font/ttf',
  txt: 'text/plain',
  vtt: 'text/vtt',
  wav: 'audio/wav',
  webm: 'video/webm',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  zip: 'application/zip',
};

export function contentTypeOf(name: string): string {
  const dot = name.lastIndexOf('.');
  const extension = dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}
