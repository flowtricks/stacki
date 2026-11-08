import { assert } from '../../../shared/core/assert';

// The interactive preview and the page switcher drive each other on Desktop, as
// they do in Studio (studio/src/features/preview/previewRoute.ts): a page picked
// while previewing loads in the preview, and a link followed in the preview opens
// the page it landed on, so the switcher names what the preview shows.

/** A path the preview frame reported, as the route it stands for: no query, hash or trailing slash. */
export function previewRouteOf(path: string): string {
  assert(path.startsWith('/'), 'A preview frame reports a site path');
  const pathname = path.split(/[?#]/)[0] ?? '';
  return pathname.replace(/\/+$/, '') || '/';
}

/** The project page a preview path shows, matched by its exact route; undefined for any other path. */
export function previewPageFor<Page extends { readonly route: string }>(pages: readonly Page[], path: string): Page | undefined {
  const route = previewRouteOf(path);
  return pages.find((page) => (page.route.replace(/\/+$/, '') || '/') === route);
}

/** Whether the switcher's page is somewhere other than where the preview is. */
export function previewNeedsPath(shown: string | undefined, wanted: string | undefined): wanted is string {
  if (wanted === undefined) {
    return false;
  }
  if (shown === undefined) {
    return true;
  }
  return previewRouteOf(shown) !== previewRouteOf(wanted);
}

/**
 * Where the preview should be for the page the editor has open, or undefined while
 * that is not known yet. `canvasPath` is the canvas's own address, which for a dynamic
 * page is one entry's URL, and which still holds the previous page's entry for the
 * render in which the page changes (the entries are cleared by an effect after it).
 * So a page with a route of its own is at that route, whatever the canvas says, and a
 * dynamic page waits until the canvas names one of its entries: its pattern is a 404.
 */
export function previewPathOfPage(page: { readonly route: string; readonly path: string } | undefined, canvasPath: string): string | undefined {
  assert(canvasPath.startsWith('/'), 'A canvas path is a site path');
  if (page === undefined) {
    return canvasPath;
  }
  if (!page.route.includes('[')) {
    return page.path;
  }
  return canvasPath.includes('[') ? undefined : canvasPath;
}
