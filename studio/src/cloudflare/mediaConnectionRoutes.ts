// A deployment's media hosting connections, kept by the Worker as its CMS
// connections are (cmsConnectionRoutes.ts): in R2, each connection's keys
// encrypted under a key derived from the Worker's own session secret, so
// neither R2, the container nor the browser ever holds a usable key at rest.
// Anyone who may edit may use a connection; only GitHub Write or Admin
// collaborators may add or remove one. The Worker cannot try a connection
// before keeping it (the hosts' signing runs in the container); a wrong key
// shows on the panel's first listing instead.

// i18n-ignore-file: HTTP API fallback text on the Studio server: it has no language, and the editor shows its own sentence for a failed request.
import { canEdit } from '../features/auth/repositoryAccess';
import type { Identity } from '../features/auth/session';
import { publicMediaList, secretText, withMediaConnection, withoutMediaConnection } from '../features/assets/mediaConnectionBook';
import { MEDIA_STORE_KEY, storedMediaConnections } from '../features/assets/mediaConnectionVault';
import { sealCmsSecret, type Vault } from '../features/cms/cmsConnectionVault';
import { parseMediaConnectionDraft, parseMediaConnectionId, type MediaConnectionDraft } from '../../vendor/stacki/shared/properties/mediaHosting';
import { parseMediaAccountConnect, parseMediaAccountKey } from '../../vendor/stacki/shared/properties/mediaAccounts';
import { accountConnectionDraft, discoverMediaAccounts } from '../../vendor/stacki/electron/content/media/mediaAccounts';
import type { MediaFetch } from '../../vendor/stacki/electron/content/media/mediaHttp';
import { cmsVault } from './cmsConnectionRoutes';
import { studioError } from './apiResponse';
import type { Environment } from './environment';

const BODY_CHARS_MAX = 64 * 1024;

/** The media connection routes; undefined for any other request. */
export async function mediaConnectionRoute(request: Request, url: URL, environment: Environment, identity: Identity): Promise<Response | undefined> {
  const path = url.pathname;
  if (!path.startsWith('/studio/api/media-connections')) {
    return undefined;
  }
  const vault = cmsVault(environment);
  if (path === '/studio/api/media-connections' && request.method === 'GET') {
    return json(publicMediaList(await storedMediaConnections(vault)));
  }
  if (request.method !== 'POST') {
    return studioError(request, 'Unknown media connection request', 404);
  }
  if (!(await canEdit(identity, { ...environment, EDITOR_ACCESS: 'repository' }, true))) {
    return studioError(request, 'Only Write or Admin collaborators can manage connections.', 403);
  }
  const input = await body(request);
  if (path === '/studio/api/media-connections/save') {
    return save(vault, () => Promise.resolve(parseMediaConnectionDraft(Reflect.get(input, 'draft'))));
  }
  // "Connect with Cloudflare / Bunny" runs here, where connections are kept: the
  // pasted account key is used for these requests and never stored.
  if (path === '/studio/api/media-connections/discover') {
    return json(await answer(() => discoverMediaAccounts(fetcher, parseMediaAccountKey(Reflect.get(input, 'key')))));
  }
  if (path === '/studio/api/media-connections/connect-account') {
    return save(vault, () => accountConnectionDraft(fetcher, parseMediaAccountConnect(Reflect.get(input, 'connect'))));
  }
  if (path === '/studio/api/media-connections/remove') {
    const next = withoutMediaConnection(await storedMediaConnections(vault), parseMediaConnectionId(Reflect.get(input, 'id')));
    await vault.store.put(MEDIA_STORE_KEY, JSON.stringify(next));
    return json(publicMediaList(next));
  }
  return studioError(request, 'Unknown media connection request', 404);
}

const fetcher: MediaFetch = (url, init) => fetch(url, init);

async function answer<T>(run: () => Promise<T>): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: message.slice(0, 900) || 'The host did not answer.' };
  }
}

async function save(vault: Vault, draftOf: () => Promise<MediaConnectionDraft>): Promise<Response> {
  try {
    const draft = await draftOf();
    const sealed = { id: crypto.randomUUID(), secret: await sealCmsSecret(vault, secretText(draft.secret)) };
    const next = withMediaConnection(await storedMediaConnections(vault), draft, sealed);
    await vault.store.put(MEDIA_STORE_KEY, JSON.stringify(next));
    return json({ ok: true, list: publicMediaList(next) });
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
