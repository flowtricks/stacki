// Goal: Stacki connections and requests through the host behave as docs/apps.md
// says ("Connections", "Calling services from Stacki"). A `provider:` manifest
// entry takes its endpoints from the registry and asks only for allowlisted
// scopes; its sign-in starts at the broker with the editor's PKCE challenge,
// state and loopback return, never a client id or secret; the exchange posts
// the code, the broker's handoff and the verifier to the broker, and the refresh
// goes to the broker too; a filled-in client id switches to the installer's own
// client. `net.fetch` reaches declared hosts only, signs with the sign-in when
// asked, follows redirects only to declared hosts and drops the authorization
// when the host changes, strips cookies both ways, and is rate limited.
// Method: temporary projects on a real disk, a fake seal, and a fake network (a
// fetch that records each request and answers as each case says).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseAppManifest } from '#dist/shared/properties/apps.js';
import { STACKI_CONNECTION_PROVIDERS, parseBrokerOrigin, stackiBrokerOrigin } from '#dist/shared/properties/appConnections.js';
import { APP_NET_LIMITS, parseAppNetRequest } from '#dist/shared/properties/appNet.js';
import { createAppSignIns } from '#dist/electron/project/appSignIn.js';
import { appNetFetch, createAppNetRate } from '#dist/electron/project/appNetFetch.js';
import { writeAppSettings } from '#dist/electron/project/appSettingsStore.js';

const BROKER = 'https://broker.example.test';

const MANIFEST_INPUT = {
  manifestVersion: 1,
  id: 'analytics',
  name: 'Analytics',
  version: '1.0.0',
  entry: 'index.html',
  settings: [
    { id: 'own-client', label: 'Your own client id', kind: 'text' },
    { id: 'own-secret', label: 'Your own client secret', kind: 'secret' },
  ],
  network: [
    { host: 'analyticsdata.example.test', purpose: 'Read reports' },
    { host: 'mirror.example.test', purpose: 'Report mirror' },
  ],
  auth: [
    {
      provider: 'google',
      label: 'Google Analytics',
      scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
      clientIdSetting: 'own-client',
      clientSecretSetting: 'own-secret',
    },
  ],
};

function project(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-connections-')));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  return root;
}

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

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function network(answer: (url: string, init: RequestInit) => Response) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return answer(url, init);
  };
  return { calls, fetch };
}

test('a provider: entry takes the registry’s endpoints and only allowlisted scopes', () => {
  const manifest = parseAppManifest(MANIFEST_INPUT);
  const provider = manifest.auth[0];
  assert.ok(provider !== undefined);
  assert.equal(provider.id, 'google');
  assert.equal(provider.connection, 'google');
  assert.equal(provider.tokenURL, STACKI_CONNECTION_PROVIDERS.google.tokenURL);
  const variant = (change: Record<string, unknown>) => ({ ...MANIFEST_INPUT, auth: [{ ...MANIFEST_INPUT.auth[0], ...change }] });
  assert.throws(() => parseAppManifest(variant({ scopes: ['https://www.googleapis.com/auth/drive'] })), /does not offer the scope/);
  assert.throws(() => parseAppManifest(variant({ provider: 'dropbox' })), /must be one of google, hubspot/);
  assert.throws(() => parseAppManifest(variant({ tokenURL: 'https://evil.example.test/token' })), /endpoints from Stacki/);
  // No client settings at all is the ordinary case: Stacki's own client.
  const plain = parseAppManifest({ ...MANIFEST_INPUT, settings: [], auth: [{ provider: 'hubspot', scopes: ['oauth', 'crm.objects.contacts.read'] }] });
  assert.equal(plain.auth[0]?.label, 'HubSpot');
  assert.equal(plain.auth[0]?.clientIdSetting, undefined);
  // The broker is stacki.build in a release, whatever the environment says.
  assert.equal(stackiBrokerOrigin({ STACKI_OAUTH_BROKER: 'http://localhost:8787' }, 'release'), 'https://stacki.build');
  assert.equal(stackiBrokerOrigin({ STACKI_OAUTH_BROKER: 'http://localhost:8787' }, 'development'), 'http://localhost:8787');
  assert.throws(() => parseBrokerOrigin('http://broker.example.test'), /https/);
});

test('a Stacki connection signs in through the broker with PKCE and state, and refreshes there', async () => {
  const root = project();
  const secrets = vault();
  const manifest = parseAppManifest(MANIFEST_INPUT);
  let nowMs = 5_000_000;
  const answers = [
    { access_token: 'broker-access-1', refresh_token: 'broker-refresh', expires_in: 3600, token_type: 'Bearer' },
    { access_token: 'broker-access-2', expires_in: 3600, token_type: 'Bearer' },
  ];
  const fake = network(() => new Response(JSON.stringify(answers.shift()), { status: 200 }));
  const signIns = createAppSignIns({ fetch: fake.fetch, now: () => nowMs, vault: secrets, broker: BROKER });
  const flow = signIns.begin(root, manifest, 'google', 'http://127.0.0.1:49200/callback');
  const start = new URL(flow.authorizeURL);
  assert.equal(start.origin + start.pathname, `${BROKER}/api/oauth/google/start`);
  assert.equal(start.searchParams.get('return'), 'http://127.0.0.1:49200/callback');
  assert.equal(start.searchParams.get('scope'), 'https://www.googleapis.com/auth/analytics.readonly');
  assert.equal(start.searchParams.has('client_id'), false, 'Stacki’s client id is the broker’s to add');
  const state = start.searchParams.get('state') ?? undefined;
  const challenge = start.searchParams.get('challenge') ?? '';
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);

  // Without the broker's handoff the code is not exchanged.
  const missing = await signIns.complete({ state, code: 'c', error: undefined });
  assert.equal(missing.ok, false);
  assert.equal(fake.calls.length, 0);

  const second = signIns.begin(root, manifest, 'google', 'http://127.0.0.1:49200/callback');
  const secondState = new URL(second.authorizeURL).searchParams.get('state') ?? undefined;
  const secondChallenge = new URL(second.authorizeURL).searchParams.get('challenge') ?? '';
  const done = await signIns.complete({ state: secondState, code: 'the-code', error: undefined, handoff: 'signed.handoff' });
  assert.ok(done.ok);
  const exchange = fake.calls[0];
  assert.ok(exchange !== undefined);
  assert.equal(exchange.url, `${BROKER}/api/oauth/google/token`);
  const parsed: unknown = JSON.parse(String(exchange.init.body));
  assert.ok(typeof parsed === 'object' && parsed !== undefined && parsed !== null);
  const sent = new Map<string, unknown>(Object.entries(parsed));
  assert.deepEqual([...sent.keys()].sort(), ['code', 'handoff', 'verifier']);
  const verifier = String(sent.get('verifier'));
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), secondChallenge);
  assert.notEqual(challenge, secondChallenge);

  nowMs += 3_600_000;
  const refreshed = await signIns.token(root, manifest, 'google');
  assert.equal(refreshed.accessToken, 'broker-access-2');
  const refresh = fake.calls[1];
  assert.equal(refresh?.url, `${BROKER}/api/oauth/google/refresh`);
  assert.deepEqual(JSON.parse(String(refresh?.init.body)), { refresh_token: 'broker-refresh' });
});

test('a filled-in client id switches a Stacki connection to the installer’s own client', () => {
  const root = project();
  const secrets = vault();
  const manifest = parseAppManifest(MANIFEST_INPUT);
  writeAppSettings(root, secrets, manifest, { 'own-client': 'my-client', 'own-secret': 'my-secret' });
  const signIns = createAppSignIns({ fetch: network(() => new Response('{}')).fetch, now: () => 0, vault: secrets, broker: BROKER });
  const url = new URL(signIns.begin(root, manifest, 'google', 'http://127.0.0.1:49201/callback').authorizeURL);
  assert.equal(url.origin + url.pathname, STACKI_CONNECTION_PROVIDERS.google.authorizeURL);
  assert.equal(url.searchParams.get('client_id'), 'my-client');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:49201/callback');
});

test('net.fetch reaches declared hosts only, signs when asked, and keeps cookies and the token out of redirects', async () => {
  const manifest = parseAppManifest(MANIFEST_INPUT);
  const rate = createAppNetRate(() => 0);
  const fake = network((url) => {
    if (url.startsWith('https://analyticsdata.example.test/redirect')) {
      return new Response('', { status: 302, headers: { location: 'https://mirror.example.test/report' } });
    }
    if (url.startsWith('https://analyticsdata.example.test/escape')) {
      return new Response('', { status: 302, headers: { location: 'https://undeclared.example.test/' } });
    }
    return new Response('{"rows":[]}', { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'session=1' } });
  });
  const dependencies = { fetch: fake.fetch, now: () => 0, accessToken: async () => 'access-token' };
  const request = (input: unknown) => parseAppNetRequest(input);

  const answer = await appNetFetch(
    manifest,
    request({
      url: 'https://analyticsdata.example.test/v1beta/properties/1:runReport',
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
      auth: 'google',
    }),
    rate,
    dependencies,
  );
  assert.equal(answer.status, 200);
  assert.equal(answer.body, '{"rows":[]}');
  assert.equal(answer.headers['set-cookie'], undefined);
  const sent = new Headers(fake.calls[0]?.init.headers);
  assert.equal(sent.get('authorization'), 'Bearer access-token');
  assert.equal(fake.calls[0]?.init.redirect, 'manual');

  await assert.rejects(appNetFetch(manifest, request({ url: 'https://undeclared.example.test/' }), rate, dependencies), /not declared/);
  await assert.rejects(appNetFetch(manifest, request({ url: 'https://analyticsdata.example.test/escape' }), rate, dependencies), /redirected to undeclared/);

  const before = fake.calls.length;
  await appNetFetch(manifest, request({ url: 'https://analyticsdata.example.test/redirect', auth: 'google' }), rate, dependencies);
  const followed = fake.calls[before + 1];
  assert.equal(followed?.url, 'https://mirror.example.test/report');
  assert.equal(new Headers(followed?.init.headers).has('authorization'), false, 'The token stays with the host the app named');

  // The boundary refuses what a host request never sends.
  assert.throws(() => request({ url: 'http://analyticsdata.example.test/' }), /https/);
  assert.throws(() => request({ url: 'https://analyticsdata.example.test/', headers: { cookie: 'a=1' } }), /cookie/);
  assert.throws(() => request({ url: 'https://analyticsdata.example.test/', headers: { authorization: 'x' }, auth: 'google' }), /authorization/);
  assert.throws(() => request({ url: 'https://analyticsdata.example.test/', method: 'GET', body: 'x' }), /no body/);
  assert.throws(() => request({ url: 'https://analyticsdata.example.test/', method: 'POST', body: 'x'.repeat(APP_NET_LIMITS.requestBytesMax + 1) }), /exceeds/);
});

test('net.fetch is rate limited per app', async () => {
  const manifest = parseAppManifest(MANIFEST_INPUT);
  const rate = createAppNetRate(() => 0);
  const dependencies = { fetch: network(() => new Response('ok')).fetch, now: () => 0, accessToken: async () => 'token' };
  for (let index = 0; index < APP_NET_LIMITS.requestsPerMinuteMax; index += 1) {
    await appNetFetch(manifest, parseAppNetRequest({ url: 'https://analyticsdata.example.test/' }), rate, dependencies);
  }
  await assert.rejects(appNetFetch(manifest, parseAppNetRequest({ url: 'https://analyticsdata.example.test/' }), rate, dependencies), /a minute/);
});

test('a connection whose broker is not set up or unreachable answers unconfigured before any browser opens', async () => {
  const root = project();
  const secrets = vault();
  const manifest = parseAppManifest({ ...MANIFEST_INPUT, settings: [], auth: [{ provider: 'google', scopes: ['openid'] }] });
  let nowMs = 0;
  let configured = false;
  let reachable = true;
  const fake = network((url) => {
    assert.equal(url, `${BROKER}/api/oauth/google/status`);
    if (!reachable) {
      throw new Error('offline');
    }
    return new Response(JSON.stringify({ configured }), { status: 200 });
  });
  const signIns = createAppSignIns({ fetch: fake.fetch, now: () => nowMs, vault: secrets, broker: BROKER });
  const unset = await signIns.unconfigured(root, manifest, 'google');
  assert.ok(unset !== undefined && !unset.connected && 'code' in unset);
  assert.equal(unset.code, 'unconfigured');
  assert.match(unset.message, /not set up/);
  assert.deepEqual(await signIns.checkedStatus(root, manifest), [unset]);
  // The answer holds for a minute: one check, not one per call.
  configured = true;
  assert.ok((await signIns.unconfigured(root, manifest, 'google')) !== undefined);
  assert.equal(fake.calls.length, 1);
  nowMs += 60_000;
  assert.equal(await signIns.unconfigured(root, manifest, 'google'), undefined);
  nowMs += 60_000;
  reachable = false;
  const offline = await signIns.unconfigured(root, manifest, 'google');
  assert.ok(offline !== undefined && 'code' in offline);
  assert.match(offline.message, /could not be reached/);
});

test('HubSpot allows its meetings scope, and refuses an installer’s own client over the loopback', () => {
  const hubspot = (entry: Record<string, unknown>) =>
    parseAppManifest({ ...MANIFEST_INPUT, settings: [{ id: 'own-client', label: 'Client id', kind: 'text' }], auth: [entry] });
  assert.ok(hubspot({ provider: 'hubspot', scopes: ['oauth', 'scheduler.meetings.meeting-link.read'] }));
  assert.throws(() => hubspot({ provider: 'hubspot', scopes: ['oauth'], clientIdSetting: 'own-client' }), /exact redirect URLs/);
});
