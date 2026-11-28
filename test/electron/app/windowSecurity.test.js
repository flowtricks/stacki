// Goal: the app's windows hand the operating system only what the user's
// browser should open, whatever a page asks for.
// Method: run each rule from its built output against accepted values, every
// refused kind, and malformed text, so a loosened rule fails here first.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { allowsPermission, guardSessionPermissions, isAllowedMedia, isAppPage, isBrowserLink } = require('#dist/electron/app/windowSecurity.js');
const { keepOnAppPage } = require('#dist/electron/app/appPageNavigation.js');

const PACKAGED_PAGE = 'file:///Applications/Stacki.app/Contents/Resources/app.asar/index.html';
const DEV_PAGE = 'http://localhost:5173/';

test('web links open in the browser', () => {
  assert.equal(isBrowserLink('https://example.com/page?query=1'), true);
  assert.equal(isBrowserLink('http://localhost:4321/'), true);
  assert.equal(isBrowserLink('HTTPS://EXAMPLE.COM'), true);
});

test('every other link kind is refused', () => {
  for (const url of [
    'file:///Applications/Calculator.app',
    'javascript:alert(1)',
    'mailto:someone@example.com',
    'vscode://file/etc/hosts',
    'data:text/html,<p>page</p>',
    'smb://server/share',
  ]) {
    assert.equal(isBrowserLink(url), false, url);
  }
});

test('malformed text is refused', () => {
  for (const url of ['', 'example.com', '//example.com', 'https//example.com', ' https:']) {
    assert.equal(isBrowserLink(url), false, JSON.stringify(url));
  }
});

test("the app's window may reload its own page", () => {
  assert.equal(isAppPage(PACKAGED_PAGE, PACKAGED_PAGE), true);
  assert.equal(isAppPage(`${PACKAGED_PAGE}#/project`, PACKAGED_PAGE), true);
  assert.equal(isAppPage(`${PACKAGED_PAGE}?view=code`, PACKAGED_PAGE), true);
  assert.equal(isAppPage(DEV_PAGE, DEV_PAGE), true);
  assert.equal(isAppPage('http://localhost:5173/src/main.tsx?reload=1', DEV_PAGE), true);
});

test("the app's window may not leave its own page", () => {
  for (const [url, appUrl] of [
    ['file:///Users/someone/Desktop/index.html', PACKAGED_PAGE],
    ['https://example.com/', PACKAGED_PAGE],
    ['http://localhost:4321/', DEV_PAGE],
    ['https://localhost:5173/', DEV_PAGE],
    ['http://localhost:5173.evil.com/', DEV_PAGE],
    ['http://localhost.evil.com:5173/', DEV_PAGE],
    ['https://example.com/', DEV_PAGE],
    ['file:///Applications/Stacki.app/Contents/Resources/app.asar/index.html', DEV_PAGE],
    ['not a url', DEV_PAGE],
    [DEV_PAGE, 'not a url'],
  ]) {
    assert.equal(isAppPage(url, appUrl), false, `${url} from ${appUrl}`);
  }
});

const SITE = 'http://localhost:4321/';
const EMBED = 'https://embed.example.com/player';

const ask = (permission, requestingUrl, more = {}) => allowsPermission({ permission, requestingUrl, appUrl: PACKAGED_PAGE, ...more });

test('a permission not allowed by name is refused to every page, Stacki’s own included', () => {
  for (const permission of [
    'geolocation',
    'geolocation-approximate',
    'display-capture',
    'clipboard-read',
    'deprecated-sync-clipboard-read',
    'hid',
    'serial',
    'usb',
    'idle-detection',
    'notifications',
    'midi',
    'midiSysex',
    'window-management',
    'local-fonts',
    'sensors',
    'unknown',
    'a-permission-a-later-electron-adds',
  ]) {
    for (const page of [PACKAGED_PAGE, SITE, EMBED, '']) {
      assert.equal(ask(permission, page), false, `${permission} for ${page}`);
    }
  }
});

test('what sites and Stacki use in ordinary browsing stays granted, in nested frames too', () => {
  for (const permission of [
    'clipboard-sanitized-write',
    'fullscreen',
    'pointerLock',
    'keyboardLock',
    'mediaKeySystem',
    'fileSystem',
    'persistent-storage',
    'storage-access',
    'screen-wake-lock',
  ]) {
    for (const page of [PACKAGED_PAGE, SITE, EMBED]) {
      assert.equal(ask(permission, page), true, `${permission} for ${page}`);
    }
  }
});

test('a frame may hand only an email, phone or text link to another app', () => {
  for (const externalURL of ['mailto:someone@example.com', 'MAILTO:someone@example.com', 'tel:+15550100', 'sms:+15550100']) {
    assert.equal(ask('openExternal', EMBED, { externalURL }), true, externalURL);
  }
  for (const externalURL of [
    'vscode://file/etc/hosts',
    'zoommtg://zoom.us/join',
    'file:///Applications/Calculator.app',
    'smb://server/share',
    'x-apple.systempreferences:com.apple.preference.security',
    'ms-msdt:/id',
    'not a url',
    '',
    undefined,
  ]) {
    for (const page of [PACKAGED_PAGE, SITE, EMBED]) {
      assert.equal(ask('openExternal', page, { externalURL }), false, `${externalURL} from ${page}`);
    }
  }
});

test('the local network is for pages on this computer or its network, not the web’s', () => {
  for (const permission of ['local-network-access', 'local-network', 'loopback-network']) {
    for (const page of [PACKAGED_PAGE, 'file:///', SITE, 'http://127.0.0.1:4321/', 'http://[::1]:4321/', 'http://192.168.1.20:4321/', 'http://studio.local/']) {
      assert.equal(ask(permission, page), true, `${permission} for ${page}`);
    }
    for (const page of [EMBED, 'http://localhost.evil.com/', 'http://10.evil.com/', 'http://172.32.0.1/', '']) {
      assert.equal(ask(permission, page), false, `${permission} for ${page}`);
    }
  }
});

test('a session answers its requests and its checks from the same rules', () => {
  let request;
  let check;
  guardSessionPermissions(
    {
      setPermissionRequestHandler: (handler) => (request = handler),
      setPermissionCheckHandler: (handler) => (check = handler),
    },
    PACKAGED_PAGE,
  );
  const requested = (permission, details) => {
    let answer;
    request(undefined, permission, (granted) => (answer = granted), details);
    return answer;
  };
  assert.equal(requested('openExternal', { requestingUrl: EMBED, externalURL: 'vscode://x', isMainFrame: false }), false);
  assert.equal(requested('openExternal', { requestingUrl: EMBED, externalURL: 'mailto:a@example.com', isMainFrame: false }), true);
  assert.equal(requested('media', { requestingUrl: PACKAGED_PAGE, mediaTypes: ['audio'] }), true);
  assert.equal(requested('media', { requestingUrl: EMBED, mediaTypes: ['audio'] }), false);
  assert.equal(requested('notifications', { requestingUrl: EMBED }), false);
  assert.equal(check(undefined, 'fullscreen', 'https://embed.example.com', {}), true);
  assert.equal(check(undefined, 'notifications', 'https://embed.example.com', {}), false);
  assert.equal(check(undefined, 'media', 'file:///', { requestingUrl: PACKAGED_PAGE, mediaType: 'audio' }), true);
  assert.equal(check(undefined, 'media', 'file:///', { requestingUrl: PACKAGED_PAGE, mediaType: 'video' }), false);
});

test('the app’s window is held on its page through navigations and redirects alike', () => {
  const listeners = new Map();
  const opened = [];
  keepOnAppPage({ on: (name, listener) => listeners.set(name, listener) }, DEV_PAGE, (url) => opened.push(url));
  for (const name of ['will-navigate', 'will-redirect']) {
    const held = (url, isMainFrame = true) => {
      let prevented = false;
      listeners.get(name)({ url, isMainFrame, preventDefault: () => (prevented = true) });
      return prevented;
    };
    assert.equal(held(DEV_PAGE), false, `${name} on the page`);
    assert.equal(held('https://example.com/'), true, `${name} away`);
    assert.equal(held('file:///etc/hosts'), true, `${name} to a file`);
    assert.equal(held('https://example.com/', false), false, `${name} in a frame`);
  }
  assert.deepEqual(opened, ['https://example.com/', 'https://example.com/']);
});

test('the microphone is allowed for dictation: audio only, from Stacki’s own page', () => {
  assert.equal(isAllowedMedia({ mediaTypes: ['audio'], requestingUrl: DEV_PAGE, appUrl: DEV_PAGE }), true, 'dev page');
  assert.equal(isAllowedMedia({ mediaTypes: ['audio'], requestingUrl: `${PACKAGED_PAGE}#/x`, appUrl: PACKAGED_PAGE }), true, 'packaged page');
});

test('the camera, an unnamed request and any other page are refused the microphone', () => {
  const audio = ['audio'];
  assert.equal(isAllowedMedia({ mediaTypes: ['video'], requestingUrl: DEV_PAGE, appUrl: DEV_PAGE }), false, 'camera');
  assert.equal(isAllowedMedia({ mediaTypes: ['audio', 'video'], requestingUrl: DEV_PAGE, appUrl: DEV_PAGE }), false, 'camera with microphone');
  assert.equal(isAllowedMedia({ mediaTypes: [], requestingUrl: DEV_PAGE, appUrl: DEV_PAGE }), false, 'names nothing');
  assert.equal(isAllowedMedia({ mediaTypes: undefined, requestingUrl: DEV_PAGE, appUrl: DEV_PAGE }), false, 'names nothing at all');
  assert.equal(isAllowedMedia({ mediaTypes: audio, requestingUrl: 'http://localhost:4321/', appUrl: DEV_PAGE }), false, 'a previewed site');
  assert.equal(isAllowedMedia({ mediaTypes: audio, requestingUrl: 'https://example.com/', appUrl: DEV_PAGE }), false, 'the web');
  assert.equal(isAllowedMedia({ mediaTypes: audio, requestingUrl: 'stacki-app://abc/', appUrl: DEV_PAGE }), false, 'an installed app');
  assert.equal(isAllowedMedia({ mediaTypes: audio, requestingUrl: '', appUrl: DEV_PAGE }), false, 'no address');
});
