// The questions only a host can answer before a destination is published: which branch a Pages project treats as
// production, which domains a project serves, and which repository it builds from. Every one is a read, through the
// person's own signed-in CLI, and every reply is parsed here (publishDestinationReplies.ts). A question that fails is a
// refusal, never a guess.
import { record } from '../../shared/core/boundary';
import { discoveryCommand } from './publishDiscoveryCommand';
import { cloudflareHeaders, cloudflareRequest } from './publishDiscoveryCloudflare';
import { netlifySite } from './publishNetlify';
import {
  PAGES_DOMAINS_PER_PAGE,
  parseNetlifyProject,
  parsePagesProductionBranch,
  parsePagesProject,
  parseVercelProduction,
  parseVercelProject,
  parseWorkerHostnames,
  readPagesDomains,
  readVercelDomains,
  type HostProject,
  type NetlifyHosting,
  type PagesHosting,
  type PagesProject,
  type VercelHosting,
} from './publishDestinationReplies';

export interface HostQuestions {
  /** Only the branch the project deploys as production, for a publish that must stay off it. */
  readonly pagesProductionBranch: (root: string, hosting: PagesHosting) => Promise<string>;
  readonly pagesProject: (root: string, hosting: PagesHosting) => Promise<PagesProject>;
  readonly vercelHasProduction: (root: string, hosting: VercelHosting) => Promise<boolean>;
  readonly vercelProject: (root: string, hosting: VercelHosting) => Promise<HostProject>;
  readonly netlifyProject: (root: string, hosting: NetlifyHosting) => Promise<HostProject>;
  /** The hostnames Cloudflare serves from one Worker through its custom domains. */
  readonly workerHostnames: (root: string, accountId: string, worker: string) => Promise<readonly string[]>;
}

export const HOST_QUESTIONS: HostQuestions = {
  pagesProductionBranch,
  pagesProject,
  vercelHasProduction,
  vercelProject,
  netlifyProject,
  workerHostnames,
};

/** One signed-in reader of Cloudflare's API, under one account. */
async function cloudflareAccount(root: string, accountId: string): Promise<(path: string) => Promise<unknown>> {
  const credentials = record(await discoveryCommand(root, 'wrangler', ['auth', 'token', '--json']));
  const headers = cloudflareHeaders(credentials);
  return (path) => cloudflareRequest(`https://api.cloudflare.com/client/v4/accounts/${accountId}/${path}`, headers);
}

async function pagesProductionBranch(root: string, hosting: PagesHosting): Promise<string> {
  const read = await cloudflareAccount(root, hosting.accountId);
  return parsePagesProductionBranch(await read(`pages/projects/${hosting.project}`), hosting);
}

async function pagesProject(root: string, hosting: PagesHosting): Promise<PagesProject> {
  const read = await cloudflareAccount(root, hosting.accountId);
  const endpoint = `pages/projects/${hosting.project}`;
  const project = await read(endpoint);
  const custom = await readPagesDomains((page) => read(`${endpoint}/domains?page=${page}&per_page=${PAGES_DOMAINS_PER_PAGE}`));
  return parsePagesProject(project, custom, hosting);
}

async function workerHostnames(root: string, accountId: string, worker: string): Promise<readonly string[]> {
  const read = await cloudflareAccount(root, accountId);
  return parseWorkerHostnames(await read(`workers/domains?service=${encodeURIComponent(worker)}`), worker);
}

function vercelGet(root: string, hosting: VercelHosting, endpoint: string): Promise<unknown> {
  return discoveryCommand(root, 'vercel', ['api', endpoint, '--method', 'GET', '--raw', '--scope', hosting.organizationId]);
}

async function vercelHasProduction(root: string, hosting: VercelHosting): Promise<boolean> {
  const endpoint = `/v7/deployments?projectId=${encodeURIComponent(hosting.projectId)}&target=production&state=READY&limit=1`;
  return parseVercelProduction(await vercelGet(root, hosting, endpoint), hosting);
}

async function vercelProject(root: string, hosting: VercelHosting): Promise<HostProject> {
  const endpoint = `/v9/projects/${encodeURIComponent(hosting.projectId)}`;
  const project = await vercelGet(root, hosting, endpoint);
  const domains = await readVercelDomains(hosting, (until) =>
    vercelGet(root, hosting, `${endpoint}/domains?limit=100${until === undefined ? '' : `&until=${until}`}`),
  );
  return parseVercelProject(project, domains, hosting);
}

async function netlifyProject(root: string, hosting: NetlifyHosting): Promise<HostProject> {
  return parseNetlifyProject(await netlifySite(root, hosting), hosting);
}
