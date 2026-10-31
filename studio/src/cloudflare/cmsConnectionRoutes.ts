// A deployment's CMS connections, kept by the Worker (cmsConnectionVault.ts):
// in R2, each key encrypted under a key derived from the Worker's own session
// secret, so neither R2, the container nor the browser ever holds a usable key
// at rest. Anyone who may edit may use a connection; only GitHub Write or Admin
// collaborators may add or remove one, checked afresh here. Changing
// SESSION_SECRET makes saved keys unreadable; they must then be added again.

import { canEdit } from '../features/auth/repositoryAccess';
import type { Identity } from '../features/auth/session';
import { publicList, withConnection, withoutConnection } from '../features/cms/cmsConnectionBook';
import {
  keepConnections,
  sealCmsSecret,
  storedConnections,
  type Vault,
} from '../features/cms/cmsConnectionVault';
import {
  parseCmsConnectionDraft,
  parseConnectionId,
} from '../../vendor/stacki/shared/properties/cmsConnections';
import { studioError } from './apiResponse';
import type { Environment } from './environment';

const BODY_CHARS_MAX = 64 * 1024;

/** The Worker's vault: its R2 bucket and its session secret. */
export function cmsVault(environment: Environment): Vault {
  return { store: environment.DRAFTS, sessionSecret: environment.SESSION_SECRET };
}

/** The connection routes; undefined for any other request. */
export async function cmsConnectionRoute(
  request: Request,
  url: URL,
  environment: Environment,
  identity: Identity,
): Promise<Response | undefined> {
  const path = url.pathname;
  if (!path.startsWith('/studio/api/cms-connections')) {
    return undefined;
  }
  const vault = cmsVault(environment);
  if (path === '/studio/api/cms-connections' && request.method === 'GET') {
    return json(publicList(await storedConnections(vault)));
  }
  if (request.method !== 'POST') {
    return studioError(request, 'Unknown CMS connection request', 404);
  }
  if (!(await canEdit(identity, { ...environment, EDITOR_ACCESS: 'repository' }, true))) {
    return studioError(request, 'Only Write or Admin collaborators can manage connections.', 403);
  }
  const input = await body(request);
  if (path === '/studio/api/cms-connections/save') {
    return save(vault, input);
  }
  if (path === '/studio/api/cms-connections/remove') {
    const id = parseConnectionId(Reflect.get(input, 'id'));
    const next = withoutConnection(await storedConnections(vault), id);
    await keepConnections(vault, next);
    return json(publicList(next));
  }
  return studioError(request, 'Unknown CMS connection request', 404);
}

async function save(vault: Vault, input: object): Promise<Response> {
  try {
    const draft = parseCmsConnectionDraft(Reflect.get(input, 'draft'));
    const sealed = { id: crypto.randomUUID(), secret: await sealCmsSecret(vault, draft.secret) };
    const next = withConnection(await storedConnections(vault), draft, sealed);
    await keepConnections(vault, next);
    return json({ ok: true, list: publicList(next) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, message: message.slice(0, 900) || 'Could not save the connection.' });
  }
}

async function body(request: Request): Promise<object> {
  const text = await request.text();
  if (text.length > BODY_CHARS_MAX) {
    throw new Error('Request is too large');
  }
  const input: unknown = JSON.parse(text);
  if (typeof input !== 'object' || input === null) {
    throw new Error('Expected an object');
  }
  return input;
}

function json(value: unknown): Response {
  return Response.json(value, { headers: { 'Cache-Control': 'no-store' } });
}
