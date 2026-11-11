// `stacki.net.fetch` (docs/apps.md, "Calling services from Stacki"): a request
// the host makes for an app, for the services that send no CORS headers (an
// app frame's own fetch to them always fails) and so the app need never hold a
// token. This module is the contract: the request an app may make, every
// bound, and the answer. The request itself runs in Desktop's main process or
// the Studio server (electron/project/appNetFetch.ts), to the hosts the app's
// manifest declares in `network` and its sign-in providers' token hosts only.
import { assert } from '../core/assert';
import { record, text } from '../core/boundary';
import { parseAuthProviderId } from './appAuth';

export const APP_NET_LIMITS = {
  urlCharsMax: 4096,
  /** A request body, in bytes. */
  requestBytesMax: 5 * 1024 * 1024,
  /** A response body, in bytes; past it the request fails rather than answer part of it. */
  responseBytesMax: 5 * 1024 * 1024,
  /** Headers one request sends, and one response answers with. */
  headersMax: 32,
  headerCharsMax: 8192,
  /** How long one request may take, redirects included. */
  timeoutMs: 30_000,
  /** Redirects followed, each to a declared host. */
  redirectsMax: 3,
  /** Requests one app may make in a minute. */
  requestsPerMinuteMax: 120,
  /** The window the rate counts over. */
  rateWindowMs: 60_000,
  /** Apps whose rates one host tracks at once (APP_LIMITS.appsMax). */
  rateAppsMax: 50,
} as const satisfies Record<string, number>;

export const APP_NET_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type AppNetMethod = (typeof APP_NET_METHODS)[number];

/**
 * Headers an app may not send: the browser's and the transport's own, and
 * cookies, which a host request never carries. `authorization` is refused only
 * when the request names `auth`, where the host sets it.
 */
const FORBIDDEN_HEADERS = /^(?:cookie|cookie2|host|connection|content-length|transfer-encoding|keep-alive|upgrade|te|trailer|origin|referer|proxy-.*|sec-.*)$/;

export interface AppNetRequest {
  readonly url: string;
  readonly method: AppNetMethod;
  readonly headers: Readonly<Record<string, string>>;
  /** The body as text, or base64 when `encoding` says so. */
  readonly body: string | undefined;
  readonly encoding: 'utf8' | 'base64';
  /** A sign-in provider of the app: the host adds `Authorization: Bearer <its access token>`. */
  readonly auth: string | undefined;
}

export interface AppNetResponse {
  readonly status: number;
  /** The final URL, after redirects. */
  readonly url: string;
  /** Lowercase names; `set-cookie` is never passed on. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** `utf8` when the body is text, else `base64`. */
  readonly encoding: 'utf8' | 'base64';
}

/** `net.fetch`'s params: an https URL, a known method, bounded headers and body. */
export function parseAppNetRequest(input: unknown): AppNetRequest {
  const value = record(input);
  const url = parseNetURL(value['url']);
  const method = value['method'] === undefined ? 'GET' : APP_NET_METHODS.find((known) => known === text(value['method']).toUpperCase());
  if (method === undefined) {
    throw new Error(`method is one of ${APP_NET_METHODS.join(', ')}`);
  }
  const auth = value['auth'] === undefined ? undefined : parseAuthProviderId(value['auth']);
  const headers = parseHeaders(value['headers'], { authBySigning: auth !== undefined });
  const encoding = value['encoding'] === undefined ? 'utf8' : value['encoding'] === 'base64' ? 'base64' : value['encoding'] === 'utf8' ? 'utf8' : undefined;
  if (encoding === undefined) {
    throw new Error('encoding is utf8 or base64');
  }
  let body: string | undefined;
  if (value['body'] !== undefined) {
    body = text(value['body']);
    if (method === 'GET' || method === 'HEAD') {
      throw new Error(`A ${method} request has no body`);
    }
    const bytesMax = encoding === 'base64' ? Math.ceil(APP_NET_LIMITS.requestBytesMax / 3) * 4 : APP_NET_LIMITS.requestBytesMax;
    if (body.length > bytesMax) {
      throw new Error(`body exceeds ${APP_NET_LIMITS.requestBytesMax} bytes`);
    }
    if (encoding === 'base64' && (!/^[A-Za-z0-9+/]*={0,2}$/.test(body) || body.length % 4 !== 0)) {
      throw new Error('body is not base64');
    }
  }
  return { url, method, headers, body, encoding, auth };
}

/** An https URL without credentials, bounded. Which hosts it may name is the host's to check against the manifest. */
export function parseNetURL(input: unknown): string {
  const value = text(input);
  if (value.length === 0 || value.length > APP_NET_LIMITS.urlCharsMax) {
    throw new Error(`url is 1 to ${APP_NET_LIMITS.urlCharsMax} characters`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('url is not a URL');
  }
  if (url.protocol !== 'https:') {
    throw new Error('url starts with https://');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('url carries no credentials');
  }
  assert(url.hostname.length > 0, 'An https URL has a host');
  return url.toString();
}

function parseHeaders(input: unknown, options: { readonly authBySigning: boolean }): Readonly<Record<string, string>> {
  if (input === undefined) {
    return {};
  }
  const entries = Object.entries(record(input));
  if (entries.length > APP_NET_LIMITS.headersMax) {
    throw new Error(`A request sends at most ${APP_NET_LIMITS.headersMax} headers`);
  }
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]{1,128}$/.test(name)) {
      throw new Error(`"${rawName.slice(0, 40)}" is not a header name`);
    }
    if (FORBIDDEN_HEADERS.test(name)) {
      throw new Error(`Apps cannot send the ${name} header`);
    }
    if (name === 'authorization' && options.authBySigning) {
      throw new Error('With auth, Stacki sets the authorization header itself');
    }
    const headerValue = text(rawValue);
    if (headerValue.length > APP_NET_LIMITS.headerCharsMax || /[\r\n\0]/.test(headerValue)) {
      throw new Error(`The ${name} header is one line of at most ${APP_NET_LIMITS.headerCharsMax} characters`);
    }
    headers[name] = headerValue;
  }
  return headers;
}

/** An answer as it crosses IPC or HTTP. */
export function parseAppNetResponse(input: unknown): AppNetResponse {
  const value = record(input);
  const status = value['status'];
  if (typeof status !== 'number' || !Number.isSafeInteger(status) || status < 100 || status > 599) {
    throw new Error('A response has an HTTP status');
  }
  const encoding = value['encoding'] === 'base64' ? 'base64' : value['encoding'] === 'utf8' ? 'utf8' : undefined;
  if (encoding === undefined) {
    throw new Error('A response body is utf8 or base64');
  }
  const body = text(value['body']);
  if (body.length > Math.ceil(APP_NET_LIMITS.responseBytesMax / 3) * 4) {
    throw new Error('A response body exceeds its bound');
  }
  const headerEntries = Object.entries(record(value['headers']));
  if (headerEntries.length > APP_NET_LIMITS.headersMax * 4) {
    throw new Error('A response has too many headers');
  }
  const headers: Record<string, string> = {};
  for (const [name, raw] of headerEntries) {
    headers[name] = text(raw).slice(0, APP_NET_LIMITS.headerCharsMax);
  }
  return { status, url: parseNetURL(value['url']), headers, body, encoding };
}
