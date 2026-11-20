import { record, string } from '../../shared/validation';

export interface Identity {
  readonly id: number;
  readonly login: string;
  readonly expires: number;
  readonly audience: 'studio' | 'preview' | 'login';
}
function base64(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (character) => character.charCodeAt(0));
}
async function key(secret: string) {
  if (secret.length < 32) {
    throw new Error('SESSION_SECRET must have at least 32 characters');
  }
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function signSession(identity: Identity, secret: string): Promise<string> {
  return signClaims(identity, secret);
}
// The signed envelope itself, shared by the GitHub sessions above and the provider-neutral ones
// (principalSession.ts). Only core calls these two: a provider never sees the session secret.
export async function signClaims(claims: object, secret: string): Promise<string> {
  const payload = base64(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign('HMAC', await key(secret), new TextEncoder().encode(payload));
  return `${payload}.${base64(new Uint8Array(signature))}`;
}
// The payload of a token whose signature verifies, or undefined. Expiry and audience are the caller's to check.
export async function verifyClaims(token: string, secret: string): Promise<Record<string, unknown> | undefined> {
  if (token.length > 4096) {
    return undefined;
  }
  const [payload, signature] = token.split('.');
  if (!payload || !signature) {
    return undefined;
  }
  try {
    if (!(await crypto.subtle.verify('HMAC', await key(secret), decode(signature), new TextEncoder().encode(payload)))) {
      return undefined;
    }
    return record(JSON.parse(new TextDecoder().decode(decode(payload))));
  } catch {
    return undefined;
  }
}
export async function verifySession(token: string, secret: string, audience: Identity['audience']): Promise<Identity | undefined> {
  const data = await verifyClaims(token, secret);
  if (!data) {
    return undefined;
  }
  try {
    if (typeof data['id'] !== 'number' || !Number.isSafeInteger(data['id']) || data['id'] < 1) {
      return undefined;
    }
    if (typeof data['expires'] !== 'number' || data['expires'] < Date.now() || data['audience'] !== audience) {
      return undefined;
    }
    return {
      id: data['id'],
      login: string(data['login'], 100),
      expires: data['expires'],
      audience,
    };
  } catch {
    return undefined;
  }
}
export function cookie(request: Request, name: string): string {
  const items = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim());
  return items.find((item) => item.startsWith(name + '='))?.slice(name.length + 1) ?? '';
}
export function sessionCookie(name: string, token: string, seconds: number) {
  return `${name}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`;
}

// The preview host's cookie. The preview is a frame inside the editor, and on a platform domain such as
// workers.dev the two hosts are different sites, so the frame's cookie is a third-party one. A browser
// refuses to set a `SameSite=Lax` cookie from a cross-site frame's response: the entry redirect then set
// nothing, the page request carried no session, the frame loaded an error document, and the editor script
// never ran (the loader's "has not answered"). `SameSite=None` allows the cross-site context; `Partitioned`
// keys the cookie to the editor's site, so it is sent only inside this editor's frame and survives the
// browser's third-party cookie blocking.
export function previewSessionCookie(name: string, token: string, seconds: number) {
  return `${name}=${token}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${seconds}`;
}
