// Goal: when the demo stands at a site's own addresses, the address bar and the page on
// the canvas follow each other both ways, and Studio without a host is unchanged.
// Method: build the demo's host against a stand-in window (history, location, title and
// popstate), read it back through the client's own checked reader, and drive it as the
// client does: open pages, go back and forward, follow a canvas link to a route that is
// no page, and stand at an address that names no page (the 404 page). Malformed hosts
// and host answers are refused by the reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documentTitle, pageAddress, pageAddressHostFor, pageAtAddress, type AddressWindow } from '../demo/pageAddress';
import { PAGE_ADDRESS_GLOBAL, pageAddressHost } from '../src/features/project/pageAddress';
import type { BakePage } from '../src/features/bake/bakeSnapshot';

const PAGES: readonly BakePage[] = [
  { file: 'src/pages/index.astro', route: '/', document: 'index.html' },
  { file: 'src/pages/studio.astro', route: '/studio', document: 'studio/index.html' },
  { file: 'src/pages/docs/index.astro', route: '/docs', document: 'docs/index.html' },
  { file: 'src/pages/404.astro', route: '/404', document: '404.html' },
];

interface StandIn extends AddressWindow {
  readonly entries: { state: unknown; url: string }[];
  readonly assigned: string[];
  back: () => void;
}

function standIn(pathname: string): StandIn {
  const entries: { state: unknown; url: string }[] = [{ state: null, url: pathname }];
  let index = 0;
  const listeners = new Set<() => void>();
  const assigned: string[] = [];
  const document = { title: 'Served' };
  return {
    entries,
    assigned,
    document,
    history: {
      get state() {
        return entries[index]?.state;
      },
      pushState: (state, _unused, url) => {
        entries.splice(index + 1);
        entries.push({ state, url });
        index = entries.length - 1;
      },
      replaceState: (state, _unused, url) => {
        const entry = entries[index];
        assert(entry !== undefined);
        entry.state = state;
        entry.url = url ?? entry.url;
      },
    },
    location: {
      get pathname() {
        return entries[index]?.url ?? '/';
      },
      assign: (url) => void assigned.push(url),
    },
    addEventListener: (_type, listener) => void listeners.add(listener),
    removeEventListener: (_type, listener) => void listeners.delete(listener),
    back: () => {
      assert(index > 0, 'There is an entry to go back to');
      index -= 1;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

const titles = async (page: BakePage) => `Title of ${page.route}`;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a baked page is served at its directory, with the trailing slash the site uses', () => {
  assert.equal(pageAddress({ document: 'index.html' }), '/');
  assert.equal(pageAddress({ document: 'studio/index.html' }), '/studio/');
  assert.equal(pageAddress({ document: 'docs/guide/index.html' }), '/docs/guide/');
  assert.equal(pageAddress({ document: '404.html' }), '/404');
  assert.throws(() => pageAddress({ document: '/index.html' }), /relative to the site/);
  assert.throws(() => pageAddress({ document: 'index.txt' }), /HTML document/);
});

test('an address names its page with or without the trailing slash, and nothing else', () => {
  assert.equal(pageAtAddress(PAGES, '/studio/')?.route, '/studio');
  assert.equal(pageAtAddress(PAGES, '/studio')?.route, '/studio');
  assert.equal(pageAtAddress(PAGES, '/')?.route, '/');
  assert.equal(pageAtAddress(PAGES, '/docs/introduction/'), undefined);
  assert.equal(pageAtAddress(PAGES, '/studio-x/'), undefined);
});

test('the title comes from the page, decoded, and an oversized or missing one is refused', () => {
  assert.equal(documentTitle('<head><title>Docs &amp; guides | Stacki</title></head>'), 'Docs & guides | Stacki');
  assert.equal(documentTitle('<title data-avb-p="a|7 0">Docs | Stacki</title>'), 'Docs | Stacki', 'Baked titles carry markers');
  assert.equal(documentTitle('<head></head>'), undefined);
  assert.equal(documentTitle(`<title>${'x'.repeat(301)}</title>`), undefined);
});

test('opening pages pushes their addresses and titles, and back reopens the page', async () => {
  const window = standIn('/studio/');
  const host = pageAddressHostFor({ pages: PAGES, route: '/studio', base: '/demo/site/', window, title: titles });
  assert.equal(host.initialFile(), 'src/pages/studio.astro');
  const reopened: string[] = [];
  const stop = host.listen((file) => reopened.push(file));
  host.opened('src/pages/studio.astro', '/studio', 'push');
  assert.equal(window.entries.length, 1, 'The page already shown pushes nothing');
  host.opened('src/pages/docs/index.astro', '/docs', 'push');
  assert.deepEqual(
    window.entries.map((entry) => entry.url),
    ['/studio/', '/docs/'],
  );
  await settle();
  assert.equal(window.document.title, 'Title of /docs');
  host.opened('src/components/Card.astro', '/', 'push');
  assert.equal(window.entries.length, 2, 'A file that is not a baked page has no address');
  window.back();
  assert.deepEqual(reopened, ['src/pages/studio.astro']);
  await settle();
  assert.equal(window.document.title, 'Title of /studio');
  host.opened('src/pages/studio.astro', '/studio', 'push');
  assert.equal(window.entries.length, 2, 'The client reporting the page back opens no new entry');
  stop();
});

test('a page the preview frame went to itself takes over its entry: back steps once per page', async () => {
  const window = standIn('/studio/');
  const host = pageAddressHostFor({ pages: PAGES, route: '/studio', base: '/demo/site/', window, title: titles });
  // The frame's own navigation made the entry; the address only names it.
  host.opened('src/pages/docs/index.astro', '/docs', 'replace');
  assert.deepEqual(
    window.entries.map((entry) => entry.url),
    ['/docs/'],
  );
  await settle();
  assert.equal(window.document.title, 'Title of /docs');
  host.opened('src/pages/studio.astro', '/studio', 'push');
  assert.deepEqual(
    window.entries.map((entry) => entry.url),
    ['/docs/', '/studio/'],
    'A page picked in the switcher still pushes',
  );
});

test('an address that names no page keeps its page in the history entry', () => {
  const window = standIn('/missing/');
  const host = pageAddressHostFor({ pages: PAGES, route: '/404', base: '/demo/site/', window, title: titles });
  const reopened: string[] = [];
  host.listen((file) => reopened.push(file));
  host.opened('src/pages/index.astro', '/', 'push');
  window.back();
  assert.deepEqual(reopened, ['src/pages/404.astro']);
  assert.equal(window.location.pathname, '/missing/');
});

test('a canvas link to a route that is no page goes to that address on the site', () => {
  const window = standIn('/docs/');
  const host = pageAddressHostFor({ pages: PAGES, route: '/docs', base: '/demo/site/', window, title: titles });
  assert.equal(host.leave('/docs/introduction'), true);
  assert.equal(host.leave('//elsewhere.example/'), false);
  assert.equal(host.leave('/demo/site/404'), false, 'The canvas copy is never left for');
  assert.equal(host.leave('/demo/site'), false);
  assert.deepEqual(window.assigned, ['/docs/introduction']);
});

test('a served route the bake did not keep is a programmer error', () => {
  assert.throws(
    () => pageAddressHostFor({ pages: PAGES, route: '/pricing', base: '/demo/site/', window: standIn('/pricing/'), title: titles }),
    /stands for a baked page/,
  );
});

test('the client reads a host only when every member is a function, and checks its answers', () => {
  assert.equal(pageAddressHost(), undefined, 'Studio without a host keeps its own navigation');
  const window = standIn('/studio/');
  const good = pageAddressHostFor({ pages: PAGES, route: '/studio', base: '/demo/site/', window, title: titles });
  const install = (value: unknown) => Reflect.set(globalThis, PAGE_ADDRESS_GLOBAL, value);
  try {
    install({ ...good, leave: 'no' });
    assert.equal(pageAddressHost(), undefined);
    install({ ...good, initialFile: () => '../secrets.astro' });
    assert.equal(pageAddressHost()?.initialFile(), undefined);
    install({ ...good, initialFile: () => 42 });
    assert.equal(pageAddressHost()?.initialFile(), undefined);
    install(good);
    const host = pageAddressHost();
    assert.equal(host?.initialFile(), 'src/pages/studio.astro');
    assert.throws(() => host?.leave('relative'), /site path/);
    const opened: string[] = [];
    install({ ...good, listen: (open: (file: unknown) => void) => (open(7), open('src/pages/x.astro'), 'not a function') });
    pageAddressHost()?.listen((file) => opened.push(file))();
    assert.deepEqual(opened, ['src/pages/x.astro']);
  } finally {
    Reflect.deleteProperty(globalThis, PAGE_ADDRESS_GLOBAL);
  }
});

const TEMPLATE = 'src/pages/docs/[...slug].astro';
const ENTRIES: readonly BakePage[] = [
  ...PAGES,
  { file: TEMPLATE, route: '/docs/introduction', document: 'docs/introduction/index.html', entry: 'introduction' },
  { file: TEMPLATE, route: '/docs/quick-start', document: 'docs/quick-start/index.html', entry: 'quick-start' },
];

test("a template's entries share its file, and the route says which one the address shows", async () => {
  const window = standIn('/docs/quick-start/');
  const host = pageAddressHostFor({ pages: ENTRIES, route: '/docs/quick-start', base: '/demo/site/', window, title: titles });
  assert.equal(host.initialFile(), TEMPLATE);
  assert.equal(host.initialRoute(), '/docs/quick-start');
  const reopened: (readonly [string, string | undefined])[] = [];
  host.listen((file, route) => reopened.push([file, route]));
  host.opened(TEMPLATE, '/docs/quick-start', 'push');
  assert.equal(window.entries.length, 1, 'The entry already shown pushes nothing');
  host.opened(TEMPLATE, '/docs/introduction', 'push');
  assert.deepEqual(
    window.entries.map((entry) => entry.url),
    ['/docs/quick-start/', '/docs/introduction/'],
  );
  await settle();
  assert.equal(window.document.title, 'Title of /docs/introduction');
  host.opened(TEMPLATE, '/docs/missing', 'push');
  assert.equal(window.entries.length, 2, 'An entry the bake did not keep has no address');
  window.back();
  assert.deepEqual(reopened, [[TEMPLATE, '/docs/quick-start']]);
  assert.equal(pageAtAddress(ENTRIES, '/docs/introduction/')?.entry, 'introduction');
});

test('the client reads an optional initial route and checks it', () => {
  const window = standIn('/docs/introduction/');
  const good = pageAddressHostFor({ pages: ENTRIES, route: '/docs/introduction', base: '/demo/site/', window, title: titles });
  const install = (value: unknown) => Reflect.set(globalThis, PAGE_ADDRESS_GLOBAL, value);
  try {
    install(good);
    assert.equal(pageAddressHost()?.initialRoute(), '/docs/introduction');
    install({ ...good, initialRoute: () => '//elsewhere' });
    assert.equal(pageAddressHost()?.initialRoute(), undefined);
    const { initialRoute: _dropped, ...older } = good;
    install(older);
    assert.equal(pageAddressHost()?.initialRoute(), undefined, 'A host without it names no entry');
    const opened: (readonly [string, string | undefined])[] = [];
    install({ ...good, listen: (open: (file: unknown, route: unknown) => void) => (open(TEMPLATE, '/docs/a'), open(TEMPLATE, 7), () => undefined) });
    pageAddressHost()?.listen((file, route) => opened.push([file, route]))();
    assert.deepEqual(opened, [
      [TEMPLATE, '/docs/a'],
      [TEMPLATE, undefined],
    ]);
    assert.throws(() => pageAddressHost()?.opened(TEMPLATE, 'relative', 'push'), /site route/);
  } finally {
    Reflect.deleteProperty(globalThis, PAGE_ADDRESS_GLOBAL);
  }
});
