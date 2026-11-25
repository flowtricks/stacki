// A Studio project's media hosting connections as they are kept: each public
// connection with its keys (MediaSecret, as JSON) sealed by whoever keeps them,
// exactly as CMS connections are (src/features/cms/cmsConnectionBook.ts). In a
// Cloudflare deployment the Worker keeps them in R2 with keys encrypted by a key
// only it derives (src/cloudflare/mediaConnectionRoutes.ts) and adds a target
// with the keys to each media call it forwards to the container; a local Studio
// keeps them in a private file in the user's home folder
// (mediaHostingServer.ts). The browser never holds a key.

import {
  MEDIA_HOSTING_LIMITS,
  parseMediaConnection,
  parseMediaSecret,
  type MediaConnection,
  type MediaConnectionDraft,
  type MediaConnectionList,
  type MediaSecret,
} from '../../../vendor/stacki/shared/properties/mediaHosting';

export interface StoredMediaConnection {
  readonly connection: MediaConnection;
  /** The keys as JSON, sealed by the keeper; plain only in a local Studio's private file. */
  readonly secret: string;
}

/** The request header the Worker adds to a media call: which host, with which keys. */
export const MEDIA_TARGET_HEADER = 'x-stacki-media-target';
/** The request header the editor names its connection in. */
export const MEDIA_CONNECTION_HEADER = 'x-stacki-media-connection';

export interface MediaTarget {
  readonly connection: MediaConnection;
  readonly secret: MediaSecret;
}

// Sealed JSON of two bounded keys: nonce, ciphertext and tag, in base64.
const SEALED_CHARS_MAX = 4 * MEDIA_HOSTING_LIMITS.secretCharsMax;

export function parseStoredMediaConnections(input: unknown): StoredMediaConnection[] {
  if (!Array.isArray(input)) {
    throw new Error('Media connections: expected a list');
  }
  const entries: unknown[] = input;
  if (entries.length > MEDIA_HOSTING_LIMITS.connectionsPerProjectMax) {
    throw new Error('Media connections: too many');
  }
  return entries.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('Media connections: expected an entry');
    }
    const secret: unknown = Reflect.get(entry, 'secret');
    if (typeof secret !== 'string' || secret.length === 0 || secret.length > SEALED_CHARS_MAX) {
      throw new Error('Media connections: invalid keys');
    }
    return { connection: parseMediaConnection(Reflect.get(entry, 'connection')), secret };
  });
}

/** The list with a new connection, replacing one for the same bucket or zone. */
export function withMediaConnection(
  stored: readonly StoredMediaConnection[],
  draft: MediaConnectionDraft,
  sealed: { readonly id: string; readonly secret: string },
): StoredMediaConnection[] {
  const connection = parseMediaConnection({ ...draft, id: sealed.id });
  const others = stored.filter((entry) => !sameTarget(entry.connection, connection));
  if (others.length >= MEDIA_HOSTING_LIMITS.connectionsPerProjectMax) {
    throw new Error('This project already has the most media connections Stacki keeps.');
  }
  return [...others, { connection, secret: sealed.secret }];
}

export function withoutMediaConnection(stored: readonly StoredMediaConnection[], id: string): StoredMediaConnection[] {
  return stored.filter((entry) => entry.connection.id !== id);
}

/** What the editor sees: connections, never keys. */
export function publicMediaList(stored: readonly StoredMediaConnection[]): MediaConnectionList {
  return { encryption: 'available', connections: stored.map((entry) => entry.connection) };
}

/** The keys as they are sealed: their JSON. */
export function secretText(secret: MediaSecret): string {
  return JSON.stringify(secret);
}

export function mediaTarget(connection: MediaConnection, plainSecret: string): MediaTarget {
  const input: unknown = JSON.parse(plainSecret);
  return { connection, secret: parseMediaSecret(input) };
}

export function parseMediaTarget(input: unknown): MediaTarget {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Media target: expected an object');
  }
  return {
    connection: parseMediaConnection(Reflect.get(input, 'connection')),
    secret: parseMediaSecret(Reflect.get(input, 'secret')),
  };
}

function sameTarget(left: MediaConnection, right: MediaConnection): boolean {
  if (left.kind === 'r2' && right.kind === 'r2') {
    return left.accountId === right.accountId && left.bucket === right.bucket;
  }
  if (left.kind === 'bunny' && right.kind === 'bunny') {
    return left.storageZone === right.storageZone;
  }
  if (left.kind === 's3' && right.kind === 's3') {
    return left.endpoint === right.endpoint && left.bucket === right.bucket;
  }
  return false;
}
