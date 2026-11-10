// Goal: "Connect with Cloudflare" and "Connect with Bunny" find what a pasted
// key reaches and derive the connection exactly as the hosts document it —
// R2's S3 key pair from the token (id, and SHA-256 of the value), Bunny's
// storage password from the account's zone list — while no reply ever carries
// a key, and refusals become sentences.
// Method: a fake fetch plays Cloudflare's v4 API (token verify, accounts, R2
// buckets, custom and managed domains) and Bunny's storage zone list; the
// tests check the requests sent, the choices returned, the derived drafts,
// and the contract parsers' known-good and known-bad shapes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { accountConnectionDraft, bucketKeysFromToken, discoverMediaAccounts } from '#dist/electron/content/media/mediaAccounts.js';
import {
  CLOUDFLARE_TOKEN_TEMPLATE_URL,
  parseMediaAccountChoices,
  parseMediaAccountConnect,
  parseMediaAccountKey,
} from '#dist/shared/properties/mediaAccounts.js';

const ACCOUNT = 'c'.repeat(32);
const OTHER = 'd'.repeat(32);
const TOKEN = 'cf-token-value';

function cloudflare(routes: Readonly<Record<string, unknown>>) {
  const sent: { url: string; authorization: string }[] = [];
  const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    sent.push({ url, authorization: headers.get('authorization') ?? headers.get('AccessKey') ?? '' });
    const path = new URL(url).pathname.replace('/client/v4', '');
    const route = Object.hasOwn(routes, path) ? routes[path] : undefined;
    if (route === undefined) {
      return Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, { status: 403 });
    }
    return Response.json(route);
  };
  return { sent, fetcher };
}

const ok = (result: unknown) => ({ success: true, errors: [], result });
const ROUTES = {
  '/user/tokens/verify': ok({ id: 'tokenid1234', status: 'active' }),
  '/accounts': ok([
    { id: ACCOUNT, name: 'Church' },
    { id: OTHER, name: 'No R2 here' },
  ]),
  [`/accounts/${ACCOUNT}/r2/buckets`]: ok({ buckets: [{ name: 'media' }, { name: 'private' }, { name: 'Bad_Name' }] }),
  [`/accounts/${ACCOUNT}/r2/buckets/media/domains/custom`]: ok({ domains: [{ domain: 'cdn.church.org', enabled: true }] }),
  [`/accounts/${ACCOUNT}/r2/buckets/private/domains/custom`]: ok({ domains: [] }),
  [`/accounts/${ACCOUNT}/r2/buckets/private/domains/managed`]: ok({ enabled: false, domain: 'pub-x.r2.dev' }),
};

test('Cloudflare: the token is verified, and buckets come with their public addresses', async () => {
  const host = cloudflare(ROUTES);
  const choices = await discoverMediaAccounts(host.fetcher, { provider: 'r2', token: TOKEN });
  assert.deepEqual(choices, {
    provider: 'r2',
    accounts: [
      {
        id: ACCOUNT,
        name: 'Church',
        buckets: [
          { name: 'media', publicBaseUrl: 'https://cdn.church.org' },
          { name: 'private', publicBaseUrl: undefined },
        ],
      },
    ],
  });
  assert.ok(host.sent.every((request) => request.authorization === `Bearer ${TOKEN}`));
  assert.equal(new URL(host.sent[0]?.url ?? '').pathname, '/client/v4/user/tokens/verify');
  assert.equal(JSON.stringify(choices).includes(TOKEN), false, 'no key comes back');
  assert.deepEqual(parseMediaAccountChoices(choices), choices, 'the reply passes its own contract');
});

test('Cloudflare: the connection’s S3 keys are the token id and the SHA-256 of its value', async () => {
  const draft = await accountConnectionDraft(cloudflare(ROUTES).fetcher, {
    provider: 'r2',
    token: TOKEN,
    label: 'Media',
    accountId: ACCOUNT,
    bucket: 'media',
    publicBaseUrl: 'https://cdn.church.org',
  });
  assert.deepEqual(draft.secret, { kind: 'keyPair', accessKeyId: 'tokenid1234', secretAccessKey: createHash('sha256').update(TOKEN).digest('hex') });
  assert.equal(draft.kind === 'r2' ? draft.bucket : '', 'media');
  assert.deepEqual(await bucketKeysFromToken({ id: 'abc', value: 'x' }), {
    accessKeyId: 'abc',
    secretAccessKey: createHash('sha256').update('x').digest('hex'),
  });
});

test('Cloudflare: an inactive or refused token is a sentence', async () => {
  const inactive = cloudflare({ ...ROUTES, '/user/tokens/verify': ok({ id: 'tokenid1234', status: 'disabled' }) });
  await assert.rejects(discoverMediaAccounts(inactive.fetcher, { provider: 'r2', token: TOKEN }), /not active/);
  const refused = cloudflare({});
  await assert.rejects(discoverMediaAccounts(refused.fetcher, { provider: 'r2', token: TOKEN }), /refused the keys.*Cloudflare said: Authentication error/);
});

const ZONES = [
  {
    Name: 'site-zone',
    Password: 'zone-password',
    Region: 'NY',
    PullZones: [
      {
        Hostnames: [
          { Value: 'site.b-cdn.net', IsSystemHostname: true, HasCertificate: true },
          { Value: 'media.site.org', IsSystemHostname: false, HasCertificate: true },
        ],
      },
    ],
  },
  { Name: 'bare-zone', Password: 'bare-password', Region: 'DE', PullZones: [] },
  { Name: 'gone', Password: 'x', Region: 'DE', Deleted: true },
  { Name: 'moon', Password: 'x', Region: 'MOON' },
];

function bunny(status = 200) {
  const sent: { url: string; key: string }[] = [];
  const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
    sent.push({ url, key: new Headers(init.headers).get('AccessKey') ?? '' });
    return status === 200 ? Response.json(ZONES) : new Response('', { status });
  };
  return { sent, fetcher };
}

test('Bunny: zones are listed without their passwords, with the pull zone found', async () => {
  const host = bunny();
  const choices = await discoverMediaAccounts(host.fetcher, { provider: 'bunny', apiKey: 'account-key' });
  assert.deepEqual(choices, {
    provider: 'bunny',
    zones: [
      { name: 'site-zone', region: 'ny', publicBaseUrl: 'https://media.site.org' },
      { name: 'bare-zone', region: 'de', publicBaseUrl: undefined },
    ],
  });
  assert.equal(host.sent[0]?.url, 'https://api.bunny.net/storagezone');
  assert.equal(host.sent[0]?.key, 'account-key');
  assert.equal(JSON.stringify(choices).includes('password'), false, 'no password comes back');
});

test('Bunny: the chosen zone connects with its own storage password, never the account key', async () => {
  const draft = await accountConnectionDraft(bunny().fetcher, {
    provider: 'bunny',
    apiKey: 'account-key',
    label: 'CDN',
    storageZone: 'site-zone',
    publicBaseUrl: 'https://media.site.org',
  });
  assert.deepEqual(draft.secret, { kind: 'accessKey', accessKey: 'zone-password' });
  assert.equal(draft.kind === 'bunny' ? draft.region : '', 'ny');
  await assert.rejects(
    accountConnectionDraft(bunny().fetcher, { provider: 'bunny', apiKey: 'k', label: 'CDN', storageZone: 'nope', publicBaseUrl: 'https://a.b-cdn.net' }),
    /no storage zone named nope/,
  );
  await assert.rejects(discoverMediaAccounts(bunny(401).fetcher, { provider: 'bunny', apiKey: 'k' }), /account API key/);
});

test('contract: keys, connects and choices refuse every malformed shape', () => {
  assert.deepEqual(parseMediaAccountKey({ provider: 'r2', token: ' t ' }), { provider: 'r2', token: 't' });
  assert.throws(() => parseMediaAccountKey({ provider: 'r2', token: '' }), /Paste/);
  assert.throws(() => parseMediaAccountKey({ provider: 'r2', token: 'has space' }), /printable/);
  assert.throws(() => parseMediaAccountKey({ provider: 'dropbox', token: 't' }), /Unknown/);
  const connect = { provider: 'r2', token: 't', label: 'M', accountId: ACCOUNT, bucket: 'media', publicBaseUrl: 'https://cdn.example.com' };
  assert.equal(parseMediaAccountConnect(connect).provider, 'r2');
  assert.throws(() => parseMediaAccountConnect({ ...connect, accountId: 'x' }), /account/);
  assert.throws(() => parseMediaAccountConnect({ ...connect, bucket: '../x' }), /bucket/);
  assert.throws(() => parseMediaAccountConnect({ ...connect, publicBaseUrl: 'http://cdn.example.com' }), /https/);
  assert.throws(() => parseMediaAccountChoices({ provider: 'bunny', zones: [{ name: 'z', region: 'moon' }] }), /region/);
  assert.throws(() => parseMediaAccountChoices({ provider: 'r2', accounts: [{ id: 'short', name: 'A', buckets: [] }] }), /account id/);
  const template = new URL(CLOUDFLARE_TOKEN_TEMPLATE_URL);
  assert.equal(template.origin, 'https://dash.cloudflare.com');
  assert.deepEqual(JSON.parse(template.searchParams.get('permissionGroupKeys') ?? ''), [{ key: 'workers_r2', type: 'edit' }]);
});
