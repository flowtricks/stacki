export function routeLogin(request: Request, forward: (request: Request) => Promise<Response>): Promise<Response> | undefined {
  const pathname = new URL(request.url).pathname;
  const providerCallback = /^\/studio\/auth\/[a-z][a-z0-9-]{0,31}\/callback$/.test(pathname);
  if (
    !['/studio/auth/login', '/studio/auth/callback', '/studio/auth/logout', '/studio/auth/passkey/bootstrap'].includes(pathname) &&
    !providerCallback &&
    !pathname.startsWith('/studio/auth/provider/')
  ) {
    return undefined;
  }
  // Service bindings can receive follow-mode requests. OAuth redirects must reach the
  // browser, which owns the cookies, rather than being followed inside the Durable Object.
  return forward(new Request(request, { redirect: 'manual' }));
}
