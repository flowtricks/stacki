// The CMS panel's connected-CMS calls, answered by the Studio server with the
// same service Desktop uses (electron/content/cmsRemoteService.ts), reading the
// site's schema code from this project.
//
// Where the key comes from depends on how Studio runs:
//   Deployed  the Worker keeps connections and adds the target with its key to
//             each call (cmsConnectionRoutes.ts); it is trusted only on a
//             request carrying the container token, so nothing else can name one.
//   Local     there is no Worker: this server keeps the project's connections in
//             the user's home folder (~/.stacki/studio-cms/<project>.json), private
//             to them (0600) and outside every repository, so a key can never be
//             committed with the site; it answers the connection routes itself.

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  cmsFailureMessage,
  cmsRemoteService,
  type CmsRemoteService,
} from '../../../vendor/stacki/electron/content/cmsRemoteService';
import { SANITY_UPLOAD_BYTES_MAX } from '../../../vendor/stacki/electron/content/sanityUpload';
import {
  parseCmsConnectionDraft,
  parseConnectionId,
} from '../../../vendor/stacki/shared/properties/cmsConnections';
import {
  parseRemoteAssetKind,
  parseRemoteCollectionName,
  parseRemoteDocumentAction,
  parseRemoteDocumentId,
  parseRemoteIds,
  parseRemoteMove,
  parseRemoteRevisionId,
  parseRemoteTypes,
  parseRemoteWrite,
} from '../../../vendor/stacki/shared/properties/cmsRemote';
import {
  CMS_CONNECTION_HEADER,
  CMS_TARGET_HEADER,
  parseSanityTarget,
  parseStoredConnections,
  publicList,
  sanityTarget,
  withConnection,
  withoutConnection,
  type SanityTarget,
  type StoredConnection,
} from './cmsConnectionBook';
import { record } from '../../shared/validation';

type Operation = (service: CmsRemoteService, input: Record<string, unknown>) => Promise<unknown>;

// Each call by name, its input parsed at this boundary before it reaches the service.
const OPERATIONS: Readonly<Record<string, Operation>> = {
  collections: (service) => service.collections(),
  documents: (service, input) => service.documents(parseRemoteCollectionName(input['collection'])),
  create: (service, input) => service.create(parseRemoteCollectionName(input['collection'])),
  delete: (service, input) => service.remove(parseRemoteIds(input['ids'])),
  move: (service, input) => service.move(parseRemoteMove(input['move'])),
  document: (service, input) => service.document(parseRemoteDocumentId(input['id'])),
  write: (service, input) => service.write(parseRemoteWrite(input['write'])),
  act: (service, input) =>
    service.act(parseRemoteDocumentId(input['id']), parseRemoteDocumentAction(input['action'])),
  history: (service, input) => service.history(parseRemoteDocumentId(input['id'])),
  restore: (service, input) =>
    service.restore(parseRemoteDocumentId(input['id']), parseRemoteRevisionId(input['revision'])),
  references: (service, input) => service.references(parseRemoteTypes(input['types'])),
};

export function cmsRemoteRoutes(root: string) {
  const deployed = Boolean(process.env['STUDIO_CONTAINER_TOKEN']);
  const local = new LocalConnections(root);
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
    readBody: () => Promise<string>,
  ): Promise<boolean> => {
    if (!deployed && pathname.startsWith('/studio/api/cms-connections')) {
      send(response, await local.route(request, pathname, readBody));
      return true;
    }
    const operation = /^\/studio\/api\/cms-remote\/([a-z]+)$/.exec(pathname)?.[1];
    if (operation === undefined || request.method !== 'POST') {
      return false;
    }
    try {
      const target = deployed ? trustedTarget(request) : local.target(request);
      const service = cmsRemoteService(root, target);
      const value =
        operation === 'upload'
          ? await upload(service, request)
          : await run(service, operation, await readBody());
      send(response, { ok: true, value });
    } catch (error) {
      send(response, { ok: false, message: cmsFailureMessage(error).slice(0, 900) });
    }
    return true;
  };
}

async function run(service: CmsRemoteService, operation: string, text: string) {
  const call = Object.hasOwn(OPERATIONS, operation) ? OPERATIONS[operation] : undefined;
  if (call === undefined) {
    throw new Error('Unknown CMS operation');
  }
  return call(service, record(JSON.parse(text)));
}

// An upload is the file's bytes, with its kind and name in the address.
async function upload(service: CmsRemoteService, request: IncomingMessage) {
  const url = new URL(request.url ?? '/', 'http://studio');
  const kind = parseRemoteAssetKind(url.searchParams.get('kind'));
  const name = path.basename(url.searchParams.get('filename') ?? 'upload').slice(0, 200);
  const bytes = await bodyBytes(request, SANITY_UPLOAD_BYTES_MAX);
  return service.upload(kind, { name, bytes });
}

// Only a request the Worker forwarded carries the container token; only then is
// the target it added believed.
function trustedTarget(request: IncomingMessage): SanityTarget {
  const token = process.env['STUDIO_CONTAINER_TOKEN'];
  if (!token || request.headers['x-studio-token'] !== token) {
    throw new Error('This CMS call did not come through Studio.');
  }
  const header = request.headers[CMS_TARGET_HEADER];
  if (typeof header !== 'string') {
    throw new Error('This CMS connection was removed. Reconnect it in Settings.');
  }
  const input: unknown = JSON.parse(header);
  return parseSanityTarget(input);
}

/** A local Studio's connections, in the user's home folder, one file per project. */
class LocalConnections {
  private readonly file: string;

  constructor(root: string, home = os.homedir()) {
    const project = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 24);
    this.file = path.join(home, '.stacki', 'studio-cms', `${project}.json`);
  }

  async route(request: IncomingMessage, pathname: string, readBody: () => Promise<string>) {
    if (pathname === '/studio/api/cms-connections' && request.method === 'GET') {
      return publicList(this.read());
    }
    const input = record(JSON.parse(await readBody()));
    if (pathname === '/studio/api/cms-connections/remove') {
      const next = withoutConnection(this.read(), parseConnectionId(input['id']));
      this.write(next);
      return publicList(next);
    }
    if (pathname !== '/studio/api/cms-connections/save') {
      throw new Error('Unknown CMS connection request');
    }
    try {
      const draft = parseCmsConnectionDraft(input['draft']);
      const next = withConnection(this.read(), draft, { id: randomUUID(), secret: draft.secret });
      this.write(next);
      return { ok: true, list: publicList(next) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: message.slice(0, 900) || 'Could not save the connection.' };
    }
  }

  target(request: IncomingMessage): SanityTarget {
    const id = parseConnectionId(request.headers[CMS_CONNECTION_HEADER] ?? '');
    const entry = this.read().find((item) => item.connection.id === id);
    if (!entry) {
      throw new Error('This CMS connection was removed. Reconnect it in Settings.');
    }
    return sanityTarget(entry.connection, entry.secret);
  }

  private read(): StoredConnection[] {
    if (!fs.existsSync(this.file)) {
      return [];
    }
    const input: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    return parseStoredConnections(input);
  }

  private write(entries: readonly StoredConnection[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}

async function bodyBytes(request: IncomingMessage, maximum: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const input of request) {
    const value: unknown = input;
    if (!Buffer.isBuffer(value)) {
      throw new Error('Invalid upload');
    }
    size += value.length;
    if (size > maximum) {
      throw new Error('This file is larger than 100 MB.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function send(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}
