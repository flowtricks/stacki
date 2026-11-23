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
// A request from the network to any other route is the site, and passes. The hover-preview header
// (previewMarkers.ts variantScopeMiddleware) is honoured from loopback only, so a device on the network
// renders the page as written, never an override.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { assert } from '../../shared/core/assert';

/** Paths only this computer may use: the editor's control routes, the local Studio and Vite's editor launcher. */
export const LOOPBACK_ONLY_PREFIXES = ['/__avb', '/studio', '/__open-in-editor'] as const;

// A Host or Origin header longer than this is not one this app sends.
const HEADER_CHARS_MAX = 512;

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

/** The verdict on one request: whether it may continue. */
export type LoopbackVerdict = { readonly kind: 'pass' } | { readonly kind: 'refuse'; readonly reason: 'remote' | 'host' | 'origin' };

/** Pure: what the guard decides for a request with these properties. */
export function judgeRequest(request: {
  readonly url: string | undefined;
  readonly remoteAddress: string | undefined;
  readonly host: string | undefined;
  readonly origin: string | undefined;
}): LoopbackVerdict {
  if (!isLoopbackOnlyRoute(request.url)) {
    return { kind: 'pass' };
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

/** The dev server middleware: registered first, before any Stacki route and before Vite's own. */
export function loopbackGuardMiddleware(request: IncomingMessage, response: ServerResponse, next: () => void): void {
  const verdict = judgeRequest({
    url: request.url,
    remoteAddress: request.socket.remoteAddress,
    host: headerText(request.headers.host),
    origin: headerText(request.headers.origin),
  });
  switch (verdict.kind) {
    case 'pass': {
      next();
      return;
    }
    case 'refuse': {
      assert(isLoopbackOnlyRoute(request.url), 'loopbackGuardMiddleware: only Stacki routes are refused');
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end('Forbidden');
      return;
    }
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
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
