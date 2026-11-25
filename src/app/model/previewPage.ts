import { assert } from '../../../shared/core/assert';
import { routeMatchesTemplate } from '../../features/props/linkType';

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

/** The page a canvas frame landed on, and for a dynamic page the entry it shows (its route, e.g. `/projects/p1`). */
export interface CanvasLanding<Page> {
  readonly page: Page;
  readonly entry: string | undefined;
}

/**
 * The project page a canvas frame in interact mode followed a link to. A page with a
 * route of its own wins; otherwise the dynamic page whose pattern the path fits, with
 * that path as its entry. Followed into a template (a card linking to its project at
 * `/projects/[slug]`), the canvas has to show that page at that entry: reloading the
 * page the editor had open instead took the visitor straight back, a flash of the
 * project and then the grid again. The most specific template wins, as Astro ranks
 * them: one without a rest parameter before one with.
 */
export function canvasLandingFor<Page extends { readonly route: string }>(pages: readonly Page[], path: string): CanvasLanding<Page> | undefined {
  const exact = previewPageFor(pages, path);
  if (exact !== undefined) {
    return { page: exact, entry: undefined };
  }
  const route = previewRouteOf(path);
  const templates = pages.filter((page) => page.route.includes('[') && routeMatchesTemplate(route, trimmedRoute(page.route)));
  const plain = templates.find((page) => !page.route.includes('[...'));
  const page = plain ?? templates[0];
  if (page === undefined) {
    return undefined;
  }
  assert(!route.includes('['), 'A followed path is an address, not a pattern');
  return { page, entry: route };
}

/** Which of a dynamic page's entries is the one at `route`; undefined when none is. */
export function dynamicEntryIndexOf(entries: readonly { readonly route: string }[], route: string): number | undefined {
  assert(route.startsWith('/'), 'An entry is found by its site path');
  const wanted = previewRouteOf(route);
  const index = entries.findIndex((entry) => entry.route.startsWith('/') && previewRouteOf(entry.route) === wanted);
  if (index < 0) {
    return undefined;
  }
  assert(index < entries.length, 'An entry index is within the entries');
  return index;
}

function trimmedRoute(route: string): string {
  return route.replace(/\/+$/, '') || '/';
}
