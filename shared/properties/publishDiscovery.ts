import { assert } from '../core/assert';
import { record, text, list } from '../core/boundary';
import { englishText, messageRef, type MessageKey } from './i18n/messageRef';
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
// Why a provider connection could not be read. The reason, never the CLI's output, crosses the
// boundary: it picks the recovery the settings offer (install, sign in, sign in again, refresh).
export const CONNECTION_FAILURES = ['missing-cli', 'signed-out', 'expired', 'network', 'unknown'] as const;
export type ConnectionFailure = (typeof CONNECTION_FAILURES)[number];
export interface ConnectionProblem {
  readonly reason: ConnectionFailure;
  readonly message: string;
}
export type PublishDiscovery =
  | {
      readonly kind: 'ready';
      readonly accounts: readonly PublishAccount[];
      readonly projects: readonly PublishProject[];
      // Discovery partly worked (a linked project, or some accounts), but a connection did not.
      readonly notice?: ConnectionProblem;
    }
  | ({ readonly kind: 'failed' } & ConnectionProblem);
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
    return { kind: 'failed', ...parseConnectionProblem(value) };
  }
  if (value['kind'] !== 'ready') {
    throw new Error('Invalid publishing discovery result.');
  }
  return {
    kind: 'ready',
    ...(value['notice'] === undefined ? {} : { notice: parseConnectionProblem(record(value['notice'])) }),
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

export function parseConnectionProblem(value: Readonly<Record<string, unknown>>): ConnectionProblem {
  const reason = CONNECTION_FAILURES.find((entry) => entry === value['reason']);
  if (reason === undefined) {
    throw new Error('Unknown publishing connection failure.');
  }
  return { reason, message: discoveryLabel(value['message']) };
}

/**
 * The English sentence for each failure (the label names the provider, "Vercel"). The screen shows the translation of the same
 * `publish.connection.failure.*` key chosen from `reason`, so this text only serves logs, tests and readers that predate it.
 */
export function connectionFailureMessage(label: string, reason: ConnectionFailure): string {
  assert(label.length > 0, 'A connection failure names its provider');
  assert(label.length <= 64, 'A provider label stays short');
  return englishText(messageRef(CONNECTION_FAILURE_KEYS[reason], { provider: label }));
}

const CONNECTION_FAILURE_KEYS = {
  'missing-cli': 'publish.connection.failure.missingCli',
  'signed-out': 'publish.connection.failure.signedOut',
  expired: 'publish.connection.failure.expired',
  network: 'publish.connection.failure.network',
  unknown: 'publish.connection.failure.unknown',
} as const satisfies Record<ConnectionFailure, MessageKey>;

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
