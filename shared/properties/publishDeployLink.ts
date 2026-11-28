// A custom host's private deploy link, and what the settings form asks about it. Anyone holding the link can
// start a deploy, so it is a secret: it travels once, from the form to Desktop's main process, and only its mask
// ever travels back. No sentence made here repeats any part of what was entered, because refusals reach toasts
// and Electron prints a thrown handler message to its log.
import { assert } from '../core/assert';
import { list, record, text } from '../core/boundary';
import { err, ok, type Result } from '../core/result';
import { described, type Described } from './i18n/messageRef';
import { parseOptionalMessageRef } from '../core/i18n/messageReference';
import { isPublishScriptName } from './publishConfig';
import { parsePublishedSiteURL } from './publishSite';
import { DESTINATION_LIMITS, parseDestinationId, parseDestinationTarget, type DestinationId } from './publishDestinations';
import type { WorkerEnvironment } from './publishDestinationDefaults';

export const DEPLOY_LINK_LIMITS = {
  linkCharsMax: 2_048,
  maskCharsMax: 320,
  scriptsMax: 200,
} as const satisfies Record<string, number>;

const MASK_TAIL = '••••••••';

/** What this computer holds for this project. `unsupported`: this host (Studio, the demo) keeps no links. */
export type DeployLinkState =
  | { readonly kind: 'none' }
  | { readonly kind: 'saved'; readonly mask: string }
  | { readonly kind: 'other-repository' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unsupported' };

/**
 * Whose link it is: `production`, or a destination's id (an id is never `production`). Each keeps its own link, and one
 * can never be sent for another.
 */
export type DeployLinkDestination = 'production' | DestinationId;
export const PRODUCTION_LINK = 'production';

export interface DeployLinkStates {
  readonly production: DeployLinkState;
  /** One entry for each saved destination. */
  readonly destinations: Readonly<Record<DestinationId, DeployLinkState>>;
  /** What a destination that has not been saved yet shows: it has no link, or this computer cannot keep one. */
  readonly unsaved: DeployLinkState;
}

export type CustomPublishRequest =
  | { readonly action: 'read' }
  | { readonly action: 'saveLink'; readonly destination: DeployLinkDestination; readonly link: string }
  | { readonly action: 'removeLink'; readonly destination: DeployLinkDestination };

export type CustomPublishResult =
  | {
      readonly kind: 'ready';
      readonly scripts: readonly string[];
      readonly environments: readonly WorkerEnvironment[];
      readonly links: DeployLinkStates;
    }
  | ({ readonly kind: 'failed' } & Described);

/** A full https address with no username, password, fragment or spaces. The refusal is one fixed sentence. */
export function parseDeployLink(input: unknown): Result<string, Described> {
  const refused = err(described('publish.custom.link.invalid'));
  if (typeof input !== 'string') {
    return refused;
  }
  const value = input.trim();
  if (value.length > DEPLOY_LINK_LIMITS.linkCharsMax) {
    return refused;
  }
  // Checked before URL parsing, which would quietly strip tabs and newlines out of the middle of a link.
  if (/[\s\p{Cc}\\]/u.test(value)) {
    return refused;
  }
  if (!/^https:\/\//i.test(value)) {
    return refused;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // The thrown error carries the input, so it is dropped here rather than passed on.
    return refused;
  }
  if (url.protocol !== 'https:' || url.hostname === '') {
    return refused;
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    return refused;
  }
  assert(url.href.startsWith('https://'), 'A checked deploy link is https');
  return ok(url.href);
}

/** The host alone: a deploy link keeps its secret in the path or the query, which the mask never shows. */
export function maskDeployLink(link: string): string {
  const parsed = parseDeployLink(link);
  assert(parsed.ok, 'Only a checked deploy link is masked');
  const url = new URL(parsed.value);
  const mask = `https://${url.host}/${MASK_TAIL}`;
  assert(url.search === '' || !mask.includes(url.search), 'A mask never carries the query, where a secret can be');
  assert(mask.length <= DEPLOY_LINK_LIMITS.maskCharsMax, 'A mask stays short: a host name is at most 253 characters');
  return mask;
}

export function parseCustomPublishRequest(input: unknown): CustomPublishRequest {
  const value = record(input);
  switch (value['action']) {
    case 'read':
      return { action: 'read' };
    case 'removeLink':
      return { action: 'removeLink', destination: parseLinkDestination(value['destination']) };
    case 'saveLink': {
      // Only the size is checked here; the handler answers a bad link as a value, so nothing about it is thrown.
      const link = value['link'];
      if (typeof link !== 'string' || link.length > DEPLOY_LINK_LIMITS.linkCharsMax) {
        throw new Error('A deploy link is text of at most 2048 characters.');
      }
      return { action: 'saveLink', destination: parseLinkDestination(value['destination']), link };
    }
    default:
      throw new Error('Unknown custom publishing request.');
  }
}

function parseLinkDestination(input: unknown): DeployLinkDestination {
  return input === PRODUCTION_LINK ? PRODUCTION_LINK : parseDestinationId(input);
}

function parseDeployLinkStates(input: unknown): DeployLinkStates {
  const value = record(input);
  const entries = Object.entries(record(value['destinations']));
  if (entries.length > DESTINATION_LIMITS.destinationsMax) {
    throw new Error('Too many deploy link states.');
  }
  return {
    production: parseDeployLinkState(value['production']),
    destinations: Object.fromEntries(entries.map(([id, state]) => [parseDestinationId(id), parseDeployLinkState(state)])),
    unsaved: parseDeployLinkState(value['unsaved']),
  };
}

export function parseDeployLinkState(input: unknown): DeployLinkState {
  const value = record(input);
  const kind = value['kind'];
  if (kind === 'none' || kind === 'other-repository' || kind === 'unavailable' || kind === 'unsupported') {
    return { kind };
  }
  if (kind !== 'saved') {
    throw new Error('Unknown deploy link state.');
  }
  const mask = text(value['mask']);
  // A producer that answered with the link itself must fail here, before a screen draws it.
  if (mask.length > DEPLOY_LINK_LIMITS.maskCharsMax || !new RegExp(`^https://[^/?#\\s]+/${MASK_TAIL}$`, 'u').test(mask)) {
    throw new Error('A saved deploy link is shown masked.');
  }
  return { kind, mask };
}

export function parseCustomPublishResult(input: unknown): CustomPublishResult {
  const value = record(input);
  if (value['kind'] === 'failed') {
    const messageRef = parseOptionalMessageRef(value['messageRef']);
    return { kind: 'failed', message: text(value['message']), ...(messageRef === undefined ? {} : { messageRef }) };
  }
  if (value['kind'] !== 'ready') {
    throw new Error('Unknown custom publishing result.');
  }
  const scripts = list(text)(value['scripts']);
  if (scripts.length > DEPLOY_LINK_LIMITS.scriptsMax) {
    throw new Error('Too many package.json scripts.');
  }
  if (!scripts.every(isPublishScriptName)) {
    throw new Error('Publish scripts are names, not commands.');
  }
  const environments = list(parseWorkerEnvironment)(value['environments']);
  if (environments.length > DESTINATION_LIMITS.environmentsMax) {
    throw new Error('Too many Wrangler environments.');
  }
  return { kind: 'ready', scripts, environments, links: parseDeployLinkStates(value['links']) };
}

function parseWorkerEnvironment(input: unknown): WorkerEnvironment {
  const value = record(input);
  const target = parseDestinationTarget({ kind: 'cloudflare-environment', environment: value['name'] });
  assert(target.kind === 'cloudflare-environment', 'An environment parses as one');
  return {
    name: target.environment,
    worker: text(value['worker']),
    ...(value['siteUrl'] === undefined ? {} : { siteUrl: parsePublishedSiteURL(value['siteUrl']) }),
  };
}

/** The script names in a package.json that publish settings can hold; the commands behind them are never read out. */
export function packageScriptNames(source: string): readonly string[] {
  const input: unknown = JSON.parse(source);
  const scripts = record(input)['scripts'];
  if (scripts === undefined) {
    return [];
  }
  const names = Object.entries(record(scripts))
    .filter(([name, command]) => typeof command === 'string' && isPublishScriptName(name))
    .map(([name]) => name)
    .slice(0, DEPLOY_LINK_LIMITS.scriptsMax);
  assert(names.every(isPublishScriptName), 'Only names publish settings can hold are offered');
  return names;
}
