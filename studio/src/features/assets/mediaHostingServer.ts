// The Assets panel's media hosting calls, answered by the Studio server with the
// same service Desktop's main process uses (vendor electron/content/media:
// the SigV4 signer, the R2/S3 and Bunny adapters, the folder order manifest).
// Every network call to a host runs here, never in the browser.
//
// Where the keys come from depends on how Studio runs, as for CMS connections
// (src/features/cms/cmsRemoteServer.ts):
//   Deployed  the Worker keeps connections and adds the target with its keys to
//             each call (src/cloudflare/mediaConnectionRoutes.ts); it is trusted
//             only on a request carrying the container token.
//   Local     there is no Worker: this server keeps the project's connections in
//             the user's home folder (~/.stacki/studio-media/<project>.json),
//             private to them (0600) and outside every repository, and answers
//             the connection routes itself.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  parseMediaConnectionDraft,
  parseMediaConnectionId,
  parseMediaFolder,
  parseMediaName,
  parseMediaOrder,
  type MediaResult,
} from '../../../vendor/stacki/shared/properties/mediaHosting';
import { MEDIA_HTTP_LIMITS, type MediaFetch } from '../../../vendor/stacki/electron/content/media/mediaHttp';
import { mediaService, type MediaService } from '../../../vendor/stacki/electron/content/media/mediaService';
import { storeFor } from '../../../vendor/stacki/electron/content/media/mediaStore';
import { accountConnectionDraft, discoverMediaAccounts } from '../../../vendor/stacki/electron/content/media/mediaAccounts';
import { parseMediaAccountConnect, parseMediaAccountKey } from '../../../vendor/stacki/shared/properties/mediaAccounts';
import {
  MEDIA_CONNECTION_HEADER,
  MEDIA_TARGET_HEADER,
  mediaTarget,
  parseMediaTarget,
  parseStoredMediaConnections,
  publicMediaList,
  secretText,
  withMediaConnection,
  withoutMediaConnection,
  type MediaTarget,
  type StoredMediaConnection,
} from './mediaConnectionBook';
import { record } from '../../shared/validation';

const MESSAGE_CHARS_MAX = 900;

type Operation = (service: MediaService, folder: string, input: Record<string, unknown>) => Promise<unknown>;

function entryKind(input: unknown): 'file' | 'folder' {
  if (input === 'file' || input === 'folder') {
    return input;
  }
  throw new Error('Expected a media entry kind');
}

// Each JSON call by name, its input parsed at this boundary before it reaches the service.
const OPERATIONS: Readonly<Record<string, Operation>> = {
  list: (service, folder) => service.list(folder),
  createFolder: (service, folder, input) => service.createFolder(folder, parseMediaName(input['name'])),
  rename: (service, folder, input) =>
    service.rename(folder, { entry: entryKind(input['entry']), from: parseMediaName(input['from']), to: parseMediaName(input['to']) }),
  delete: (service, folder, input) => service.remove(folder, { entry: entryKind(input['entry']), name: parseMediaName(input['name']) }),
  reorder: (service, folder, input) => service.reorder(folder, parseMediaOrder(input['order'])),
};

export interface MediaHostingOptions {
  readonly fetch?: MediaFetch;
  /** Where a local Studio keeps connections; the user's home folder by default. */
  readonly home?: string;
}

export function mediaHostingRoutes(root: string, options: MediaHostingOptions = {}) {
  const deployed = Boolean(process.env['STUDIO_CONTAINER_TOKEN']);
  const fetcher: MediaFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const storeOptions = { fetch: fetcher, now: () => new Date() };
  const local = new LocalMediaConnections(root, options.home ?? os.homedir());
  const serviceOf = (target: MediaTarget) => mediaService(storeFor(target.connection, target.secret, storeOptions));
  return async (request: IncomingMessage, response: ServerResponse, pathname: string, readBody: () => Promise<string>): Promise<boolean> => {
    if (!deployed && pathname.startsWith('/studio/api/media-connections')) {
      send(response, await local.route(request, pathname, readBody, { serviceOf, fetch: fetcher }));
      return true;
    }
    const operation = /^\/studio\/api\/media-hosting\/([a-zA-Z]+)$/.exec(pathname)?.[1];
    if (operation === undefined || request.method !== 'POST') {
      return false;
    }
    send(
      response,
      await attempt(async () => {
        const service = serviceOf(deployed ? trustedTarget(request) : local.target(request));
        if (operation === 'upload' || operation === 'replace') {
          return transfer(service, operation, request);
        }
        const call = Object.hasOwn(OPERATIONS, operation) ? OPERATIONS[operation] : undefined;
        if (call === undefined) {
          throw new Error('Unknown media hosting operation');
        }
        const input = record(JSON.parse(await readBody()));
        return call(service, parseMediaFolder(input['folder']), input);
      }),
    );
    return true;
  };
}

// An upload or a replacement is one file's bytes, with its folder and names in the address.
async function transfer(service: MediaService, operation: 'upload' | 'replace', request: IncomingMessage) {
  const url = new URL(request.url ?? '/', 'http://studio');
  const folder = parseMediaFolder(url.searchParams.get('folder') ?? '');
  const filename = parseMediaName(path.basename(url.searchParams.get('filename') ?? ''));
  const bytes = await bodyBytes(request, MEDIA_HTTP_LIMITS.fileBytesMax);
  if (operation === 'upload') {
    return service.upload(folder, [{ name: filename, bytes }]);
  }
  return service.replace(folder, parseMediaName(url.searchParams.get('name')), { name: filename, bytes });
}

// Only a request the Worker forwarded carries the container token; only then is
// the target it added believed.
function trustedTarget(request: IncomingMessage): MediaTarget {
  const token = process.env['STUDIO_CONTAINER_TOKEN'];
  if (!token || request.headers['x-studio-token'] !== token) {
    throw new Error('This media call did not come through Studio.');
  }
  const header = request.headers[MEDIA_TARGET_HEADER];
  if (typeof header !== 'string') {
    throw new Error('This media connection was removed. Connect it again in the Assets panel.');
  }
  const input: unknown = JSON.parse(header);
  return parseMediaTarget(input);
}

/** A local Studio's media connections, in the user's home folder, one file per project. */
export class LocalMediaConnections {
  private readonly file: string;

  constructor(root: string, home: string) {
    const project = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 24);
    this.file = path.join(home, '.stacki', 'studio-media', `${project}.json`);
  }

  async route(
    request: IncomingMessage,
    pathname: string,
    readBody: () => Promise<string>,
    host: { readonly serviceOf: (target: MediaTarget) => MediaService; readonly fetch: MediaFetch },
  ) {
    if (pathname === '/studio/api/media-connections' && request.method === 'GET') {
      return publicMediaList(this.read());
    }
    const input = record(JSON.parse(await readBody()));
    if (pathname === '/studio/api/media-connections/remove') {
      const next = withoutMediaConnection(this.read(), parseMediaConnectionId(input['id']));
      this.write(next);
      return publicMediaList(next);
    }
    // "Connect with Cloudflare / Bunny": the pasted account key, used here and never kept.
    if (pathname === '/studio/api/media-connections/discover') {
      return attempt(() => discoverMediaAccounts(host.fetch, parseMediaAccountKey(input['key'])));
    }
    const connectAccount = pathname === '/studio/api/media-connections/connect-account';
    if (pathname !== '/studio/api/media-connections/save' && !connectAccount) {
      throw new Error('Unknown media connection request');
    }
    const saved = await attempt(async () => {
      const draft = connectAccount
        ? await accountConnectionDraft(host.fetch, parseMediaAccountConnect(input['connect']))
        : parseMediaConnectionDraft(input['draft']);
      const id = randomUUID();
      const next = withMediaConnection(this.read(), draft, { id, secret: secretText(draft.secret) });
      const added = next.find((entry) => entry.connection.id === id);
      if (added === undefined) {
        throw new Error('The connection was not kept.');
      }
      // A connection is tried before it is kept, so a typo shows now, not at first use.
      await host.serviceOf(mediaTarget(added.connection, added.secret)).list('');
      this.write(next);
      return publicMediaList(next);
    });
    return saved.ok ? { ok: true, list: saved.value } : saved;
  }

  target(request: IncomingMessage): MediaTarget {
    const id = parseMediaConnectionId(request.headers[MEDIA_CONNECTION_HEADER] ?? '');
    const entry = this.read().find((item) => item.connection.id === id);
    if (!entry) {
      throw new Error('This media connection was removed. Connect it again in the Assets panel.');
    }
    return mediaTarget(entry.connection, entry.secret);
  }

  private read(): StoredMediaConnection[] {
    if (!fs.existsSync(this.file)) {
      return [];
    }
    const input: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    return parseStoredMediaConnections(input);
  }

  private write(entries: readonly StoredMediaConnection[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}

// Expected failures — offline, a revoked key, a name taken — are answers the panel shows.
async function attempt<T>(run: () => Promise<T>): Promise<MediaResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: message.slice(0, MESSAGE_CHARS_MAX) || 'The media host did not answer.' };
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
      throw new Error(`This file is larger than ${maximum / 1024 / 1024} MB.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function send(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}
