// CMS connections: which hosted CMS a project's content comes from, and the key
// Stacki writes drafts with. The key itself never crosses to the renderer — it
// is sent once, when a connection is saved, and from then on only the main
// process holds it (encrypted at rest). Everything else here is what the
// Settings section shows and what the sign-in steps report.

import { record, text } from '../core/boundary';
import { assert } from '../core/assert';
import { parseMessageRef, type MessageRef } from '../core/i18n/messageReference';
import type { MessageParams } from '../core/i18n/catalog';
import { englishText, messageRef, type MessageKey, type TypedMessageRef } from './i18n/messageRef';

export const CMS_CONNECTION_LIMITS = {
  connectionsPerProjectMax: 16,
  datasetsPerProjectMax: 100,
  labelCharsMax: 80,
  messageCharsMax: 1000,
  projectsMax: 200,
  secretCharsMax: 4096,
  payloadCollectionsMax: 50,
  emailCharsMax: 254,
  urlCharsMax: 2048,
} as const;

export type PayloadAuthMode = 'apiKey' | 'password';
export const PAYLOAD_AUTH_MODES: readonly PayloadAuthMode[] = ['apiKey', 'password'];

export const SANITY_LOGIN_TIMEOUT_MS = 5 * 60_000;

/**
 * What the connect form's validators throw when a person typed something unusable. It is an expected failure of user
 * input, shown in the form, so it carries a message reference beside the English sentence it always had: the renderer
 * translates the reference, and every older reader still gets `message`. Programmer errors stay plain `Error`.
 */
export class CmsInputError extends Error {
  readonly messageRef: TypedMessageRef;

  constructor(key: MessageKey, params?: MessageParams) {
    const reference = messageRef(key, params);
    super(englishText(reference));
    this.name = 'CmsInputError';
    this.messageRef = reference;
  }
}

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
      /** The auth collection the API key (or the login) belongs to, e.g. `users`. */
      readonly collection: string;
      /**
       * `apiKey`: the secret is a Payload API key. `password`: the secret is the account's password and
       * Stacki logs in (POST /api/<collection>/login), keeping the token in memory only.
       */
      readonly auth: PayloadAuthMode;
      /** The account's email, for a `password` connection; absent for an API key. */
      readonly email: string | undefined;
      /**
       * Collections the person named in the form. Payload has no REST endpoint that describes its
       * collections, so these are used when detection (access list, GraphQL) cannot see them; empty means detect.
       */
      readonly collections: readonly string[];
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
  { readonly ok: true; readonly list: CmsConnectionList } | { readonly ok: false; readonly message: string; readonly messageRef?: MessageRef | undefined };

/** A collection a Payload server offers this account, as detection found it. */
export interface PayloadCollectionSummary {
  readonly slug: string;
  /** `versions.drafts` is on: edits are saved as drafts. Off, an edit changes the live content. */
  readonly drafts: boolean;
  /** An upload collection: files go here. */
  readonly upload: boolean;
}

/** What a check of a Payload connection found out, for the card and the form's Detect button. */
export interface PayloadSummary {
  /** The account's email (or the auth collection when it has none), or `API key` for a key without one. */
  readonly user: string;
  readonly mode: PayloadAuthMode;
  /** When the check ran, an ISO time. */
  readonly checkedAt: string;
  readonly collections: readonly PayloadCollectionSummary[];
  readonly locales: readonly string[];
  /** Whether GraphQL introspection answered (field types are then exact rather than sampled). */
  readonly graphql: boolean;
}

export type CmsCheckRequest =
  { readonly action: 'test'; readonly id: string } | { readonly action: 'detect'; readonly draft: Extract<CmsConnectionDraft, { readonly kind: 'payload' }> };

export type CmsCheckResult =
  { readonly ok: true; readonly summary: PayloadSummary } | { readonly ok: false; readonly message: string; readonly messageRef?: MessageRef | undefined };

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
  | { readonly kind: 'failed'; readonly message: string; readonly messageRef?: MessageRef | undefined };

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
    throw new CmsInputError('cmsConnections.input.invalid.projectId');
  }
  return id;
}

export function parseSanityDataset(input: unknown): string {
  const dataset = text(input);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(dataset)) {
    throw new CmsInputError('cmsConnections.input.invalid.dataset');
  }
  return dataset;
}

/** A CMS server address: https, or http on this machine for a local server. */
export function parseCmsURL(input: unknown): string {
  const raw = text(input);
  if (raw.length === 0 || raw.length > CMS_CONNECTION_LIMITS.urlCharsMax) {
    throw new CmsInputError('cmsConnections.input.address.empty');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CmsInputError('cmsConnections.input.address.notURL');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new CmsInputError('cmsConnections.input.address.https');
  }
  if (url.username || url.password || url.hash) {
    throw new CmsInputError('cmsConnections.input.address.credentials');
  }
  // A query would end up in the middle of every request address built from this one.
  if (url.search) {
    throw new CmsInputError('cmsConnections.input.address.query');
  }
  const parsed = url.toString().replace(/\/$/, '');
  assert(parsed.length <= CMS_CONNECTION_LIMITS.urlCharsMax + 1, 'A parsed address stays bounded');
  assert(!parsed.endsWith('/'), 'A parsed address has no trailing slash');
  return parsed;
}

// A Payload connection saved before logins existed has no `auth`: it holds an API key.
function parsePayloadAccount(value: Record<string, unknown>): {
  readonly auth: PayloadAuthMode;
  readonly email: string | undefined;
  readonly collections: readonly string[];
} {
  const mode = value['auth'] === undefined ? 'apiKey' : PAYLOAD_AUTH_MODES.find((candidate) => candidate === value['auth']);
  if (mode === undefined) {
    throw new CmsInputError('cmsConnections.input.authChoice');
  }
  const email = mode === 'password' ? parseEmail(value['email']) : undefined;
  const collections = parsePayloadCollections(value['collections']);
  assert(mode === 'password' || email === undefined, 'Only a login names an email');
  return { auth: mode, email, collections };
}

function parseEmail(input: unknown): string {
  const email = typeof input === 'string' ? input.trim() : '';
  if (email.length === 0 || email.length > CMS_CONNECTION_LIMITS.emailCharsMax || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new CmsInputError('cmsConnections.input.email');
  }
  assert(email.includes('@'), 'An email has an @');
  return email;
}

/** Collection slugs typed in the form: kebab or snake case, no repeats, a few. */
export function parsePayloadCollections(input: unknown): readonly string[] {
  if (input === undefined) {
    return [];
  }
  if (!Array.isArray(input) || input.length > CMS_CONNECTION_LIMITS.payloadCollectionsMax) {
    throw new CmsInputError('cmsConnections.input.collections.few');
  }
  const slugs = input.map((entry: unknown) => parseSlug(entry, 'cmsConnections.input.invalid.collection'));
  if (new Set(slugs).size !== slugs.length) {
    throw new CmsInputError('cmsConnections.input.collections.twice');
  }
  assert(slugs.length <= CMS_CONNECTION_LIMITS.payloadCollectionsMax, 'A connection names a bounded set of collections');
  return slugs;
}

function parseLabel(input: unknown): string {
  const label = text(input).trim();
  if (label.length === 0 || label.length > CMS_CONNECTION_LIMITS.labelCharsMax) {
    throw new CmsInputError('cmsConnections.input.label', { max: CMS_CONNECTION_LIMITS.labelCharsMax });
  }
  return label;
}

function parseSlug(input: unknown, invalidKey: MessageKey): string {
  const slug = text(input);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(slug)) {
    throw new CmsInputError(invalidKey);
  }
  return slug;
}

/** A key: printable ASCII on one line, as every CMS issues them. */
export function parseCmsSecret(input: unknown): string {
  const secret = text(input).trim();
  if (secret.length === 0 || secret.length > CMS_CONNECTION_LIMITS.secretCharsMax) {
    throw new CmsInputError('cmsConnections.input.secret.paste');
  }
  if (!/^[\x20-\x7e]+$/.test(secret)) {
    throw new CmsInputError('cmsConnections.input.secret.printable');
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
  const fields = parseConnectionFields(value);
  const login = fields.kind === 'payload' && fields.auth === 'password';
  return { ...fields, secret: login ? parsePassword(value['secret']) : parseCmsSecret(value['secret']) };
}

/** A password as typed: any characters on one line (people use more than printable ASCII), never trimmed. */
export function parsePassword(input: unknown): string {
  const password = text(input);
  if (password.length === 0 || password.length > CMS_CONNECTION_LIMITS.secretCharsMax) {
    throw new CmsInputError('cmsConnections.input.password.enter');
  }
  if (/[\r\n\0]/.test(password)) {
    throw new CmsInputError('cmsConnections.input.password.oneLine');
  }
  assert(!/[\r\n]/.test(password), 'A password never holds a line break');
  return password;
}

function parseConnectionFields(value: Record<string, unknown>): DistributiveOmit<CmsConnection, 'id'> {
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
        collection: parseSlug(value['collection'], 'cmsConnections.input.invalid.authCollection'),
        ...parsePayloadAccount(value),
      };
    case 'custom':
      return {
        kind: 'custom',
        label,
        baseUrl: parseCmsURL(value['baseUrl']),
        header: parseSlug(value['header'], 'cmsConnections.input.invalid.header'),
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
  return { ok: false, message: parseMessage(value['message']), ...parseRef(value['messageRef']) };
}

export function parseCmsCheckRequest(input: unknown): CmsCheckRequest {
  const value = record(input);
  switch (value['action']) {
    case 'test':
      return { action: 'test', id: parseConnectionId(value['id']) };
    case 'detect': {
      const draft = parseCmsConnectionDraft(value['draft']);
      if (draft.kind !== 'payload') {
        throw new Error('Only Payload connections can be detected.');
      }
      return { action: 'detect', draft };
    }
    default:
      throw new Error('Unknown CMS check.');
  }
}

export function parseCmsCheckResult(input: unknown): CmsCheckResult {
  const value = record(input);
  if (value['ok'] === true) {
    return { ok: true, summary: parsePayloadSummary(value['summary']) };
  }
  return { ok: false, message: parseMessage(value['message']), ...parseRef(value['messageRef']) };
}

function parsePayloadSummary(input: unknown): PayloadSummary {
  const value = record(input);
  const mode = PAYLOAD_AUTH_MODES.find((candidate) => candidate === value['mode']);
  if (mode === undefined) {
    throw new Error('Invalid Payload sign-in mode.');
  }
  const collections = value['collections'];
  const locales = value['locales'];
  if (!Array.isArray(collections) || collections.length > CMS_CONNECTION_LIMITS.payloadCollectionsMax * 4) {
    throw new Error('Invalid Payload collection list.');
  }
  if (!Array.isArray(locales) || locales.length > 64) {
    throw new Error('Invalid Payload locale list.');
  }
  const checkedAt = text(value['checkedAt']);
  if (Number.isNaN(Date.parse(checkedAt))) {
    throw new Error('Invalid check time.');
  }
  if (typeof value['graphql'] !== 'boolean') {
    throw new Error('Expected whether GraphQL answered.');
  }
  return {
    user: parseLabelText(value['user']),
    mode,
    checkedAt,
    graphql: value['graphql'],
    locales: locales.map((locale: unknown) => parseSlug(locale, 'cmsConnections.input.invalid.locale')),
    collections: collections.map((entry: unknown) => {
      const collection = record(entry);
      if (typeof collection['drafts'] !== 'boolean' || typeof collection['upload'] !== 'boolean') {
        throw new Error('Invalid Payload collection.');
      }
      return { slug: parseSlug(collection['slug'], 'cmsConnections.input.invalid.collection'), drafts: collection['drafts'], upload: collection['upload'] };
    }),
  };
}

function parseRef(input: unknown): { readonly messageRef?: MessageRef } {
  if (input === undefined) {
    return {};
  }
  const parsed = parseMessageRef(input);
  return parsed.ok ? { messageRef: parsed.value } : {};
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
      return { kind: 'failed', message: parseMessage(value['message']), ...parseRef(value['messageRef']) };
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
  return name.length > CMS_CONNECTION_LIMITS.labelCharsMax ? name.slice(0, CMS_CONNECTION_LIMITS.labelCharsMax) : name;
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
