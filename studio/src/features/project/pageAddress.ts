// The address a host page may keep in step with the page open on the canvas.
//
// Studio has no address per page: it opens the home page and keeps the open page in
// React state. The static demo on stacki.build stands at the site's own addresses
// (stacki.build/studio/ opens the Studio page), so it installs a host on the global
// object before it loads this client. The client asks the host which page to open
// first, tells it every page it opens (with the entry a template page shows, which has
// an address of its own), lets it open pages when the address changes
// under it (back and forward), and offers it the routes a canvas link reached that are
// not pages. A global, rather than an import, because the demo and the client are two
// bundles; the demo's half is `demo/pageAddress.ts`. With no host, nothing changes.
import { assert } from '../../../vendor/stacki/shared/core/assert';

export const PAGE_ADDRESS_GLOBAL = '__stackiPageAddress';

/** How an opened page's address enters the tab's history. */
export type AddressHistory = 'push' | 'replace';

// The route the preview frame navigated to on its own, until the open it causes is
// reported (InteractivePreview.tsx). One route, not a queue: a newer navigation wins.
let previewRoute: string | undefined;

/** The preview frame is about to open this route's page itself: its address replaces, not pushes. */
export function addressFollowsPreview(route: string): void {
  assert(route.startsWith('/'), 'The preview reports a site path');
  previewRoute = trimSlash(route);
}

/** How the address for an opened route enters history; the preview's own route is taken once. */
export function addressHistoryFor(route: string): AddressHistory {
  assert(route.startsWith('/'), 'An opened page has a site route');
  if (previewRoute !== undefined && previewRoute === trimSlash(route)) {
    previewRoute = undefined;
    return 'replace';
  }
  previewRoute = undefined;
  return 'push';
}

function trimSlash(path: string): string {
  return path.replace(/\/+$/, '') || '/';
}

/** Longer than any page file or route a project can have. */
const PAGE_ADDRESS_LENGTH_MAX = 1000;

export interface PageAddressHost {
  /** The page file the address names, to open first instead of the home page. */
  readonly initialFile: () => string | undefined;
  /** The route the address names: for a template page, the entry to show first. */
  readonly initialRoute: () => string | undefined;
  /**
   * The client opened this page file on the canvas, showing this route (a template's entry).
   * `replace` when the preview frame got there itself: its navigation already made the
   * history entry (frames share the tab's history), so the address takes that entry
   * over instead of adding a second one that back would have to step through.
   */
  readonly opened: (file: string, route: string, history: AddressHistory) => void;
  /** Calls `open` with a page file and its route whenever the address moves under the client. Returns the unsubscribe. */
  readonly listen: (open: (file: string, route: string | undefined) => void) => () => void;
  /** A canvas link reached a route that is not a page. True when the host took the visitor there. */
  readonly leave: (route: string) => boolean;
}

/** The host the page installed, checked member by member, or undefined when there is none. */
export function pageAddressHost(): PageAddressHost | undefined {
  const value: unknown = Reflect.get(globalThis, PAGE_ADDRESS_GLOBAL);
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const initialFile: unknown = Reflect.get(value, 'initialFile');
  const opened: unknown = Reflect.get(value, 'opened');
  const listen: unknown = Reflect.get(value, 'listen');
  const leave: unknown = Reflect.get(value, 'leave');
  if (typeof initialFile !== 'function' || typeof opened !== 'function') {
    return undefined;
  }
  if (typeof listen !== 'function' || typeof leave !== 'function') {
    return undefined;
  }
  // Optional: a host without it names pages, never a template's entry.
  const initialRoute: unknown = Reflect.get(value, 'initialRoute');
  return {
    initialFile: () => pageFile(Reflect.apply(initialFile, value, [])),
    initialRoute: () => (typeof initialRoute === 'function' ? pageRoute(Reflect.apply(initialRoute, value, [])) : undefined),
    opened: (file, route, history) => {
      assert(file.length > 0, 'An opened page has a file');
      assert(route.startsWith('/'), 'An opened page has a site route');
      Reflect.apply(opened, value, [file, route, history]);
    },
    listen: (open) => {
      const stop: unknown = Reflect.apply(listen, value, [(file: unknown, route: unknown) => openListened(file, route, open)]);
      return typeof stop === 'function' ? () => void Reflect.apply(stop, undefined, []) : () => undefined;
    },
    leave: (route) => {
      assert(route.startsWith('/'), 'A route to leave for is a site path');
      return Reflect.apply(leave, value, [route]) === true;
    },
  };
}

/** A host's answer is outside the client's control, so only a page file passes. */
function pageFile(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > PAGE_ADDRESS_LENGTH_MAX) {
    return undefined;
  }
  return value.startsWith('src/pages/') ? value : undefined;
}

/** A route the host names: a site path, never a protocol-relative URL. */
function pageRoute(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > PAGE_ADDRESS_LENGTH_MAX) {
    return undefined;
  }
  return value.startsWith('/') && !value.startsWith('//') ? value : undefined;
}

function openListened(value: unknown, route: unknown, open: (file: string, route: string | undefined) => void): void {
  const file = pageFile(value);
  if (file !== undefined) {
    open(file, pageRoute(route));
  }
}
