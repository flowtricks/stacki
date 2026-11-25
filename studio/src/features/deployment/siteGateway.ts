import { translatorForLanguages } from '../../shared/requestTranslate';
interface Service {
  fetch(request: Request): Promise<Response>;
}
export interface SiteEnvironment {
  readonly ASSETS: Service;
  readonly STUDIO?: Service;
  readonly SITE_VERSION?: { readonly tag?: string };
}

export function serveSite(request: Request, environment: SiteEnvironment): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/__studio-deployment') {
    const tag = environment.SITE_VERSION?.tag;
    return Promise.resolve(Response.json({ sha: tag && /^[a-f0-9]{40}$/.test(tag) ? tag : null }, { headers: { 'Cache-Control': 'no-store' } }));
  }
  if (pathname !== '/studio' && !pathname.startsWith('/studio/')) {
    return environment.ASSETS.fetch(request);
  }
  if (environment.STUDIO) {
    // Preserve the public origin, cookies, and WebSocket headers for studio authentication.
    return environment.STUDIO.fetch(request);
  }
  return Promise.resolve(
    new Response(translatorForLanguages(request.headers.get('Accept-Language')).translate('studio.gateway.unavailable'), {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    }),
  );
}
