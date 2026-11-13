// Goal: connecting to Payload tells the person at once, in words they can act on, whether the address,
// the auth collection, the key or the password is wrong, and never makes things worse: a wrong password
// is sent once, not in a loop, so Payload's ten-minute lockout is not triggered by Stacki; a locked account
// says "too many attempts", not "wrong password"; an expired login is renewed once and then the request
// is repeated; a secret never appears in a message.
// Method: a fake Payload (test/helpers/fakePayload.js) that answers with the replies recorded from a real
// Payload 3.93 (test/fixtures/cms/payload/, docs/cms-testing.md), including `{"user":null}` with HTTP 200
// for a key it does not accept. The same checks run against a real server by hand (docs/cms-testing.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fakePayload, API_KEY, EMAIL, PASSWORD } = require('../../helpers/fakePayload.js');
const { payloadRequest, clearPayloadSessions, PayloadError } = require('#dist/electron/content/payloadClient.js');
const { checkPayloadAccount } = require('#dist/electron/content/payloadService.js');
const { checkPayload, payloadTargetOf } = require('#dist/electron/content/payloadAccess.js');
const { clearPayloadSchemas } = require('#dist/electron/content/payloadSchema.js');
const { cmsNetworkFailure } = require('#dist/electron/content/cmsNetworkFailure.js');
const { cmsFailureMessage } = require('#dist/electron/content/cmsRemoteService.js');
const { CmsConnectionStore } = require('#dist/electron/content/cmsConnectionStore.js');
const { registerCmsConnectionHandlers } = require('#dist/electron/handlers/cmsConnectionHandlers.js');

const keyTarget = (base, key = API_KEY, collection = 'users') => ({ baseUrl: base, collection, auth: { kind: 'apiKey', key } });
const passwordTarget = (base, password = PASSWORD) => ({ baseUrl: base, collection: 'users', auth: { kind: 'password', email: EMAIL, password } });
const failure = async (run) => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
};
test.beforeEach(() => {
  clearPayloadSessions();
  clearPayloadSchemas();
});

test('a key Payload accepts connects, and the request is exactly what Payload reads', async () => {
  const fake = await fakePayload();
  const summary = await checkPayloadAccount(keyTarget(fake.base), []);
  assert.equal(summary.user, EMAIL);
  assert.equal(summary.mode, 'apiKey');
  assert.equal(summary.graphql, true);
  assert.deepEqual(summary.locales, ['en', 'fr']);
  assert.deepEqual(
    summary.collections.map((collection) => `${collection.slug}${collection.drafts ? '+drafts' : ''}${collection.upload ? '+upload' : ''}`).sort(),
    ['categories', 'media+upload', 'pages', 'posts+drafts', 'users'],
  );
  const me = fake.calls.find((call) => call.path === '/api/users/me');
  assert.equal(me.method, 'GET');
  assert.equal(me.authorization, `users API-Key ${API_KEY}`);
  await fake.close();
});

test('a key Payload does not accept is refused even though Payload answers 200', async () => {
  const fake = await fakePayload();
  const wrongKey = await failure(() => checkPayloadAccount(keyTarget(fake.base, 'wrong'), []));
  assert.equal(wrongKey.failure, 'noUser');
  assert.match(wrongKey.message, /did not accept this key/);
  assert.match(wrongKey.message, /Enable API key/);
  const wrongCollection = await failure(() => checkPayloadAccount(keyTarget(fake.base, API_KEY, 'admins'), []));
  assert.equal(wrongCollection.failure, 'badAddress');
  assert.match(wrongCollection.message, /No Payload API at .*\/api\/admins\/me/);
  await fake.close();
});

test('each other answer reads as what it is', async () => {
  const answer = (status, headers, text) => (request, response) => (response.writeHead(status, headers), response.end(text), true);
  const cases = [
    [answer(401, {}, '{}'), 'unauthorized', /refused this key/],
    [answer(403, {}, '{}'), 'forbidden', /not allowed/],
    [answer(404, {}, '{}'), 'badAddress', /No Payload API at/],
    [answer(429, {}, '{}'), 'rateLimited', /too many requests/],
    [answer(413, {}, '{}'), 'tooLarge', /larger than/],
    [answer(500, {}, 'boom'), 'server', /server error \(500\)/],
    [answer(301, { location: 'https://cms.example.test/' }, ''), 'redirect', /redirects to https:\/\/cms\.example\.test\//],
    [answer(200, { 'content-type': 'text/html' }, '<html>my website</html>'), 'malformed', /not like Payload/],
    [answer(200, {}, '{"user":'), 'malformed', /not like Payload/],
  ];
  for (const [route, kind, expected] of cases) {
    const fake = await fakePayload({ route });
    const error = await failure(() => checkPayloadAccount(keyTarget(fake.base), []));
    assert.equal(error?.failure, kind);
    assert.match(error.message, expected);
    assert.ok(error.messageRef.key.startsWith('settings.cms.payload.error.'), 'every failure carries a translatable reference');
    await fake.close();
  }
});

test('a reply larger than Stacki reads is refused, not buffered', async () => {
  const fake = await fakePayload({
    route: (request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(30 * 1024 * 1024) });
      response.write('{"pad":"');
      return true;
    },
  });
  const error = await failure(() => payloadRequest(keyTarget(fake.base), { method: 'GET', path: '/api/users/me' }));
  assert.equal(error?.failure, 'tooLargeReply');
  await fake.close();
});

test('a server that is not running says so, with its address', async () => {
  const fake = await fakePayload();
  await fake.close();
  const error = await failure(() => checkPayloadAccount(keyTarget(fake.base), []));
  assert.equal(error.failure, 'network');
  assert.match(error.message, /Nothing is answering at http:\/\/127\.0\.0\.1:\d+/);
});

test('a connection cut in the middle of a reply is a network failure, not half a document', async () => {
  const fake = await fakePayload({
    route: (request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': '5000' });
      response.write('{"user":');
      setTimeout(() => response.socket.destroy(), 20);
      return true;
    },
  });
  const error = await failure(() => payloadRequest(keyTarget(fake.base), { method: 'GET', path: '/api/users/me' }));
  assert.equal(error?.failure, 'network');
  assert.match(error.message, /cut off|reach the CMS/);
  await fake.close();
});

test('a slow server times out with a message, and the timeout is Stacki’s, not the server’s', async () => {
  const fake = await fakePayload({ route: () => true });
  const started = Date.now();
  const error = await failure(() => payloadRequest(keyTarget(fake.base), { method: 'GET', path: '/api/users/me', timeoutMs: 150 }));
  assert.equal(error?.failure, 'timeout');
  assert.match(error.message, /took too long/);
  assert.ok(Date.now() - started < 3000);
  await fake.close();
});

test('an email and password log in once, and the token is the only thing sent afterwards', async () => {
  const fake = await fakePayload();
  const target = passwordTarget(fake.base);
  const summary = await checkPayloadAccount(target, []);
  assert.equal(summary.mode, 'password');
  assert.equal(summary.user, EMAIL);
  await payloadRequest(target, { method: 'GET', path: '/api/access' });
  assert.equal(fake.state.logins, 1, 'one login serves every request');
  const login = fake.calls.find((call) => call.path === '/api/users/login');
  assert.deepEqual(login.body, { email: EMAIL, password: PASSWORD });
  const others = fake.calls.filter((call) => call.path !== '/api/users/login');
  assert.ok(others.every((call) => call.authorization === 'JWT token-1'));
  await fake.close();
});

test('a wrong password is sent once; asking again does not send it again, so the account is never locked by Stacki', async () => {
  const fake = await fakePayload();
  const target = passwordTarget(fake.base, 'nope');
  const kinds = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    kinds.push((await failure(() => checkPayloadAccount(target, [])))?.failure);
  }
  assert.deepEqual(kinds, ['login', 'loginPaused', 'loginPaused', 'loginPaused', 'loginPaused', 'loginPaused']);
  assert.equal(fake.state.logins, 1);
  assert.equal(fake.state.failedLogins, 1);
  // The right password still works for the person who fixes it (a new session: the connection was saved again).
  clearPayloadSessions();
  assert.equal((await checkPayloadAccount(passwordTarget(fake.base), [])).user, EMAIL);
  await fake.close();
});

test('a locked account says too many attempts, not wrong password', async () => {
  const fake = await fakePayload();
  fake.state.failedLogins = 5;
  const error = await failure(() => checkPayloadAccount(passwordTarget(fake.base), []));
  assert.equal(error.failure, 'locked');
  assert.match(error.message, /Too many attempts; try again in about 10 minutes/);
  assert.doesNotMatch(error.message, /password/i);
  const again = await failure(() => checkPayloadAccount(passwordTarget(fake.base), []));
  assert.equal(again.failure, 'locked', 'a locked account stays reported as locked while remembered');
  assert.equal(fake.state.logins, 1, 'and is not asked again');
  await fake.close();
});

test('an expired login is renewed once and the request repeated', async () => {
  const fake = await fakePayload({ tokenSeconds: 3600 });
  const target = passwordTarget(fake.base);
  await payloadRequest(target, { method: 'GET', path: '/api/users' });
  // The server's clock moves past the token's expiry while Stacki still believes it is valid: Payload now sees
  // an anonymous visitor, who is refused (403) a protected collection.
  const realNow = fake.state.now;
  fake.state.now = () => realNow() + 2 * 3600 * 1000;
  const reply = await payloadRequest(target, { method: 'GET', path: '/api/users' });
  assert.ok(Array.isArray(reply.docs), 'the repeated request succeeded');
  assert.equal(fake.state.logins, 2, 'exactly one new login');
  assert.equal(fake.calls.filter((call) => call.path === '/api/users' && call.method === 'GET').length, 3, 'refused once, then repeated');
  await fake.close();
});

test('an expired login that Payload answers as an anonymous visitor does not quietly hide drafts', async () => {
  // Payload gives an expired token, a revoked one or a switched-off key published content only, with HTTP 200.
  const fake = await fakePayload({ postCount: 10 });
  const target = passwordTarget(fake.base);
  const draftsIn = async () =>
    (await payloadRequest(target, { method: 'GET', path: '/api/posts', query: { limit: 100, draft: true } })).docs.filter((post) => post._status === 'draft')
      .length;
  assert.equal(await draftsIn(), 2);
  const realNow = fake.state.now;
  fake.state.now = () => realNow() + 2 * 3600 * 1000;
  const clock = Date.now;
  Date.now = () => clock() + 3 * 60 * 1000;
  try {
    assert.equal(await draftsIn(), 2, 'the account is looked at again, found signed out, logged in again');
    assert.equal(fake.state.logins, 2);
  } finally {
    Date.now = clock;
  }
  await fake.close();
});

test('an API key that was switched off is reported, not read as an anonymous visitor', async () => {
  const fake = await fakePayload({ postCount: 10 });
  const target = keyTarget(fake.base);
  await payloadRequest(target, { method: 'GET', path: '/api/posts', query: { limit: 1 } });
  fake.state.keyEnabled = false;
  const clock = Date.now;
  Date.now = () => clock() + 3 * 60 * 1000;
  try {
    const error = await failure(() => payloadRequest(target, { method: 'GET', path: '/api/posts', query: { limit: 100, draft: true } }));
    assert.equal(error?.failure, 'noUser');
  } finally {
    Date.now = clock;
  }
  await fake.close();
});

test('a token that is still refused after logging in again is a final answer, not a loop', async () => {
  const fake = await fakePayload({
    route: (request, response) => (request.url.startsWith('/api/access') ? (response.writeHead(401), response.end('{}'), true) : false),
  });
  const error = await failure(() => payloadRequest(passwordTarget(fake.base), { method: 'GET', path: '/api/access' }));
  assert.equal(error.failure, 'unauthorized');
  assert.equal(fake.state.logins, 2);
  await fake.close();
});

test('no message or reference ever contains the secret', async () => {
  const fake = await fakePayload();
  const messages = [];
  for (const target of [keyTarget(fake.base, 'SECRET-KEY-VALUE'), passwordTarget(fake.base, 'SECRET-PASSWORD-VALUE')]) {
    clearPayloadSessions();
    const error = await failure(() => checkPayloadAccount(target, []));
    messages.push(JSON.stringify({ message: error.message, ref: error.messageRef }));
  }
  assert.ok(messages.every((text) => !/SECRET-/.test(text)));
  await fake.close();
});

test('the connection becomes a request target of the right kind', () => {
  const key = payloadTargetOf({ baseUrl: 'http://x.test', collection: 'users', auth: 'apiKey', email: undefined }, 'k');
  assert.deepEqual(key.auth, { kind: 'apiKey', key: 'k' });
  const login = payloadTargetOf({ baseUrl: 'http://x.test', collection: 'users', auth: 'password', email: 'a@b.test' }, 'p');
  assert.deepEqual(login.auth, { kind: 'password', email: 'a@b.test', password: 'p' });
  assert.throws(() => payloadTargetOf({ baseUrl: 'http://x.test', collection: 'users', auth: 'password', email: undefined }, 'p'), /names its email/);
});

test('network failures are told apart by the code fetch buries in cause', () => {
  const failed = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code }) });
  assert.match(cmsNetworkFailure(failed('ECONNREFUSED'), 'http://localhost:3000'), /Nothing is answering at http:\/\/localhost:3000/);
  assert.match(cmsNetworkFailure(failed('ENOTFOUND'), 'https://nope.test'), /Can’t find https:\/\/nope\.test/);
  assert.match(cmsNetworkFailure(failed('ECONNRESET'), 'https://x.test'), /cut off/);
  assert.match(cmsNetworkFailure(failed('DEPTH_ZERO_SELF_SIGNED_CERT'), 'https://x.test'), /certificate this computer does not trust/);
  assert.match(cmsNetworkFailure(failed('ERR_SSL_WRONG_VERSION_NUMBER'), 'http://x.test'), /does not speak https/);
  assert.match(cmsNetworkFailure(new TypeError('fetch failed'), undefined), /internet connection/);
  assert.equal(cmsNetworkFailure(new Error(''), undefined), 'The CMS request failed.');
  // Without an address the failure can only say the CMS was not reached.
  assert.match(cmsFailureMessage(failed('ECONNREFUSED')), /Can’t reach the CMS/);
});

test('the same failures carry a reference the interface translates, for every network code', async () => {
  const codes = {
    ECONNREFUSED: 'refused',
    ENOTFOUND: 'unresolved',
    ECONNRESET: 'cutOff',
    ERR_SSL_WRONG_VERSION_NUMBER: 'wrongProtocol',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'certificate',
  };
  const originalFetch = globalThis.fetch;
  try {
    for (const [code, key] of Object.entries(codes)) {
      globalThis.fetch = async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code }) });
      };
      const error = await failure(() => payloadRequest(keyTarget('https://cms.example.test'), { method: 'GET', path: '/api/users/me' }));
      assert.equal(error.messageRef.key, `settings.cms.payload.error.${key}`);
      assert.ok(error instanceof PayloadError);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('saving a Payload connection checks the account first, and keeps nothing when it fails', async () => {
  const fake = await fakePayload();
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-payload-')));
  fs.writeFileSync(path.join(work, 'package.json'), '{}');
  const crypt = { available: () => true, encrypt: (value) => Buffer.from(value), decrypt: (data) => data.toString() };
  const store = new CmsConnectionStore(crypt, () => work);
  const handlers = new Map();
  registerCmsConnectionHandlers(
    {
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      assertInProject: () => {},
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    },
    store,
    { request: async () => ({ kind: 'failed', message: 'unused' }) },
  );
  const save = (draft) =>
    handlers.get('cmsConnections:save')(
      {},
      { projectPath: work, draft: { kind: 'payload', label: 'CMS', baseUrl: fake.base, collection: 'users', auth: 'apiKey', collections: [], ...draft } },
    );
  const bad = await save({ secret: 'wrong' });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /did not accept this key/);
  assert.equal(bad.messageRef.key, 'settings.cms.payload.error.noUser');
  assert.equal(store.list(work).connections.length, 0, 'a refused key leaves nothing saved');
  const good = await save({ secret: API_KEY });
  assert.equal(good.ok, true);
  assert.equal(good.list.connections.length, 1);
  assert.equal(JSON.stringify(good).includes(API_KEY), false, 'no reply carries the key');
  // A login connection: the password is checked by logging in, and is stored like a key.
  const login = await save({ auth: 'password', email: EMAIL, secret: PASSWORD, label: 'Login' });
  assert.equal(login.ok, true);
  assert.equal(JSON.stringify(login).includes(PASSWORD), false);
  const stored = store.list(work).connections.find((connection) => connection.label === 'Login');
  assert.equal(store.secret(work, stored.id), PASSWORD);
  assert.equal(fs.readFileSync(path.join(work, 'package.json'), 'utf8'), '{}', 'nothing is written into the project');
  const test = await handlers.get('cmsConnections:check')({}, { projectPath: work, request: { action: 'test', id: stored.id } });
  assert.equal(test.ok, true);
  assert.equal(test.summary.user, EMAIL);
  assert.equal(JSON.stringify(test).includes(PASSWORD), false);
  const detect = await handlers.get('cmsConnections:check')(
    {},
    {
      projectPath: work,
      request: {
        action: 'detect',
        draft: { kind: 'payload', label: 'x', baseUrl: fake.base, collection: 'users', auth: 'apiKey', collections: [], secret: 'wrong' },
      },
    },
  );
  assert.equal(detect.ok, false);
  assert.equal(store.list(work).connections.length, 1, 'Detect and Test save nothing (one connection per address: the login replaced the key)');
  await fake.close();
  fs.rmSync(work, { recursive: true, force: true });
});

test('checkPayload returns a failure value for a Payload failure and lets a programmer error crash', async () => {
  const fake = await fakePayload();
  const result = await checkPayload({ baseUrl: fake.base, collection: 'users', auth: 'apiKey', email: undefined, collections: [] }, 'wrong');
  assert.equal(result.ok, false);
  await assert.rejects(
    () => checkPayload({ baseUrl: fake.base, collection: 'users', auth: 'password', email: undefined, collections: [] }, 'p'),
    /names its email/,
  );
  await fake.close();
});
