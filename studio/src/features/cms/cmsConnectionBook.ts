// A Studio project's CMS connections as they are kept: each public connection
// with its key sealed by whoever keeps it. In a Cloudflare deployment the
// Worker keeps them in R2 with keys encrypted by a key only it derives
// (cmsConnectionRoutes.ts); a local Studio keeps them in the project's
// ignored `.studio` folder (cmsRemoteServer.ts). Either way the same rules
// apply: one connection per CMS target, a bounded number per project, and no
// key ever leaves in a reply.

import {
  CMS_CONNECTION_LIMITS,
  parseCmsConnection,
  parseSanityDataset,
  parseSanityProjectId,
  type CmsConnection,
  type CmsConnectionDraft,
  type CmsConnectionList,
} from '../../../vendor/stacki/shared/properties/cmsConnections';

export interface StoredConnection {
  readonly connection: CmsConnection;
  /** The key, sealed by the keeper; plain only in a local Studio's private file. */
  readonly secret: string;
}

/** The request header the Worker adds to a connected-CMS call: where, and with which key. */
export const CMS_TARGET_HEADER = 'x-stacki-cms-target';
/** The request header the editor names its connection in. */
export const CMS_CONNECTION_HEADER = 'x-stacki-cms-connection';

export interface SanityTarget {
  readonly projectId: string;
  readonly dataset: string;
  readonly token: string;
}

export function parseStoredConnections(input: unknown): StoredConnection[] {
  if (!Array.isArray(input)) {
    throw new Error('CMS connections: expected a list');
  }
  const entries: unknown[] = input;
  if (entries.length > CMS_CONNECTION_LIMITS.connectionsPerProjectMax) {
    throw new Error('CMS connections: too many');
  }
  return entries.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('CMS connections: expected an entry');
    }
    const secret: unknown = Reflect.get(entry, 'secret');
    if (typeof secret !== 'string' || secret.length > CMS_CONNECTION_LIMITS.secretCharsMax * 2) {
      throw new Error('CMS connections: invalid key');
    }
    return { connection: parseCmsConnection(Reflect.get(entry, 'connection')), secret };
  });
}

/** The list with a new connection, replacing one for the same target. */
export function withConnection(
  stored: readonly StoredConnection[],
  draft: CmsConnectionDraft,
  sealed: { readonly id: string; readonly secret: string },
): StoredConnection[] {
  const { secret: _plain, ...fields } = draft;
  const connection = parseCmsConnection({ ...fields, id: sealed.id });
  const others = stored.filter((entry) => !sameTarget(entry.connection, connection));
  if (others.length >= CMS_CONNECTION_LIMITS.connectionsPerProjectMax) {
    throw new Error('This project already has the most CMS connections Stacki keeps.');
  }
  return [...others, { connection, secret: sealed.secret }];
}

export function withoutConnection(
  stored: readonly StoredConnection[],
  id: string,
): StoredConnection[] {
  return stored.filter((entry) => entry.connection.id !== id);
}

/** What the editor sees: connections, never keys. */
export function publicList(stored: readonly StoredConnection[]): CmsConnectionList {
  return { encryption: 'available', connections: stored.map((entry) => entry.connection) };
}

/** A Sanity connection's target with its key, for one request; other kinds are not browsable yet. */
export function sanityTarget(connection: CmsConnection, token: string): SanityTarget {
  if (connection.kind !== 'sanity') {
    throw new Error('Browsing this CMS in Stacki is not available yet.');
  }
  return { projectId: connection.projectId, dataset: connection.dataset, token };
}

export function parseSanityTarget(input: unknown): SanityTarget {
  if (typeof input !== 'object' || input === null) {
    throw new Error('CMS target: expected an object');
  }
  const token: unknown = Reflect.get(input, 'token');
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
    throw new Error('CMS target: invalid key');
  }
  return {
    projectId: parseSanityProjectId(Reflect.get(input, 'projectId')),
    dataset: parseSanityDataset(Reflect.get(input, 'dataset')),
    token,
  };
}

function sameTarget(left: CmsConnection, right: CmsConnection): boolean {
  if (left.kind === 'sanity') {
    return right.kind === 'sanity' && left.projectId === right.projectId
      ? left.dataset === right.dataset
      : false;
  }
  return right.kind === left.kind && 'baseUrl' in right ? right.baseUrl === left.baseUrl : false;
}
