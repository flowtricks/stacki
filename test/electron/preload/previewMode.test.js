// Goal: the interactive preview is the visitor's site, not an editor surface. A
// click is never kept for selection there: a link to one of the site's pages is
// the browser's to follow as a full load (the static demo's own guard moves a root
// link under its base), a link that leaves the site or a download route opens in a new tab, a
// link within the page and a button are left entirely to the page. The preview
// says which page it is on after a client-side navigation as well as after a
// load, and the page switcher and the preview drive each other: the pure rules
// for that are pinned on literal paths.
// Method: build the shared frame module (frameInteraction.ts) against a jsdom
// window at a preview address (`#avb-preview`, never `#avb-design`), with
// `window.open` and `location.assign` recorded, the listeners installed as Studio's
// client installs them, and a stand-in for the demo's link guard after them. The
// built preload runs in a second jsdom frame to check its navigation reports.
// The Desktop switcher rules (src/app/model/previewPage.ts) are pure.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const loadRenderer = require('../../helpers/rendererModule');

const DEMO_FRAME = 'http://localhost:8787/demo/site/#avb-preview';
const PAGES = { base: '/demo/site', routes: ['/', '/about', '/docs/[...slug]'] };
const PAGE =
  '<!doctype html><body>' +
  '<a id="about" href="/about"><span id="words">About</span></a>' +
  '<a id="based" href="/demo/site/about/">About, under the base</a>' +
  '<a id="docs" href="/docs/intro">Docs entry</a>' +
  '<a id="download" href="/download/mac">Download for Mac</a>' +
  '<a id="discord" href="https://discord.gg/example">Community</a>' +
  '<a id="pricing" href="#pricing">Pricing</a>' +
  '<a id="mail" href="mailto:hello@example.com">Mail</a>' +
  '<button id="watch">Watch tutorial</button>' +
  '</body>';

// Globals the frame module reads at load and when a click arrives.
function install(window) {
  const globals = { window, document: window.document, location: window.location, Element: window.Element, MouseEvent: window.MouseEvent };
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(global, name, { value, configurable: true, writable: true });
  }
}

function previewFrame(url = DEMO_FRAME) {
  const { window } = new JSDOM(PAGE, { url, pretendToBeVisual: true });
  install(window);
  const opened = [];
  const assigned = [];
  window.open = (address, target, features) => {
    opened.push({ address, target, features });
    return undefined;
  };
  // jsdom's location cannot be stubbed per property, so the module's global is a stand-in that reads through.
  const location = {
    get href() {
      return window.location.href;
    },
    get hash() {
      return window.location.hash;
    },
    get origin() {
      return window.location.origin;
    },
    assign: (address) => assigned.push(address),
  };
  Object.defineProperty(global, 'location', { value: location, configurable: true, writable: true });
  const frame = loadRenderer('electron/preload/frameInteraction.ts');
  const ran = [];
  window.document.getElementById('watch').addEventListener('click', () => ran.push('watch'));
  // Installed first, as Studio's client does (previewLinks.ts); `guard` stands in for the
  // static demo's link guard (staticHot.ts), which holds root links in capture after it.
  frame.installPreviewLinks();
  const guarded = [];
  window.addEventListener(
    'click',
    (event) => {
      const link = event.target instanceof window.Element ? (event.target.closest('a[href]') ?? undefined) : undefined;
      if (link && guard.enabled && link.origin === window.location.origin && !link.pathname.startsWith('/demo/site/')) {
        event.preventDefault();
        guarded.push(link.getAttribute('href'));
      }
    },
    true,
  );
  const guard = { enabled: false };
  const click = (id, init = {}) => {
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
    window.document.getElementById(id).dispatchEvent(event);
    return event;
  };
  return { frame, window, opened, assigned, ran, click, guard, guarded };
}

test('the preview frame is not the canvas: nothing selects, and the cursor is the page own', () => {
  const { frame } = previewFrame();
  assert.equal(frame.canvasSelects(), false);
  assert.equal(frame.canvasInert(), false);
});

test("a link to a site page is the browser's to follow, under the demo base by the demo's own guard", () => {
  const { frame, click, assigned, opened, guard, guarded } = previewFrame();
  frame.setCanvasSitePages(PAGES);
  assert.equal(click('words').defaultPrevented, false, 'without the guard, the browser follows it');
  guard.enabled = true;
  click('words');
  click('docs');
  assert.deepEqual(guarded, ['/about', '/docs/intro'], "the demo's guard sees root page links, a template's entry too");
  assert.deepEqual([...assigned, ...opened], [], 'the preview loads nothing itself');
});

test('a link that already works as written is left to the page and the browser', () => {
  const { frame, click, assigned, opened } = previewFrame();
  frame.setCanvasSitePages(PAGES);
  for (const id of ['based', 'pricing', 'mail']) {
    assert.equal(click(id).defaultPrevented, false, id);
  }
  const { frame: root, click: rootClick, assigned: rootAssigned } = previewFrame('http://localhost:4321/#avb-preview');
  root.setCanvasSitePages({ base: '', routes: PAGES.routes });
  assert.equal(rootClick('about').defaultPrevented, false, 'at the site root the browser follows it');
  assert.deepEqual([...assigned, ...rootAssigned, ...opened], []);
});

test('a download route and a link off the site open in a new tab', () => {
  const { frame, click, opened, assigned } = previewFrame();
  frame.setCanvasSitePages(PAGES);
  assert.equal(click('download').defaultPrevented, true);
  assert.equal(click('discord').defaultPrevented, true);
  assert.deepEqual(
    opened.map((entry) => [entry.address, entry.target, entry.features]),
    [
      ['http://localhost:8787/download/mac', '_blank', 'noopener,noreferrer'],
      ['https://discord.gg/example', '_blank', 'noopener,noreferrer'],
    ],
  );
  assert.deepEqual(assigned, []);
});

test("a button runs the page's own script, and a link the page took is left to it", () => {
  const { frame, window, click, ran, opened, assigned } = previewFrame();
  frame.setCanvasSitePages(PAGES);
  assert.equal(click('watch').defaultPrevented, false);
  assert.deepEqual(ran, ['watch']);
  // A lightbox's link script cancels the click before it bubbles to the window.
  const discord = window.document.getElementById('discord');
  discord.addEventListener('click', (event) => event.preventDefault());
  click('discord');
  assert.deepEqual([...opened, ...assigned], []);
});

test("a download route never reaches the demo's link guard, which would keep it as a missing page", () => {
  const { frame, click, opened, assigned, guard, guarded } = previewFrame();
  frame.setCanvasSitePages(PAGES);
  guard.enabled = true;
  click('download');
  assert.deepEqual(guarded, []);
  assert.deepEqual(
    opened.map((entry) => entry.address),
    ['http://localhost:8787/download/mac'],
  );
  assert.deepEqual(assigned, []);
});

test('a canvas frame keeps its clicks: the preview listeners do nothing there', () => {
  const { frame, click, opened, assigned } = previewFrame('http://localhost:4321/#avb-design');
  frame.setCanvasSitePages({ base: '', routes: PAGES.routes });
  assert.equal(click('discord').defaultPrevented, false);
  assert.equal(click('download').defaultPrevented, false);
  assert.deepEqual([...opened, ...assigned], []);
});

test('the preload reports a client-side navigation in the preview, not only a load', async () => {
  const { window } = new JSDOM('<!doctype html><body><a href="/docs">Docs</a></body>', { url: 'http://127.0.0.1:4321/#avb-preview', pretendToBeVisual: true });
  install(window);
  Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true, writable: true });
  Object.defineProperty(global, 'MutationObserver', { value: window.MutationObserver, configurable: true, writable: true });
  Object.defineProperty(global, 'Node', { value: window.Node, configurable: true, writable: true });
  Object.defineProperty(global, 'HTMLStyleElement', { value: window.HTMLStyleElement, configurable: true, writable: true });
  Object.defineProperty(global, 'getComputedStyle', { value: window.getComputedStyle.bind(window), configurable: true, writable: true });
  Object.defineProperty(global, 'requestAnimationFrame', { value: window.requestAnimationFrame.bind(window), configurable: true, writable: true });
  const sent = [];
  window.parent = { postMessage: (message) => sent.push(message) };
  const electron = { contextBridge: { exposeInMainWorld: () => {} }, ipcRenderer: { on: () => {}, send: () => {}, invoke: async () => {} }, webUtils: {} };
  const realRequire = Module.prototype.require;
  Module.prototype.require = function (id) {
    return id === 'electron' ? electron : realRequire.apply(this, arguments);
  };
  process.isMainFrame = false;
  const entry = repoPath('dist/electron/preload/preload.js');
  delete require.cache[entry];
  try {
    require(entry);
  } finally {
    Module.prototype.require = realRequire;
  }
  await new Promise((resolve) => setTimeout(resolve, 80));
  const navigated = () => sent.filter((message) => message.type === 'avb:navigated').map((message) => message.path);
  assert.deepEqual(navigated(), ['/'], 'the load is reported');
  window.history.pushState({}, '', '/docs');
  window.document.dispatchEvent(new window.Event('astro:page-load'));
  assert.deepEqual(navigated().at(-1), '/docs', "Astro's router swapping in a page is reported too");
  assert.equal(window.document.documentElement.classList.contains('stacki-preview'), true);
  const link = window.document.querySelector('a');
  const event = new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  link.dispatchEvent(event);
  assert.equal(
    sent.some((message) => message.type === 'avb:click-node'),
    false,
    'nothing is selected in the preview',
  );
});

test('Desktop: the switcher and the preview follow each other by route', () => {
  const { previewRouteOf, previewPageFor, previewNeedsPath } = loadRenderer('src/app/model/previewPage.ts');
  const pages = [
    { route: '/', path: 'src/pages/index.astro' },
    { route: '/studio', path: 'src/pages/studio.astro' },
    { route: '/docs/[...slug]', path: 'src/pages/docs/[...slug].astro' },
  ];
  assert.equal(previewRouteOf('/studio/?tab=1#top'), '/studio');
  assert.equal(previewRouteOf('/'), '/');
  assert.equal(previewPageFor(pages, '/studio/')?.path, 'src/pages/studio.astro');
  assert.equal(previewPageFor(pages, '/docs/intro'), undefined, 'a dynamic entry is not opened by guess');
  assert.equal(previewNeedsPath('/studio', '/studio/'), false, 'the preview opened the page itself: no reload');
  assert.equal(previewNeedsPath('/studio', '/docs'), true, 'a page picked in the switcher loads');
  assert.equal(previewNeedsPath(undefined, '/'), true);
  assert.equal(previewNeedsPath('/', undefined), false);
  assert.throws(() => previewRouteOf('studio'), /a site path/);
});
