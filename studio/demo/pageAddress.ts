// Keeps the address bar and the page on the canvas in step, for a demo that stands at
// the site's own addresses: stacki.build/studio/ is the Studio page open in the editor.
//
// The page that serves the demo says which page it stands for (`stacki-demo-page`); a
// page without that tag, like the standalone demo, keeps one address and installs
// nothing. Opening a page pushes its address, so reload, back, forward and a shared link
// all land on it; back and forward open the page they return to. A template page's entries
// are pages of their own here, each with its address (/docs/introduction/): they share the
// template's file, and the route the client reports says which entry the canvas shows. A canvas link to a
// route that is no page (a docs entry, a download) takes the visitor to that address,
// where the site serves it as it is. The client's half is
// `src/features/project/pageAddress.ts`.
import { assert } from '../vendor/stacki/shared/core/assert';
import type { BakePage } from '../src/features/bake/bakeSnapshot';
import { PAGE_ADDRESS_GLOBAL, type PageAddressHost } from '../src/features/project/pageAddress';

export const DEMO_PAGE_META = 'stacki-demo-page';

/** Longer than any page title a visitor reads in a tab. */
const TITLE_LENGTH_MAX = 300;
/** The history entry's own record of its page, which outlives an address that names none (the 404 page). */
const STATE_ROUTE = 'stackiDemoRoute';

/** The parts of `window` this needs, so the rules run in a test without a browser. */
export interface AddressWindow {
  readonly history: {
    readonly state: unknown;
    readonly pushState: (state: unknown, unused: string, url: string) => void;
    readonly replaceState: (state: unknown, unused: string, url?: string) => void;
  };
  readonly location: { readonly pathname: string; readonly assign: (url: string) => void };
  readonly document: { title: string };
  readonly addEventListener: (type: 'popstate', listener: () => void) => void;
  readonly removeEventListener: (type: 'popstate', listener: () => void) => void;
}

export interface PageAddressOptions {
  readonly pages: readonly BakePage[];
  /** The route the serving page stands for. */
  readonly route: string;
  /** Where the canvas's copy of the site lives, `/demo/site/`. */
  readonly base: string;
  readonly window: AddressWindow;
  /** The page's own title, read from its baked document. */
  readonly title: (page: BakePage) => Promise<string | undefined>;
}

/** Where the site serves a baked page: its document's directory, with the site's trailing slash. */
export function pageAddress(page: Pick<BakePage, 'document'>): string {
  assert(page.document.endsWith('.html'), 'A baked page is an HTML document');
  assert(!page.document.startsWith('/'), 'A baked document is relative to the site');
  if (page.document === 'index.html') {
    return '/';
  }
  if (page.document.endsWith('/index.html')) {
    return `/${page.document.slice(0, -'index.html'.length)}`;
  }
  return `/${page.document.slice(0, -'.html'.length)}`;
}

/** The baked page an address names, with or without its trailing slash. */
export function pageAtAddress(pages: readonly BakePage[], pathname: string): BakePage | undefined {
  const target = withoutTrailingSlash(pathname);
  return pages.find((page) => withoutTrailingSlash(page.route) === target || withoutTrailingSlash(pageAddress(page)) === target);
}

/** The title in a page's HTML, with the entities Astro writes decoded. */
export function documentTitle(html: string): string | undefined {
  // A baked title carries the editor's marker attributes.
  const match = /<title\b[^>]*>([^<]*)<\/title>/i.exec(html);
  const raw = match?.[1];
  if (raw === undefined || raw.length > TITLE_LENGTH_MAX) {
    return undefined;
  }
  return raw.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (entity) => ENTITIES[entity] ?? entity);
}

const ENTITIES: Readonly<Record<string, string>> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'" };

/** The page the serving document stands for, or undefined when it stands for none. */
export function servedRoute(document: Pick<Document, 'querySelector'>): string | undefined {
  const route = document.querySelector<HTMLMetaElement>(`meta[name=${DEMO_PAGE_META}]`)?.content;
  return route !== undefined && route.startsWith('/') && !route.startsWith('//') ? route : undefined;
}

/** Builds the host the client reads. Installs nothing; `installPageAddress` publishes it. */
export function pageAddressHostFor(options: PageAddressOptions): PageAddressHost {
  const { pages, window: target } = options;
  const first = pages.find((page) => page.route === options.route);
  assert(first !== undefined, 'The serving page stands for a baked page');
  let current = first;
  let titleRequest = 0;
  const show = (page: BakePage) => {
    current = page;
    titleRequest += 1;
    const request = titleRequest;
    void options.title(page).then((title) => {
      if (title !== undefined && request === titleRequest) {
        target.document.title = title;
      }
    });
  };
  target.history.replaceState({ [STATE_ROUTE]: first.route }, '');
  return {
    initialFile: () => first.file,
    initialRoute: () => first.route,
    opened: (file, route, history) => {
      // A template's entries share its file, so the route says which one is showing.
      const page = pages.find((candidate) => candidate.file === file && withoutTrailingSlash(candidate.route) === withoutTrailingSlash(route));
      if (page !== undefined && page !== current) {
        // The preview frame's own navigation already made the entry (frames share the
        // tab's history): the address takes it over, so back steps once per page.
        if (history === 'replace') {
          target.history.replaceState({ [STATE_ROUTE]: page.route }, '', pageAddress(page));
        } else {
          target.history.pushState({ [STATE_ROUTE]: page.route }, '', pageAddress(page));
        }
        show(page);
      }
    },
    listen: (open) => {
      const moved = () => {
        const page = stateRoutePage(pages, target.history.state) ?? pageAtAddress(pages, target.location.pathname);
        if (page !== undefined && page !== current) {
          show(page);
          open(page.file, page.route);
        }
      };
      target.addEventListener('popstate', moved);
      return () => target.removeEventListener('popstate', moved);
    },
    leave: (route) => {
      if (!route.startsWith('/') || route.startsWith('//')) {
        return false;
      }
      if (`${route}/`.startsWith(options.base)) {
        return false; // The canvas's own copy of the site is never a page to stand on.
      }
      target.location.assign(route);
      return true;
    },
  };
}

/** Publishes the host before the client loads, when the serving page stands for a baked page. */
export function installPageAddress(options: PageAddressOptions): void {
  if (!options.pages.some((page) => page.route === options.route)) {
    return; // A page the bake did not keep: the editor opens on the home page, as Studio does.
  }
  Object.defineProperty(globalThis, PAGE_ADDRESS_GLOBAL, { value: pageAddressHostFor(options), configurable: false, enumerable: false, writable: false });
}

function stateRoutePage(pages: readonly BakePage[], state: unknown): BakePage | undefined {
  if (typeof state !== 'object' || state === null) {
    return undefined;
  }
  const route: unknown = Reflect.get(state, STATE_ROUTE);
  return typeof route === 'string' ? pages.find((page) => page.route === route) : undefined;
}

function withoutTrailingSlash(path: string): string {
  return path.replace(/\/+$/, '') || '/';
}
