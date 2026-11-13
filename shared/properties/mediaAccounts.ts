// Connecting a media host from its account rather than from hand-copied keys:
// "Connect with Cloudflare" and "Connect with Bunny" in the Assets panel.
//
// Neither host offers Stacki a sign-in it can use for this. Cloudflare's
// third-party OAuth needs an app registered and published by its owner, and an
// OAuth token cannot be turned into the S3 key pair R2's API signs with; R2's
// S3 keys come only from an API token (its id, and the SHA-256 of its value).
// Bunny has no OAuth at all: its management API takes the account API key.
// So the person pastes one key — a Cloudflare API token they create from a
// pre-filled template, or their Bunny account API key — and the main process
// (or the Studio server) uses it to find their buckets or storage zones, and
// derives everything else. The pasted key goes to the main process only, in
// these two requests; no reply carries a key, and only the derived connection
// keys are kept (encrypted, as any other connection's).

import { record, text } from '../core/boundary';
import { assert } from '../core/assert';
import { MediaInputError } from './mediaInputError';
import { BUNNY_REGIONS, MEDIA_HOSTING_LIMITS, parseBunnyRegion, parseMediaURL, type BunnyRegion } from './mediaHosting';

export const MEDIA_ACCOUNT_LIMITS = {
  accountsMax: 50,
  bucketsPerAccountMax: 1000,
  zonesMax: 1000,
  nameCharsMax: 128,
  // Cloudflare API tokens are 40 characters and Bunny API keys are UUID-like;
  // this leaves room for either to grow.
  accountKeyCharsMax: 512,
} as const satisfies Record<string, number>;

/**
 * Where a person creates the Cloudflare token: the dashboard's API token page,
 * pre-filled through Cloudflare's documented template URL with one permission,
 * Workers R2 Storage edit (`workers_r2`). They approve it there and paste it back.
 */
export const CLOUDFLARE_TOKEN_TEMPLATE_URL =
  'https://dash.cloudflare.com/profile/api-tokens?' +
  `permissionGroupKeys=${encodeURIComponent(JSON.stringify([{ key: 'workers_r2', type: 'edit' }]))}` +
  '&accountId=*&zoneId=all&name=' +
  encodeURIComponent('Stacki media (R2)');

/** Where a person finds their Bunny account API key. */
export const BUNNY_API_KEY_URL = 'https://dash.bunny.net/account/api-key';

/** A pasted account key, and what to look up with it. */
export type MediaAccountKey = { readonly provider: 'r2'; readonly token: string } | { readonly provider: 'bunny'; readonly apiKey: string };

export interface CloudflareBucketChoice {
  readonly name: string;
  /** The bucket's public address, when it has one: a custom domain, else its r2.dev domain. */
  readonly publicBaseUrl: string | undefined;
}

export interface CloudflareAccountChoice {
  readonly id: string;
  readonly name: string;
  readonly buckets: readonly CloudflareBucketChoice[];
}

export interface BunnyZoneChoice {
  readonly name: string;
  readonly region: BunnyRegion;
  /** The pull zone that serves it, when one is linked. */
  readonly publicBaseUrl: string | undefined;
}

/** What a pasted key can reach: nothing secret, only what to choose from. */
export type MediaAccountChoices =
  | { readonly provider: 'r2'; readonly accounts: readonly CloudflareAccountChoice[] }
  | { readonly provider: 'bunny'; readonly zones: readonly BunnyZoneChoice[] };

/** The chosen bucket or zone, with the key again: the main process derives the connection's keys from it. */
export type MediaAccountConnect =
  | {
      readonly provider: 'r2';
      readonly token: string;
      readonly label: string;
      readonly accountId: string;
      readonly bucket: string;
      readonly publicBaseUrl: string;
    }
  | {
      readonly provider: 'bunny';
      readonly apiKey: string;
      readonly label: string;
      readonly storageZone: string;
      readonly publicBaseUrl: string;
    };

function parseAccountKey(input: unknown, what: string): string {
  const key = text(input).trim();
  if (key.length === 0 || key.length > MEDIA_ACCOUNT_LIMITS.accountKeyCharsMax) {
    throw new MediaInputError('assets.input.key.paste', { what });
  }
  if (!/^[\x21-\x7e]+$/.test(key)) {
    throw new MediaInputError('assets.input.key.printable', { what });
  }
  assert(!/\s/.test(key), 'An account key never holds whitespace');
  return key;
}

export function parseMediaAccountKey(input: unknown): MediaAccountKey {
  const value = record(input);
  switch (value['provider']) {
    case 'r2':
      return { provider: 'r2', token: parseAccountKey(value['token'], 'Cloudflare API token') };
    case 'bunny':
      return { provider: 'bunny', apiKey: parseAccountKey(value['apiKey'], 'Bunny API key') };
    default:
      throw new Error('Unknown media account provider.');
  }
}

function parseLabel(input: unknown): string {
  const label = text(input).trim();
  if (label.length === 0 || label.length > MEDIA_HOSTING_LIMITS.labelCharsMax) {
    throw new MediaInputError('assets.input.label', { max: MEDIA_HOSTING_LIMITS.labelCharsMax });
  }
  return label;
}

function parseName(input: unknown, what: string): string {
  const name = text(input).trim();
  if (name.length === 0 || name.length > MEDIA_ACCOUNT_LIMITS.nameCharsMax || /[\x00-\x1f\x7f/\\]/.test(name)) {
    throw new MediaInputError('assets.input.choose', { what });
  }
  return name;
}

export function parseMediaAccountConnect(input: unknown): MediaAccountConnect {
  const value = record(input);
  switch (value['provider']) {
    case 'r2': {
      const accountId = text(value['accountId']);
      if (!/^[a-f0-9]{32}$/.test(accountId)) {
        throw new MediaInputError('assets.input.chooseAccount');
      }
      return {
        provider: 'r2',
        token: parseAccountKey(value['token'], 'Cloudflare API token'),
        label: parseLabel(value['label']),
        accountId,
        bucket: parseName(value['bucket'], 'bucket'),
        publicBaseUrl: parseMediaURL(value['publicBaseUrl'], 'public bucket URL'),
      };
    }
    case 'bunny':
      return {
        provider: 'bunny',
        apiKey: parseAccountKey(value['apiKey'], 'Bunny API key'),
        label: parseLabel(value['label']),
        storageZone: parseName(value['storageZone'], 'storage zone'),
        publicBaseUrl: parseMediaURL(value['publicBaseUrl'], 'pull zone URL'),
      };
    default:
      throw new Error('Unknown media account provider.');
  }
}

export function parseMediaAccountChoices(input: unknown): MediaAccountChoices {
  const value = record(input);
  switch (value['provider']) {
    case 'r2':
      return { provider: 'r2', accounts: bounded(value['accounts'], MEDIA_ACCOUNT_LIMITS.accountsMax).map(parseAccountChoice) };
    case 'bunny':
      return { provider: 'bunny', zones: bounded(value['zones'], MEDIA_ACCOUNT_LIMITS.zonesMax).map(parseZoneChoice) };
    default:
      throw new Error('Unknown media account provider.');
  }
}

function bounded(input: unknown, max: number): readonly unknown[] {
  if (!Array.isArray(input) || input.length > max) {
    throw new Error('Expected a bounded list of choices.');
  }
  return input;
}

function parseAccountChoice(input: unknown): CloudflareAccountChoice {
  const value = record(input);
  const id = text(value['id']);
  if (!/^[a-f0-9]{32}$/.test(id)) {
    throw new Error('Invalid Cloudflare account id.');
  }
  return {
    id,
    name: parseName(value['name'], 'account'),
    buckets: bounded(value['buckets'], MEDIA_ACCOUNT_LIMITS.bucketsPerAccountMax).map((entry) => {
      const bucket = record(entry);
      return { name: parseName(bucket['name'], 'bucket'), publicBaseUrl: optionalURL(bucket['publicBaseUrl']) };
    }),
  };
}

function parseZoneChoice(input: unknown): BunnyZoneChoice {
  const value = record(input);
  return {
    name: parseName(value['name'], 'storage zone'),
    region: parseBunnyRegion(value['region']),
    publicBaseUrl: optionalURL(value['publicBaseUrl']),
  };
}

function optionalURL(input: unknown): string | undefined {
  return input === undefined ? undefined : parseMediaURL(input, 'public URL');
}

/** Bunny's region code ("DE", "NY") as the connection keeps it, or undefined for one Stacki does not know. */
export function bunnyRegionOf(code: unknown): BunnyRegion | undefined {
  const lower = typeof code === 'string' ? code.toLowerCase() : '';
  return BUNNY_REGIONS.find((region) => region === lower);
}
