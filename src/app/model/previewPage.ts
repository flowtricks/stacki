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
