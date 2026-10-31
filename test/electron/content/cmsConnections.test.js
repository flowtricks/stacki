// Goal: CMS keys are kept only encrypted and never read back out, and "Log in with Sanity" ends
// with a project Editor key saved and the person's login logged out.
// Method: a stand-in for the OS encryption (reversible but never the plain key) and a temporary
// data folder for the store; for sign-in, a real localhost callback carrying a session id and a
// stubbed fetch that plays Sanity's auth, projects, datasets, tokens and logout endpoints.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CmsConnectionStore } = require('#dist/electron/content/cmsConnectionStore.js');
const { SanityLogin } = require('#dist/electron/content/sanityLogin.js');
const { cmsPreviewEnvironment } = require('#dist/electron/content/cmsPreviewEnvironment.js');

const crypt = (available = true) => ({
  available: () => available,
  encrypt: (text) => Buffer.from(`enc:${[...text].reverse().join('')}`),
  decrypt: (data) => [...data.toString().replace(/^enc:/, '')].reverse().join(''),
});
const SANITY = { kind: 'sanity', label: 'Church', projectId: 'abc123', dataset: 'production' };

function withFolder(run) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-cms-'));
  return Promise.resolve(run(folder)).finally(() => fs.rmSync(folder, { recursive: true }));
}

test('a key is stored encrypted, listed without its value, and given to the preview', () =>
  withFolder((folder) => {
    const store = new CmsConnectionStore(crypt(), () => folder);
    const saved = store.save('/site', { ...SANITY, secret: 'sk-live-secret' });
    const file = fs.readFileSync(path.join(folder, 'cms-connections.json'), 'utf8');
    assert.equal(file.includes('sk-live-secret'), false, 'the key is not on disk in the clear');
    const listed = store.list('/site');
    assert.deepEqual(listed.connections, [saved]);
    assert.equal(JSON.stringify(listed).includes('sk-live'), false);
    assert.equal(store.secret('/site', saved.id), 'sk-live-secret');
    assert.deepEqual(cmsPreviewEnvironment(store, '/site'), {
      STACKI_SANITY_PREVIEW: '1',
      STACKI_SANITY_PROJECT_ID: 'abc123',
      STACKI_SANITY_DATASET: 'production',
      STACKI_SANITY_TOKEN: 'sk-live-secret',
    });
    assert.deepEqual(cmsPreviewEnvironment(store, '/other'), {}, 'another project gets nothing');
    store.save('/site', { ...SANITY, label: 'Again', secret: 'sk-2' });
    assert.equal(store.list('/site').connections.length, 1, 'same project+dataset replaces');
    store.remove('/site', store.list('/site').connections[0].id);
    assert.deepEqual(store.list('/site').connections, []);
  }));

test('nothing is saved where keys cannot be encrypted; a damaged file reads as empty', () =>
  withFolder((folder) => {
    const store = new CmsConnectionStore(crypt(false), () => folder);
    assert.equal(store.list('/site').encryption, 'unavailable');
    assert.throws(() => store.save('/site', { ...SANITY, secret: 'k' }), /cannot encrypt/);
    fs.writeFileSync(path.join(folder, 'cms-connections.json'), '{ not json');
    assert.deepEqual(new CmsConnectionStore(crypt(), () => folder).list('/site').connections, []);
  }));

// Plays Sanity: the session exchange, one project with one dataset, a new key, and logout.
function fakeSanity(calls, { tokenStatus = 201 } = {}) {
  const realFetch = globalThis.fetch;
  return async (url, init = {}) => {
    const href = String(url);
    // The test's own visit to the callback goes to the real local server.
    if (href.startsWith('http://localhost:')) {
      return realFetch(url, init);
    }
    calls.push(`${init.method ?? 'GET'} ${new URL(href).pathname}`);
    const reply = (status, body) =>
      new Response(body === undefined ? '' : JSON.stringify(body), { status });
    if (href.includes('/auth/fetch?sid=good-sid')) {
      return reply(200, { token: 'login-token-123', label: 'x' });
    }
    if (href.endsWith('/projects')) {
      return reply(200, [{ id: 'abc123', displayName: 'Church' }]);
    }
    if (href.endsWith('/projects/abc123/datasets')) {
      return reply(200, [{ name: 'production' }]);
    }
    if (href.endsWith('/projects/abc123/tokens')) {
      assert.match(init.headers.Authorization, /login-token-123/);
      assert.deepEqual(JSON.parse(init.body).roleName, 'editor');
      // Every key gets a new label: Sanity refuses a second key with the same one.
      assert.match(JSON.parse(init.body).label, /^Stacki \(.+\) \d{4}-\d\d-\d\d \d\d:\d\d UTC$/);
      return tokenStatus === 201
        ? reply(201, { key: 'editor-key-456' })
        : reply(tokenStatus, { message: 'Forbidden' });
    }
    if (href.endsWith('/auth/logout')) {
      return reply(200, {});
    }
    return reply(404, { message: 'unexpected' });
  };
}

async function signIn(login, root, back = 'cli') {
  const id = '00000000-0000-4000-8000-000000000001';
  login.request(root, { action: 'start', id });
  let state;
  for (let tries = 0; tries < 50; tries++) {
    state = login.request(root, { action: 'status', id });
    if (state.kind === 'browser') {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(state.kind, 'browser');
  const page = new URL(state.url);
  assert.equal(page.origin + page.pathname, 'https://www.sanity.io/login');
  assert.equal(page.searchParams.get('type'), 'stampedToken');
  const origin = page.searchParams.get('origin');
  assert.match(origin, /^http:\/\/localhost:\d+\/callback$/);
  if (back === 'fragment') {
    // A return with the id in the fragment: the page reads it and comes back with it.
    const handoff = await (await fetch(origin)).text();
    assert.match(handoff, /location\.hash/);
    assert.match(handoff, /\/callback\?sid=/);
  }
  // The browser's return: the CLI's form (`url`) or the SDK's (`sid` in the query).
  const query =
    back === 'cli'
      ? `url=${encodeURIComponent('https://api.sanity.io/v1/auth/done?sid=good-sid')}`
      : 'sid=good-sid';
  const answer = await fetch(`${origin}?${query}`, { redirect: 'manual' });
  assert.equal(answer.status, 303);
  return id;
}

async function until(login, root, id, kind) {
  for (let tries = 0; tries < 100; tries++) {
    const state = login.request(root, { action: 'status', id });
    if (state.kind === kind || state.kind === 'failed') {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`never reached ${kind}`);
}

test('signing in saves an Editor key for the chosen project and logs the login out', () =>
  withFolder(async (folder) => {
    const root = path.join(folder, 'site');
    fs.mkdirSync(root);
    fs.writeFileSync(
      path.join(root, '.env'),
      'SANITY_PROJECT_ID=abc123\nSANITY_DATASET=production\n',
    );
    const calls = [];
    const realFetch = globalThis.fetch;
    const store = new CmsConnectionStore(crypt(), () => folder);
    const login = new SanityLogin(store);
    try {
      globalThis.fetch = fakeSanity(calls);
      const id = await signIn(login, root);
      const choosing = await until(login, root, id, 'choosing');
      assert.deepEqual(choosing.suggestion, { projectId: 'abc123', dataset: 'production' });
      login.request(root, { action: 'choose', id, projectId: 'abc123', dataset: 'production' });
      const done = await until(login, root, id, 'complete');
      assert.equal(done.kind, 'complete');
      assert.equal(store.secret(root, done.connection.id), 'editor-key-456');
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(
        calls.some((call) => call === 'POST /v2021-06-07/auth/logout'),
        calls.join('\n'),
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  }));

test('a role that cannot create keys says so, and nothing is saved', () =>
  withFolder(async (folder) => {
    const calls = [];
    const realFetch = globalThis.fetch;
    const store = new CmsConnectionStore(crypt(), () => folder);
    const login = new SanityLogin(store);
    try {
      globalThis.fetch = fakeSanity(calls, { tokenStatus: 403 });
      const id = await signIn(login, folder, 'fragment');
      await until(login, folder, id, 'choosing');
      login.request(folder, { action: 'choose', id, projectId: 'abc123', dataset: 'production' });
      const failed = await until(login, folder, id, 'complete');
      assert.equal(failed.kind, 'failed');
      assert.match(failed.message, /cannot create API keys/);
      assert.deepEqual(store.list(folder).connections, []);
    } finally {
      globalThis.fetch = realFetch;
    }
  }));

test('a choice outside the listed projects is ignored, and an unknown session is refused', () =>
  withFolder(async (folder) => {
    const login = new SanityLogin(new CmsConnectionStore(crypt(), () => folder));
    const unknown = login.request(folder, {
      action: 'status',
      id: '00000000-0000-4000-8000-000000000009',
    });
    assert.equal(unknown.kind, 'failed');
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = fakeSanity([]);
      const id = await signIn(login, folder, 'query');
      await until(login, folder, id, 'choosing');
      const state = login.request(folder, {
        action: 'choose',
        id,
        projectId: 'zzz',
        dataset: 'production',
      });
      assert.equal(state.kind, 'choosing', 'nothing happens for a project not offered');
      login.request(folder, { action: 'cancel', id });
    } finally {
      globalThis.fetch = realFetch;
    }
  }));
