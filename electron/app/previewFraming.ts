// Letting the canvas show the project's own dev server in its frame.
//
// The canvas is an iframe of the app's window pointing at the project's dev server on loopback. A site may forbid being
// framed: EmDash's integration answers every page with `X-Frame-Options: SAMEORIGIN`, and a Content-Security-Policy can say
// `frame-ancestors 'self'`. The app's page is a different origin from the dev server, so the browser refuses the frame
// (ERR_BLOCKED_BY_RESPONSE) and the canvas stays blank, though the page itself is fine. A site's framing rule protects its
// visitors from other sites framing it; here the frame is the person's own editor showing their own project on their own
// machine, so for responses from loopback hosts to a frame request those two framing rules are dropped, and nothing else in
// the response changes. It is one rule in a single composed listener (below). Requests to any other host, and every non-frame request, are left alone.
import type { Session } from 'electron';

type Headers = Record<string, string[]>;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** True for an http(s) address on this machine's loopback, the only place a project's dev server runs. */
export function isLoopbackAddress(address: string): boolean {
  try {
    const url = new URL(address);
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/** The response headers without `X-Frame-Options`, `Cross-Origin-Resource-Policy` (it can refuse a framed document too) and without the `frame-ancestors` directive of any CSP header; every other byte as it was. */
export function withoutFramingRules(headers: Readonly<Headers>): Headers {
  const result: Headers = {};
  for (const [name, values] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === 'x-frame-options' || lower === 'cross-origin-resource-policy') {
      continue;
    }
    if (lower === 'content-security-policy' || lower === 'content-security-policy-report-only') {
      const kept = values.map(dropFrameAncestors).filter((value) => value.length > 0);
      if (kept.length > 0) {
        result[name] = kept;
      }
      continue;
    }
    result[name] = values;
  }
  return result;
}

function dropFrameAncestors(policy: string): string {
  return policy
    .split(';')
    .filter((directive) => !/^\s*frame-ancestors(\s|$)/i.test(directive))
    .join(';')
    .trim();
}

/** A change to a response's headers: the new headers, or undefined to leave them. Pure; it never sees a request body. */
export type ResponseHeaderRule = (response: {
  readonly url: string;
  readonly resourceType: string;
  readonly headers: Readonly<Headers>;
}) => Headers | undefined;

/** The framing rule: a loopback frame response loses `X-Frame-Options`, a CSP `frame-ancestors` and `Cross-Origin-Resource-Policy`. */
export const loopbackFramingRule: ResponseHeaderRule = ({ url, resourceType, headers }) =>
  resourceType === 'subFrame' && isLoopbackAddress(url) ? withoutFramingRules(headers) : undefined;

// Electron keeps ONE onHeadersReceived listener per session: registering a second silently replaces the first. So every rule
// that changes response headers is added here and one listener runs them all, in the order added; nothing else in the app
// may call `webRequest.onHeadersReceived` (test/electron/app/previewFraming.test.js reads the source for it).
const rules: ResponseHeaderRule[] = [loopbackFramingRule];
const installed = new WeakSet<object>();

/** Adds a rule to every session this module serves, already installed or not. */
export function addResponseHeaderRule(rule: ResponseHeaderRule): void {
  rules.push(rule);
}

/** Installs the one listener on a session, once; it runs the rules as they are at the time of each response. */
export function installResponseHeaderRules(target: Pick<Session, 'webRequest'>): void {
  if (installed.has(target)) {
    return;
  }
  installed.add(target);
  target.webRequest.onHeadersReceived((details, callback) => {
    if (details.responseHeaders === undefined) {
      callback({});
      return;
    }
    let headers: Headers = details.responseHeaders;
    let changed = false;
    for (const rule of rules) {
      const next = rule({ url: details.url, resourceType: details.resourceType, headers });
      if (next !== undefined) {
        headers = next;
        changed = true;
      }
    }
    callback(changed ? { responseHeaders: headers } : {});
  });
}

/** Lets the canvas show the project's own dev server in its frame: installs the shared listener on the session. */
export function allowLoopbackFraming(target: Pick<Session, 'webRequest'>): void {
  installResponseHeaderRules(target);
}
