// CMS connections: which hosted CMS a project's content comes from, and the key
// Stacki writes drafts with. The key itself never crosses to the renderer — it
// is sent once, when a connection is saved, and from then on only the main
// process holds it (encrypted at rest). Everything else here is what the
// Settings section shows and what the sign-in steps report.

import { record, text } from '../core/boundary';
import { assert } from '../core/assert';

export const CMS_CONNECTION_LIMITS = {
  connectionsPerProjectMax: 16,
  datasetsPerProjectMax: 100,
  labelCharsMax: 80,
  messageCharsMax: 1000,
  projectsMax: 200,
  secretCharsMax: 4096,
  urlCharsMax: 2048,
} as const;

export const SANITY_LOGIN_TIMEOUT_MS = 5 * 60_000;

export type CmsConnection =
  | {
      readonly kind: 'sanity';
      readonly id: string;
      readonly label: string;
      readonly projectId: string;
      readonly dataset: string;
    }
  | {
      readonly kind: 'payload';
      readonly id: string;
      readonly label: string;
      /** The site's Payload server, e.g. https://cms.example.com. */
      readonly baseUrl: string;
      /** The auth collection the API key belongs to, e.g. `users`. */
      readonly collection: string;
    }
  | {
      readonly kind: 'custom';
      readonly id: string;
      readonly label: string;
      /** Where drafts are sent: POST {document, field, value}. */
      readonly baseUrl: string;
      /** The header the key goes in, e.g. `Authorization`. */
      readonly header: string;
    };

/** A connection as it is saved: the public fields, without an id yet, and its key. */
export type CmsConnectionDraft = DistributiveOmit<CmsConnection, 'id'> & {
  readonly secret: string;
};
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface CmsConnectionList {
  /** Whether keys can be encrypted on this machine; none are saved without it. */
  readonly encryption: 'available' | 'unavailable';
  readonly connections: readonly CmsConnection[];
}

export type CmsSaveResult =
  | { readonly ok: true; readonly list: CmsConnectionList }
  | { readonly ok: false; readonly message: string };

export interface SanityProjectChoice {
  readonly id: string;
  readonly name: string;
  readonly datasets: readonly string[];
}

export type SanityLoginRequest =
  | { readonly action: 'start'; readonly id: string }
  | { readonly action: 'status'; readonly id: string }
  | { readonly action: 'cancel'; readonly id: string }
  | {
      readonly action: 'choose';
      readonly id: string;
      readonly projectId: string;
      readonly dataset: string;
    };

export type SanityLoginState =
  | { readonly kind: 'starting' }
  | { readonly kind: 'browser'; readonly url: string }
  | {
      readonly kind: 'choosing';
      readonly projects: readonly SanityProjectChoice[];
      /** The project and dataset the site's own .env names, when it names one. */
      readonly suggestion: { readonly projectId: string; readonly dataset: string } | undefined;
    }
  | { readonly kind: 'creating' }
  | { readonly kind: 'complete'; readonly connection: CmsConnection }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly message: string };

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function parseConnectionId(input: unknown): string {
  const id = text(input);
  if (!UUID.test(id)) {
    throw new Error('Invalid CMS connection id.');
  }
  assert(id.length === 36, 'A connection id is a UUID');
  return id;
}

export function parseSanityProjectId(input: unknown): string {
  const id = text(input);
  if (!/^[a-z0-9]{1,64}$/.test(id)) {
    throw new Error('Invalid Sanity project id.');
  }
  return id;
}

export function parseSanityDataset(input: unknown): string {
  const dataset = text(input);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(dataset)) {
    throw new Error('Invalid Sanity dataset name.');
  }
  return dataset;
}

/** A CMS server address: https, or http on this machine for a local server. */
export function parseCmsURL(input: unknown): string {
  const raw = text(input);
  if (raw.length === 0 || raw.length > CMS_CONNECTION_LIMITS.urlCharsMax) {
    throw new Error('Enter the CMS address.');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('The CMS address is not a URL.');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('The CMS address must use https (http only for localhost).');
  }
  if (url.username || url.password || url.hash) {
    throw new Error('The CMS address cannot hold a login or a fragment.');
  }
  const parsed = url.toString().replace(/\/$/, '');
  assert(parsed.length <= CMS_CONNECTION_LIMITS.urlCharsMax + 1, 'A parsed address stays bounded');
  assert(!parsed.endsWith('/'), 'A parsed address has no trailing slash');
  return parsed;
}

function parseLabel(input: unknown): string {
  const label = text(input).trim();
  if (label.length === 0 || label.length > CMS_CONNECTION_LIMITS.labelCharsMax) {
    throw new Error(`A connection name is 1–${CMS_CONNECTION_LIMITS.labelCharsMax} characters.`);
  }
  return label;
}

function parseSlug(input: unknown, what: string): string {
  const slug = text(input);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(slug)) {
    throw new Error(`Invalid ${what}.`);
  }
  return slug;
}

/** A key: printable ASCII on one line, as every CMS issues them. */
export function parseCmsSecret(input: unknown): string {
  const secret = text(input).trim();
  if (secret.length === 0 || secret.length > CMS_CONNECTION_LIMITS.secretCharsMax) {
    throw new Error('Paste the API key.');
  }
  if (!/^[\x20-\x7e]+$/.test(secret)) {
    throw new Error('An API key is printable characters on one line.');
  }
  assert(!/[\r\n]/.test(secret), 'A key never holds a line break');
  return secret;
}

export function parseCmsConnection(input: unknown): CmsConnection {
  const value = record(input);
  const id = parseConnectionId(value['id']);
  const fields = parseConnectionFields(value);
  assert(!('secret' in fields), 'A public connection never carries its key');
  return { ...fields, id };
}

export function parseCmsConnectionDraft(input: unknown): CmsConnectionDraft {
  const value = record(input);
  return { ...parseConnectionFields(value), secret: parseCmsSecret(value['secret']) };
}

function parseConnectionFields(
  value: Record<string, unknown>,
): DistributiveOmit<CmsConnection, 'id'> {
  const label = parseLabel(value['label']);
  switch (value['kind']) {
    case 'sanity':
      return {
        kind: 'sanity',
        label,
        projectId: parseSanityProjectId(value['projectId']),
        dataset: parseSanityDataset(value['dataset']),
      };
    case 'payload':
      return {
        kind: 'payload',
        label,
        baseUrl: parseCmsURL(value['baseUrl']),
        collection: parseSlug(value['collection'], 'Payload auth collection'),
      };
    case 'custom':
      return {
        kind: 'custom',
        label,
        baseUrl: parseCmsURL(value['baseUrl']),
        header: parseSlug(value['header'], 'header name'),
      };
    default:
      throw new Error('Unknown CMS kind.');
  }
}

export function parseCmsConnectionList(input: unknown): CmsConnectionList {
  const value = record(input);
  const encryption = value['encryption'];
  if (encryption !== 'available' && encryption !== 'unavailable') {
    throw new Error('Invalid encryption state.');
  }
  const connections = value['connections'];
  if (!Array.isArray(connections)) {
    throw new Error('Expected a list of CMS connections.');
  }
  if (connections.length > CMS_CONNECTION_LIMITS.connectionsPerProjectMax) {
    throw new Error('Too many CMS connections.');
  }
  const parsed = connections.map(parseCmsConnection);
  assert(parsed.length === connections.length, 'Every listed connection parses');
  return { encryption, connections: parsed };
}

export function parseCmsSaveResult(input: unknown): CmsSaveResult {
  const value = record(input);
  if (value['ok'] === true) {
    return { ok: true, list: parseCmsConnectionList(value['list']) };
  }
  return { ok: false, message: parseMessage(value['message']) };
}

export function parseSanityLoginRequest(input: unknown): SanityLoginRequest {
  const value = record(input);
  const id = parseConnectionId(value['id']);
  switch (value['action']) {
    case 'start':
    case 'status':
    case 'cancel':
      return { action: value['action'], id };
    case 'choose':
      return {
        action: 'choose',
        id,
        projectId: parseSanityProjectId(value['projectId']),
        dataset: parseSanityDataset(value['dataset']),
      };
    default:
      throw new Error('Unknown Sanity sign-in action.');
  }
}

export function parseSanityLoginState(input: unknown): SanityLoginState {
  const value = record(input);
  switch (value['kind']) {
    case 'starting':
    case 'creating':
    case 'cancelled':
      return { kind: value['kind'] };
    case 'browser':
      return { kind: 'browser', url: parseSanityLoginURL(value['url']) };
    case 'choosing':
      return {
        kind: 'choosing',
        projects: parseProjectChoices(value['projects']),
        suggestion: parseSuggestion(value['suggestion']),
      };
    case 'complete':
      return { kind: 'complete', connection: parseCmsConnection(value['connection']) };
    case 'failed':
      return { kind: 'failed', message: parseMessage(value['message']) };
    default:
      throw new Error('Unknown Sanity sign-in state.');
  }
}

/** The page Sanity signs in on: its own login site, over https, nothing else. */
export function parseSanityLoginURL(input: unknown): string {
  const raw = text(input);
  assert(raw.length <= CMS_CONNECTION_LIMITS.urlCharsMax, 'Sanity sign-in URL is too long.');
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.hostname !== 'www.sanity.io') {
    throw new Error('Unexpected Sanity sign-in address.');
  }
  if (url.username || url.password) {
    throw new Error('Unexpected Sanity sign-in address.');
  }
  assert(url.protocol === 'https:', 'Sanity sign-in is over https');
  return url.toString();
}

function parseProjectChoices(input: unknown): SanityProjectChoice[] {
  if (!Array.isArray(input) || input.length > CMS_CONNECTION_LIMITS.projectsMax) {
    throw new Error('Invalid Sanity project list.');
  }
  return input.map((entry: unknown) => {
    const value = record(entry);
    const datasets = value['datasets'];
    if (!Array.isArray(datasets) || datasets.length > CMS_CONNECTION_LIMITS.datasetsPerProjectMax) {
      throw new Error('Invalid Sanity dataset list.');
    }
    return {
      id: parseSanityProjectId(value['id']),
      name: parseLabelText(value['name']),
      datasets: datasets.map(parseSanityDataset),
    };
  });
}

function parseLabelText(input: unknown): string {
  const name = text(input);
  return name.length > CMS_CONNECTION_LIMITS.labelCharsMax
    ? name.slice(0, CMS_CONNECTION_LIMITS.labelCharsMax)
    : name;
}

function parseSuggestion(input: unknown) {
  if (input === undefined) {
    return undefined;
  }
  const value = record(input);
  return {
    projectId: parseSanityProjectId(value['projectId']),
    dataset: parseSanityDataset(value['dataset']),
  };
}

function parseMessage(input: unknown): string {
  const message = text(input);
  if (message.length === 0 || message.length > CMS_CONNECTION_LIMITS.messageCharsMax) {
    throw new Error('Invalid CMS message.');
  }
  return message;
}
