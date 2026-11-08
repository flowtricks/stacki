// Stands in for `fetch` on Studio's own paths. Every other URL, including anything
// the page loads for itself, goes to the network untouched.
export type DemoRoutes = (url: URL, init: RequestInit | undefined) => Promise<Response>;

export function fetchStandIn(routes: DemoRoutes, native: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.origin === location.origin && (url.pathname === '/studio' || url.pathname.startsWith('/studio/'))) {
      return routes(url, init);
    }
    return native(input, init);
  };
}
