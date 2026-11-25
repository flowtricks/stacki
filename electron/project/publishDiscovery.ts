import { repositoryState } from './publishRepositories';
import { record } from '../../shared/core/boundary';
import {
  parseDiscoveryRequest,
  parsePublishDiscovery,
  discoveryList,
  discoveryIdentifier,
  connectionFailureMessage,
  type ConnectionFailure,
  type ConnectionProblem,
  type DiscoveryProvider,
  type DiscoveryRequest,
  type PublishDiscovery,
  type PublishProject,
} from '../../shared/properties/publishDiscovery';
import { discoveryCommand, DiscoveryCommandError } from './publishDiscoveryCommand';
import { cloudflareAccounts, cloudflareProjects, cloudflareWorkers } from './publishDiscoveryCloudflare';
import { vercelAccounts, vercelProjects } from './publishDiscoveryVercel';
import { linkedPublishProject } from './publishLinkedProject';

/** This boundary returns sanitized failures, never CLI output that could contain credentials. */
export async function discoverPublishing(root: string, input: DiscoveryRequest): Promise<PublishDiscovery> {
  const request = parseDiscoveryRequest(input);
  try {
    return parsePublishDiscovery(await discoverProvider(root, request));
  } catch (error: unknown) {
    return { kind: 'failed', ...connectionProblem(request.provider, failureReason(error)) };
  }
}

const PROVIDER_LABELS: Readonly<Record<DiscoveryProvider, string>> = {
  // i18n-ignore: product and tool names (GitHub, Vercel, Cloudflare, Wrangler), shown as written in every language.
  cloudflare: 'Cloudflare',
  // i18n-ignore: product and tool names (GitHub, Vercel, Cloudflare, Wrangler), shown as written in every language.
  'cloudflare-workers': 'Cloudflare',
  linked: 'hosting',
  // i18n-ignore: product and tool names (GitHub, Vercel, Cloudflare, Wrangler), shown as written in every language.
  vercel: 'Vercel',
  // i18n-ignore: product and tool names (GitHub, Vercel, Cloudflare, Wrangler), shown as written in every language.
  github: 'GitHub',
};

export function connectionProblem(provider: DiscoveryProvider, reason: ConnectionFailure): ConnectionProblem {
  return { reason, message: connectionFailureMessage(PROVIDER_LABELS[provider], reason) };
}

// Only a classified command failure says why; anything else (a malformed reply, a bound) is unknown.
function failureReason(error: unknown): ConnectionFailure {
  return error instanceof DiscoveryCommandError ? error.reason : 'unknown';
}

// A missing tool or login blocks publishing even when a linked project can still be listed.
function blocksPublishing(reason: ConnectionFailure): boolean {
  switch (reason) {
    case 'missing-cli':
    case 'signed-out':
    case 'expired':
      return true;
    case 'network':
    case 'unknown':
      return false;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

async function discoverProvider(root: string, request: DiscoveryRequest): Promise<PublishDiscovery> {
  if (request.provider === 'linked') {
    const results = await Promise.allSettled((['linked', 'vercel'] as const).map((provider) => linkedPublishProject(root, provider)));
    return {
      kind: 'ready',
      accounts: [],
      projects: results.flatMap((result) => (result.status === 'fulfilled' ? result.value : [])),
    };
  }
  if (request.provider === 'github') {
    const status = record(await discoveryCommand(root, 'gh', ['auth', 'status', '--hostname', 'github.com', '--json', 'hosts']));
    const entries = discoveryList(record(status['hosts'])['github.com'] ?? []);
    const connected = await repositoryState(root).catch(() => undefined);
    const owner = connected?.connected.split('/')[0];
    const accounts = entries
      .map(record)
      .filter((value) => value['state'] === 'success')
      .sort((left, right) => Number(right['login'] === owner) - Number(left['login'] === owner))
      .map((value) => {
        const id = discoveryIdentifier(value['login']);
        return { id, name: id };
      });
    return { kind: 'ready', accounts, projects: [] };
  }
  if (request.account) {
    const projects =
      request.provider === 'cloudflare'
        ? await cloudflareProjects(root, request.account)
        : request.provider === 'cloudflare-workers'
          ? await cloudflareWorkers(root, request.account)
          : await vercelProjects(root, request.account);
    return { kind: 'ready', accounts: [], projects };
  }
  return discoverHosting(root, request.provider);
}

async function discoverHosting(root: string, provider: 'cloudflare' | 'cloudflare-workers' | 'vercel'): Promise<PublishDiscovery> {
  const [linked, connected] = await Promise.allSettled([
    linkedPublishProject(root, provider),
    provider === 'vercel' ? vercelAccounts(root) : cloudflareAccounts(root),
  ]);
  const linkedProjects = linked.status === 'fulfilled' ? linked.value : [];
  if (connected.status === 'rejected' && linkedProjects.length === 0) {
    // Keep the classified reason: it decides whether the settings offer install, sign-in or refresh.
    throw connected.reason instanceof DiscoveryCommandError ? connected.reason : new Error('No accessible provider connection.');
  }
  const accounts = connected.status === 'fulfilled' ? connected.value : [];
  if (accounts.length > 20) {
    throw new Error('Discovery supports at most twenty accounts per provider.');
  }
  const requests = accounts.flatMap((account) => {
    switch (provider) {
      case 'cloudflare':
        return [cloudflareProjects(root, account.id), cloudflareWorkers(root, account.id)];
      case 'cloudflare-workers':
        return [cloudflareWorkers(root, account.id)];
      case 'vercel':
        return [vercelProjects(root, account.id)];
    }
  });
  const results = await Promise.allSettled(requests);
  const projects = results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
  discoveryList(projects);
  const unique = new Map(projects.map((project) => [discoveryProjectKey(project), project]));
  for (const project of linkedProjects) {
    unique.set(discoveryProjectKey(project), project);
  }
  return {
    kind: 'ready',
    accounts,
    projects: [...unique.values()],
    ...discoveryNotice(provider, connected.status === 'rejected' ? failureReason(connected.reason) : undefined, results),
  };
}

function discoveryNotice(
  provider: DiscoveryProvider,
  connection: ConnectionFailure | undefined,
  results: readonly PromiseSettledResult<unknown>[],
): { readonly notice?: ConnectionProblem } {
  if (connection !== undefined) {
    if (blocksPublishing(connection)) {
      return { notice: connectionProblem(provider, connection) };
    }
  }
  if (connection !== undefined || results.some((result) => result.status === 'rejected')) {
    // The screen shows the sentence for the reason, so a partly loaded list reports as that reason rather than a second, unshown text.
    return { notice: connectionProblem(provider, connection ?? 'unknown') };
  }
  return {};
}

function discoveryProjectKey(project: PublishProject): string {
  const hosting = project.hosting;
  switch (hosting.provider) {
    case 'none':
      return 'none';
    case 'cloudflare':
    case 'cloudflare-workers':
      return `${hosting.provider}/${hosting.accountId}/${hosting.project}`;
    case 'vercel':
      // i18n-ignore: HTTP header value or request path, protocol text.
      return `vercel/${hosting.organizationId}/${hosting.projectId}`;
  }
}
