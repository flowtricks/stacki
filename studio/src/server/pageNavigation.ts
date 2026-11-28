// Astro's dev server serves exactly one spelling of a page's path when the site
// sets `trailingSlash`: under 'always' it serves /about/ and answers /about with a
// 404 help page. Studio names pages by slashless routes (routeFor), and both the
// local preview-url answer and the hosted entry redirect send the canvas there as
// is, so on an 'always' site every page but the home page loaded Astro's 404, its
// editor script never answered, and the canvas stopped at "taking a little longer".
//
// The container is the one place that knows the site's setting in every host, so
// a page navigation that misses the slash is redirected to the spelling Astro
// serves. Fetches, writes, files and Studio's own paths are never touched, and
// 'never' needs nothing: Studio's routes never end in a slash.
import { assert } from '../../vendor/stacki/shared/core/assert';

/** What the redirect decision reads from a request: nothing else about it matters. */
export interface PageNavigation {
  readonly method: string;
  readonly pathname: string;
  readonly search: string;
  /** `Sec-Fetch-Mode`; 'navigate' for a frame or tab loading a page. */
  readonly fetchMode: string | undefined;
}

/** The address Astro serves this page at, when the request asked for another spelling of it. */
export function slashRedirect(request: PageNavigation, trailingSlash: string): string | undefined {
  assert(request.pathname.startsWith('/'), 'A request path is a site path');
  if (trailingSlash !== 'always') {
    return undefined;
  }
  if (request.fetchMode !== 'navigate') {
    return undefined;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return undefined;
  }
  if (request.pathname.endsWith('/')) {
    return undefined;
  }
  if (isToolingPath(request.pathname)) {
    return undefined;
  }
  // An extension means a file (/feed.xml, /llms.txt), which keeps its shape under every
  // setting; this is how Astro checks it too.
  const last = request.pathname.slice(request.pathname.lastIndexOf('/') + 1);
  if (last.includes('.')) {
    return undefined;
  }
  return `${request.pathname}/${request.search}`;
}

// Studio's own routes (/studio/…), its preview internals (/__avb/…, /__studio-entry) and
// Vite's and Astro's (/@vite/…, /_astro/…) are not site pages.
function isToolingPath(pathname: string): boolean {
  return (
    pathname === '/studio' || pathname.startsWith('/studio/') || pathname.startsWith('/__') || pathname.startsWith('/@') || pathname.startsWith('/_astro/')
  );
}
