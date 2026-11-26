// Netlify's teams, sites, public address and Add site, read through the signed-in CLI. Every reply is parsed here.
import { record, text } from '../../shared/core/boundary';
import { assert } from '../../shared/core/assert';
import { described, type Described, type MessageKey } from '../../shared/properties/i18n/messageRef';
import {
  discoveryIdentifier,
  discoveryLabel,
  discoveryList,
  DISCOVERY_LIMITS,
  type ConnectionFailure,
  type PublishAccount,
  type PublishProject,
} from '../../shared/properties/publishDiscovery';
import type { NetlifyHosting, NetlifySiteRequest, NetlifySiteResult } from '../../shared/properties/publishNetlify';
import { parseNetlifySiteRequest, parseNetlifySiteResult } from '../../shared/properties/publishNetlify';
import { netlifyAPI, type NetlifyFailure } from './publishNetlifyCommand';
import { DiscoveryCommandError } from './publishDiscoveryCommand';

const SITES_PER_PAGE = 50;
const SITE_PAGES_MAX = DISCOVERY_LIMITS.itemsMax / SITES_PER_PAGE;

/** The connection problem a failed read reports: Netlify's own refusals are not problems the settings can fix. */
export function netlifyConnectionFailure(failure: NetlifyFailure): ConnectionFailure {
  switch (failure) {
    case 'refused':
    case 'not-found':
      return 'unknown';
    case 'timeout':
      return 'network';
    case 'missing-cli':
    case 'signed-out':
    case 'expired':
    case 'network':
    case 'unknown':
      return failure;
    default: {
      const exhaustive: never = failure;
      return exhaustive;
    }
  }
}

async function netlifyRead(root: string, method: 'listAccountsForUser' | 'listSitesForAccount' | 'getSite', data: Readonly<Record<string, unknown>>) {
  const result = await netlifyAPI(root, method, data);
  if (!result.ok) {
    // i18n-ignore: the tool's name, in a diagnostic that stays in this process.
    throw new DiscoveryCommandError(netlifyConnectionFailure(result.error), 'Netlify');
  }
  return result.value;
}

/** The teams this sign-in belongs to; a team's slug is what lists and creates its sites. */
export async function netlifyAccounts(root: string): Promise<readonly PublishAccount[]> {
  const accounts = discoveryList(await netlifyRead(root, 'listAccountsForUser', {}));
  return accounts.map((entry) => {
    const account = record(entry);
    return { id: discoveryIdentifier(account['slug']), name: discoveryLabel(account['name']) };
  });
}

export async function netlifyProjects(root: string, team: string): Promise<readonly PublishProject[]> {
  const projects: PublishProject[] = [];
  for (let page = 1; page <= SITE_PAGES_MAX; page++) {
    const sites = discoveryList(await netlifyRead(root, 'listSitesForAccount', { account_slug: team, page, per_page: SITES_PER_PAGE }));
    projects.push(
      ...sites.map((entry): PublishProject => {
        const site = record(entry);
        return { name: discoveryLabel(site['name']), account: team, hosting: { provider: 'netlify', siteId: discoveryIdentifier(site['id']) } };
      }),
    );
    discoveryList(projects);
    if (sites.length < SITES_PER_PAGE) {
      return projects;
    }
  }
  throw new Error('Netlify has too many sites to list. Use manual configuration.');
}

/** The addresses a site answers at: its custom domain when it has one, and its netlify.app address. */
export function netlifySiteDomains(input: unknown): readonly string[] {
  const site = record(input);
  const custom = site['custom_domain'];
  const secure = site['ssl_url'];
  return [
    // Netlify uses JSON null for "no custom domain"; keep it out of the application model.
    ...(typeof custom === 'string' && custom !== '' ? [custom] : []),
    ...(typeof secure === 'string' && secure !== '' ? [new URL(secure).hostname] : []),
  ];
}

export async function netlifySite(root: string, hosting: NetlifyHosting): Promise<unknown> {
  return netlifyRead(root, 'getSite', { site_id: hosting.siteId });
}

/** Creates one site in the chosen team. A taken name is refused, never replaced with another name. */
export async function createNetlifySite(root: string, input: NetlifySiteRequest): Promise<NetlifySiteResult> {
  const request = parseNetlifySiteRequest(input);
  // `netlify sites:create` silently picks another name when one is taken; the API method answers 422 instead.
  const created = await netlifyAPI(root, 'createSiteInTeam', { account_slug: request.team, body: { name: request.name } });
  if (!created.ok) {
    return failedSite(createProblem(created.error));
  }
  try {
    const site = record(created.value);
    assert(text(site['name']) === request.name, 'Netlify created the requested name');
    return parseNetlifySiteResult({ kind: 'ready', name: request.name, hosting: { provider: 'netlify', siteId: text(site['id']) } });
  } catch {
    return failedSite(described('publish.netlify.error.createUnconfirmed'));
  }
}

function createProblem(failure: NetlifyFailure): Described {
  switch (failure) {
    case 'refused':
      return described('publish.netlify.error.nameRefused');
    case 'timeout':
      return described('publish.netlify.error.createUnconfirmed');
    case 'not-found':
    case 'unknown':
      return described('publish.netlify.error.createFailed');
    case 'missing-cli':
    case 'signed-out':
    case 'expired':
    case 'network':
      return connectionSentence(failure);
    default: {
      const exhaustive: never = failure;
      return exhaustive;
    }
  }
}

function failedSite(problem: Described): NetlifySiteResult {
  return problem.messageRef === undefined
    ? { kind: 'failed', message: problem.message }
    : { kind: 'failed', message: problem.message, messageRef: problem.messageRef };
}

/** The sentence a deploy reports when Netlify cannot be reached or does not know the site. */
export function netlifyDeployProblem(failure: NetlifyFailure): Described {
  return failure === 'not-found' ? described('publish.netlify.error.siteNotFound') : connectionSentence(netlifyConnectionFailure(failure));
}

// The same sentences the settings show for these connection problems.
const CONNECTION_KEYS = {
  'missing-cli': 'publish.connection.failure.missingCli',
  'signed-out': 'publish.connection.failure.signedOut',
  expired: 'publish.connection.failure.expired',
  network: 'publish.connection.failure.network',
  unknown: 'publish.connection.failure.unknown',
} as const satisfies Record<ConnectionFailure, MessageKey>;

function connectionSentence(reason: ConnectionFailure): Described {
  return described(CONNECTION_KEYS[reason], { provider: 'Netlify' }); // i18n-ignore: product name.
}
