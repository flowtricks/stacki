import { assert } from '../../../vendor/stacki/shared/core/assert';
import { canvasRoute, canvasRouteBase } from './canvasRoute';
import { pageForRoute } from '../pages/templateRoutes';

// The interactive preview and the page switcher drive each other. Picking a page
// loads its route in the preview; a link followed in the preview opens the page it
// landed on, so the switcher and the address name what the preview shows. Each side
// only acts when the other is somewhere else, so neither echoes the other back.

/** Where the preview frame was pointed: its address, and the project route it was opened on. */
export interface PreviewOpening {
  readonly url: string;
  readonly route: string;
}

/** A page the preview landed on: the project file, and the entry when the file is a template. */
export interface PreviewPage {
  readonly file: string;
  readonly entry: string | undefined;
}

/**
 * The project route a path the frame reported stands for: query and hash dropped,
 * the static demo's base taken off, no trailing slash.
 */
export function previewFrameRoute(path: string, opening: PreviewOpening): string {
  assert(path.startsWith('/'), 'A preview frame reports a site path');
  assert(opening.route.startsWith('/'), 'A preview opens on a site path');
  const pathname = path.split(/[?#]/)[0] ?? '/';
  return trimSlash(canvasRoute(pathname || '/', opening.url, opening.route));
}

/** The page the preview landed on, or undefined when the route is none of the project's. */
export function previewLandedPage(files: readonly string[], route: string, routeFor: (file: string) => string): PreviewPage | undefined {
  assert(route.startsWith('/'), 'A preview route is a site path');
  return pageForRoute(files, route, routeFor);
}

/** Whether the switcher asks for a route the preview is not on. An unknown route (a template still reading its entries) waits. */
export function previewNeedsRoute(frameRoute: string | undefined, wanted: string | undefined): wanted is string {
  if (wanted === undefined) {
    return false;
  }
  assert(wanted.startsWith('/'), 'The switcher asks for a site path');
  if (frameRoute === undefined) {
    return true;
  }
  return trimSlash(frameRoute) !== trimSlash(wanted);
}

/** The base the preview's pages are served under, for the frame's link handling (frameInteraction.ts). */
export function previewBase(opening: PreviewOpening): string {
  return canvasRouteBase(opening.url, opening.route);
}

/** A site-root path moved under the base, at the folder its baked page is served from. */
export function previewUnderBase(pathname: string, base: string): string {
  assert(pathname.startsWith('/'), 'A frame path is a site path');
  assert(base.startsWith('/') && !base.endsWith('/'), 'A base is a site path with no trailing slash');
  if (pathname === base || pathname.startsWith(`${base}/`)) {
    return pathname;
  }
  const last = pathname.split('/').at(-1) ?? '';
  const folder = pathname.endsWith('/') || last.includes('.') ? pathname : `${pathname}/`;
  return `${base}${folder}`;
}

function trimSlash(path: string): string {
  return path.replace(/\/+$/, '') || '/';
}
