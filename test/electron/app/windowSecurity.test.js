// Goal: the app's windows hand the operating system only what the user's
// browser should open, whatever a page asks for.
// Method: run each rule from its built output against accepted values, every
// refused kind, and malformed text, so a loosened rule fails here first.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isAllowedMedia, isAppPage, isBrowserLink, isPrivatePermission } = require('#dist/electron/app/windowSecurity.js');

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

test('permissions that reveal the user or reach their devices are refused', () => {
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
  ]) {
    assert.equal(isPrivatePermission(permission), true, permission);
  }
});

test('the permissions Stacki relies on, and other harmless ones, stay granted', () => {
  for (const permission of ['clipboard-sanitized-write', 'fullscreen', 'notifications', 'pointerLock', 'openExternal']) {
    assert.equal(isPrivatePermission(permission), false, permission);
  }
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
  assert.equal(isPrivatePermission('media'), false, 'media is decided by isAllowedMedia, not the blanket list');
});
