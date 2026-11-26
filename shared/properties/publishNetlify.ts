// Add site's contract for Netlify: what the settings ask for and what they get back. Netlify, unlike a Cloudflare
// Worker, has no destination until a site exists (publishing needs its id), so this one request creates a real site in
// the chosen team, and only when the person presses Create site.
import { record, text } from '../core/boundary';
import { assert } from '../core/assert';
import { parseOptionalMessageRef, type MessageRef } from '../core/i18n/messageReference';
import { DEFAULT_PUBLISH_CONFIG, parsePublishConfig, type Hosting } from './publishConfig';

/** A Netlify site name is its `<name>.netlify.app` subdomain: lowercase letters, digits and inner hyphens. */
export const NETLIFY_SITE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// A team slug as the API returns it. It never starts with a hyphen, so it can never read as a CLI option.
const NETLIFY_TEAM_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/;
const MESSAGE_CHARS_MAX = 1000;

export interface NetlifySiteRequest {
  readonly team: string;
  readonly name: string;
}

export type NetlifyHosting = Extract<Hosting, { readonly provider: 'netlify' }>;

export type NetlifySiteResult =
  | { readonly kind: 'ready'; readonly name: string; readonly hosting: NetlifyHosting }
  | { readonly kind: 'failed'; readonly message: string; readonly messageRef?: MessageRef | undefined };

export function parseNetlifySiteRequest(input: unknown): NetlifySiteRequest {
  const value = record(input);
  const team = text(value['team']);
  if (!NETLIFY_TEAM_PATTERN.test(team)) {
    throw new Error('Choose a Netlify team.');
  }
  const name = text(value['name']);
  if (!NETLIFY_SITE_NAME_PATTERN.test(name)) {
    throw new Error('A Netlify site name uses lowercase letters, numbers and hyphens, at most 63 characters.');
  }
  return { team, name };
}

export function parseNetlifySiteResult(input: unknown): NetlifySiteResult {
  const value = record(input);
  if (value['kind'] === 'ready') {
    const hosting = parsePublishConfig({ ...DEFAULT_PUBLISH_CONFIG, hosting: value['hosting'] }).hosting;
    assert(hosting.provider === 'netlify', 'A new Netlify site deploys to Netlify');
    const name = text(value['name']);
    assert(NETLIFY_SITE_NAME_PATTERN.test(name), 'A new Netlify site has a valid name');
    return { kind: 'ready', name, hosting };
  }
  if (value['kind'] !== 'failed') {
    throw new Error('Invalid Netlify site result.');
  }
  const message = text(value['message']);
  if (message.length === 0 || message.length > MESSAGE_CHARS_MAX) {
    throw new Error('Invalid Netlify site message.');
  }
  const messageRef = parseOptionalMessageRef(value['messageRef']);
  return messageRef === undefined ? { kind: 'failed', message } : { kind: 'failed', message, messageRef };
}
