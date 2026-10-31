import { PublishIdleGuard } from './publishIdleGuard';
import { updateRoutes } from './updateRoutes';
import { isStudioAPI, studioError } from './apiResponse';
import { canEdit } from '../features/auth/repositoryAccess';
import { Container } from '@cloudflare/containers';
import { githubLogin, loginPage } from '../features/auth/githubLogin';
import { routeLogin } from '../features/auth/loginRoute';
import {
  cookie,
  sessionCookie,
  signSession,
  verifySession,
  type Identity,
} from '../features/auth/session';
import type { Environment } from './environment';
import { internal } from './internalRoutes';
import { claimLoginAttempt, LoginAttempts } from '../features/auth/loginAttempts';
import { warmupRequest } from './warmupRequest';
import { cmsConnectionRoute, cmsVault } from './cmsConnectionRoutes';
import { CmsUnavailable, cmsForwarded } from '../features/cms/cmsConnectionVault';

export class PreviewContainer extends Container<Environment> {
  private readonly loginAttempts = new LoginAttempts((state, expires) =>
    this.ctx.storage.transaction((storage) => claimLoginAttempt(storage, state, expires)),
  );
  private readonly publishIdle = new PublishIdleGuard();
  override defaultPort = 4350;
  override sleepAfter = '3m';
  // Port probes only need an HTTP response; the protected API rejects this
  // unauthenticated probe cheaply instead of rendering the Astro homepage.
  override pingEndpoint = 'localhost/studio/api/status';
  override async fetch(request: Request): Promise<Response> {
    // OAuth coordination uses the existing Durable Object without starting the preview Container.
    const auth = await githubLogin(request, this.env, this.loginAttempts, (profile) =>
      canEdit(profile, this.env, true),
    );
    if (auth) {
      return auth;
    }
    if ((await this.getState()).status !== 'healthy') {
      await this.startAndWaitForPorts(4350, { portReadyTimeoutMS: 600_000 });
    }
    return super.fetch(request);
  }
  override async onActivityExpired(): Promise<void> {
    await this.publishIdle.expire({
      read: () =>
        this.containerFetch(
          new Request('http://localhost/studio/api/publish', {
            headers: { 'x-studio-token': this.env.CONTAINER_TOKEN },
            signal: AbortSignal.timeout(10_000),
          }),
          4350,
        ),
      renew: () => this.renewActivityTimeout(),
      stop: () => this.stop(),
    });
  }
  override onStart() {
    console.info('Studio container ready');
  }
  override onStop({ exitCode, reason }: { exitCode: number; reason: string }) {
    console.info('Studio container stopped', { exitCode, reason });
  }
  override envVars = {
    STUDIO_CONTAINER_TOKEN: this.env.CONTAINER_TOKEN,
    STUDIO_BACKEND_URL: this.env.STUDIO_ORIGIN,
    GITHUB_REPOSITORY: this.env.GITHUB_REPOSITORY,
    STUDIO_PARENT_ORIGIN: this.env.STUDIO_ORIGIN,
    STUDIO_PREVIEW_ORIGIN: this.env.PREVIEW_ORIGIN,
    STUDIO_DEPLOYMENT_URL: this.env.SITE_DEPLOYMENT_URL ?? '',
    STUDIO_GITHUB_DEPLOY_WORKER: this.env.GITHUB_DEPLOY_WORKER ?? '',
    STUDIO_GITHUB_DEPLOY_ACCOUNT: this.env.GITHUB_DEPLOY_ACCOUNT ?? '',
    CLOUDFLARE_API_TOKEN: this.env.PUBLISH_CLOUDFLARE_API_TOKEN ?? '',
    VERCEL_TOKEN: this.env.PUBLISH_VERCEL_TOKEN ?? '',
    PORT: '4350',
  };
}
export default {
  async fetch(
    request: Request,
    environment: Environment,
    context: ExecutionContext,
  ): Promise<Response> {
    try {
      return await route(request, environment, context);
    } catch (error) {
      console.error('Studio request failed', error instanceof Error ? error.message : 'Unknown');
      return studioError(
        request,
        'Studio is restarting or temporarily unavailable. Please retry shortly.',
        503,
      );
    }
  },
};
async function route(
  request: Request,
  environment: Environment,
  context: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/studio/internal/')) {
    return internal(request, environment);
  }
  const previewHost = url.origin === environment.PREVIEW_ORIGIN;
  if (!previewHost && url.origin !== environment.STUDIO_ORIGIN) {
    return new Response('Unknown studio host', { status: 404 });
  }
  if (previewHost && url.pathname === '/__studio-entry') {
    return previewEntry(url, environment);
  }
  if (!previewHost) {
    const auth = routeLogin(request, (forwarded) =>
      environment.PREVIEW.getByName('project').fetch(forwarded),
    );
    if (auth) {
      return auth;
    }
  }
  const identity = await studioIdentity(request, environment, previewHost);
  if (identity instanceof Response) {
    return identity;
  }
  if (
    request.method !== 'GET' &&
    request.method !== 'HEAD' &&
    request.headers.get('Origin') !==
      (previewHost ? environment.PREVIEW_ORIGIN : environment.STUDIO_ORIGIN)
  ) {
    return studioError(request, 'Invalid request origin', 403);
  }
  const answered = !previewHost && (await workerRoute(request, url, environment, identity));
  if (answered) {
    return answered;
  }
  const asset = !previewHost && studioAsset(request, environment);
  if (asset) {
    warmPreview(request, environment, identity, context);
    return asset;
  }
  if (
    previewHost &&
    url.pathname.startsWith('/studio/') &&
    !['/studio/preview.js', '/studio/morph.js'].includes(url.pathname)
  ) {
    return new Response('Unavailable on preview host', { status: 403 });
  }
  if (
    request.headers.get('Upgrade') === 'websocket' &&
    request.headers.get('Origin') !== environment.STUDIO_ORIGIN &&
    !previewHost
  ) {
    return new Response('Invalid socket origin', { status: 403 });
  }
  return forward(request, url, environment, identity, previewHost);
}

// The Studio host's requests the Worker answers itself, without the container.
async function workerRoute(
  request: Request,
  url: URL,
  environment: Environment,
  identity: Identity,
): Promise<Response | undefined> {
  if (url.pathname === '/studio/api/updates') {
    return authorizedUpdate(request, environment, identity);
  }
  if (url.pathname === '/studio/api/session') {
    return Response.json(
      { kind: 'github', id: identity.id, login: identity.login },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (url.pathname === '/studio/api/preview-url') {
    return previewURL(url, environment, identity);
  }
  // CMS connections are kept here, never by the container (cmsConnectionRoutes.ts).
  return cmsConnectionRoute(request, url, environment, identity);
}

// To the container: never with a client's CMS target, and with ours for a CMS
// call (cmsConnectionRoutes.ts). A connection that cannot be used is answered here.
async function forward(
  request: Request,
  url: URL,
  environment: Environment,
  identity: Identity,
  previewHost: boolean,
): Promise<Response> {
  let forwarded: Request;
  try {
    forwarded = await cmsForwarded(request, url, cmsVault(environment));
  } catch (error) {
    if (error instanceof CmsUnavailable) {
      return Response.json({ ok: false, message: error.message });
    }
    throw error;
  }
  return proxy(forwarded, environment, identity, previewHost);
}

function warmPreview(
  request: Request,
  environment: Environment,
  identity: Identity,
  context: ExecutionContext,
) {
  const warmup = warmupRequest(request, environment.PREVIEW_ORIGIN);
  if (!warmup) {
    return;
  }
  // Restore the workspace while the editor loads; only visible previews render.
  context.waitUntil(
    proxy(warmup, environment, identity, false)
      .then((response) => response.body?.cancel())
      .catch(() => {}),
  );
}

async function studioIdentity(
  request: Request,
  environment: Environment,
  previewHost: boolean,
): Promise<Identity | Response> {
  const identity = await verifySession(
    cookie(request, previewHost ? '__Host-studio-preview' : '__Host-studio'),
    environment.SESSION_SECRET,
    previewHost ? 'preview' : 'studio',
  );
  if (!identity) {
    return isStudioAPI(request) || previewHost
      ? studioError(request, 'Your Studio session expired. Sign in again.', 401)
      : loginPage();
  }
  if (!(await canEdit(identity, environment))) {
    return isStudioAPI(request) || previewHost
      ? studioError(request, 'Repository editing access is required.', 403)
      : loginPage('access', 403);
  }
  return identity;
}

async function previewEntry(url: URL, environment: Environment): Promise<Response> {
  const token = url.searchParams.get('token') ?? '';
  const identity = await verifySession(token, environment.SESSION_SECRET, 'preview');
  if (!identity || !(await canEdit(identity, environment))) {
    return new Response('Preview sign-in expired', { status: 403 });
  }
  const session = await signSession(
    { ...identity, expires: Date.now() + 28_800_000 },
    environment.SESSION_SECRET,
  );
  const page = url.searchParams.get('page') ?? '/';
  if (!page.startsWith('/') || page.startsWith('//') || page.includes('\\')) {
    return new Response('Invalid preview path', { status: 400 });
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location:
        page + (url.searchParams.get('mode') === 'interactive' ? '#avb-preview' : '#avb-design'),
      'Set-Cookie': sessionCookie('__Host-studio-preview', session, 28_800),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

async function proxy(
  request: Request,
  environment: Environment,
  identity: Identity,
  previewHost: boolean,
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set('x-studio-token', environment.CONTAINER_TOKEN);
  headers.set('x-studio-user', identity.login);
  headers.set('x-studio-user-id', String(identity.id));
  headers.set(
    'x-studio-session',
    cookie(request, previewHost ? '__Host-studio-preview' : '__Host-studio'),
  );
  headers.delete('Cookie');
  const response = await environment.PREVIEW.getByName('project').fetch(
    new Request(request, { headers }),
  );
  if (response.status === 101) {
    return response;
  }
  const outgoing = new Response(response.body, response);
  outgoing.headers.set('Cache-Control', 'no-store');
  if (previewHost) {
    outgoing.headers.set('Content-Security-Policy', `frame-ancestors ${environment.STUDIO_ORIGIN}`);
  }
  return outgoing;
}

async function previewURL(url: URL, environment: Environment, identity: Identity) {
  const token = await signSession(
    { ...identity, audience: 'preview', expires: Date.now() + 30_000 },
    environment.SESSION_SECRET,
  );
  const preview = new URL('/__studio-entry', environment.PREVIEW_ORIGIN);
  preview.searchParams.set('token', token);
  preview.searchParams.set('page', url.searchParams.get('page') ?? '/');
  if (url.searchParams.get('mode') === 'interactive') {
    preview.searchParams.set('mode', 'interactive');
  }
  return Response.json(
    { url: preview.href, origin: environment.PREVIEW_ORIGIN },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

function studioAsset(request: Request, environment: Environment) {
  const asset = new URL(request.url);
  if (
    !['/studio', '/studio/', '/studio/studio.js', '/studio/studio.css'].includes(asset.pathname)
  ) {
    return undefined;
  }
  asset.pathname =
    asset.pathname === '/studio' || asset.pathname === '/studio/'
      ? '/'
      : asset.pathname.slice('/studio'.length);
  return environment.ASSETS.fetch(new Request(asset, request));
}

async function authorizedUpdate(request: Request, environment: Environment, identity: Identity) {
  if (!(await canEdit(identity, { ...environment, EDITOR_ACCESS: 'repository' }, true))) {
    return new Response('Repository write access is required to manage Studio updates', {
      status: 403,
    });
  }
  return updateRoutes(request, environment);
}
