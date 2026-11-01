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
  const payload = base64(new TextEncoder().encode(JSON.stringify(identity)));
  const signature = await crypto.subtle.sign('HMAC', await key(secret), new TextEncoder().encode(payload));
  return `${payload}.${base64(new Uint8Array(signature))}`;
}
export async function verifySession(token: string, secret: string, audience: Identity['audience']): Promise<Identity | undefined> {
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
    const data = record(JSON.parse(new TextDecoder().decode(decode(payload))));
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
