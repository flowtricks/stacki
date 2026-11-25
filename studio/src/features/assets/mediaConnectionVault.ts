// The Worker's keeping of media hosting connections, without Cloudflare types so
// it can be tested anywhere (as cmsConnectionVault.ts is for CMS connections):
// the list in the Worker's object store, each connection's keys sealed with the
// CMS sealing key, and the forwarding rule that only the Worker ever names a
// target. Routes and permissions are in src/cloudflare/mediaConnectionRoutes.ts.

import { MEDIA_CONNECTION_HEADER, MEDIA_TARGET_HEADER, mediaTarget, parseStoredMediaConnections, type StoredMediaConnection } from './mediaConnectionBook';
import { CmsUnavailable, unsealCmsSecret, type Vault } from '../cms/cmsConnectionVault';
import { parseMediaConnectionId } from '../../../vendor/stacki/shared/properties/mediaHosting';

export const MEDIA_STORE_KEY = 'media/connections.json';

export async function storedMediaConnections(vault: Vault): Promise<StoredMediaConnection[]> {
  const object = await vault.store.get(MEDIA_STORE_KEY);
  if (!object) {
    return [];
  }
  const input: unknown = JSON.parse(await object.text());
  return parseStoredMediaConnections(input);
}

/**
 * The request as the container may see it: never with a client's media
 * target, and with ours — the connection and its keys, decrypted — for a
 * media hosting call.
 */
export async function mediaForwarded(request: Request, url: URL, vault: Vault): Promise<Request> {
  const headers = new Headers(request.headers);
  headers.delete(MEDIA_TARGET_HEADER);
  if (url.pathname.startsWith('/studio/api/media-hosting/')) {
    const id = parseMediaConnectionId(request.headers.get(MEDIA_CONNECTION_HEADER) ?? '');
    const entry = (await storedMediaConnections(vault)).find((item) => item.connection.id === id);
    if (!entry) {
      throw new CmsUnavailable('This media connection was removed. Connect it again in the Assets panel.');
    }
    headers.set(MEDIA_TARGET_HEADER, JSON.stringify(mediaTarget(entry.connection, await unsealCmsSecret(vault, entry.secret))));
  }
  return new Request(request, { headers });
}
