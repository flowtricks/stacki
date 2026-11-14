// The Worker's two app file routes (appFileLinks.ts explains the links and their threat model):
// a signed-in load is redirected to a signed link, and a load under a link is served
// without a session, from the container, for that app's folder only.
import { appFileContainerPath, mintAppFileLink, parseAppFilePath, verifyAppFileLink } from './appFileLinks';
import type { Environment } from './environment';
import type { Identity } from '../features/auth/session';

const NOT_FOUND_HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } as const;

/**
 * Serves a request under a link, before any session check. Undefined for every path that
 * is not link-shaped, which then needs a session as before. Every refusal is the same 404.
 */
export async function appFileLinkRoute(request: Request, url: URL, environment: Environment): Promise<Response | undefined> {
  const parsed = parseAppFilePath(url.pathname);
  if (parsed.kind === 'other' || parsed.kind === 'plain') {
    return undefined;
  }
  if (parsed.kind === 'refused') {
    return notFound();
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return notFound();
  }
  if (!(await verifyAppFileLink({ secret: environment.SESSION_SECRET, host: url.host, link: parsed, nowMs: Date.now() }))) {
    return notFound();
  }
  // Only the container token: no user, session or cookie reaches the container, so any
  // route there that needs a person refuses, and the path is rebuilt from checked parts.
  const target = new URL(appFileContainerPath(parsed.id, parsed.file), environment.STUDIO_ORIGIN);
  const headers = new Headers({
    'x-studio-token': environment.CONTAINER_TOKEN,
    // The container writes its app CSP's source as this scheme and host (appsServer.ts serveFile).
    'x-forwarded-proto': url.protocol === 'https:' ? 'https' : 'http',
  });
  const response = await environment.PREVIEW.getByName('project').fetch(new Request(target, { method: request.method, headers }));
  return linkedResponse(response, environment.STUDIO_ORIGIN);
}

/** A signed-in GET or HEAD of an app file: redirect into the link prefix. Undefined for any other request. */
export async function appFileRedirect(request: Request, url: URL, environment: Environment, identity: Identity): Promise<Response | undefined> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return undefined;
  }
  const parsed = parseAppFilePath(url.pathname);
  if (parsed.kind !== 'plain') {
    return undefined;
  }
  const link = await mintAppFileLink({
    secret: environment.SESSION_SECRET,
    host: url.host,
    id: parsed.id,
    file: parsed.file,
    sessionExpiresMs: identity.expires,
    nowMs: Date.now(),
  });
  if (link === undefined) {
    return Response.json({ error: 'Your Studio session expired. Sign in again.' }, { status: 401, headers: NOT_FOUND_HEADERS });
  }
  return new Response(null, { status: 302, headers: { Location: link, ...NOT_FOUND_HEADERS } });
}

function linkedResponse(response: Response, studioOrigin: string): Response {
  const outgoing = new Response(response.body, response);
  // The frame's origin is opaque, so its <script>, <link> and <img> loads are cross-origin;
  // the container's `same-origin` would block them.
  outgoing.headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  outgoing.headers.set('Referrer-Policy', 'no-referrer');
  outgoing.headers.set('Cache-Control', 'private, no-store');
  outgoing.headers.delete('Set-Cookie');
  // Keep the container's app policy (sandbox, connect-src limited to the manifest's hosts)
  // and allow only the editor to embed the frame.
  const policy = response.headers.get('Content-Security-Policy');
  outgoing.headers.set('Content-Security-Policy', policy ? `${policy}; frame-ancestors ${studioOrigin}` : `frame-ancestors ${studioOrigin}`);
  return outgoing;
}

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: NOT_FOUND_HEADERS });
}
