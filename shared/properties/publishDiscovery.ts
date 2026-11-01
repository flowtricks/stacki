import { assert } from '../core/assert';
import { record, text, list } from '../core/boundary';
import { DEFAULT_PUBLISH_CONFIG, parsePublishConfig, type Hosting } from './publishConfig';

export type DiscoveryProvider = 'cloudflare' | 'cloudflare-workers' | 'vercel' | 'github' | 'linked';
export interface DiscoveryRequest {
  readonly provider: DiscoveryProvider;
  readonly account: string;
}
export interface PublishAccount {
  readonly id: string;
  readonly name: string;
}
export interface PublishProject {
  readonly name: string;
  readonly hosting: Hosting;
}
export type PublishDiscovery =
  | {
      readonly kind: 'ready';
      readonly accounts: readonly PublishAccount[];
      readonly projects: readonly PublishProject[];
      readonly notice?: string;
    }
  | { readonly kind: 'failed'; readonly message: string };
export const DISCOVERY_LIMITS = { itemsMax: 500, pagesMax: 5, timeoutMs: 30_000 } as const;

export function parseDiscoveryRequest(input: unknown): DiscoveryRequest {
  const value = record(input);
  const provider = value['provider'];
  if (provider !== 'cloudflare' && provider !== 'cloudflare-workers' && provider !== 'vercel' && provider !== 'github' && provider !== 'linked') {
    throw new Error('Unknown publishing provider.');
  }
  const account = text(value['account']);
  if (account !== '') {
    discoveryIdentifier(account);
  }
  return { provider, account };
}

export function parsePublishDiscovery(input: unknown): PublishDiscovery {
  const value = record(input);
  if (value['kind'] === 'failed') {
    return { kind: 'failed', message: discoveryLabel(value['message']) };
  }
  if (value['kind'] !== 'ready') {
    throw new Error('Invalid publishing discovery result.');
  }
  return {
    kind: 'ready',
    ...(value['notice'] === undefined ? {} : { notice: discoveryLabel(value['notice']) }),
    accounts: discoveryList(value['accounts']).map((item) => {
      const account = record(item);
      return { id: discoveryIdentifier(account['id']), name: discoveryLabel(account['name']) };
    }),
    projects: discoveryList(value['projects']).map((item) => {
      const project = record(item);
      return {
        name: discoveryLabel(project['name']),
        hosting: parseDiscoveredHosting(project['hosting']),
      };
    }),
  };
}

export function discoveryList(input: unknown): readonly unknown[] {
  const values = list((value) => value)(input);
  if (values.length > DISCOVERY_LIMITS.itemsMax) {
    throw new Error('Discovery exceeds 500 entries. Use manual configuration.');
  }
  return values;
}
export function discoveryIdentifier(input: unknown): string {
  const value = text(input);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(value)) {
    throw new Error('Invalid provider identifier.');
  }
  return value;
}
export function discoveryLabel(input: unknown): string {
  const value = text(input);
  if (value.length === 0 || value.length > 512) {
    throw new Error('Provider label must contain 1–512 characters.');
  }
  return value;
}

function parseDiscoveredHosting(input: unknown): Hosting {
  const value = record(input);
  if (value['provider'] === 'cloudflare-workers' && value['accountId'] === '') {
    // A local Wrangler name is useful before login; saving still requires a resolved account.
    const parsed = parsePublishConfig({
      ...DEFAULT_PUBLISH_CONFIG,
      hosting: { ...value, accountId: 'unresolved' },
    }).hosting;
    assert(parsed.provider === 'cloudflare-workers', 'Discovery preserves the Worker provider');
    assert(parsed.accountId === 'unresolved', 'Discovery replaces only the unresolved account');
    return { ...parsed, accountId: '' };
  }
  return parsePublishConfig({ ...DEFAULT_PUBLISH_CONFIG, hosting: input }).hosting;
}
