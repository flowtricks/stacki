// What each host's reply is held to before a destination is published. The one rule: a field a check needs is never
// taken as "no clash" because it is missing or looks different. A reply that does not name the project asked about is
// refused outright. A list of domains or a repository link that cannot be read in full is `unread`, which refuses the
// publish whenever that check has something to compare (publishDestination.ts).
//
// Field names and which of them a host requires, from the public references (docs/contracts.md lists the pages):
//
// - Cloudflare Pages project: `name` and `production_branch` required; `domains` and `source` optional. Since
//   `domains` is optional, the separate domains list (`result[].name`) is asked too, and it must answer.
//   `source` is `{ type: 'github' | 'gitlab', config: { owner, repo_name } }`. Without it the project is not connected
//   to Git, which is also how Wrangler reads it (`project.source ? 'Yes' : 'No'` under "Git Provider").
// - Cloudflare Worker domains: `result[].service` and `result[].hostname`; `result_info` optional.
// - Vercel project: `id` and `accountId` required; `link` optional, absent when no repository is connected. Its types
//   are not all published, so a type this file does not know is `unread`.
// - Vercel project domains: `domains[].name` and `.projectId` required, and `pagination.next`, required and nullable.
// - Vercel deployments: `deployments[]` with `projectId` and `readyState` required; `target` is nullable.
// - Netlify site (open-api swagger.yml): `id`, `custom_domain`, `domain_aliases`, `url`, `ssl_url`, and
//   `build_settings` (`repo_url`, `repo_path`, `provider`). The spec marks nothing as required, so nothing here may
//   read a missing key as an answer: the three domain keys and `build_settings` must be there.
import { assert } from '../../shared/core/assert';
import { record, text } from '../../shared/core/boundary';
import { toRecord } from '../../shared/core/record';
import type { Hosting } from '../../shared/properties/publishConfig';
import { discoveryList, DISCOVERY_LIMITS } from '../../shared/properties/publishDiscovery';
import { repositoryIdentity } from './deployLinkStore';

export type PagesHosting = Extract<Hosting, { readonly provider: 'cloudflare' }>;
export type VercelHosting = Extract<Hosting, { readonly provider: 'vercel' }>;
export type NetlifyHosting = Extract<Hosting, { readonly provider: 'netlify' }>;

export type HostDomains =
  /** Every hostname the host says the project serves, lowercase. */
  { readonly kind: 'listed'; readonly hosts: readonly string[] } | { readonly kind: 'unread' };

export type HostRepository =
  | { readonly kind: 'not-connected' }
  /** Connected to a repository on GitHub, as `github.com/owner/name`. */
  | { readonly kind: 'github'; readonly repository: string }
  /** Connected to another Git host, so not to a project's GitHub repository. */
  | { readonly kind: 'elsewhere' }
  | { readonly kind: 'unread' };

/** What a host says about one project. */
export interface HostProject {
  readonly domains: HostDomains;
  readonly repository: HostRepository;
}

export interface PagesProject extends HostProject {
  readonly productionBranch: string;
}

const UNREAD = { kind: 'unread' } as const;
const NOT_CONNECTED = { kind: 'not-connected' } as const;
const ELSEWHERE = { kind: 'elsewhere' } as const;

export const PAGES_DOMAINS_PER_PAGE = 25;
const PAGES_DOMAIN_PAGES_MAX = Math.ceil(DISCOVERY_LIMITS.itemsMax / PAGES_DOMAINS_PER_PAGE);

/** A hostname as a host writes one, wildcards included. Anything else means the field is not what it is taken to be. */
function hostname(input: unknown): string {
  const value = text(input).toLowerCase();
  if (value.length > 253 || !/^[^\s/:?#@]+\.[^\s/:?#@]+$/.test(value)) {
    throw new Error('A host listed something that is not a domain.');
  }
  return value;
}

/** Reads a list of domains whole, or says it could not: a list read in part would hide what it left out. */
function domainsOf(read: () => readonly string[]): HostDomains {
  try {
    const hosts = read();
    assert(hosts.length <= DISCOVERY_LIMITS.itemsMax * 2, 'Listed domains stay bounded');
    return { kind: 'listed', hosts: [...new Set(hosts)] };
  } catch {
    return UNREAD;
  }
}

/** A Cloudflare reply that said it succeeded. */
function cloudflareReply(input: unknown): Readonly<Record<string, unknown>> {
  const reply = record(input);
  if (reply['success'] !== true) {
    throw new Error('Cloudflare did not answer.');
  }
  return reply;
}

/** The project the reply describes, which must be the one asked about. */
function pagesResult(input: unknown, hosting: PagesHosting): Readonly<Record<string, unknown>> {
  const result = record(cloudflareReply(input)['result']);
  if (text(result['name']).toLowerCase() !== hosting.project.toLowerCase()) {
    throw new Error('Cloudflare described another Pages project.');
  }
  return result;
}

export function parsePagesProductionBranch(input: unknown, hosting: PagesHosting): string {
  const branch = text(pagesResult(input, hosting)['production_branch']);
  if (branch === '') {
    throw new Error('A Pages project names its production branch.');
  }
  return branch;
}

/** How many entries Cloudflare says there are beyond a page; its counts are optional. */
function cloudflareCount(reply: Readonly<Record<string, unknown>>, name: 'total_pages' | 'total_count'): number | undefined {
  const info = reply['result_info'];
  const value = info === undefined ? undefined : record(info)[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Cloudflare counted its list in a form Stacki does not know.');
  }
  return value;
}

/** Every custom domain of a Pages project, page by page. A failed request throws; a list not read whole is `unread`. */
export async function readPagesDomains(read: (page: number) => Promise<unknown>): Promise<HostDomains> {
  const replies: unknown[] = [];
  const names: string[] = [];
  for (let page = 1; page <= PAGES_DOMAIN_PAGES_MAX; page++) {
    replies.push(await read(page));
    let last: boolean;
    try {
      const reply = cloudflareReply(replies.at(-1));
      const entries = discoveryList(reply['result']);
      names.push(...entries.map((entry) => hostname(record(entry)['name'])));
      const pages = cloudflareCount(reply, 'total_pages');
      last = pages === undefined ? entries.length < PAGES_DOMAINS_PER_PAGE : page >= pages;
      if (last && (cloudflareCount(reply, 'total_count') ?? 0) > names.length) {
        return UNREAD;
      }
    } catch {
      return UNREAD;
    }
    if (last) {
      return domainsOf(() => names);
    }
  }
  return UNREAD;
}

export function parsePagesProject(input: unknown, custom: HostDomains, hosting: PagesHosting): PagesProject {
  const result = pagesResult(input, hosting);
  const domains =
    custom.kind === 'unread'
      ? custom
      : domainsOf(() => {
          // The project's own list and address are optional; when they are there, they count too.
          const listed = result['domains'] === undefined ? [] : discoveryList(result['domains']).map(hostname);
          const address = result['subdomain'] === undefined ? [] : [hostname(result['subdomain'])];
          return [...custom.hosts, ...listed, ...address];
        });
  return { productionBranch: parsePagesProductionBranch(input, hosting), domains, repository: pagesRepository(result['source']) };
}

function pagesRepository(input: unknown): HostRepository {
  // Absent, or null: a project uploaded directly, connected to no repository.
  if (input === undefined || input === null) {
    return NOT_CONNECTED;
  }
  const source = toRecord(input);
  if (source?.['type'] === 'gitlab') {
    return ELSEWHERE;
  }
  const config = toRecord(source?.['config']);
  return source?.['type'] === 'github' ? githubRepository(config?.['owner'], config?.['repo_name']) : UNREAD;
}

function githubRepository(owner: unknown, name: unknown): HostRepository {
  const part = /^[\w.-]+$/;
  if (typeof owner !== 'string' || typeof name !== 'string' || !part.test(owner) || !part.test(name)) {
    return UNREAD;
  }
  return { kind: 'github', repository: `github.com/${owner}/${name}`.toLowerCase() };
}

/** One Worker's custom domains. Cloudflare lists them in one page, so a count beyond it means something was left out. */
export function parseWorkerHostnames(input: unknown, worker: string): readonly string[] {
  const reply = cloudflareReply(input);
  const entries = discoveryList(reply['result']);
  const pages = cloudflareCount(reply, 'total_pages') ?? 1;
  if (pages > 1 || (cloudflareCount(reply, 'total_count') ?? 0) > entries.length) {
    throw new Error('Cloudflare did not list every Worker domain.');
  }
  return entries.flatMap((entry) => {
    const domain = record(entry);
    const service = text(domain['service']);
    const served = hostname(domain['hostname']);
    // Asked for one Worker's domains; the answer is still held to it.
    return service.toLowerCase() === worker.toLowerCase() ? [served] : [];
  });
}

/** Whether Vercel lists a ready production deployment of this project. Only that exact answer counts as yes. */
export function parseVercelProduction(input: unknown, hosting: VercelHosting): boolean {
  const deployments = discoveryList(record(input)['deployments']).map((entry) => {
    const value = record(entry);
    // Required of every deployment. Without them the reply is not one this check can read.
    const projectId = text(value['projectId']);
    const ready = text(value['readyState']) === 'READY' || value['state'] === 'READY';
    return projectId === hosting.projectId && ready && value['target'] === 'production';
  });
  return deployments.includes(true);
}

/** Every domain of a Vercel project, following its pagination. A failed request throws; a list not read whole is `unread`. */
export async function readVercelDomains(hosting: VercelHosting, read: (until: number | undefined) => Promise<unknown>): Promise<HostDomains> {
  const names: string[] = [];
  let until: number | undefined;
  for (let page = 0; page < DISCOVERY_LIMITS.pagesMax; page++) {
    const reply = await read(until);
    let next: unknown;
    try {
      const value = record(reply);
      names.push(...discoveryList(value['domains']).map((entry) => vercelDomain(entry, hosting)));
      next = record(value['pagination'])['next'];
    } catch {
      return UNREAD;
    }
    // Vercel says null at the end. A reply without the key has not said there is no more.
    if (next === null) {
      return domainsOf(() => names);
    }
    if (typeof next !== 'number' || !Number.isSafeInteger(next) || next < 0 || next === until) {
      return UNREAD;
    }
    until = next;
  }
  return UNREAD;
}

function vercelDomain(input: unknown, hosting: VercelHosting): string {
  const value = record(input);
  if (value['projectId'] !== hosting.projectId) {
    throw new Error('Vercel listed another project’s domain.');
  }
  return hostname(value['name']);
}

/** The API also answers to a project's name, so the reply must name the saved id and team. */
export function parseVercelProject(input: unknown, domains: HostDomains, hosting: VercelHosting): HostProject {
  const value = record(input);
  if (value['id'] !== hosting.projectId) {
    throw new Error('Vercel described another project.');
  }
  if (value['accountId'] !== hosting.organizationId) {
    throw new Error('Vercel described a project of another team.');
  }
  return { domains, repository: vercelRepository(value['link']) };
}

function vercelRepository(input: unknown): HostRepository {
  if (input === undefined || input === null) {
    return NOT_CONNECTED;
  }
  const link = toRecord(input);
  switch (link?.['type']) {
    case 'github':
    case 'github-limited':
      return githubRepository(link['org'], link['repo']);
    case 'github-custom-host': {
      const host = link['host'];
      if (typeof host !== 'string' || host === '') {
        return UNREAD;
      }
      return host.toLowerCase() === 'github.com' ? githubRepository(link['org'], link['repo']) : ELSEWHERE;
    }
    case 'gitlab':
    case 'bitbucket':
      return ELSEWHERE;
    default:
      return UNREAD;
  }
}

/** The API also answers to a site's domain, so the reply must name the saved id. */
export function parseNetlifyProject(input: unknown, hosting: NetlifyHosting): HostProject {
  const value = record(input);
  if (value['id'] !== hosting.siteId) {
    throw new Error('Netlify described another site.');
  }
  return { domains: netlifyDomains(value), repository: netlifyRepository(value['build_settings']) };
}

function netlifyDomains(site: Readonly<Record<string, unknown>>): HostDomains {
  return domainsOf(() => {
    // `custom_domain` is null or empty without one, and `domain_aliases` is an empty list. A missing key is neither.
    const custom = site['custom_domain'];
    if (custom === undefined) {
      throw new Error('Netlify did not say whether the site has a custom domain.');
    }
    const addresses = [site['ssl_url'], site['url']].flatMap((address) =>
      address === undefined || address === null || address === '' ? [] : [hostname(new URL(text(address)).hostname)],
    );
    if (addresses.length === 0) {
      throw new Error('Netlify did not give the site an address.');
    }
    const named = custom === null || custom === '' ? [] : [hostname(custom)];
    return [...named, ...discoveryList(site['domain_aliases']).map(hostname), ...addresses];
  });
}

function netlifyRepository(input: unknown): HostRepository {
  const settings = toRecord(input);
  if (settings === undefined) {
    return UNREAD;
  }
  const provider = filled(settings['provider']);
  const address = filled(settings['repo_url']);
  const path = filled(settings['repo_path']);
  if (provider === 'gitlab' || provider === 'bitbucket') {
    return ELSEWHERE;
  }
  if (provider === 'github' && path !== undefined) {
    const [owner, name, ...more] = path.split('/');
    return more.length === 0 ? githubRepository(owner, name) : UNREAD;
  }
  if (address !== undefined) {
    const identity = repositoryIdentity(address);
    if (/^github\.com\/[\w.-]+\/[\w.-]+$/.test(identity)) {
      return { kind: 'github', repository: identity };
    }
    return /^(?:https:\/\/|git@|ssh:\/\/git@)(?:gitlab\.com|bitbucket\.org)[/:]/i.test(address) ? ELSEWHERE : UNREAD;
  }
  // No repository is named. That means none only if nothing else here speaks of one, under this name or another.
  const traces = Object.entries(settings).some(
    ([key, value]) => /repo|git|provider|installation|deploy_key/i.test(key) && typeof value !== 'boolean' && filled(String(value ?? '')) !== undefined,
  );
  return traces ? UNREAD : NOT_CONNECTED;
}

function filled(input: unknown): string | undefined {
  return typeof input === 'string' && input !== '' ? input : undefined;
}
