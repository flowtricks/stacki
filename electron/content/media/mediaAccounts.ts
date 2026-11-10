// "Connect with Cloudflare" and "Connect with Bunny" (shared/properties/mediaAccounts.ts
// says why these take one pasted key rather than a sign-in). With that key this
// module lists what the person can connect and, once they choose, derives the
// connection and its keys. It uses only fetch and Web Crypto, so the Studio
// server and its Worker run it as Desktop's main process does.
//
// Cloudflare, as https://developers.cloudflare.com/r2/api/tokens/ documents it:
// an R2 S3 key pair is derived from an API token. The access key ID is the
// token's id; the secret access key is the SHA-256 of the token's value. The
// token is verified at `/user/tokens/verify`, accounts are listed at
// `/accounts`, buckets at `/accounts/{id}/r2/buckets`, and a bucket's public
// address is read from its custom domains, else its r2.dev managed domain.
//
// Bunny (https://docs.bunny.net/api-reference/core/storage-zone/list-storage-zones):
// the account API key lists storage zones at api.bunny.net/storagezone, each
// with its password (what the Storage API takes), region and linked pull zones.

import { assert } from '../../../shared/core/assert';
import {
  MEDIA_ACCOUNT_LIMITS,
  bunnyRegionOf,
  type BunnyZoneChoice,
  type CloudflareAccountChoice,
  type CloudflareBucketChoice,
  type MediaAccountChoices,
  type MediaAccountConnect,
  type MediaAccountKey,
} from '../../../shared/properties/mediaAccounts';
import { parseMediaConnectionDraft, type MediaConnectionDraft } from '../../../shared/properties/mediaHosting';
import { MEDIA_HTTP_LIMITS, MediaHostError, expectOk, readText, send, statusSentence, type MediaFetch } from './mediaHttp';

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const BUNNY_API = 'https://api.bunny.net';
// Buckets whose public address is looked up (two requests each); past this the
// person types the address, rather than one connect costing hundreds of calls.
const PUBLIC_URL_LOOKUPS_MAX = 50;

export async function discoverMediaAccounts(fetcher: MediaFetch, key: MediaAccountKey): Promise<MediaAccountChoices> {
  switch (key.provider) {
    case 'r2':
      await verifyCloudflareToken(fetcher, key.token);
      return { provider: 'r2', accounts: await cloudflareAccounts(fetcher, key.token) };
    case 'bunny':
      return { provider: 'bunny', zones: (await bunnyZones(fetcher, key.apiKey)).map((zone) => zone.choice) };
    default: {
      const exhaustive: never = key;
      return exhaustive;
    }
  }
}

/** The connection the chosen bucket or zone makes, with keys derived here; parsed as any draft is. */
export async function accountConnectionDraft(fetcher: MediaFetch, connect: MediaAccountConnect): Promise<MediaConnectionDraft> {
  switch (connect.provider) {
    case 'r2': {
      const tokenId = await verifyCloudflareToken(fetcher, connect.token);
      return parseMediaConnectionDraft({
        kind: 'r2',
        label: connect.label,
        accountId: connect.accountId,
        bucket: connect.bucket,
        publicBaseUrl: connect.publicBaseUrl,
        secret: { kind: 'keyPair', ...(await bucketKeysFromToken({ id: tokenId, value: connect.token })) },
      });
    }
    case 'bunny': {
      const zone = (await bunnyZones(fetcher, connect.apiKey)).find((entry) => entry.choice.name === connect.storageZone);
      if (zone === undefined) {
        throw new MediaHostError(`This Bunny account has no storage zone named ${connect.storageZone}.`, 404);
      }
      return parseMediaConnectionDraft({
        kind: 'bunny',
        label: connect.label,
        storageZone: zone.choice.name,
        region: zone.choice.region,
        publicBaseUrl: connect.publicBaseUrl,
        secret: { kind: 'accessKey', accessKey: zone.password },
      });
    }
    default: {
      const exhaustive: never = connect;
      return exhaustive;
    }
  }
}

/** R2's S3 key pair for an API token, as Cloudflare documents it. */
export async function bucketKeysFromToken(token: {
  readonly id: string;
  readonly value: string;
}): Promise<{ readonly accessKeyId: string; readonly secretAccessKey: string }> {
  assert(token.id.length > 0, 'A token has an id');
  assert(token.value.length > 0, 'A token has a value');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token.value));
  const secretAccessKey = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  assert(secretAccessKey.length === 64, 'The secret is a hex SHA-256');
  return { accessKeyId: token.id, secretAccessKey };
}

// --- Cloudflare ------------------------------------------------------------------

async function cloudflare(fetcher: MediaFetch, token: string, path: string): Promise<unknown> {
  const response = await send(fetcher, {
    method: 'GET',
    url: `${CLOUDFLARE_API}${path}`,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    timeoutMs: MEDIA_HTTP_LIMITS.requestTimeoutMs,
  });
  await expectOk(response, (status, body) => `${statusSentence(status)}${cloudflareError(body)}`);
  const body: unknown = JSON.parse(await readText(response));
  if (field(body, 'success') !== true) {
    throw new MediaHostError(`Cloudflare refused the request.${cloudflareError(JSON.stringify(body))}`, response.status);
  }
  return field(body, 'result');
}

/** The token's id, once Cloudflare says the token is active. */
async function verifyCloudflareToken(fetcher: MediaFetch, token: string): Promise<string> {
  const result = await cloudflare(fetcher, token, '/user/tokens/verify');
  const id = field(result, 'id');
  if (typeof id !== 'string' || !/^[A-Za-z0-9]{8,128}$/.test(id)) {
    throw new MediaHostError('Cloudflare did not say which token this is.', 0);
  }
  if (field(result, 'status') !== 'active') {
    throw new MediaHostError('This Cloudflare token is not active. Create a new one and paste it again.', 0);
  }
  return id;
}

async function cloudflareAccounts(fetcher: MediaFetch, token: string): Promise<readonly CloudflareAccountChoice[]> {
  const accounts = list(await cloudflare(fetcher, token, `/accounts?per_page=${MEDIA_ACCOUNT_LIMITS.accountsMax}`), MEDIA_ACCOUNT_LIMITS.accountsMax);
  const choices: CloudflareAccountChoice[] = [];
  let lookups = 0;
  for (const account of accounts) {
    const id = field(account, 'id');
    const name = field(account, 'name');
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id) || typeof name !== 'string') {
      continue;
    }
    // An account the token may not use for R2 has no buckets to offer.
    let names: readonly string[];
    try {
      names = await bucketNames(fetcher, token, id);
    } catch {
      continue;
    }
    const buckets: CloudflareBucketChoice[] = [];
    for (const bucket of names) {
      lookups++;
      const publicBaseUrl = lookups <= PUBLIC_URL_LOOKUPS_MAX ? await bucketPublicURL(fetcher, token, id, bucket) : undefined;
      buckets.push({ name: bucket, publicBaseUrl });
    }
    choices.push({ id, name: name.slice(0, MEDIA_ACCOUNT_LIMITS.nameCharsMax) || id, buckets });
  }
  return choices;
}

async function bucketNames(fetcher: MediaFetch, token: string, accountId: string): Promise<readonly string[]> {
  const result = await cloudflare(fetcher, token, `/accounts/${accountId}/r2/buckets?per_page=${MEDIA_ACCOUNT_LIMITS.bucketsPerAccountMax}`);
  return list(field(result, 'buckets'), MEDIA_ACCOUNT_LIMITS.bucketsPerAccountMax)
    .map((bucket) => field(bucket, 'name'))
    .filter((name): name is string => typeof name === 'string' && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name));
}

// A custom domain first (what a site should link to), else the r2.dev domain
// when it is switched on; undefined when the bucket is not public.
async function bucketPublicURL(fetcher: MediaFetch, token: string, accountId: string, bucket: string): Promise<string | undefined> {
  const base = `/accounts/${accountId}/r2/buckets/${bucket}/domains`;
  try {
    const custom = list(field(await cloudflare(fetcher, token, `${base}/custom`), 'domains'), MEDIA_ACCOUNT_LIMITS.bucketsPerAccountMax);
    const enabled = custom.find((domain) => field(domain, 'enabled') === true && typeof field(domain, 'domain') === 'string');
    const domain = enabled === undefined ? undefined : field(enabled, 'domain');
    if (typeof domain === 'string' && hostname(domain)) {
      return `https://${domain}`;
    }
    const managed = await cloudflare(fetcher, token, `${base}/managed`);
    const managedDomain = field(managed, 'domain');
    return field(managed, 'enabled') === true && typeof managedDomain === 'string' && hostname(managedDomain) ? `https://${managedDomain}` : undefined;
  } catch {
    // A token without the domain permission still connects; the person types the address.
    return undefined;
  }
}

function cloudflareError(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    const [first] = list(field(parsed, 'errors'), 10);
    const message = field(first, 'message');
    return typeof message === 'string' ? ` Cloudflare said: ${message.slice(0, 200)}` : '';
  } catch {
    return '';
  }
}

// --- Bunny -------------------------------------------------------------------------

interface BunnyZone {
  readonly choice: BunnyZoneChoice;
  readonly password: string;
}

async function bunnyZones(fetcher: MediaFetch, apiKey: string): Promise<readonly BunnyZone[]> {
  const response = await send(fetcher, {
    method: 'GET',
    url: `${BUNNY_API}/storagezone`,
    headers: { AccessKey: apiKey, accept: 'application/json' },
    timeoutMs: MEDIA_HTTP_LIMITS.requestTimeoutMs,
  });
  await expectOk(response, (status) =>
    status === 401 ? 'Bunny refused this API key. Use the account API key (Account settings → API key), not a storage zone password.' : statusSentence(status),
  );
  const body: unknown = JSON.parse(await readText(response));
  const zones: BunnyZone[] = [];
  for (const zone of list(body, MEDIA_ACCOUNT_LIMITS.zonesMax)) {
    const name = field(zone, 'Name');
    const password = field(zone, 'Password');
    const region = bunnyRegionOf(field(zone, 'Region'));
    if (field(zone, 'Deleted') === true || typeof name !== 'string' || typeof password !== 'string' || password === '' || region === undefined) {
      continue;
    }
    zones.push({ choice: { name, region, publicBaseUrl: pullZoneURL(field(zone, 'PullZones')) }, password });
  }
  return zones;
}

// A custom hostname with a certificate first, else the pull zone's own b-cdn.net one.
function pullZoneURL(pullZones: unknown): string | undefined {
  const hostnames = list(pullZones, MEDIA_ACCOUNT_LIMITS.zonesMax).flatMap((zone) => list(field(zone, 'Hostnames'), MEDIA_ACCOUNT_LIMITS.zonesMax));
  const usable = hostnames.filter((entry) => typeof field(entry, 'Value') === 'string' && hostname(String(field(entry, 'Value'))));
  const custom = usable.find((entry) => field(entry, 'IsSystemHostname') !== true && field(entry, 'HasCertificate') === true);
  const system = usable.find((entry) => field(entry, 'IsSystemHostname') === true);
  const chosen = custom ?? system;
  return chosen === undefined ? undefined : `https://${String(field(chosen, 'Value'))}`;
}

// --- Reading host JSON ---------------------------------------------------------------

function field(input: unknown, name: string): unknown {
  return typeof input === 'object' && input !== null && !Array.isArray(input) ? Reflect.get(input, name) : undefined;
}

function list(input: unknown, max: number): readonly unknown[] {
  return Array.isArray(input) ? input.slice(0, max) : [];
}

function hostname(value: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(value);
}
