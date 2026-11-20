// Goal: strict base64url, the encoding of every JWT segment and WebAuthn value this folder reads.
// Why strict: `atob` accepts padding, whitespace and the standard alphabet, so two different texts could decode to the same
// bytes. A signature check over text that decodes loosely is a check over something the sender did not sign.
// Every decode names the largest result it accepts (AGENTS.md §10).
const URL_SAFE = /^[A-Za-z0-9_-]*$/;

export function encodeBase64url(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** The bytes `text` stands for, or undefined when it is not canonical unpadded base64url or decodes past `bytesMax`. */
export function decodeBase64url(text: string, bytesMax: number): Uint8Array<ArrayBuffer> | undefined {
  if (!URL_SAFE.test(text) || text.length % 4 === 1 || Math.ceil((text.length * 3) / 4) > bytesMax + 3) {
    return undefined;
  }
  let binary: string;
  try {
    binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  } catch {
    return undefined;
  }
  if (binary.length > bytesMax) {
    return undefined;
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  // Canonical form only: leftover bits in the last character must be zero, so one byte string has one text.
  return encodeBase64url(bytes) === text ? bytes : undefined;
}

export function utf8Bytes(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

/** Compares two texts without stopping at the first difference. */
export function sameText(left: string, right: string): boolean {
  const a = utf8Bytes(left);
  const b = utf8Bytes(right);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/** A key derived from `secret` for one purpose, so a value made for one use is worthless for another. */
export async function hmacSha256(secret: string, label: string): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', utf8Bytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8Bytes(label)));
}

/** A random token of `byteCount` bytes as base64url. */
export function randomToken(byteCount: number): string {
  return encodeBase64url(crypto.getRandomValues(new Uint8Array(byteCount)));
}
