// Signed links that let a hosted app frame load its own files (issue #80).
//
// The problem: app frames are sandboxed without `allow-same-origin`, so their origin is
// opaque and their subresource requests (app.css, stacki-sdk.js, __stacki/ui.js) carry
// no cookies. Every `/studio/api/*` request needs the `__Host-studio` session cookie, so
// only the entry document, which the editor's own navigation loads, ever arrived.
//
// The design: a signed-in GET of `/studio/api/apps/files/<id>/<file>` redirects to
// `/studio/api/apps/files/<id>/~<expires>.<signature>/<file>`. The frame's relative loads
// then resolve under that prefix and carry the link with them. A request under a link
// is served without a cookie, but only when all of these hold; anything else is the
// same 404, so a probe learns nothing about which check failed:
//   - the method is GET or HEAD;
//   - the signature is an HMAC-SHA-256, checked in constant time by WebCrypto, over a
//     purpose label, this host, this app id and the expiry, each length-prefixed, with
//     a key derived from SESSION_SECRET by HKDF for this purpose alone (never the raw
//     secret, which also signs sessions);
//   - the expiry is a plain decimal count of seconds, in the future, and at most eight
//     hours away (minting never exceeds the session's own expiry either);
//   - the file path is strict: printable ASCII names only, no empty, dot-leading or
//     `..` segment, no slash, backslash, colon, percent or control character after
//     decoding, and no encoded dot, slash, backslash, NUL or percent before it.
// The Worker then asks the container for that app's file with the container token
// alone: no user, no session, no cookie. The container still applies its own checks
// (appsServer.ts serveFile: appFolderRuns, readAppFile and the app's sandboxing CSP).
//
// Threat model. A link grants exactly what the frame's code can already read, its own
// app's bundle, for at most eight hours, to whoever holds the URL. It is bound to one
// host and one app id, so it opens neither another app's folder, the preview host nor
// any other route: the forwarded path is rebuilt from the parsed id and file, never
// passed through. It can leak through the frame itself (the app's code can read
// `location.href` and send it to a host its manifest declares) or through browser
// history; both give back only that app's bundle, which its author already has.
// Responses send `Referrer-Policy: no-referrer` and `Cache-Control: private, no-store`
// so neither outgoing requests nor shared caches carry the signature on. Nothing here
// logs a URL.
//
// Why not make bundle files public instead: a bundle is not guaranteed to be free of
// secrets (a configuration file, a key an author forgot), and a public route would
// serve every installed app's files to anyone, forever, without a session.
import { parseAppId } from '../../vendor/stacki/shared/properties/apps';
import { APP_FILES_PREFIX_PATH } from '../features/apps/appsPaths';

export const APP_FILE_LINK_LIMITS = {
  /** A link outlives neither the session that minted it nor eight hours. */
  lifetimeSecondsMax: 8 * 60 * 60,
  /** The path after the files prefix: id, link and file together. */
  pathCharsMax: 1024,
  /** File path segments under the app folder. */
  segmentsMax: 32,
} as const satisfies Record<string, number>;

/** Domain separation: a MAC for this purpose and version can never verify as any other. */
const LINK_PURPOSE = 'stacki-app-file-link-v1';
const SIGNATURE_BYTES = 32;

/** A path under the app files prefix, as the Worker routes it. */
export type AppFilePath =
  | { readonly kind: 'other' }
  | { readonly kind: 'plain'; readonly id: string; readonly file: string }
  | { readonly kind: 'linked'; readonly id: string; readonly file: string; readonly expiresSeconds: number; readonly signature: string }
  | { readonly kind: 'refused' };

/**
 * Parses a request's pathname (from `new URL`, so dot segments are already resolved).
 * `plain` and `linked` carry `file` re-encoded canonically: decoded once, checked, and
 * encoded again, so the container sees exactly the file that was checked.
 * `refused` is a link-shaped or malformed path that must answer 404; `other` is any
 * path this module does not own, including a plain path with an unusual file name,
 * which keeps its signed-in behaviour unchanged.
 */
export function parseAppFilePath(pathname: string): AppFilePath {
  if (!pathname.startsWith(APP_FILES_PREFIX_PATH)) {
    return { kind: 'other' };
  }
  const rest = pathname.slice(APP_FILES_PREFIX_PATH.length);
  const parts = rest.split('/');
  const linked = parts[1]?.startsWith('~') === true;
  if (rest.length > APP_FILE_LINK_LIMITS.pathCharsMax) {
    return linked ? { kind: 'refused' } : { kind: 'other' };
  }
  const id = appIdOf(parts[0] ?? '');
  if (id === undefined) {
    return linked ? { kind: 'refused' } : { kind: 'other' };
  }
  if (!linked) {
    const file = canonicalFile(parts.slice(1));
    return file === undefined ? { kind: 'other' } : { kind: 'plain', id, file };
  }
  const link = /^~([1-9][0-9]{0,10})\.([A-Za-z0-9_-]{43})$/.exec(parts[1] ?? '');
  const file = canonicalFile(parts.slice(2));
  if (link?.[1] === undefined || link[2] === undefined || file === undefined) {
    return { kind: 'refused' };
  }
  const expiresSeconds = Number(link[1]);
  if (!Number.isSafeInteger(expiresSeconds)) {
    return { kind: 'refused' };
  }
  return { kind: 'linked', id, file, expiresSeconds, signature: link[2] };
}

/** The redirect target for a signed-in load of `file`, or undefined when the session has no time left. */
export async function mintAppFileLink(input: {
  readonly secret: string;
  readonly host: string;
  readonly id: string;
  readonly file: string;
  readonly sessionExpiresMs: number;
  readonly nowMs: number;
}): Promise<string | undefined> {
  const nowSeconds = Math.floor(input.nowMs / 1000);
  const expiresSeconds = Math.min(Math.floor(input.sessionExpiresMs / 1000), nowSeconds + APP_FILE_LINK_LIMITS.lifetimeSecondsMax);
  if (expiresSeconds <= nowSeconds) {
    return undefined;
  }
  assertLinkField(input.host);
  assertLinkField(input.id);
  const key = await linkKey(input.secret, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, linkMessage(input.host, input.id, expiresSeconds)));
  if (signature.length !== SIGNATURE_BYTES) {
    throw new Error('Assertion failed: an app file link signature is 32 bytes');
  }
  const link = `${APP_FILES_PREFIX_PATH}${input.id}/~${expiresSeconds}.${base64URL(signature)}/${input.file}`;
  if (parseAppFilePath(link).kind !== 'linked') {
    throw new Error('Assertion failed: a minted app file link parses as a link');
  }
  return link;
}

/** Whether a parsed link was minted for this host and app and has not expired. */
export async function verifyAppFileLink(input: {
  readonly secret: string;
  readonly host: string;
  readonly link: Extract<AppFilePath, { readonly kind: 'linked' }>;
  readonly nowMs: number;
}): Promise<boolean> {
  const nowSeconds = Math.floor(input.nowMs / 1000);
  const remainingSeconds = input.link.expiresSeconds - nowSeconds;
  const signature = fromBase64URL(input.link.signature);
  if (signature === undefined) {
    return false;
  }
  // The signature is checked even when the expiry already rules the link out, so the
  // work done does not depend on which check fails.
  const key = await linkKey(input.secret, ['verify']);
  const authentic = await crypto.subtle.verify('HMAC', key, signature, linkMessage(input.host, input.link.id, input.link.expiresSeconds));
  if (!authentic) {
    return false;
  }
  if (remainingSeconds <= 0) {
    return false;
  }
  return remainingSeconds <= APP_FILE_LINK_LIMITS.lifetimeSecondsMax;
}

/** The container's own path for a checked app file: rebuilt from parts, never the request's path. */
export function appFileContainerPath(id: string, file: string): string {
  return `${APP_FILES_PREFIX_PATH}${id}/${file}`;
}

function appIdOf(raw: string): string | undefined {
  try {
    return parseAppId(raw);
  } catch {
    return undefined;
  }
}

/** Decoded once, checked, and encoded again; undefined when any segment is not a plain file name. */
function canonicalFile(segments: readonly string[]): string | undefined {
  if (segments.length === 0) {
    return '';
  }
  if (segments.length === 1 && segments[0] === '') {
    return '';
  }
  if (segments.length > APP_FILE_LINK_LIMITS.segmentsMax) {
    return undefined;
  }
  const names: string[] = [];
  for (const segment of segments) {
    const name = fileName(segment);
    if (name === undefined) {
      return undefined;
    }
    names.push(encodeURIComponent(name));
  }
  return names.join('/');
}

function fileName(segment: string): string | undefined {
  // Encodings of a dot, slash, backslash, NUL or percent never name a plain file:
  // they only appear in traversal and double-encoding attempts.
  if (/%(?:2e|2f|5c|00|25)/i.test(segment)) {
    return undefined;
  }
  let name: string;
  try {
    name = decodeURIComponent(segment);
  } catch {
    return undefined;
  }
  // Printable ASCII without separators, so no normalization can turn a name into a path.
  if (!/^[A-Za-z0-9 _~!$&'()+,=@.-]+$/.test(name)) {
    return undefined;
  }
  if (name.startsWith('.')) {
    return undefined;
  }
  return name;
}

async function linkKey(secret: string, usages: readonly ('sign' | 'verify')[]): Promise<CryptoKey> {
  if (secret.length < 32) {
    throw new Error('SESSION_SECRET must have at least 32 characters');
  }
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(LINK_PURPOSE) },
    material,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    [...usages],
  );
}

/** `purpose`, then each field as `<length>:<value>` on its own line: no two inputs encode alike. */
function linkMessage(host: string, id: string, expiresSeconds: number) {
  const field = (value: string) => `${value.length}:${value}`;
  return new TextEncoder().encode([LINK_PURPOSE, field(host.toLowerCase()), field(id), field(String(expiresSeconds))].join('\n'));
}

function assertLinkField(value: string): void {
  if (value.length === 0) {
    throw new Error('Assertion failed: an app file link field is not empty');
  }
  if (value.includes('\n')) {
    throw new Error('Assertion failed: an app file link field is one line');
  }
}

function base64URL(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64URL(value: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (character) => character.charCodeAt(0));
    return bytes.length === SIGNATURE_BYTES ? bytes : undefined;
  } catch {
    return undefined;
  }
}
