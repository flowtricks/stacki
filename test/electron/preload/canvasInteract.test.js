// Goal: the canvas's interact mode is select mode plus one difference. A click
// still selects (the app is told which node), and the page also receives the
// activation: a button's own listener runs, and a link navigates once the
// double-click window has passed, unless a second click turns it into a
// double-click. Select mode keeps links inert, as it always has. A link that
// is not one of the site's pages never navigates the canvas: a web link opens
// in the browser, anything else does nothing, and a page script sending the
// frame to another site is cancelled. Main refuses the same navigations for
// every frame (electron/app/previewNavigation.ts).
// Method: run the real built preload in jsdom as a tracked canvas frame, with
// the parent's postMessage captured, `window.open` and the Navigation API
// stubbed, and jsdom's "navigation not implemented" report standing in for the
// browser following a link. The link rules themselves are pure and pinned on
// literal URLs.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { JSDOM, VirtualConsole } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const loadRenderer = require('../../helpers/rendererModule');
const { refusesPreviewNavigation } = require('#dist/electron/app/previewNavigation.js');

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
// LINK_HOLD_MS in electron/preload/frameInteraction.ts, with room for the timer.
const LINK_HOLD_WAIT_MS = 350 + 150;
const PAGE =
  '<!doctype html><body>' +
  '<!--avb-s:0--><button id="menu">Menu</button><!--avb-e:0-->' +
  '<!--avb-s:1--><a id="about" href="/about/"><span id="words">About us</span></a><!--avb-e:1-->' +
  '<!--avb-s:2--><a id="github" href="https://github.com/flowtricks/stacki">GitHub</a><!--avb-e:2-->' +
  '<!--avb-s:3--><a id="mail" href="mailto:hello@example.com">Mail</a><!--avb-e:3-->' +
  '<!--avb-s:4--><a id="tab" href="/docs/" target="_blank">Docs</a><!--avb-e:4-->' +
  '<!--avb-s:5--><a id="download" href="/download/mac">Download for Mac</a><!--avb-e:5-->' +
  '<!--avb-s:6--><input id="field" type="text"><!--avb-e:6-->' +
  '<!--avb-s:7--><a id="menu-link" href="#">Open menu</a><!--avb-e:7-->' +
  '</body>';

async function frame() {
  const navigations = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => {
    if (String(error.message).includes('navigation')) {
      navigations.push(error.message);
    }
  });
  const dom = new JSDOM(PAGE, { url: 'http://127.0.0.1:4321/#avb-design', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  const opened = [];
  window.open = (url, target, features) => {
    opened.push({ url, target, features });
    return undefined; // `noopener` hands back no window.
  };
  // The Navigation API, as Chromium has it: navigate events the frame may cancel.
  window.navigation = new window.EventTarget();
  const BOX = { x: 0, y: 0, width: 100, height: 20, left: 0, top: 0, right: 100, bottom: 20 };
  window.Element.prototype.getBoundingClientRect = () => BOX;
  window.Range.prototype.getBoundingClientRect = () => BOX;
  window.Range.prototype.getClientRects = () => [BOX];
  const sent = [];
  const globals = {
    window,
    document: window.document,
    location: window.location,
    navigator: window.navigator,
    MutationObserver: window.MutationObserver,
    Element: window.Element,
    HTMLStyleElement: window.HTMLStyleElement,
    getComputedStyle: window.getComputedStyle.bind(window),
    Node: window.Node,
    MouseEvent: window.MouseEvent,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
  };
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(global, name, { value, configurable: true, writable: true });
  }
  window.parent = { postMessage: (message) => sent.push(message) };
  const electron = {
    contextBridge: { exposeInMainWorld: () => {} },
    ipcRenderer: { on: () => {}, send: () => {}, invoke: async () => {} },
    webUtils: {},
  };
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
  await settle();
  const message = (data) => {
    const event = new window.MessageEvent('message', { data });
    Object.defineProperty(event, 'source', { value: window.parent });
    window.dispatchEvent(event);
  };
  message({ type: 'avb:track', paths: ['0', '1', '2', '3', '4', '5', '6', '7'], scope: '', focus: '', focusOcc: 0 });
  await settle();
  const click = (element, detail = 1) => {
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail });
    element.dispatchEvent(event);
    return event;
  };
  const selections = () => sent.filter((item) => item.type === 'avb:click-node').map((item) => item.path);
  const navigate = (url) => {
    const event = new window.Event('navigate', { cancelable: true });
    Object.defineProperty(event, 'destination', { value: { url } });
    window.navigation.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const key = (element, value) => {
    const event = new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event;
  };
  return {
    window,
    sent,
    opened,
    navigations,
    navigate,
    click,
    key,
    message,
    selections,
    mode: (value) => message({ type: 'avb:interaction', mode: value }),
  };
}

test('interact mode: a click selects a button and runs its own listener', async () => {
  const page = await frame();
  try {
    page.mode('interact');
    const button = page.window.document.getElementById('menu');
    let opened = 0;
    button.addEventListener('click', () => {
      opened += 1;
    });
    const event = page.click(button);
    assert.equal(event.defaultPrevented, false, 'the page keeps the click');
    assert.equal(opened, 1, "the button's own listener ran");
    assert.deepEqual(page.selections(), ['0'], 'the click still selected the button');
    const style = page.window.document.getElementById('avb-design-style');
    assert.equal(style?.disabled, false, 'the canvas keeps its cursor sheet');
    assert.match(style?.textContent ?? '', /:where\(html\) \{ cursor: default; \}/, 'the editor arrow over text, never the I-beam');
    assert.match(style?.textContent ?? '', /a\[href\][^{]*\{ cursor: pointer; \}/, 'the pointer over what acts on a click');
    assert.doesNotMatch(style?.textContent ?? '', /!important/, 'a cursor the page sets wins');
  } finally {
    page.window.close();
  }
});

test('interact mode: a link click selects at once and navigates after the double-click window', async () => {
  const page = await frame();
  try {
    page.mode('interact');
    const link = page.window.document.getElementById('about');
    const seen = [];
    link.addEventListener('click', (event) => seen.push(event.defaultPrevented));
    const event = page.click(page.window.document.getElementById('words'));
    assert.deepEqual(page.selections(), ['1'], 'the click selected the link');
    assert.equal(event.defaultPrevented, true, 'the real click is held back');
    assert.deepEqual(seen, [], 'the page has not seen it yet');
    await settle(LINK_HOLD_WAIT_MS);
    assert.deepEqual(seen, [], 'the canvas loads the page itself: no client-side router swaps it in unmarked');
    assert.equal(page.navigations.length, 1, 'the link was followed');
    assert.deepEqual(page.selections(), ['1'], 'the replayed click selected nothing again');
  } finally {
    page.window.close();
  }
});

test('interact mode: a double-click on a link stays on the page', async () => {
  const page = await frame();
  try {
    page.mode('interact');
    const words = page.window.document.getElementById('words');
    page.click(words, 1);
    page.click(words, 2);
    await settle(LINK_HOLD_WAIT_MS);
    assert.equal(page.navigations.length, 0, 'the second click cancelled the navigation');
    assert.deepEqual(page.selections(), ['1', '1']);
  } finally {
    page.window.close();
  }
});

test('interact mode: switching back to select mode cancels a held link click', async () => {
  const page = await frame();
  try {
    page.mode('interact');
    page.click(page.window.document.getElementById('words'));
    page.mode('select');
    await settle(LINK_HOLD_WAIT_MS);
    assert.equal(page.navigations.length, 0);
  } finally {
    page.window.close();
  }
});

test('select mode: a link click selects and never navigates; a button keeps its listener quiet', async () => {
  const page = await frame();
  try {
    const button = page.window.document.getElementById('menu');
    let opened = 0;
    button.addEventListener('click', () => {
      opened += 1;
    });
    assert.equal(page.click(page.window.document.getElementById('words')).defaultPrevented, true);
    assert.equal(page.click(button).defaultPrevented, true);
    await settle(LINK_HOLD_WAIT_MS);
    assert.equal(page.navigations.length, 0, 'select mode keeps links inert');
    assert.equal(opened, 0, 'select mode keeps page scripts quiet');
    assert.deepEqual(page.selections(), ['1', '0']);
    assert.equal(page.window.document.getElementById('avb-design-style')?.disabled, false, 'the editor cursor shows');
    assert.equal(page.window.document.getElementById('avb-design-style')?.textContent, '*, *::before, *::after { cursor: default !important; }');
  } finally {
    page.window.close();
  }
});

test('interact mode: a link to another site selects, opens in the browser and leaves the canvas where it is', async () => {
  const page = await frame();
  try {
    page.mode('interact');
    const event = page.click(page.window.document.getElementById('github'));
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(page.selections(), ['2'], 'the click still selected the link');
    await settle(LINK_HOLD_WAIT_MS);
    assert.deepEqual(page.opened, [{ url: 'https://github.com/flowtricks/stacki', target: '_blank', features: 'noopener,noreferrer' }]);
    assert.equal(page.navigations.length, 0, 'the frame did not navigate');
    assert.equal(page.window.location.href, 'http://127.0.0.1:4321/#avb-design');
  } finally {
    page.window.close();
  }
});

test('interact mode: mailto: and target=_blank never navigate the canvas', async () => {
  const page = await frame();
  try {
    page.mode('interact');
    page.click(page.window.document.getElementById('mail'));
    await settle(LINK_HOLD_WAIT_MS);
    page.click(page.window.document.getElementById('tab'));
    await settle(LINK_HOLD_WAIT_MS);
    assert.deepEqual(
      page.opened.map((item) => item.url),
      ['http://127.0.0.1:4321/docs/'],
      'mailto: opens nothing, as on Desktop; a new-tab link opens in the browser',
    );
    assert.equal(page.navigations.length, 0);
    assert.deepEqual(page.selections(), ['3', '4']);
  } finally {
    page.window.close();
  }
});

test('the canvas cancels a page script sending it to another site, in either mode', async () => {
  const page = await frame();
  try {
    assert.equal(page.navigate('https://github.com/'), true, 'select mode');
    page.mode('interact');
    assert.equal(page.navigate('https://github.com/'), true, 'interact mode');
    assert.equal(page.navigate('/about/#avb-design'), false, 'a page of the site loads');
  } finally {
    page.window.close();
  }
});

test('link rules: only a same-frame link on the site navigates; it keeps the design hash', () => {
  Object.defineProperty(global, 'location', { value: { hash: '' }, configurable: true, writable: true });
  const { canvasLinkDestination, canvasPageAddress, canvasLeavesOrigin } = loadRenderer('electron/preload/frameInteraction.ts');
  const FRAME = 'http://localhost:4321/demo/site/#avb-design';
  const plain = { newContext: false, pages: undefined };
  assert.deepEqual(canvasLinkDestination({ href: '/demo/site/about/', target: '', download: false }, FRAME, plain), { kind: 'page' });
  assert.deepEqual(canvasLinkDestination({ href: 'about/', target: '_self', download: false }, FRAME, plain), { kind: 'page' });
  assert.deepEqual(canvasLinkDestination({ href: '#pricing', target: '', download: false }, FRAME, plain), { kind: 'page' });
  assert.deepEqual(canvasLinkDestination({ href: 'javascript:void 0', target: '', download: false }, FRAME, plain), { kind: 'page' });
  assert.deepEqual(canvasLinkDestination({ href: 'https://github.com/x', target: '', download: false }, FRAME, plain), {
    kind: 'browser',
    url: 'https://github.com/x',
  });
  assert.deepEqual(canvasLinkDestination({ href: '/about/', target: '_blank', download: false }, FRAME, plain), {
    kind: 'browser',
    url: 'http://localhost:4321/about/',
  });
  assert.deepEqual(canvasLinkDestination({ href: '/about/', target: '_top', download: false }, FRAME, plain), {
    kind: 'browser',
    url: 'http://localhost:4321/about/',
  });
  assert.deepEqual(canvasLinkDestination({ href: '/about/', target: '', download: false }, FRAME, { newContext: true, pages: undefined }), {
    kind: 'browser',
    url: 'http://localhost:4321/about/',
  });
  assert.deepEqual(canvasLinkDestination({ href: 'http://localhost:9999/', target: '', download: false }, FRAME, plain), {
    kind: 'browser',
    url: 'http://localhost:9999/',
  });
  for (const href of ['mailto:a@b.c', 'tel:+15551234', 'file:///etc/passwd', 'stacki://open']) {
    assert.deepEqual(canvasLinkDestination({ href, target: '' }, FRAME, plain), { kind: 'none' }, href);
  }
  assert.equal(canvasPageAddress('/demo/site/about/', FRAME), 'http://localhost:4321/demo/site/about/#avb-design');
  assert.equal(canvasPageAddress('/demo/site/about/#team', FRAME), 'http://localhost:4321/demo/site/about/#avb-design');
  assert.equal(canvasPageAddress('#pricing', FRAME), undefined, 'a link within the page scrolls');
  assert.equal(canvasPageAddress('javascript:void 0', FRAME), undefined);
  assert.equal(canvasLeavesOrigin('https://github.com/', FRAME), true);
  assert.equal(canvasLeavesOrigin('/elsewhere', FRAME), false);
  assert.throws(
    () => canvasLinkDestination({ href: '/', target: '', download: false }, 'not a url', plain),
    /Assertion failed: canvasLinkDestination: the frame has a URL/,
  );
});

test('main refuses a preview frame leaving its site on its own, and nothing else', () => {
  const leaving = { currentURL: 'http://localhost:4321/about/#avb-design', targetURL: 'https://github.com/', initiatedByWindow: false, childOfWindow: true };
  assert.equal(refusesPreviewNavigation(leaving), true, 'a link, a script or a form sending the canvas elsewhere');
  assert.equal(refusesPreviewNavigation({ ...leaving, targetURL: 'http://localhost:4321/docs/' }), false, 'a page of the site');
  assert.equal(refusesPreviewNavigation({ ...leaving, initiatedByWindow: true }), false, 'the editor switching what the frame shows');
  assert.equal(refusesPreviewNavigation({ ...leaving, childOfWindow: false }), false, "the site's own embeds");
  assert.equal(refusesPreviewNavigation({ ...leaving, currentURL: 'about:blank' }), false, 'a frame that has loaded nothing yet');
  assert.equal(refusesPreviewNavigation({ ...leaving, targetURL: 'not a url' }), true, 'nowhere the canvas can show');
});

test('interact mode: a same-site link to no page of the site (a download route) opens in the browser', async () => {
  const page = await frame();
  try {
    page.message({ type: 'avb:site-pages', base: '', routes: ['/', '/about', '/blog/[slug]'] });
    page.mode('interact');
    page.click(page.window.document.getElementById('download'));
    await settle(LINK_HOLD_WAIT_MS);
    assert.deepEqual(
      page.opened.map((item) => item.url),
      ['http://127.0.0.1:4321/download/mac'],
      'as the live site would answer it',
    );
    assert.equal(page.navigations.length, 0, 'the canvas stays');
    page.click(page.window.document.getElementById('words'));
    await settle(LINK_HOLD_WAIT_MS);
    assert.equal(page.navigations.length, 1, 'a page of the site is still followed');
    assert.deepEqual(page.selections(), ['5', '1']);
  } finally {
    page.window.close();
  }
});

test('arrow keys move the selection from the canvas in both modes, and a field keeps them', async () => {
  const page = await frame();
  try {
    const heading = page.window.document.getElementById('menu');
    for (const mode of ['select', 'interact']) {
      page.mode(mode);
      page.sent.length = 0;
      const event = page.key(heading, 'ArrowUp');
      assert.equal(event.defaultPrevented, true, `${mode}: the page does not scroll`);
      assert.deepEqual(
        page.sent.filter((item) => item.type === 'avb:shortcut'),
        [{ type: 'avb:shortcut', name: 'arrow', key: 'ArrowUp' }],
        `${mode}: the app moves the selection`,
      );
    }
    page.sent.length = 0;
    const typed = page.key(page.window.document.getElementById('field'), 'ArrowLeft');
    assert.equal(typed.defaultPrevented, false, 'the caret moves');
    assert.equal(page.sent.filter((item) => item.type === 'avb:shortcut').length, 0);
  } finally {
    page.window.close();
  }
});

test('link rules: with the page list, a download or a path that is no page opens in the browser', () => {
  Object.defineProperty(global, 'location', { value: { hash: '' }, configurable: true, writable: true });
  const { canvasLinkDestination } = loadRenderer('electron/preload/frameInteraction.ts');
  const FRAME = 'https://stacki.build/demo/site/#avb-design';
  const listed = { newContext: false, pages: { base: '/demo/site', routes: ['/', '/docs'] } };
  const link = (href, extra = {}) => ({ href, target: '', download: false, ...extra });
  assert.deepEqual(canvasLinkDestination(link('/download/mac'), FRAME, listed), { kind: 'browser', url: 'https://stacki.build/download/mac' });
  assert.deepEqual(canvasLinkDestination(link('/docs'), FRAME, listed), { kind: 'page' }, 'a page written from the site root');
  assert.deepEqual(canvasLinkDestination(link('/demo/site/docs/'), FRAME, listed), { kind: 'page' }, 'a page under the base');
  assert.deepEqual(canvasLinkDestination(link('#pricing'), FRAME, listed), { kind: 'page' }, 'within the page');
  assert.deepEqual(
    canvasLinkDestination(link('/docs', { download: true }), FRAME, listed),
    { kind: 'browser', url: 'https://stacki.build/docs' },
    'a link marked download',
  );
  assert.deepEqual(canvasLinkDestination(link('/download/mac'), FRAME, { newContext: false, pages: undefined }), { kind: 'page' }, 'no list yet: as before');
});

test("interact mode: a link within the page runs the page's own handler once", async () => {
  const page = await frame();
  try {
    page.mode('interact');
    const link = page.window.document.getElementById('menu-link');
    const seen = [];
    link.addEventListener('click', (event) => seen.push(event.defaultPrevented));
    page.click(link);
    assert.deepEqual(seen, [], 'held for the double-click window');
    await settle(LINK_HOLD_WAIT_MS);
    assert.deepEqual(seen, [false], 'then the menu opens');
    assert.equal(page.navigations.length, 0);
  } finally {
    page.window.close();
  }
});

test('link rules: under a base, a root link loads the baked page with the design hash', () => {
  Object.defineProperty(global, 'location', { value: { hash: '' }, configurable: true, writable: true });
  const { canvasPageAddress } = loadRenderer('electron/preload/frameInteraction.ts');
  const FRAME = 'https://stacki.build/demo/site/#avb-design';
  const pages = { base: '/demo/site', routes: ['/', '/features'] };
  assert.equal(canvasPageAddress('/features', FRAME, pages), 'https://stacki.build/demo/site/features/#avb-design');
  assert.equal(canvasPageAddress('/features/', FRAME, pages), 'https://stacki.build/demo/site/features/#avb-design');
  assert.equal(canvasPageAddress('/#pricing', FRAME, pages), undefined, 'a place on the page it is on, written from the root');
  assert.equal(canvasPageAddress('#', FRAME, pages), undefined, 'an empty fragment: a script opening a menu');
  assert.equal(canvasPageAddress('/demo/site/features/', FRAME, pages), 'https://stacki.build/demo/site/features/#avb-design', 'already under the base');
  assert.equal(
    canvasPageAddress('/features', 'http://localhost:4321/#avb-design', { base: '', routes: ['/features'] }),
    'http://localhost:4321/features#avb-design',
    'no base: kept',
  );
});
