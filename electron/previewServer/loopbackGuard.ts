// Stacki's own routes on the project's dev server answer this computer only.
//
// The dev server normally listens on 127.0.0.1, where only this computer can reach it. With the
// preview open on the local network (devServers.ts, `--host 0.0.0.0`) every device on the Wi-Fi can,
// and the dev server carries more than the site: the editor's control routes (`/__avb/*`: touch a
// file, reload the canvas, refresh content, run a module's export, sample collection data), the local
// Studio at `/studio`, and Vite's `/__open-in-editor`, which opens a file in this computer's editor.
// A phone needs none of them; it gets the site, exactly as `astro dev --host` would serve it.
//
// So every one of those routes is refused, with 403, unless
//   - the connection comes from loopback (the socket's own remote address, which a client cannot
//     choose: 127.0.0.0/8, ::1, or either written as an IPv4-mapped IPv6 address), and
//   - the Host header names loopback (localhost, 127.0.0.1, [::1]), and
//   - an Origin header, when the request carries one, names loopback too.
// The header checks stop a page on another site from reaching these routes through this computer's
// own browser by a DNS name that resolves to 127.0.0.1 (DNS rebinding); the socket check stops the
// rest of the network. All three hold in both modes: on loopback alone they cost nothing, since every
// request the app makes already passes them.
//
// A request from the network to any other route is the site, and passes, unless the person chose that only
// the devices that scanned the code may open it (shared/ipc/devNetwork.ts). Then main starts the server with
// a random key in its environment, and a request from the network to the site passes only
//   - with the key in its query (the code's address): it is answered with a cookie holding the key and a
//     redirect to the same page without it, so the key does not stay in the address bar or the history, or
//   - with that cookie.
// Anything else from the network is refused with 403, and so is Vite's live-reload WebSocket, which never
// reaches a middleware (loopbackGuardUpgrade). This computer always passes: the canvas never needs a key.
// The hover-preview header (previewMarkers.ts variantScopeMiddleware) is honoured from loopback only, so a
// device on the network renders the page as written, never an override.
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { assert } from '../../shared/core/assert';
import { PREVIEW_KEY_COOKIE, PREVIEW_KEY_ENV, PREVIEW_KEY_PARAM, toPreviewKey, type PreviewKey } from '../../shared/ipc/devNetwork';

/** Paths only this computer may use: the editor's control routes, the local Studio and Vite's editor launcher. */
export const LOOPBACK_ONLY_PREFIXES = ['/__avb', '/studio', '/__open-in-editor'] as const;

// A Host or Origin header longer than this is not one this app sends.
const HEADER_CHARS_MAX = 512;
// A Cookie header past this is read as holding no key; the cookies before the bound are all a device needs.
const COOKIE_HEADER_CHARS_MAX = 8192;
const COOKIES_MAX = 64;

/** The key main started this server with, or undefined while anyone on the network may open the preview. */
const SERVER_KEY = previewKeyOf(process.env[PREVIEW_KEY_ENV]);

/** Whether `remote`, a socket's remote address, is this computer. */
export function isLoopbackAddress(remote: string | undefined): boolean {
  if (remote === undefined) {
    return false;
  }
  const address = remote.toLowerCase();
  if (address === '::1' || address === '0:0:0:0:0:0:0:1') {
    return true;
  }
  // An IPv4 address on a dual-stack socket arrives as ::ffff:127.0.0.1.
  const mapped = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(mapped);
}

/** Whether a Host header (`127.0.0.1:4321`, `localhost`, `[::1]:4321`) names this computer. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined || host.length === 0 || host.length > HEADER_CHARS_MAX) {
    return false;
  }
  const hostname = hostnameOf(host.toLowerCase());
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return true;
  }
  if (hostname === '[::1]') {
    return true;
  }
  return /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(hostname);
}

/** Whether an Origin header is absent or names this computer. `null` (a sandboxed or file page) is not this computer. */
export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (origin === undefined) {
    return true;
  }
  if (origin.length > HEADER_CHARS_MAX) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    return isLoopbackHost(parsed.host);
  }
  return false;
}

/** Whether `url`, a request's path and query, is one of the routes only this computer may use. */
export function isLoopbackOnlyRoute(url: string | undefined): boolean {
  const path = (url ?? '/').split('?')[0] ?? '/';
  // Percent-encoding and doubled slashes must not walk around the prefix check.
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return true; // A path that does not decode is refused rather than guessed at.
  }
  const normalized = decoded.replace(/\/{2,}/g, '/').toLowerCase();
  return LOOPBACK_ONLY_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(prefix + '/') || normalized.startsWith(prefix + '?'));
}

/**
 * The verdict on one request: whether it may continue, or, for the code's address, be let in with the cookie
 * and sent to `location`, the same page without the key.
 */
export type LoopbackVerdict =
  | { readonly kind: 'pass' }
  | { readonly kind: 'admit'; readonly location: string }
  | { readonly kind: 'refuse'; readonly reason: 'remote' | 'host' | 'origin' | 'key' };

export interface GuardedRequest {
  readonly url: string | undefined;
  readonly method: string | undefined;
  readonly remoteAddress: string | undefined;
  readonly host: string | undefined;
  readonly origin: string | undefined;
  readonly cookie: string | undefined;
  /** The server's key, or undefined while anyone on the network may open the preview. */
  readonly key: PreviewKey | undefined;
}

/** Pure: what the guard decides for a request with these properties. */
export function judgeRequest(request: GuardedRequest): LoopbackVerdict {
  if (!isLoopbackOnlyRoute(request.url)) {
    return judgeSiteRequest(request);
  }
  if (!isLoopbackAddress(request.remoteAddress)) {
    return { kind: 'refuse', reason: 'remote' };
  }
  if (!isLoopbackHost(request.host)) {
    return { kind: 'refuse', reason: 'host' };
  }
  if (!isLoopbackOrigin(request.origin)) {
    return { kind: 'refuse', reason: 'origin' };
  }
  return { kind: 'pass' };
}

/**
 * Pure: the site's routes, which pass unless the server has a key. With one, this computer passes, the code's
 * address (a GET or HEAD carrying the key) is admitted, a device with the cookie passes, and the rest is refused.
 */
export function judgeSiteRequest(request: GuardedRequest): LoopbackVerdict {
  const key = request.key;
  if (key === undefined) {
    return { kind: 'pass' };
  }
  if (isLoopbackAddress(request.remoteAddress)) {
    return { kind: 'pass' }; // This computer: the canvas, thumbnails and main never need the key.
  }
  const url = new URL(request.url ?? '/', 'http://preview.invalid');
  const given = url.searchParams.get(PREVIEW_KEY_PARAM) ?? undefined;
  if (given !== undefined && sameKey(given, key)) {
    if (request.method === 'GET' || request.method === 'HEAD') {
      url.searchParams.delete(PREVIEW_KEY_PARAM);
      const location = `${url.pathname}${url.search}`;
      assert(location.startsWith('/'), 'judgeSiteRequest: the redirect stays on this server');
      return { kind: 'admit', location };
    }
  }
  if (cookieKeys(request.cookie).some((value) => sameKey(value, key))) {
    return { kind: 'pass' };
  }
  return { kind: 'refuse', reason: 'key' };
}

/** The guard's two halves for a server started with `key` (or none): the middleware and the `upgrade` listener. */
export interface LoopbackGuard {
  readonly middleware: (request: IncomingMessage, response: ServerResponse, next: () => void) => void;
  readonly upgrade: (request: IncomingMessage, socket: Duplex) => void;
}

export function loopbackGuard(key: PreviewKey | undefined): LoopbackGuard {
  return {
    middleware: (request, response, next) => guardMiddleware(key, request, response, next),
    upgrade: (request, socket) => guardUpgrade(key, request, socket),
  };
}

const SERVER_GUARD = loopbackGuard(SERVER_KEY);
/** The dev server middleware: registered first, before any Stacki route and before Vite's own. */
export const loopbackGuardMiddleware = SERVER_GUARD.middleware;
/** The dev server's `upgrade` listener, put before Vite's own (guardUpgrade). */
export const loopbackGuardUpgrade = SERVER_GUARD.upgrade;

function guardMiddleware(key: PreviewKey | undefined, request: IncomingMessage, response: ServerResponse, next: () => void): void {
  const verdict = judgeRequest(guardedRequest(request, key));
  switch (verdict.kind) {
    case 'pass': {
      next();
      return;
    }
    case 'admit': {
      assert(key !== undefined, 'loopbackGuardMiddleware: only a server with a key admits');
      response.writeHead(303, {
        location: verdict.location,
        // Lax, not Strict: a code opened from the camera, or a link from a message, is a navigation from no
        // site, and the device must send the cookie on the very next request. HttpOnly: no page script reads it.
        'set-cookie': `${PREVIEW_KEY_COOKIE}=${key}; Path=/; HttpOnly; SameSite=Lax`,
        'cache-control': 'no-store',
      });
      response.end();
      return;
    }
    case 'refuse': {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end(verdict.reason === 'key' ? 'Forbidden: scan the preview code in Stacki to open this page on this device.' : 'Forbidden');
      return;
    }
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

// Vite's live-reload WebSocket never passes a middleware, so a device the key keeps out of the site is kept out
// of it here too. Only the key is judged: an upgrade asks for no Stacki route, and the page's own socket carries
// the cookie like any request.
function guardUpgrade(key: PreviewKey | undefined, request: IncomingMessage, socket: Duplex): void {
  const verdict = judgeSiteRequest(guardedRequest(request, key));
  if (verdict.kind === 'pass') {
    return;
  }
  // An admit is a page's address, never a socket's: a socket without the cookie is refused either way.
  socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  socket.destroy();
}

function guardedRequest(request: IncomingMessage, key: PreviewKey | undefined): GuardedRequest {
  return {
    url: request.url,
    method: request.method,
    remoteAddress: request.socket.remoteAddress,
    host: headerText(request.headers.host),
    origin: headerText(request.headers.origin),
    cookie: headerText(request.headers.cookie),
    key,
  };
}

/** The values of every cookie named PREVIEW_KEY_COOKIE in a Cookie header, within the header's bounds. */
export function cookieKeys(header: string | undefined): readonly string[] {
  if (header === undefined || header.length > COOKIE_HEADER_CHARS_MAX) {
    return [];
  }
  const values: string[] = [];
  for (const pair of header.split(';').slice(0, COOKIES_MAX)) {
    const equals = pair.indexOf('=');
    if (equals !== -1 && pair.slice(0, equals).trim() === PREVIEW_KEY_COOKIE) {
      values.push(pair.slice(equals + 1).trim());
    }
  }
  assert(values.length <= COOKIES_MAX, 'cookieKeys: bounded by the cookies read');
  return values;
}

// Compared in constant time, so the time a refusal takes says nothing about how much of a guess was right.
function sameKey(given: string, key: PreviewKey): boolean {
  const left = Buffer.from(given);
  const right = Buffer.from(key);
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function previewKeyOf(value: string | undefined): PreviewKey | undefined {
  return value === undefined || value === '' ? undefined : toPreviewKey(value);
}

function headerText(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  // A repeated Host or Origin header is not one this app sends: read it as the first, which the checks then judge.
  return value?.[0];
}

// The hostname part of a Host header: `[::1]:4321` keeps its brackets, `127.0.0.1:4321` loses its port.
function hostnameOf(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.indexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}
