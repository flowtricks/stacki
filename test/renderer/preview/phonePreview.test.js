// Goal: the phone preview in the title bar's address bar, as a person meets it. No globe while no dev server
// runs (hidden, not greyed). The popover is a header ("Phone preview", the "?" tip, a switch) and, while on,
// one card: the QR tile, the address on one line without the scheme, and Copy, whose check replaces its icon
// in the same button. No divider anywhere. The first "on" of the session asks in the app's own dialog; off
// never asks; while the server restarts the switch is disabled and the card shows skeletons; a failure is a
// toast and the switch shows what main runs; the address picker appears only with several addresses.
// Method: the Desktop button (src/features/preview/phone) is bundled with the confirmation host
// (test/helpers/phonePreviewEntry.tsx) and mounted in jsdom. window.avb is a fake main that records every
// dev:setNetwork and answers from a script, and can hold a reply to show the restarting state; the clipboard
// is a recorder that can refuse. Waits poll the DOM at a fixed interval for a bounded count, never a fixed pause. Sizes
// and overlap need real layout: phoneUrlBarChromium.test.js holds those.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { installPopupDOM } = require('../../helpers/popupDom.js');
const { waitFor } = require('../../helpers/waitFor.js');

const directory = repoPath('node_modules/.stacki-test/phone-preview');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'phone.cjs');
buildSync({
  entryPoints: [path.join(ROOT, 'test/helpers/phonePreviewEntry.tsx')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
});

const WIFI = { address: '192.168.1.23', interfaceName: 'en0' };
const ETHERNET = { address: '10.0.0.8', interfaceName: 'en7' };

function setup() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const { window } = dom;
  Object.assign(global, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLDialogElement: window.HTMLDialogElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    getComputedStyle: window.getComputedStyle.bind(window),
  });
  installPopupDOM(window);
  // `jsdom` lays nothing out; the Dropdown scrolls its highlighted option into view.
  window.HTMLElement.prototype.scrollIntoView = () => undefined;
  global.matchMedia = window.matchMedia;
  global.ResizeObserver = window.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  const main = { state: { kind: 'off' }, calls: [], replies: [], held: undefined };
  window.avb = {
    devNetwork: async () => main.state,
    setDevNetwork: async (payload) => {
      main.calls.push(payload);
      if (main.held !== undefined) {
        await main.held;
      }
      const reply = main.replies.shift() ?? { ok: true, value: payload.mode === 'network' ? { kind: 'on', port: 4321, addresses: [WIFI] } : { kind: 'off' } };
      if (reply.ok) {
        main.state = reply.value;
      }
      return reply;
    },
  };
  const clipboard = { written: [], refuse: false };
  Object.defineProperty(global, 'navigator', { configurable: true, value: window.navigator });
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text) => (clipboard.refuse ? Promise.reject(new Error('denied')) : void clipboard.written.push(text)) },
  });
  return { window, main, clipboard };
}

// Up to 200 turns of the event loop for `predicate` to hold: the fakes answer within a few.
// Waits on the state, polling at the helper's interval for a bounded count, flushing React before each read: a slow runner gets the
// time it needs where a fixed number of event-loop turns ran out on Ubuntu.
async function until(predicate, what) {
  await waitFor({
    what,
    read: async () => {
      await act(async () => undefined);
      return predicate();
    },
    until: Boolean,
  });
}

const click = (window, element) => act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
const byText = (selector, text) => [...document.querySelectorAll(selector)].find((element) => element.textContent.trim() === text);

test('the globe lives in the address bar only: AppShell hands it to UrlGroup, the preview toolbar never draws it', () => {
  const source = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
  const shell = source('src/app/shell/AppShell.tsx');
  assert.match(shell, /<UrlGroup\s+app=\{app\}\s+trailing=\{\s*<PhonePreviewButton /, "Desktop passes the globe as the bar's trailing control");
  assert.match(shell, /\{trailing\}\s*<OpenBrowserButton /, 'drawn just before Open in browser');
  for (const file of [
    'src/features/preview/PreviewToolbar.tsx',
    'src/features/preview/PreviewPane.tsx',
    'src/features/preview/ToolbarOverflow.tsx',
    'src/app/shell/AppPanes.tsx',
  ]) {
    assert.doesNotMatch(source(file), /phone\/PhonePreview|PhonePreviewButton|usePhonePreview/, `${file} does not draw the globe`);
  }
});

test('the phone preview: hidden without a server, header and switch, confirm once, card, copy, skeletons, failures and the picker', async () => {
  const { window, main, clipboard } = setup();
  const { PhonePreviewHost, QR_TILE_PX } = require(output);
  const toasts = [];
  const showToast = (message, kind) => toasts.push({ message, kind });
  const root = createRoot(document.getElementById('root'));
  const render = (devStatus, route = '/blog/post') => act(() => root.render(React.createElement(PhonePreviewHost, { devStatus, route, showToast })));
  const button = () => document.querySelector('.url-bar .url-phone') ?? undefined;
  const toggle = () => document.querySelector('.phone-preview [role="switch"]') ?? undefined;
  const card = () => document.querySelector('.phone-preview .phone-preview-card') ?? undefined;
  const dialog = () => document.querySelector('.confirm-dialog') ?? undefined;
  const url = () => document.querySelector('.phone-preview-url')?.textContent;
  const copyButton = () => document.querySelector('.phone-preview-address button') ?? undefined;
  try {
    await render('off');
    assert.equal(button(), undefined, 'no globe while no dev server runs');
    await render('starting');
    assert.equal(button(), undefined, 'nor while it starts');
    await render('on');
    assert.ok(button(), 'the globe once the server runs');
    assert.equal(button().getAttribute('aria-label'), 'Phone preview');
    assert.equal(button().className, 'titlebar-btn url-phone', 'off by default');
    assert.equal(button().nextElementSibling.getAttribute('aria-label'), 'Open in browser', 'the globe sits just before Open in browser');

    // Off: the header alone, its "?" tip and an off switch; no card, no divider.
    await click(window, button());
    await until(() => toggle() !== undefined, 'the popover');
    assert.equal(document.querySelector('.phone-preview-title').textContent, 'Phone preview');
    assert.ok(document.querySelector('.phone-preview-header [aria-label="Connection help"]'), 'the "?" sits in the header');
    assert.equal(toggle().getAttribute('aria-label'), 'Open on local network');
    assert.equal(toggle().getAttribute('aria-checked'), 'false');
    assert.equal(card(), undefined, 'no card while off');
    assert.equal(document.querySelector('.phone-preview [role="separator"], .phone-preview .menu-divider') ?? undefined, undefined, 'no divider');

    // The first "on" of the session asks, and Cancel changes nothing.
    await click(window, toggle());
    await until(() => byText('button', 'Turn on') !== undefined, 'the confirmation');
    assert.ok(dialog().textContent.includes('Anyone on your Wi-Fi can open this site while this is on.'));
    assert.equal(byText('button', 'Turn on').className, 'primary', 'the blue primary button');
    await click(window, byText('.confirm-dialog button', 'Cancel'));
    await until(() => dialog() === undefined, 'the dialog to close');
    assert.deepEqual(main.calls, [], 'Cancel restarts nothing');

    // On, held mid-restart: the switch is on and disabled, the card is skeletons.
    let release;
    main.held = new Promise((resolve) => (release = resolve));
    await click(window, toggle());
    await until(() => byText('button', 'Turn on') !== undefined, 'the confirmation again');
    await click(window, byText('button', 'Turn on'));
    await until(() => card()?.getAttribute('aria-busy') === 'true', 'the skeleton card');
    assert.equal(toggle().getAttribute('aria-checked'), 'true');
    assert.equal(toggle().disabled, true, 'the switch waits for the restart');
    assert.ok(card().querySelectorAll('.ui-skeleton').length >= 2, 'the tile and the address as shapes');
    assert.equal(url(), undefined);
    main.held = undefined;
    release();
    await until(() => url() !== undefined, 'the address');
    assert.deepEqual(main.calls, [{ projectPath: '/site', mode: 'network' }]);
    assert.equal(
      url(),
      '192.168.1.23:4321/bl…st',
      'the address of the page the canvas shows, on one line without the scheme, a path that does not fit cut in its middle',
    );
    assert.equal(document.querySelector('.phone-preview-url').getAttribute('title'), 'http://192.168.1.23:4321/blog/post');
    assert.equal(toggle().disabled, false);
    assert.equal(button().className, 'titlebar-btn url-phone on');
    assert.equal(document.querySelector('.phone-preview-picker') ?? undefined, undefined, 'no picker with one address');

    const qr = card().querySelector('svg.phone-preview-qr');
    assert.ok(qr, 'a QR tile in the card');
    assert.equal(qr.getAttribute('width'), String(QR_TILE_PX));
    assert.equal(qr.getAttribute('height'), String(QR_TILE_PX));
    const modules = Number(qr.getAttribute('data-modules'));
    assert.equal(qr.getAttribute('viewBox'), `0 0 ${modules + 8} ${modules + 8}`, 'four light modules of quiet zone on each side');
    assert.equal(qr.getAttribute('aria-label'), 'QR code for http://192.168.1.23:4321/blog/post');
    assert.ok(qr.querySelector('rect.phone-preview-qr-tile'), 'a light tile behind the modules');

    // Copy: the full URL on the clipboard, and the check in the same button; a refusal is a toast.
    const copy = copyButton();
    assert.equal(copy.getAttribute('aria-label'), 'Copy address');
    await click(window, copy);
    await until(() => clipboard.written.length === 1, 'the copy');
    assert.deepEqual(clipboard.written, ['http://192.168.1.23:4321/blog/post']);
    await until(() => copyButton().getAttribute('aria-label') === 'Address copied', 'the copied state');
    assert.equal(copyButton(), copy, 'the same button, its icon swapped');
    clipboard.refuse = true;
    await click(window, copyButton());
    await until(() => toasts.length === 1, 'the copy failure toast');
    assert.deepEqual(toasts, [{ message: 'Couldn’t copy the address.', kind: 'error' }]);

    // Another page on the canvas: the address follows it.
    await render('on', '/about');
    assert.equal(url(), '192.168.1.23:4321/about');

    // Off: no question, and the card goes.
    await click(window, toggle());
    await until(() => card() === undefined, 'the card to go');
    assert.deepEqual(main.calls.at(-1), { projectPath: '/site', mode: 'local' });
    assert.equal(dialog(), undefined, 'turning off never asks');
    assert.equal(toggle().getAttribute('aria-checked'), 'false');

    // On again: the session already answered. Main reports two networks: a picker offers both.
    main.replies.push({ ok: true, value: { kind: 'on', port: 4321, addresses: [WIFI, ETHERNET] } });
    await click(window, toggle());
    await until(() => url() !== undefined, 'the address without a question');
    assert.equal(dialog(), undefined);
    const picker = document.querySelector('.phone-preview-picker');
    assert.ok(picker, 'a picker with several addresses');
    await click(window, picker.matches('button') ? picker : picker.querySelector('button'));
    await until(() => document.querySelectorAll('.dd-option').length === 2, 'the picker options');
    const options = [...document.querySelectorAll('.dd-option')];
    assert.ok(options[1].textContent.includes('10.0.0.8'));
    assert.ok(options[1].textContent.includes('en7'), 'each option names its interface');
    await click(window, options[1]);
    await until(() => url() === '10.0.0.8:4321/about', 'the chosen address');

    // A failure: a toast, and the switch shows what main runs (off).
    await click(window, toggle());
    await until(() => toggle().getAttribute('aria-checked') === 'false' && toggle().disabled === false, 'off');
    main.replies.push({ ok: false, error: 'no-address' });
    await click(window, toggle());
    await until(() => toasts.length === 2, 'the failure toast');
    assert.deepEqual(toasts[1], { message: 'This computer isn’t on a network a phone can reach. Join a Wi-Fi network and try again.', kind: 'error' });
    await until(() => toggle().getAttribute('aria-checked') === 'false', 'the switch back off');
    assert.equal(card(), undefined, 'no card');

    // The server goes away: the globe goes with it.
    await render('off');
    assert.equal(button(), undefined);
  } finally {
    await act(() => root.unmount());
    window.close();
  }
});

test('the address is one line: no scheme, the host whole, a long path cut in its middle', () => {
  const { phoneAddressText, PHONE_ADDRESS_CHARS_MAX } = require('../../helpers/rendererModule')('src/features/preview/phone/phoneAddress.ts');
  assert.equal(phoneAddressText('http://192.168.4.135:48781/'), '192.168.4.135:48781/');
  // A short host leaves room for a short path whole.
  assert.equal(phoneAddressText('http://10.0.0.5:48781/a/b'), '10.0.0.5:48781/a/b');
  // The host and port stay whole; a path that does not fit is cut in its middle.
  const cut = phoneAddressText('http://192.168.4.135:48781/blog/post?x=1');
  assert.ok(cut.startsWith('192.168.4.135:48781/'), cut);
  assert.ok(cut.includes('…'), cut);
  assert.ok(cut.length <= PHONE_ADDRESS_CHARS_MAX, cut);
  // The longest host still leaves one line: the host, then "/…".
  const long = phoneAddressText('http://192.168.100.200:48781/blog/a-very-long-post-name/with/segments');
  assert.equal(long, '192.168.100.200:48781/…');
  assert.ok(long.length <= PHONE_ADDRESS_CHARS_MAX, long);
  assert.throws(() => phoneAddressText('http://10.0.0.1/', 3), /holds an address/);
});
