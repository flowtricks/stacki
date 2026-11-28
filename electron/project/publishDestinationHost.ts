// The questions only a host can answer before a destination is published: which branch a Pages project treats as
// production, which domains a project serves, and which repository it builds from. Every one is a read, through the
// person's own signed-in CLI, and every reply is parsed here. A question that fails is a refusal, never a guess.
import { assert } from '../../shared/core/assert';
import { record, text } from '../../shared/core/boundary';
import { toArray, toRecord } from '../../shared/core/record';
import type { Hosting } from '../../shared/properties/publishConfig';
import { discoveryList } from '../../shared/properties/publishDiscovery';
import { discoveryCommand } from './publishDiscoveryCommand';
import { cloudflareHeaders, cloudflareRequest } from './publishDiscoveryCloudflare';
import { vercelPages } from './publishDiscoveryVercel';
import { netlifySite, netlifySiteDomains } from './publishNetlify';
import { repositoryIdentity } from './deployLinkStore';

export type PagesHosting = Extract<Hosting, { readonly provider: 'cloudflare' }>;
export type VercelHosting = Extract<Hosting, { readonly provider: 'vercel' }>;
export type NetlifyHosting = Extract<Hosting, { readonly provider: 'netlify' }>;

/** What a host says about one project. */
export interface HostProject {
  /** Every hostname the host says the project serves, lowercase. */
  readonly domains: readonly string[];
  /** The repository the host builds the project from, as `github.com/owner/name`, when it is connected to one. */
  readonly repository: string | undefined;
}

export interface PagesProject extends HostProject {
  readonly productionBranch: string;
}

export interface HostQuestions {
  readonly pagesProject: (root: string, hosting: PagesHosting) => Promise<PagesProject>;
  readonly vercelHasProduction: (root: string, hosting: VercelHosting) => Promise<boolean>;
  readonly vercelProject: (root: string, hosting: VercelHosting) => Promise<HostProject>;
  readonly netlifyProject: (root: string, hosting: NetlifyHosting) => Promise<HostProject>;
  /** The hostnames Cloudflare serves from one Worker through its custom domains. */
  readonly workerHostnames: (root: string, accountId: string, worker: string) => Promise<readonly string[]>;
}

export const HOST_QUESTIONS: HostQuestions = { pagesProject, vercelHasProduction, vercelProject, netlifyProject, workerHostnames };

async function cloudflareResult(root: string, endpoint: string): Promise<unknown> {
  const credentials = record(await discoveryCommand(root, 'wrangler', ['auth', 'token', '--json']));
  const response = record(await cloudflareRequest(`https://api.cloudflare.com/client/v4/accounts/${endpoint}`, cloudflareHeaders(credentials)));
  if (response['success'] !== true) {
    throw new Error('Cloudflare did not answer.');
  }
  return response['result'];
}

async function pagesProject(root: string, hosting: PagesHosting): Promise<PagesProject> {
  const result = await cloudflareResult(root, `${hosting.accountId}/pages/projects/${hosting.project}`);
  return parsePagesProject(result);
}

export function parsePagesProject(input: unknown): PagesProject {
  const value = record(input);
  const productionBranch = text(value['production_branch']);
  assert(productionBranch.length > 0, 'A Pages project names its production branch');
  const source = toRecord(toRecord(value['source'])?.['config']);
  return {
    productionBranch,
    domains: hostnames(value['domains'] ?? []),
    repository: repositoryOf(source?.['owner'], source?.['repo_name']),
  };
}

async function workerHostnames(root: string, accountId: string, worker: string): Promise<readonly string[]> {
  return parseWorkerHostnames(await cloudflareResult(root, `${accountId}/workers/domains`), worker);
}

export function parseWorkerHostnames(input: unknown, worker: string): readonly string[] {
  return discoveryList(input).flatMap((entry) => {
    const domain = record(entry);
    return text(domain['service']).toLowerCase() === worker.toLowerCase() ? [text(domain['hostname']).toLowerCase()] : [];
  });
}

async function vercelHasProduction(root: string, hosting: VercelHosting): Promise<boolean> {
  const endpoint = `/v6/deployments?projectId=${encodeURIComponent(hosting.projectId)}&target=production&state=READY&limit=1`;
  const response = record(await discoveryCommand(root, 'vercel', ['api', endpoint, '--method', 'GET', '--raw', '--scope', hosting.organizationId]));
  const deployments = response['deployments'];
  if (!Array.isArray(deployments)) {
    throw new Error('Vercel did not list deployments.');
  }
  return deployments.some((entry: unknown) => record(entry)['target'] === 'production');
}

async function vercelProject(root: string, hosting: VercelHosting): Promise<HostProject> {
  const endpoint = `/v9/projects/${encodeURIComponent(hosting.projectId)}`;
  const project = await discoveryCommand(root, 'vercel', ['api', endpoint, '--method', 'GET', '--raw', '--scope', hosting.organizationId]);
  const domains = await vercelPages(root, `${endpoint}/domains`, 'domains', hosting.organizationId);
  return parseVercelProject(project, domains, hosting);
}

/** The API also answers to a project's name, so the reply must name the saved id and team. */
export function parseVercelProject(input: unknown, domains: readonly unknown[], hosting: VercelHosting): HostProject {
  const value = record(input);
  if (value['id'] !== hosting.projectId) {
    throw new Error('Vercel described another project.');
  }
  if (value['accountId'] !== hosting.organizationId) {
    throw new Error('Vercel described a project of another team.');
  }
  const link = toRecord(value['link']);
  return {
    domains: hostnames(discoveryList(domains).map((entry) => record(entry)['name'])),
    repository: link?.['type'] === 'github' ? repositoryOf(link['org'], link['repo']) : undefined,
  };
}

async function netlifyProject(root: string, hosting: NetlifyHosting): Promise<HostProject> {
  return parseNetlifyProject(await netlifySite(root, hosting), hosting);
}

/** The API also answers to a site's domain, so the reply must name the saved id. */
export function parseNetlifyProject(input: unknown, hosting: NetlifyHosting): HostProject {
  const value = record(input);
  if (value['id'] !== hosting.siteId) {
    throw new Error('Netlify described another site.');
  }
  const repository = toRecord(value['build_settings'])?.['repo_url'];
  return {
    domains: hostnames([...netlifySiteDomains(value), ...(toArray(value['domain_aliases']) ?? [])]),
    repository: typeof repository === 'string' && repository !== '' ? repositoryIdentity(repository) : undefined,
  };
}

function hostnames(input: unknown): readonly string[] {
  return discoveryList(input).map((entry) => text(entry).toLowerCase());
}

function repositoryOf(owner: unknown, name: unknown): string | undefined {
  return typeof owner === 'string' && typeof name === 'string' ? `github.com/${owner}/${name}`.toLowerCase() : undefined;
}
