// Goal: the interactive preview (and the canvas) behave like a browser tab on
// the site, except that a frame never shows another site in its place. A link
// to one of the site's routes that the server redirects elsewhere (the
// marketing site's `/download`, which answers with the release's file) used to
// be followed into a "refused to connect" page, because only the start of a
// navigation was checked. Now the redirect is held to the same rule: the frame
// stays where it was and the destination opens in the browser.
// Method: drive the built keepPreviewsOnSite with a stand-in WebContents that
// emits `will-frame-navigate` and `will-redirect` events the way Electron does
// for a frame directly in the window, for one the site embeds, and for one the
// app itself points somewhere, and record what is cancelled and opened.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { keepPreviewsOnSite } = require('#dist/electron/app/previewNavigation.js');

const SITE = 'http://127.0.0.1:49335/';
const RELEASE = 'https://github.com/flowtricks/stacki-releases/releases/latest';

function window() {
  const listeners = new Map();
  // No parent: the window's own frame (Electron says null; the policy reads it as absent).
  const mainFrame = { processId: 1, routingId: 1, url: 'http://localhost:5173/' };
  const opened = [];
  const contents = {
    mainFrame,
    on(name, listener) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
      return contents;
    },
  };
  keepPreviewsOnSite(contents, (url) => opened.push(url));
  const preview = { processId: 2, routingId: 7, parent: mainFrame, url: SITE };
  const embed = { processId: 3, routingId: 9, parent: preview, url: 'https://www.youtube-nocookie.com/embed/x' };
  // One navigation event, as Electron hands it to every listener for that name.
  const emit = (name, fields) => {
    const event = { isMainFrame: false, initiator: fields.frame, defaultPrevented: false, ...fields };
    event.preventDefault = () => {
      event.defaultPrevented = true;
    };
    for (const listener of listeners.get(name) ?? []) {
      listener(event);
    }
    return event;
  };
  return { emit, opened, mainFrame, preview, embed, listeners };
}

test('both the start of a navigation and each redirect are watched', () => {
  const { listeners } = window();
  assert.equal(listeners.get('will-frame-navigate')?.length, 1);
  assert.equal(listeners.get('will-redirect')?.length, 1);
});

test('a site route the server redirects elsewhere opens in the browser and the frame stays', () => {
  const { emit, opened, preview } = window();
  const start = emit('will-frame-navigate', { url: `${SITE}download`, frame: preview });
  assert.equal(start.defaultPrevented, false, 'the link starts on the site, so it is followed');
  const redirect = emit('will-redirect', { url: RELEASE, frame: preview });
  assert.equal(redirect.defaultPrevented, true, 'the redirect off the site is cancelled');
  assert.deepEqual(opened, [RELEASE]);
});

test('a redirect within the site is followed like any page', () => {
  const { emit, opened, preview } = window();
  const redirect = emit('will-redirect', { url: `${SITE}docs/`, frame: preview });
  assert.equal(redirect.defaultPrevented, false);
  assert.deepEqual(opened, []);
});

test('a link to another site opens in the browser, as before', () => {
  const { emit, opened, preview } = window();
  const start = emit('will-frame-navigate', { url: 'https://discord.gg/z2BRMXkbvz', frame: preview });
  assert.equal(start.defaultPrevented, true);
  assert.deepEqual(opened, ['https://discord.gg/z2BRMXkbvz']);
});

test('a redirect to something the browser should not open is cancelled and opens nothing', () => {
  const { emit, opened, preview } = window();
  const redirect = emit('will-redirect', { url: 'vscode://file/etc/hosts', frame: preview });
  assert.equal(redirect.defaultPrevented, true);
  assert.deepEqual(opened, []);
});

test("the site's own embeds, the app's own navigations and the app window are left alone", () => {
  const { emit, opened, mainFrame, preview, embed } = window();
  const video = emit('will-redirect', { url: 'https://www.youtube.com/embed/x', frame: embed });
  assert.equal(video.defaultPrevented, false, 'an embed inside the site goes where it likes');
  const editor = emit('will-redirect', { url: RELEASE, frame: preview, initiator: mainFrame });
  assert.equal(editor.defaultPrevented, false, 'the editor decides what its frames show');
  const app = emit('will-redirect', { url: RELEASE, frame: mainFrame, isMainFrame: true });
  assert.equal(app.defaultPrevented, false, "the app's page is main.ts keepOnAppPage's to hold");
  const blank = emit('will-redirect', { url: RELEASE, frame: { ...preview, url: 'about:blank' } });
  assert.equal(blank.defaultPrevented, false, 'a frame that has loaded nothing yet has no site to leave');
  assert.deepEqual(opened, []);
});
