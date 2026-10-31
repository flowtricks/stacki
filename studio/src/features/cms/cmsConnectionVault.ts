// The Worker's keeping of CMS connections, without Cloudflare types so it can
// be tested anywhere: the list in an object store (R2 in a deployment), each
// key sealed with AES-GCM under a key derived (HKDF) from the Worker's session
// secret, and the forwarding rule that only the Worker ever names a target.
// Routes and permissions are in src/cloudflare/cmsConnectionRoutes.ts.

import {
  CMS_CONNECTION_HEADER,
  CMS_TARGET_HEADER,
  parseStoredConnections,
  sanityTarget,
  type StoredConnection,
} from './cmsConnectionBook';
import { parseConnectionId } from '../../../vendor/stacki/shared/properties/cmsConnections';

/** Where the list is kept: R2 in a deployment. */
export interface VaultStore {
  readonly get: (key: string) => Promise<{ readonly text: () => Promise<string> } | null>;
  readonly put: (key: string, value: string) => Promise<unknown>;
}

export interface Vault {
  readonly store: VaultStore;
  readonly sessionSecret: string;
}

const STORE_KEY = 'cms/connections.json';
const NONCE_BYTES = 12;

/** A connected-CMS call that cannot go ahead, said where the person is looking. */
export class CmsUnavailable extends Error {}

export async function storedConnections(vault: Vault): Promise<StoredConnection[]> {
  const object = await vault.store.get(STORE_KEY);
  if (!object) {
    return [];
  }
  const input: unknown = JSON.parse(await object.text());
  return parseStoredConnections(input);
}

export async function keepConnections(
  vault: Vault,
  entries: readonly StoredConnection[],
): Promise<void> {
  await vault.store.put(STORE_KEY, JSON.stringify(entries));
}

/**
 * The request as the container may see it: never with a client's CMS target,
 * and with ours — the connection's key, decrypted — for a connected-CMS call.
 */
export async function cmsForwarded(request: Request, url: URL, vault: Vault): Promise<Request> {
  const headers = new Headers(request.headers);
  headers.delete(CMS_TARGET_HEADER);
  if (url.pathname.startsWith('/studio/api/cms-remote/')) {
    const id = parseConnectionId(request.headers.get(CMS_CONNECTION_HEADER) ?? '');
    const entry = (await storedConnections(vault)).find((item) => item.connection.id === id);
    if (!entry) {
      throw new CmsUnavailable('This CMS connection was removed. Reconnect it in Settings.');
    }
    const token = await unsealCmsSecret(vault, entry.secret);
    headers.set(CMS_TARGET_HEADER, JSON.stringify(sanityTarget(entry.connection, token)));
  }
  return new Request(request, { headers });
}

/** A key sealed for the store: a fresh nonce, then the ciphertext, in base64. */
export async function sealCmsSecret(vault: Pick<Vault, 'sessionSecret'>, secret: string) {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    await sealingKey(vault.sessionSecret),
    new TextEncoder().encode(secret),
  );
  const out = new Uint8Array(nonce.length + sealed.byteLength);
  out.set(nonce);
  out.set(new Uint8Array(sealed), nonce.length);
  return btoa(String.fromCharCode(...out));
}

// A key that no longer opens — the session secret changed — must be added again.
async function unsealCmsSecret(vault: Vault, sealed: string): Promise<string> {
  const bytes = Uint8Array.from(atob(sealed), (char) => char.charCodeAt(0));
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, NONCE_BYTES) },
      await sealingKey(vault.sessionSecret),
      bytes.slice(NONCE_BYTES),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new CmsUnavailable('This connection’s key can no longer be read. Add it again.');
  }
}

async function sealingKey(sessionSecret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', encoder.encode(sessionSecret), 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('stacki-cms-connections'),
      info: encoder.encode('cms connection keys v1'),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
