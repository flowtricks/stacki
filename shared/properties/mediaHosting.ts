// Media hosting connections: object stores and CDNs a project keeps its media
// on (Cloudflare R2, Bunny Storage, or any S3-compatible host), browsed and
// edited from the Assets panel. As with CMS connections (cmsConnections.ts),
// a connection's keys cross to the main process once, when it is saved, and
// never come back: everything here the renderer sees is the public half of a
// connection and the listings the main process reads with its keys.
//
// A provider is one variant of `MediaConnection`. Adding a host means a variant
// here, a parser case below, and a store adapter in `electron/media/`; an
// S3-compatible host usually needs only the `s3` variant's endpoint.

import { record, text } from '../core/boundary';
import { assert } from '../core/assert';
import { parseMessageRef, type MessageRef } from '../core/i18n/messageReference';
import { MediaInputError } from './mediaInputError';
import { described, type Described, type MessageKey } from './i18n/messageRef';

export const MEDIA_HOSTING_LIMITS = {
  connectionsPerProjectMax: 16,
  // A folder's own entries a listing returns; a bigger folder is shown truncated.
  entriesPerFolderMax: 5000,
  // Folder levels below a connection's root that the panel navigates.
  folderDepthMax: 32,
  // S3 and R2 keys are at most 1,024 bytes of UTF-8; Bunny paths are shorter.
  keyBytesMax: 1024,
  keyIdCharsMax: 128,
  labelCharsMax: 80,
  messageCharsMax: 1000,
  nameCharsMax: 255,
  secretCharsMax: 512,
  // Files one upload request carries.
  uploadFilesMax: 100,
  urlCharsMax: 2048,
} as const satisfies Record<string, number>;

/**
 * The object each folder's custom order is kept in, inside the bucket itself
 * (electron/media/mediaOrder.ts). Listings never show it, and no file may take
 * its name.
 */
export const MEDIA_ORDER_FILE = '.stacki-order.json';

export const MEDIA_PROVIDER_KINDS = ['r2', 'bunny', 's3'] as const;
export type MediaProviderKind = (typeof MEDIA_PROVIDER_KINDS)[number];

// Bunny Storage regions, by the code Bunny's dashboard shows. Falkenstein (de)
// is the primary region and has no prefix on its storage host.
export const BUNNY_REGIONS = ['de', 'uk', 'ny', 'la', 'sg', 'se', 'br', 'jh', 'syd'] as const;
export type BunnyRegion = (typeof BUNNY_REGIONS)[number];

/** How an S3-compatible host addresses a bucket: in the path, or as a subdomain. */
export const BUCKET_ADDRESSING = ['path', 'virtual'] as const;
export type BucketAddressing = (typeof BUCKET_ADDRESSING)[number];

export type MediaConnection =
  | {
      readonly kind: 'r2';
      readonly id: string;
      readonly label: string;
      /** The Cloudflare account id: 32 hex characters. */
      readonly accountId: string;
      readonly bucket: string;
      /** Where the bucket is public: its r2.dev address or a custom domain. */
      readonly publicBaseUrl: string;
    }
  | {
      readonly kind: 'bunny';
      readonly id: string;
      readonly label: string;
      readonly storageZone: string;
      readonly region: BunnyRegion;
      /** The pull zone that serves the storage zone, e.g. https://site.b-cdn.net. */
      readonly publicBaseUrl: string;
    }
  | {
      readonly kind: 's3';
      readonly id: string;
      readonly label: string;
      /** The S3 API origin, e.g. https://s3.us-east-1.amazonaws.com. */
      readonly endpoint: string;
      readonly region: string;
      readonly bucket: string;
      readonly addressing: BucketAddressing;
      readonly publicBaseUrl: string;
    };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The keys an S3-style API signs with, or the single key Bunny Storage takes. */
export type MediaSecret =
  { readonly kind: 'keyPair'; readonly accessKeyId: string; readonly secretAccessKey: string } | { readonly kind: 'accessKey'; readonly accessKey: string };

/** A connection as it is saved: its public fields, without an id yet, and its keys. */
export type MediaConnectionDraft = DistributiveOmit<MediaConnection, 'id'> & { readonly secret: MediaSecret };

export interface MediaConnectionList {
  /** Whether keys can be encrypted on this machine; none are saved without it. */
  readonly encryption: 'available' | 'unavailable';
  readonly connections: readonly MediaConnection[];
}

export type MediaSaveResult =
  { readonly ok: true; readonly list: MediaConnectionList } | { readonly ok: false; readonly message: string; readonly messageRef?: MessageRef | undefined };

/** What a file previews as in the panel. */
export type MediaFileKind = 'image' | 'video' | 'audio' | 'file';

export interface MediaFolder {
  readonly name: string;
  /** The folder's path from the connection's root, e.g. `images/2024`. */
  readonly path: string;
}

export interface MediaFile {
  readonly name: string;
  /** The file's key from the connection's root, e.g. `images/2024/hero.jpg`. */
  readonly key: string;
  readonly kind: MediaFileKind;
  readonly sizeBytes: number | undefined;
  /** When it last changed, as an ISO 8601 time, when the host says. */
  readonly modified: string | undefined;
  /** Where the public reads it: what a picked file writes into a field. */
  readonly url: string;
}

export interface MediaListing {
  /** The folder listed: '' for the root, else its path. */
  readonly folder: string;
  readonly folders: readonly MediaFolder[];
  /** In the folder's custom order when it has one, then by name. */
  readonly files: readonly MediaFile[];
  /** The folder held more than the panel lists. */
  readonly truncated: boolean;
}

/** An expected failure — offline, a revoked key, a missing bucket — is an answer, not a crash. */
export type MediaResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string; readonly messageRef?: MessageRef | undefined };

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function parseMediaConnectionId(input: unknown): string {
  const id = text(input);
  if (!UUID.test(id)) {
    throw new Error('Invalid media connection id.');
  }
  assert(id.length === 36, 'A media connection id is a UUID');
  return id;
}

/**
 * A public or API address: https, or http on this machine for a local server
 * (MinIO, a dev CDN). No login, query or fragment; no trailing slash.
 */
export function parseMediaURL(input: unknown, what: string): string {
  const raw = text(input).trim();
  if (raw.length === 0 || raw.length > MEDIA_HOSTING_LIMITS.urlCharsMax) {
    throw new MediaInputError('assets.input.url.enter', { what });
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MediaInputError('assets.input.url.notUrl', { what });
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:') {
    if (!(url.protocol === 'http:' && local)) {
      throw new MediaInputError('assets.input.url.https', { what });
    }
  }
  if (url.username !== '' || url.password !== '') {
    throw new MediaInputError('assets.input.url.login', { what });
  }
  if (url.search !== '' || url.hash !== '') {
    throw new MediaInputError('assets.input.url.queryFragment', { what });
  }
  const parsed = url.toString().replace(/\/+$/, '');
  assert(!parsed.endsWith('/'), 'A parsed address has no trailing slash');
  assert(parsed.length <= MEDIA_HOSTING_LIMITS.urlCharsMax, 'A parsed address stays bounded');
  return parsed;
}

/** An API endpoint is an origin: the bucket and keys are added to it. */
function parseEndpoint(input: unknown): string {
  const parsed = parseMediaURL(input, 'S3 endpoint');
  if (new URL(parsed).pathname !== '/') {
    throw new MediaInputError('assets.input.url.endpointPath');
  }
  assert(!parsed.endsWith('/'), 'An endpoint has no trailing slash');
  return parsed;
}

function parseLabel(input: unknown): string {
  const label = text(input).trim();
  if (label.length === 0 || label.length > MEDIA_HOSTING_LIMITS.labelCharsMax) {
    throw new MediaInputError('assets.input.label', { max: MEDIA_HOSTING_LIMITS.labelCharsMax });
  }
  return label;
}

function parseAccountId(input: unknown): string {
  const id = text(input).trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(id)) {
    throw new MediaInputError('assets.input.accountId');
  }
  return id;
}

// S3's bucket rules, which R2 follows: 3–63 lower-case letters, digits, dots
// and hyphens, starting and ending with a letter or digit.
function parseBucket(input: unknown): string {
  const bucket = text(input).trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new MediaInputError('assets.input.bucket');
  }
  assert(!bucket.includes('/'), 'A bucket name is one path segment');
  return bucket;
}

function parseStorageZone(input: unknown): string {
  const zone = text(input).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(zone)) {
    throw new MediaInputError('assets.input.storageZone');
  }
  return zone;
}

function parseRegion(input: unknown): string {
  const region = text(input).trim();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(region)) {
    throw new MediaInputError('assets.input.region');
  }
  return region;
}

export function parseBunnyRegion(input: unknown): BunnyRegion {
  const region = BUNNY_REGIONS.find((candidate) => candidate === input);
  if (region === undefined) {
    throw new Error('Unknown Bunny Storage region.');
  }
  return region;
}

function parseAddressing(input: unknown): BucketAddressing {
  const addressing = BUCKET_ADDRESSING.find((candidate) => candidate === input);
  if (addressing === undefined) {
    throw new Error('Unknown S3 addressing style.');
  }
  return addressing;
}

/** A key as hosts issue them: printable ASCII on one line, no spaces. */
function parseKey(input: unknown, what: string, charsMax: number): string {
  const key = text(input).trim();
  if (key.length === 0 || key.length > charsMax) {
    throw new MediaInputError('assets.input.key.paste', { what });
  }
  if (!/^[\x21-\x7e]+$/.test(key)) {
    throw new MediaInputError('assets.input.key.printable', { what });
  }
  assert(!/\s/.test(key), 'A key never holds whitespace');
  return key;
}

export function parseMediaSecret(input: unknown): MediaSecret {
  const value = record(input);
  switch (value['kind']) {
    case 'keyPair':
      return {
        kind: 'keyPair',
        accessKeyId: parseKey(value['accessKeyId'], 'access key ID', MEDIA_HOSTING_LIMITS.keyIdCharsMax),
        secretAccessKey: parseKey(value['secretAccessKey'], 'secret access key', MEDIA_HOSTING_LIMITS.secretCharsMax),
      };
    case 'accessKey':
      return { kind: 'accessKey', accessKey: parseKey(value['accessKey'], 'storage password', MEDIA_HOSTING_LIMITS.secretCharsMax) };
    default:
      throw new Error('Unknown media key kind.');
  }
}

export function parseMediaConnection(input: unknown): MediaConnection {
  const value = record(input);
  const id = parseMediaConnectionId(value['id']);
  const fields = parseConnectionFields(value);
  assert(!('secret' in fields), 'A public connection never carries its keys');
  return { ...fields, id };
}

export function parseMediaConnectionDraft(input: unknown): MediaConnectionDraft {
  const value = record(input);
  const fields = parseConnectionFields(value);
  const secret = parseMediaSecret(value['secret']);
  // Each provider signs with its own kind of key; a mismatch is a broken form.
  if (fields.kind === 'bunny') {
    if (secret.kind !== 'accessKey') {
      throw new MediaInputError('assets.input.secret.bunny');
    }
  } else if (secret.kind !== 'keyPair') {
    throw new MediaInputError('assets.input.secret.keyPair');
  }
  return { ...fields, secret };
}

function parseConnectionFields(value: Record<string, unknown>): DistributiveOmit<MediaConnection, 'id'> {
  const label = parseLabel(value['label']);
  switch (value['kind']) {
    case 'r2':
      return {
        kind: 'r2',
        label,
        accountId: parseAccountId(value['accountId']),
        bucket: parseBucket(value['bucket']),
        publicBaseUrl: parseMediaURL(value['publicBaseUrl'], 'public bucket URL'),
      };
    case 'bunny':
      return {
        kind: 'bunny',
        label,
        storageZone: parseStorageZone(value['storageZone']),
        region: parseBunnyRegion(value['region']),
        publicBaseUrl: parseMediaURL(value['publicBaseUrl'], 'pull zone URL'),
      };
    case 's3':
      return {
        kind: 's3',
        label,
        endpoint: parseEndpoint(value['endpoint']),
        region: parseRegion(value['region']),
        bucket: parseBucket(value['bucket']),
        addressing: parseAddressing(value['addressing']),
        publicBaseUrl: parseMediaURL(value['publicBaseUrl'], 'public URL'),
      };
    default:
      throw new Error('Unknown media host.');
  }
}

export function parseMediaConnectionList(input: unknown): MediaConnectionList {
  const value = record(input);
  const encryption = value['encryption'];
  if (encryption !== 'available' && encryption !== 'unavailable') {
    throw new Error('Invalid encryption state.');
  }
  const connections = value['connections'];
  if (!Array.isArray(connections)) {
    throw new Error('Expected a list of media connections.');
  }
  if (connections.length > MEDIA_HOSTING_LIMITS.connectionsPerProjectMax) {
    throw new Error('Too many media connections.');
  }
  const parsed = connections.map(parseMediaConnection);
  assert(parsed.length === connections.length, 'Every listed connection parses');
  return { encryption, connections: parsed };
}

export function parseMediaSaveResult(input: unknown): MediaSaveResult {
  const value = record(input);
  if (value['ok'] === true) {
    return { ok: true, list: parseMediaConnectionList(value['list']) };
  }
  if (value['ok'] !== false) {
    throw new Error('Expected a save result.');
  }
  return { ok: false, message: parseMediaMessage(value['message']), ...parseOptionalRef(value['messageRef']) };
}

export function parseMediaResult<T>(input: unknown, parseValue: (value: unknown) => T): MediaResult<T> {
  const value = record(input);
  if (value['ok'] === true) {
    return { ok: true, value: parseValue(value['value']) };
  }
  if (value['ok'] !== false) {
    throw new Error('Expected a media result.');
  }
  return { ok: false, message: parseMediaMessage(value['message']), ...parseOptionalRef(value['messageRef']) };
}

/** A reference that came with a failure: kept when well formed, dropped (the English message shows) when not. */
function parseOptionalRef(input: unknown): { readonly messageRef?: MessageRef } {
  if (input === undefined) {
    return {};
  }
  const parsed = parseMessageRef(input);
  return parsed.ok ? { messageRef: parsed.value } : {};
}

export function parseMediaMessage(input: unknown): string {
  const message = text(input);
  if (message.length === 0 || message.length > MEDIA_HOSTING_LIMITS.messageCharsMax) {
    throw new Error('Invalid media hosting message.');
  }
  return message;
}

// --- Names, folders and keys --------------------------------------------------

/** One file or folder name: a single trimmed path segment the panel can show and the host can store. */
export function parseMediaName(input: unknown): string {
  const name = text(input);
  if (name.length === 0 || name.length > MEDIA_HOSTING_LIMITS.nameCharsMax) {
    throw new Error(`A name is 1–${MEDIA_HOSTING_LIMITS.nameCharsMax} characters.`);
  }
  if (name.trim() !== name) {
    throw new Error('A name cannot start or end with a space.');
  }
  if (name === '.' || name === '..') {
    throw new Error('That name is reserved.');
  }
  if (/[/\\]/.test(name)) {
    throw new Error('A name cannot hold a slash.');
  }
  if (/[\x00-\x1f\x7f]/.test(name)) {
    throw new Error('A name cannot hold control characters.');
  }
  if (name === MEDIA_ORDER_FILE) {
    throw new Error(`${MEDIA_ORDER_FILE} holds each folder's order and cannot be used as a name.`);
  }
  return name;
}

/** A folder from the connection's root: '' for the root, else `a/b` with no leading or trailing slash. */
export function parseMediaFolder(input: unknown): string {
  const folder = text(input);
  if (folder === '') {
    return folder;
  }
  const segments = folder.split('/');
  if (segments.length > MEDIA_HOSTING_LIMITS.folderDepthMax) {
    throw new Error('That folder is nested too deeply.');
  }
  segments.forEach(parseMediaName);
  assertKeyBytes(`${folder}/`);
  return folder;
}

/** A file's key: a folder and a name. */
export function parseMediaKey(input: unknown): string {
  const key = text(input);
  const slash = key.lastIndexOf('/');
  const folder = slash < 0 ? '' : key.slice(0, slash);
  parseMediaFolder(folder);
  parseMediaName(key.slice(slash + 1));
  assertKeyBytes(key);
  return key;
}

/** The key of a name in a folder. */
export function mediaKeyOf(folder: string, name: string): string {
  const key = folder === '' ? name : `${folder}/${name}`;
  assert(!key.startsWith('/'), 'A media key is relative to the root');
  assert(!key.endsWith('/'), 'A media key names a file, not a folder');
  return key;
}

function assertKeyBytes(key: string): void {
  if (new TextEncoder().encode(key).length > MEDIA_HOSTING_LIMITS.keyBytesMax) {
    throw new Error(`A path is at most ${MEDIA_HOSTING_LIMITS.keyBytesMax} bytes.`);
  }
}

/** Names in their new order; each once. */
export function parseMediaOrder(input: unknown): readonly string[] {
  if (!Array.isArray(input)) {
    throw new Error('Expected an order of names.');
  }
  if (input.length > MEDIA_HOSTING_LIMITS.entriesPerFolderMax) {
    throw new Error('Too many names to order.');
  }
  const names = input.map(parseMediaName);
  if (new Set(names).size !== names.length) {
    throw new Error('An order names each file once.');
  }
  return names;
}

const IMAGE_NAME = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i;
const VIDEO_NAME = /\.(mp4|webm|mov|m4v|ogv)$/i;
const AUDIO_NAME = /\.(mp3|wav|m4a|aac|flac|oga|ogg|opus)$/i;

/** What a file previews as, by its name. */
export function mediaKindOf(name: string): MediaFileKind {
  if (IMAGE_NAME.test(name)) {
    return 'image';
  }
  if (VIDEO_NAME.test(name)) {
    return 'video';
  }
  if (AUDIO_NAME.test(name)) {
    return 'audio';
  }
  return 'file';
}

// --- Listings -------------------------------------------------------------------

export function parseMediaListing(input: unknown): MediaListing {
  const value = record(input);
  const folder = parseMediaFolder(value['folder']);
  const folders = boundedArray(value['folders'], 'folders').map((entry) => parseListedFolder(entry, folder));
  const files = boundedArray(value['files'], 'files').map((entry) => parseListedFile(entry, folder));
  const truncated = value['truncated'];
  if (typeof truncated !== 'boolean') {
    throw new Error('Expected whether the listing is truncated.');
  }
  const names = [...folders.map((entry) => `d:${entry.name}`), ...files.map((entry) => `f:${entry.name}`)];
  if (new Set(names).size !== names.length) {
    throw new Error('A listing names each entry once.');
  }
  assert(folders.length + files.length <= 2 * MEDIA_HOSTING_LIMITS.entriesPerFolderMax, 'A listing stays bounded');
  return { folder, folders, files, truncated };
}

function boundedArray(input: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(input)) {
    throw new Error(`Expected listed ${what}.`);
  }
  if (input.length > MEDIA_HOSTING_LIMITS.entriesPerFolderMax) {
    throw new Error(`Too many listed ${what}.`);
  }
  return input;
}

function parseListedFolder(input: unknown, parent: string): MediaFolder {
  const value = record(input);
  const name = parseMediaName(value['name']);
  const folderPath = parseMediaFolder(value['path']);
  if (folderPath !== mediaKeyOf(parent, name)) {
    throw new Error('A listed folder is not in the listed folder.');
  }
  return { name, path: folderPath };
}

function parseListedFile(input: unknown, parent: string): MediaFile {
  const value = record(input);
  const name = parseMediaName(value['name']);
  const key = parseMediaKey(value['key']);
  if (key !== mediaKeyOf(parent, name)) {
    throw new Error('A listed file is not in the listed folder.');
  }
  const kind = value['kind'];
  if (kind !== 'image' && kind !== 'video' && kind !== 'audio' && kind !== 'file') {
    throw new Error('Unknown media file kind.');
  }
  return {
    name,
    key,
    kind,
    sizeBytes: parseOptionalSize(value['sizeBytes']),
    modified: parseOptionalTime(value['modified']),
    url: parseMediaURL(value['url'], 'file URL'),
  };
}

function parseOptionalSize(input: unknown): number | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) {
    throw new Error('Expected a file size in bytes.');
  }
  return input;
}

function parseOptionalTime(input: unknown): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  const time = text(input);
  if (time.length > 64 || Number.isNaN(Date.parse(time))) {
    throw new Error('Expected a time.');
  }
  return time;
}

/**
 * Why a file cannot replace another in place, or undefined when it can. A
 * replacement keeps the old name, path or key, so every reference to it keeps
 * working; it must therefore be the same kind of media (an image for an image),
 * and a file of no media kind must have the same extension, or the name would
 * lie about what it holds.
 */
export function replacementRefusal(currentName: string, replacementName: string): string | undefined {
  return describeReplacementRefusal(currentName, replacementName)?.message;
}

/** `replacementRefusal` with the reference the renderer translates beside the English sentence. */
export function describeReplacementRefusal(currentName: string, replacementName: string): Described | undefined {
  const currentKind = mediaKindOf(currentName);
  const replacementKind = mediaKindOf(replacementName);
  if (currentKind !== replacementKind) {
    const key = REPLACE_KIND_KEYS[currentKind][replacementKind];
    assert(key !== undefined, 'describeReplacementRefusal: every pair of different kinds has a sentence');
    return described(key, { name: currentName });
  }
  if (currentKind === 'file' && extensionOf(currentName) !== extensionOf(replacementName)) {
    const extension = extensionOf(currentName);
    return extension === ''
      ? described('assets.error.replaceExtensionless', { name: currentName })
      : described('assets.error.replaceExtension', { name: currentName, extension });
  }
  return undefined;
}

/** Which sentence says "a <current> must be replaced by a <current>, not a <replacement>": one per pair, since the nouns differ in every language. */
const REPLACE_KIND_KEYS: Readonly<Record<MediaFileKind, Readonly<Partial<Record<MediaFileKind, MessageKey>>>>> = {
  image: { video: 'assets.error.replaceImageNotVideo', audio: 'assets.error.replaceImageNotAudio', file: 'assets.error.replaceImageNotFile' },
  video: { image: 'assets.error.replaceVideoNotImage', audio: 'assets.error.replaceVideoNotAudio', file: 'assets.error.replaceVideoNotFile' },
  audio: { image: 'assets.error.replaceAudioNotImage', video: 'assets.error.replaceAudioNotVideo', file: 'assets.error.replaceAudioNotFile' },
  file: { image: 'assets.error.replaceFileNotImage', video: 'assets.error.replaceFileNotVideo', audio: 'assets.error.replaceFileNotAudio' },
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}
