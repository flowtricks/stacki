// Goal: what apps reach beyond the editor behaves as docs/apps.md says.
// Project files ("Project files"): paths are relative and bounded; traversal,
// absolute paths, `.git/`, `node_modules/`, `.env` files, other apps' folders
// and a symbolic link out of the project are all refused, and an app's own
// folder is allowed; a write, delete, move and folder creation each answer with
// the states before and after, and restoring those states undoes and redoes the
// change; the per-minute budget refuses past its bound. Sign-ins ("Signing
// in"): the manifest's providers are https only, PKCE only, and name declared
// settings; a flow sends a PKCE S256 challenge and a random state; a callback
// with a wrong state is refused and leaves the flow waiting; the exchange sends
// the verifier and the client secret from the vault; the app's token holds the
// access token and nothing else; an expired token refreshes; a revoked refresh
// forgets the sign-in; tokens never land under the project. External services
// ("External services"): `network` is bounded, bare host names only.
// Method: temporary projects on a real disk, a fake seal, and a fake token
// endpoint (a fetch that records each request and answers as each case says).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseAppManifest } from '#dist/shared/properties/apps.js';
import { APP_FILE_LIMITS, parseAppFileOperation, parseAppFilePath } from '#dist/shared/properties/appFiles.js';
import { appConnectHosts, networkSummary, parseAppNetwork } from '#dist/shared/properties/appAuth.js';
import { createAppFileBudget, runAppFileOperation } from '#dist/electron/project/appFilesStore.js';
import { appTokenFile, createAppSignIns, pkcePair } from '#dist/electron/project/appSignIn.js';
import { writeAppSettings } from '#dist/electron/project/appSettingsStore.js';
import { CHANNEL_ACCESS } from '#dist/electron/handlers/channelAccess.js';

const APP = 'analytics';
const BROKER = 'https://broker.example.test';

function project(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-access-')));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/pages/index.astro'), '<h1>Home</h1>\n');
  return root;
}

function store(root: string, operation: unknown, budget = createAppFileBudget(() => 0)) {
  const writes: string[] = [];
  const answer = runAppFileOperation(root, APP, parseAppFileOperation(operation, APP), {
    budget,
    writeFile: (absolute, bytes) => {
      writes.push(absolute);
      fs.writeFileSync(absolute, bytes);
    },
  });
  return { answer, writes };
}

test('app file paths refuse traversal, absolute paths and protected folders, and allow the app’s own folder', () => {
  const refused = [
    '../outside.txt',
    '/etc/passwd',
    'C:/Windows/win.ini',
    'src/../../x',
    'src//double.astro',
    '.git/config',
    'packages/.git/HEAD',
    'node_modules/react/index.js',
    '.env',
    '.env.production',
    '.stacki/apps/apps.json',
    '.stacki/apps/settings.json',
    '.stacki/apps/other-app/index.html',
    '.stacki/app-data/other-app.json',
    'a\\b.txt',
    'x'.repeat(APP_FILE_LIMITS.pathCharsMax + 1),
  ];
  for (const candidate of refused) {
    assert.throws(() => parseAppFilePath(candidate, APP, { allowRoot: false }), /./, candidate);
  }
  assert.equal(parseAppFilePath(`.stacki/apps/${APP}/cache.json`, APP, { allowRoot: false }), `.stacki/apps/${APP}/cache.json`);
  assert.equal(parseAppFilePath(`.stacki/app-data/${APP}.json`, APP, { allowRoot: false }), `.stacki/app-data/${APP}.json`);
  assert.equal(parseAppFilePath('./src/pages/about.astro', APP, { allowRoot: false }), 'src/pages/about.astro');
  assert.equal(parseAppFilePath('', APP, { allowRoot: true }), '');
  assert.throws(() => parseAppFilePath('', APP, { allowRoot: false }), /names a file/);
  // A restore names at most the bound, and a base64 content must be base64.
  assert.throws(() => parseAppFileOperation({ kind: 'restore', states: [] }, APP), /at least one/);
  assert.throws(() => parseAppFileOperation({ kind: 'write', path: 'a.bin', content: 'not base64!', encoding: 'base64' }, APP), /base64/);
  assert.throws(() => parseAppFileOperation({ kind: 'move', from: 'a.txt', to: 'a.txt' }, APP), /same path/);
  // Files are code: the channel is gated by code editing.
  assert.deepEqual(CHANNEL_ACCESS['apps:files'], ['code:edit']);
});

test('a file change answers before and after states, and restoring them undoes and redoes it', () => {
  const root = project();
  const written = store(root, { kind: 'write', path: 'src/data/stats.json', content: '{"views":1}\n' });
  assert.ok(written.answer.ok);
  assert.equal(written.answer.value.kind, 'changed');
  const change = written.answer.value.kind === 'changed' ? written.answer.value.change : undefined;
  assert.ok(change !== undefined);
  // The missing folder is made and recorded, so undo removes it too.
  assert.deepEqual(change.paths, ['src/data', 'src/data/stats.json']);
  assert.deepEqual(
    change.before.map((state) => state.kind),
    ['absent', 'absent'],
  );
  assert.deepEqual(
    change.after.map((state) => state.kind),
    ['directory', 'file'],
  );
  assert.equal(fs.readFileSync(path.join(root, 'src/data/stats.json'), 'utf8'), '{"views":1}\n');

  const read = store(root, { kind: 'read', path: 'src/data/stats.json' });
  assert.ok(read.answer.ok && read.answer.value.kind === 'content');
  assert.equal(read.answer.value.content.encoding, 'utf8');
  assert.equal(read.answer.value.content.content, '{"views":1}\n');

  const binary = store(root, { kind: 'write', path: 'public/pixel.bin', content: Buffer.from([0, 1, 2]).toString('base64'), encoding: 'base64' });
  assert.ok(binary.answer.ok);
  const readBinary = store(root, { kind: 'read', path: 'public/pixel.bin' });
  assert.ok(readBinary.answer.ok && readBinary.answer.value.kind === 'content');
  assert.equal(readBinary.answer.value.content.encoding, 'base64');

  const listing = store(root, { kind: 'list', dir: '' });
  assert.ok(listing.answer.ok && listing.answer.value.kind === 'listing');
  assert.ok(listing.answer.value.listing.entries.some((entry) => entry.path === 'src' && entry.kind === 'directory'));

  // Undo: the states before; redo: the states after.
  assert.ok(store(root, { kind: 'restore', states: change.before }).answer.ok);
  assert.equal(fs.existsSync(path.join(root, 'src/data')), false);
  assert.ok(store(root, { kind: 'restore', states: change.after }).answer.ok);
  assert.equal(fs.readFileSync(path.join(root, 'src/data/stats.json'), 'utf8'), '{"views":1}\n');

  const moved = store(root, { kind: 'move', from: 'src/data/stats.json', to: 'src/content/stats.json' });
  assert.ok(moved.answer.ok && moved.answer.value.kind === 'changed');
  assert.ok(fs.existsSync(path.join(root, 'src/content/stats.json')));
  assert.ok(store(root, { kind: 'restore', states: moved.answer.value.change.before }).answer.ok);
  assert.ok(fs.existsSync(path.join(root, 'src/data/stats.json')));
  assert.equal(fs.existsSync(path.join(root, 'src/content')), false);

  const notEmpty = store(root, { kind: 'delete', path: 'src/data' });
  assert.ok(!notEmpty.answer.ok);
  assert.match(notEmpty.answer.message, /files in it/);
  const removed = store(root, { kind: 'delete', path: 'src/data/stats.json' });
  assert.ok(removed.answer.ok && removed.answer.value.kind === 'changed');
  assert.ok(store(root, { kind: 'restore', states: removed.answer.value.change.before }).answer.ok);
  assert.equal(fs.readFileSync(path.join(root, 'src/data/stats.json'), 'utf8'), '{"views":1}\n');

  const folder = store(root, { kind: 'mkdir', path: 'src/reports/2026' });
  assert.ok(folder.answer.ok && folder.answer.value.kind === 'changed');
  assert.deepEqual(folder.answer.value.change.paths, ['src/reports', 'src/reports/2026']);
  // Too large is refused at the boundary, before anything is written.
  assert.throws(() => parseAppFileOperation({ kind: 'write', path: 'big.txt', content: 'x'.repeat(APP_FILE_LIMITS.fileBytesMax + 1) }, APP), /exceeds/);
  assert.equal(fs.existsSync(path.join(root, 'big.txt')), false);
});

test('a symbolic link cannot lead an app out of the project or into a refused folder', () => {
  const root = project();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-outside-')));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
  fs.symlinkSync(outside, path.join(root, 'linked'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.symlinkSync(path.join(root, '.git'), path.join(root, 'innocent'));
  const escape = store(root, { kind: 'read', path: 'linked/secret.txt' });
  assert.ok(!escape.answer.ok);
  assert.match(escape.answer.message, /outside the project/);
  const write = store(root, { kind: 'write', path: 'linked/new.txt', content: 'x' });
  assert.ok(!write.answer.ok);
  assert.equal(fs.existsSync(path.join(outside, 'new.txt')), false);
  const git = store(root, { kind: 'write', path: 'innocent/config', content: 'x' });
  assert.ok(!git.answer.ok);
  assert.match(git.answer.message, /\.git/);
  // A listing leaves links out.
  const listing = store(root, { kind: 'list', dir: '' });
  assert.ok(listing.answer.ok && listing.answer.value.kind === 'listing');
  assert.ok(!listing.answer.value.listing.entries.some((entry) => entry.path === 'linked'));
});

test('the per-minute budget refuses changes past its bound, and frees them a minute later', () => {
  const root = project();
  let nowMs = 0;
  const budget = createAppFileBudget(() => nowMs);
  for (let index = 0; index < APP_FILE_LIMITS.writesPerMinuteMax; index += 1) {
    assert.ok(store(root, { kind: 'write', path: 'counter.txt', content: String(index) }, budget).answer.ok);
  }
  const refused = store(root, { kind: 'write', path: 'counter.txt', content: 'one too many' }, budget);
  assert.ok(!refused.answer.ok);
  assert.match(refused.answer.message, /a minute/);
  // Reads are not changes, and a restore is the person's own step.
  assert.ok(store(root, { kind: 'read', path: 'counter.txt' }, budget).answer.ok);
  nowMs = APP_FILE_LIMITS.budgetWindowMs;
  assert.ok(store(root, { kind: 'write', path: 'counter.txt', content: 'later' }, budget).answer.ok);
});

// ---------------------------------------------------------------------------
// Sign-ins
// ---------------------------------------------------------------------------

const MANIFEST_INPUT = {
  manifestVersion: 1,
  id: APP,
  name: 'Analytics',
  version: '1.0.0',
  entry: 'index.html',
  settings: [
    { id: 'client-id', label: 'Client ID', kind: 'text', required: true },
    { id: 'client-secret', label: 'Client secret', kind: 'secret', required: true },
  ],
  network: [{ host: 'reports.example.test', purpose: 'Read reports' }],
  auth: [
    {
      id: 'reports',
      label: 'Reports',
      authorizeURL: 'https://accounts.example.test/authorize',
      tokenURL: 'https://oauth.example.test/token',
      scopes: ['reports.read'],
      pkce: true,
      clientIdSetting: 'client-id',
      clientSecretSetting: 'client-secret',
      authorizeParams: { access_type: 'offline' },
    },
  ],
};

function vault() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-vault-')));
  return {
    directory: () => directory,
    seal: {
      refusal: () => undefined,
      seal: (value: string) => `sealed:${Buffer.from(value).toString('base64')}`,
      open: (sealed: string) => Buffer.from(sealed.slice(7), 'base64').toString(),
    },
  };
}

interface TokenCall {
  readonly url: string;
  readonly body: URLSearchParams;
}

function tokenEndpoint(answers: Array<{ readonly status: number; readonly body: unknown }>) {
  const calls: TokenCall[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, body: new URLSearchParams(String(init.body)) });
    const answer = answers.shift();
    assert.ok(answer !== undefined, 'The test answers every token request');
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, fetch };
}

test('the manifest’s auth and network are bounded, https only, PKCE only, and name declared settings', () => {
  const manifest = parseAppManifest(MANIFEST_INPUT);
  assert.equal(manifest.auth[0]?.clientSecretSetting, 'client-secret');
  assert.deepEqual(appConnectHosts(manifest.network, manifest.auth), ['reports.example.test', 'oauth.example.test']);
  assert.equal(networkSummary(manifest.network), 'Uses external services: reports.example.test (Read reports)');
  assert.equal(networkSummary([]), 'Works fully offline');
  const provider = MANIFEST_INPUT.auth[0];
  const variant = (change: Record<string, unknown>) => ({ ...MANIFEST_INPUT, auth: [{ ...provider, ...change }] });
  assert.throws(() => parseAppManifest(variant({ pkce: false })), /pkce/);
  assert.throws(() => parseAppManifest(variant({ tokenURL: 'http://oauth.example.test/token' })), /https/);
  assert.throws(() => parseAppManifest(variant({ clientIdSetting: 'missing' })), /clientIdSetting/);
  assert.throws(() => parseAppManifest(variant({ clientSecretSetting: 'client-id' })), /secret setting/);
  assert.throws(() => parseAppManifest(variant({ authorizeParams: { state: 'mine' } })), /sets state itself/);
  assert.throws(() => parseAppNetwork([{ host: 'https://api.example.test', purpose: 'x' }]), /host name/);
  assert.throws(() => parseAppNetwork([{ host: 'api.example.test/v1', purpose: 'x' }]), /host name/);
  assert.throws(() => parseAppNetwork([{ host: '*.example.test', purpose: 'x' }]), /host name/);
  assert.throws(() => parseAppNetwork(Array.from({ length: 17 }, (_, index) => ({ host: `h${index}.example.test`, purpose: 'x' }))), /at most 16/);
  assert.throws(
    () =>
      parseAppNetwork([
        { host: 'a.example.test', purpose: 'x' },
        { host: 'a.example.test', purpose: 'y' },
      ]),
    /twice/,
  );
});

test('a sign-in uses PKCE and state, refuses a wrong state, and hands the app its access token only', async () => {
  const root = project();
  const secrets = vault();
  const manifest = parseAppManifest(MANIFEST_INPUT);
  writeAppSettings(root, secrets, manifest, { 'client-id': 'installer-client', 'client-secret': 'installer-secret' });
  let nowMs = 1_000_000;
  const endpoint = tokenEndpoint([
    { status: 200, body: { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, token_type: 'Bearer', email: 'ada@example.test' } },
    { status: 200, body: { access_token: 'access-2', expires_in: 3600, token_type: 'Bearer' } },
    { status: 400, body: { error: 'invalid_grant', error_description: 'Token has been revoked.' } },
  ]);
  const signIns = createAppSignIns({ fetch: endpoint.fetch, now: () => nowMs, vault: secrets, broker: BROKER });

  const flow = signIns.begin(root, manifest, 'reports', 'http://127.0.0.1:49152/callback');
  const url = new URL(flow.authorizeURL);
  assert.equal(url.searchParams.get('client_id'), 'installer-client');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:49152/callback');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.has('client_secret'), false, 'The secret never goes to the browser');
  const state = url.searchParams.get('state') ?? '';
  assert.ok(state.length >= 43, 'The state is 32 random bytes');
  // One flow per app at a time.
  assert.throws(() => signIns.begin(root, manifest, 'reports', 'http://127.0.0.1:49153/callback'), /already waiting/);

  // A wrong state is refused, and the real flow keeps waiting for its own callback.
  const wrong = await signIns.complete({ state: `${state.slice(0, -1)}x`, code: 'stolen', error: undefined });
  assert.equal(wrong.ok, false);
  assert.equal(endpoint.calls.length, 0, 'A wrong state never reaches the token endpoint');

  const done = await signIns.complete({ state, code: 'the-code', error: undefined });
  assert.ok(done.ok);
  assert.deepEqual(done.value, { provider: 'reports', connected: true, account: 'ada@example.test', expiresAtMs: nowMs + 3_600_000 });
  assert.deepEqual(await flow.done, done);
  const exchange = endpoint.calls[0];
  assert.ok(exchange !== undefined);
  assert.equal(exchange.url, 'https://oauth.example.test/token');
  assert.equal(exchange.body.get('grant_type'), 'authorization_code');
  assert.equal(exchange.body.get('code'), 'the-code');
  assert.equal(exchange.body.get('client_secret'), 'installer-secret');
  // The verifier sent is the one whose S256 digest the browser was given.
  const verifier = exchange.body.get('code_verifier') ?? '';
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), url.searchParams.get('code_challenge'));
  // A state is spent once.
  assert.equal((await signIns.complete({ state, code: 'again', error: undefined })).ok, false);

  // The app's token: the access token, its type and expiry, and nothing else.
  const token = await signIns.token(root, manifest, 'reports');
  assert.deepEqual(Object.keys(token).sort(), ['accessToken', 'expiresAtMs', 'tokenType']);
  assert.equal(token.accessToken, 'access-1');
  assert.ok(!JSON.stringify(token).includes('refresh-1'));
  assert.ok(!JSON.stringify(token).includes('installer-secret'));

  // Near expiry the token refreshes in the host, keeping the refresh token the answer did not repeat.
  nowMs += 3_600_000 - 30_000;
  const refreshed = await signIns.token(root, manifest, 'reports');
  assert.equal(refreshed.accessToken, 'access-2');
  assert.equal(endpoint.calls[1]?.body.get('grant_type'), 'refresh_token');
  assert.equal(endpoint.calls[1]?.body.get('refresh_token'), 'refresh-1');

  // A revoked refresh token forgets the sign-in: the person connects again.
  nowMs += 3_600_000;
  await assert.rejects(signIns.token(root, manifest, 'reports'), /invalid_grant/);
  assert.deepEqual(signIns.status(root, manifest), [{ provider: 'reports', connected: false }]);
});

test('tokens are sealed in the vault beside the secret settings, never under the project', async () => {
  const root = project();
  const secrets = vault();
  const manifest = parseAppManifest(MANIFEST_INPUT);
  writeAppSettings(root, secrets, manifest, { 'client-id': 'installer-client', 'client-secret': 'installer-secret' });
  const endpoint = tokenEndpoint([{ status: 200, body: { access_token: 'access-sealed', refresh_token: 'refresh-sealed' } }]);
  const signIns = createAppSignIns({ fetch: endpoint.fetch, now: () => 0, vault: secrets, broker: BROKER });
  const flow = signIns.begin(root, manifest, 'reports', 'http://127.0.0.1:49152/callback');
  const state = new URL(flow.authorizeURL).searchParams.get('state') ?? undefined;
  assert.ok((await signIns.complete({ state, code: 'c', error: undefined })).ok);
  const file = appTokenFile(secrets, root);
  assert.ok(path.relative(root, file).startsWith('..'), 'The token file is outside the project');
  const sealed = fs.readFileSync(file, 'utf8');
  assert.ok(!sealed.includes('refresh-sealed'), 'Tokens are sealed, not kept as received');
  // Nothing under the project holds a token, sealed or not.
  const pending = [root];
  for (let visited = 0; visited < 1000 && pending.length > 0; visited += 1) {
    const directory = pending.pop() ?? root;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else {
        const text = fs.readFileSync(full, 'utf8');
        assert.ok(!text.includes('access-sealed'), `${full} holds the token`);
        assert.ok(!text.includes(Buffer.from('refresh').toString('base64').slice(0, 6) + 'sealed'), `${full} holds the sealed token`);
      }
    }
  }
  signIns.forget(root, APP);
  assert.deepEqual(signIns.status(root, manifest), [{ provider: 'reports', connected: false }]);
  // A host that cannot seal refuses to start a sign-in.
  const refusing = createAppSignIns({
    fetch: endpoint.fetch,
    now: () => 0,
    broker: BROKER,
    vault: { ...secrets, seal: { ...secrets.seal, refusal: () => 'A hosted Studio does not keep secret settings yet.' } },
  });
  assert.throws(() => refusing.begin(root, manifest, 'reports', 'http://127.0.0.1:1/callback'), /hosted Studio/);
});

test('a PKCE pair is a 43-character verifier and its S256 challenge', () => {
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), challenge);
  assert.notEqual(pkcePair().verifier, verifier);
});
