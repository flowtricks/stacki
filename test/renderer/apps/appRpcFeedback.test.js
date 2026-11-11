// Goal: the Apps RPC methods and events the Feedback pins, GA and HubSpot apps
// asked for hold their contracts.
// - `overlay.post`: the params are bounded (data length, item id form); an app
//   must name the frame item and a frame item may speak only as itself; the
//   runtime delivers an app's message to the overlay frame drawing that item and
//   a frame's message to its app's other frames, as `overlay.message`, only to
//   frames of the same app that listen, and says how many heard it.
// - `overlay.hover`: hovers noted within one frame send once, the last one
//   winning, and a hover the app already heard is not sent again.
// - `app.openSettings`: the request names the calling app and the App settings
//   section, is handled once, and a role that cannot see the Apps panel is refused.
// - `people.list`: role members first, then commit authors, each once (a member's
//   GitHub noreply address is that member), at most 200; with the person's
//   details hidden only logins and pictures; the boundary parser refuses what it
//   must; a host without the list fails the request with a reason.
// - `clipboard.write`: the text reaches the host's clipboard, bounded.
// - `canvas.capture` events carry why (`app`, `escape`, `replaced`): see
//   appCanvasTools.test.js.
// Method: the real dispatcher, runtime and contract bundled with esbuild, driven
// by fake hosts and fake frame windows that record what they are posted.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');

const rpc = load('src/features/apps/appRpcHost.ts');
const runtime = load('src/features/apps/appsRuntime.ts');
const requests = load('src/features/apps/appDetailsRequests.ts');
const roles = load('shared/properties/projectRoles.ts');
const contract = load('shared/properties/appsRpc.ts');

const app = (id = 'pins') => ({
  manifest: {
    manifestVersion: 1,
    id,
    name: 'Pins',
    version: '1.0.0',
    description: '',
    icon: undefined,
    entry: 'index.html',
    window: { mode: 'panel', widthPx: undefined, heightPx: undefined },
    shortcutClaims: [],
    commands: [],
    settings: [],
    permissions: [],
    network: [],
    auth: [],
  },
  lock: { source: { kind: 'local' }, update: undefined, autoUpdate: false },
});
const session = (overlayItem) => ({ app: app(), subscriptions: new Set(), overlayItem, ...rpc.inFlightCounter() });
const request = (id, method, params) => ({ stacki: 'app', v: 1, id, method, params });
const context = (extra = {}, role = roles.ADMIN_VIEW) => ({ host: { people: undefined }, role: () => role, setOverlay: () => undefined, ...extra });

test('overlay.post params are bounded and name a frame item', () => {
  const parse = contract.APP_METHODS['overlay.post'].params;
  assert.deepEqual(parse({ itemId: 'rotator', data: '{"x":1}' }), { itemId: 'rotator', data: '{"x":1}' });
  assert.deepEqual(parse({ data: '' }), { itemId: undefined, data: '' });
  assert.throws(() => parse({ itemId: 'no spaces', data: 'x' }), /letters, digits/);
  assert.throws(() => parse({ itemId: 'a', data: 7 }));
  assert.throws(() => parse({ itemId: 'a', data: 'x'.repeat(contract.APP_RPC_LIMITS.overlayMessageCharsMax + 1) }), /exceeds/);
  assert.equal(parse({ data: 'x'.repeat(contract.APP_RPC_LIMITS.overlayMessageCharsMax) }).data.length, contract.APP_RPC_LIMITS.overlayMessageCharsMax);
});

test('overlay.post: an app names the item, a frame speaks only as itself', async () => {
  const posted = [];
  const overlayMessages = { post: (sender, message) => posted.push([sender.overlayItem, message]) };
  const fromApp = await rpc.answerAppMessage(session(undefined), request(1, 'overlay.post', { data: 'x' }), context({ overlayMessages }));
  assert.equal(fromApp.error.code, 'failed');
  assert.match(fromApp.error.message, /itemId/);
  const named = await rpc.answerAppMessage(session(undefined), request(2, 'overlay.post', { itemId: 'rotator', data: 'x' }), context({ overlayMessages }));
  assert.deepEqual(named.value, { delivered: 1 });
  const elsewhere = await rpc.answerAppMessage(session('rotator'), request(3, 'overlay.post', { itemId: 'other', data: 'x' }), context({ overlayMessages }));
  assert.equal(elsewhere.error.code, 'failed');
  const own = await rpc.answerAppMessage(session('rotator'), request(4, 'overlay.post', { data: 'y' }), context({ overlayMessages }));
  assert.deepEqual(own.value, { delivered: 2 });
  assert.deepEqual(posted, [
    [undefined, { itemId: 'rotator', data: 'x' }],
    ['rotator', { itemId: undefined, data: 'y' }],
  ]);
  const none = await rpc.answerAppMessage(session(undefined), request(5, 'overlay.post', { itemId: 'rotator', data: 'x' }), context());
  assert.equal(none.error.code, 'failed', 'a host without overlays says so');
});

// A frame window that records what Stacki posts it.
function frameWindow() {
  const messages = [];
  return { messages, postMessage: (message) => messages.push(message) };
}

test('overlay messages reach subscribed frames only, each way', async () => {
  runtime.resetAppsRuntime();
  runtime.configureAppsRuntime({}, () => roles.ADMIN_VIEW);
  const panel = frameWindow();
  const rotator = frameWindow();
  const legend = frameWindow();
  const stranger = frameWindow();
  const stops = [
    runtime.attachAppFrame(panel, app()),
    runtime.attachAppFrame(rotator, app(), undefined, 'rotator'),
    runtime.attachAppFrame(legend, app(), undefined, 'legend'),
    runtime.attachAppFrame(stranger, app('notes'), undefined, 'rotator'),
  ];
  try {
    const subscribe = runtime.subscribeAppFrameForTests;
    assert.equal(typeof subscribe, 'function');
    for (const window of [panel, rotator, legend, stranger]) {
      subscribe(window, 'overlay.message');
    }
    const fromApp = runtime.overlayMessages.post({ app: app(), overlayItem: undefined }, { itemId: 'rotator', data: '{"angle":30}' });
    assert.equal(fromApp, 1, 'only the frame drawing that item of that app');
    assert.deepEqual(rotator.messages.at(-1), {
      stacki: 'host',
      v: 1,
      event: 'overlay.message',
      data: { itemId: 'rotator', data: '{"angle":30}', from: 'app' },
    });
    assert.equal(legend.messages.length + stranger.messages.length + panel.messages.length, 0);
    const fromFrame = runtime.overlayMessages.post({ app: app(), overlayItem: 'rotator' }, { itemId: undefined, data: 'ready' });
    assert.equal(fromFrame, 1, "a frame's message reaches its app's own frames, not other overlays");
    assert.deepEqual(panel.messages.at(-1).data, { itemId: 'rotator', data: 'ready', from: 'overlay' });
  } finally {
    for (const stop of stops) {
      stop();
    }
  }
});

test('overlay.hover sends once per frame, the last hover winning, and never repeats', () => {
  runtime.resetAppsRuntime();
  runtime.configureAppsRuntime({}, () => roles.ADMIN_VIEW);
  runtime.launchApp(app(), 'panel');
  const panel = frameWindow();
  const stop = runtime.attachAppFrame(panel, app());
  try {
    runtime.subscribeAppFrameForTests(panel, 'overlay.hover');
    runtime.noteOverlayHover('pins', 'pin-1');
    runtime.noteOverlayHover('pins', 'pin-2');
    runtime.flushOverlayHover();
    assert.deepEqual(
      panel.messages.map((message) => message.data),
      [{ itemId: 'pin-2' }],
    );
    runtime.noteOverlayHover('pins', 'pin-2');
    runtime.flushOverlayHover();
    assert.equal(panel.messages.length, 1, 'the hover the app heard is not sent again');
    runtime.noteOverlayHover('pins', undefined);
    runtime.flushOverlayHover();
    assert.deepEqual(panel.messages.at(-1).data, { itemId: undefined });
  } finally {
    stop();
    runtime.stopApp('pins');
  }
});

test('app.openSettings asks for the calling app at App settings, once; a role without the Apps panel is refused', async () => {
  const opened = [];
  const answer = await rpc.answerAppMessage(session(undefined), request(1, 'app.openSettings'), context({ openDetails: (appId) => opened.push(appId) }));
  assert.deepEqual(answer.value, { applied: true });
  assert.deepEqual(opened, ['pins']);
  const noPanel = { ...roles.ADMIN_VIEW, id: 'writer', isAdmin: false, name: 'Writer', features: new Set(['app:pins']) };
  const refused = await rpc.answerAppMessage(
    session(undefined),
    request(2, 'app.openSettings'),
    context({ openDetails: (appId) => opened.push(appId) }, noPanel),
  );
  assert.equal(refused.error.code, 'role-denied');
  assert.equal(opened.length, 1);

  let revealed = 0;
  requests.setAppDetailsReveal(() => {
    revealed += 1;
  });
  requests.requestAppDetails('pins', 'settings');
  const pending = requests.pendingAppDetailsRequest();
  assert.equal(pending.appId, 'pins');
  assert.equal(pending.section, 'settings');
  assert.equal(revealed, 1, 'the Apps panel is revealed');
  requests.handleAppDetailsRequest(pending);
  assert.equal(requests.pendingAppDetailsRequest(), undefined, 'handled once');
  requests.setAppDetailsReveal(undefined);
});

test('people.list: members, then authors, each once, bounded; hidden details stay hidden', async () => {
  const avatar = (login) => `https://github.com/${login}.png?size=40`;
  const authors = [
    { name: 'Ada Lovelace', email: '123+ada@users.noreply.github.com' },
    { name: 'Grace', email: 'grace@example.test' },
    { name: 'Grace again', email: 'GRACE@example.test' },
    { name: undefined, email: undefined },
    { name: 'Linus', email: 'linus@users.noreply.github.com' },
  ];
  const shown = contract.appMembers({ roleMembers: ['Ada', 'ada', 'not a login'], authors, hidden: false, avatar });
  assert.deepEqual(shown, [
    { login: 'Ada', name: undefined, email: undefined, avatarURL: avatar('Ada') },
    { login: undefined, name: 'Grace', email: 'grace@example.test', avatarURL: undefined },
    { login: 'linus', name: 'Linus', email: 'linus@users.noreply.github.com', avatarURL: avatar('linus') },
  ]);
  const hidden = contract.appMembers({ roleMembers: ['Ada'], authors, hidden: true, avatar });
  assert.deepEqual(hidden, [
    { login: 'Ada', name: undefined, email: undefined, avatarURL: avatar('Ada') },
    { login: 'linus', name: undefined, email: undefined, avatarURL: avatar('linus') },
  ]);
  const many = Array.from({ length: 300 }, (_, index) => `member-${index}`);
  assert.equal(contract.appMembers({ roleMembers: many, authors, hidden: false, avatar }).length, contract.APP_RPC_LIMITS.peopleMax);

  assert.deepEqual(contract.parseAppMembers(shown), shown);
  assert.throws(() => contract.parseAppMembers({}), /list/);
  assert.throws(() => contract.parseAppMembers([{ login: 'bad login' }]), /login/);
  assert.throws(() => contract.parseAppMembers([{ avatarURL: 'https://example.test/a.png' }]), /picture/);
  assert.throws(() => contract.parseAppMembers(Array.from({ length: 201 }, () => ({}))), /at most/);

  const listed = await rpc.answerAppMessage(session(undefined), request(1, 'people.list'), { ...context(), host: { people: async () => shown } });
  assert.deepEqual(listed.value, shown);
  const missing = await rpc.answerAppMessage(session(undefined), request(2, 'people.list'), context());
  assert.equal(missing.error.code, 'failed');
});

test('clipboard.write copies bounded text through the host', async () => {
  const copied = [];
  const writeClipboard = async (text) => {
    copied.push(text);
  };
  const answer = await rpc.answerAppMessage(session(undefined), request(1, 'clipboard.write', { text: 'https://stacki.build' }), context({ writeClipboard }));
  assert.deepEqual(answer.value, { applied: true });
  assert.deepEqual(copied, ['https://stacki.build']);
  const tooLong = 'x'.repeat(contract.APP_RPC_LIMITS.clipboardCharsMax + 1);
  assert.equal(
    (await rpc.answerAppMessage(session(undefined), request(2, 'clipboard.write', { text: tooLong }), context({ writeClipboard }))).error.code,
    'bad-params',
  );
  assert.equal((await rpc.answerAppMessage(session(undefined), request(3, 'clipboard.write', {}), context({ writeClipboard }))).error.code, 'bad-params');
  const refused = await rpc.answerAppMessage(
    session(undefined),
    request(4, 'clipboard.write', { text: 'x' }),
    context({ writeClipboard: () => Promise.reject(new Error('Document is not focused')) }),
  );
  assert.equal(refused.error.code, 'failed');
  assert.match(refused.error.message, /focused/);
});
