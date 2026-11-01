import { record, text } from '../../shared/core/boundary';
import {
  discoveryList,
  discoveryIdentifier,
  discoveryLabel,
  DISCOVERY_LIMITS,
  type PublishAccount,
  type PublishProject,
} from '../../shared/properties/publishDiscovery';
import { discoveryCommand } from './publishDiscoveryCommand';

// Pages uses ten entries per page, matching Wrangler's own project listing.
const PROJECTS_PER_PAGE = 10;
const PROJECT_PAGES_MAX = Math.ceil(DISCOVERY_LIMITS.itemsMax / PROJECTS_PER_PAGE);

export async function cloudflareAccounts(root: string): Promise<readonly PublishAccount[]> {
  const user = record(await discoveryCommand(root, 'wrangler', ['whoami', '--json']));
  return discoveryList(user['accounts']).map((entry) => {
    const value = record(entry);
    return { id: discoveryIdentifier(value['id']), name: discoveryLabel(value['name']) };
  });
}

export async function cloudflareProjects(root: string, account: string): Promise<readonly PublishProject[]> {
  const credentials = record(await discoveryCommand(root, 'wrangler', ['auth', 'token', '--json']));
  const headers = cloudflareHeaders(credentials);
  const projects: PublishProject[] = [];
  for (let page = 1; page <= PROJECT_PAGES_MAX; page++) {
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects`;
    const result = record(await cloudflareRequest(`${endpoint}?per_page=${PROJECTS_PER_PAGE}&page=${page}`, headers));
    if (result['success'] !== true) {
      throw new Error('Cloudflare could not list Pages projects. Check account permissions.');
    }
    const values = discoveryList(result['result']);
    projects.push(...values.map((value) => parseCloudflareProject(value, account)));
    discoveryList(projects);
    const info = result['result_info'];
    if (info !== undefined) {
      const pages = record(info)['total_pages'];
      if (typeof pages === 'number' && Number.isSafeInteger(pages) && pages <= page) {
        return projects;
      }
    }
    if (values.length < PROJECTS_PER_PAGE) {
      return projects;
    }
  }
  throw new Error('Cloudflare has too many projects to list. Use manual configuration.');
}

export function parseCloudflareProject(input: unknown, account: string): PublishProject {
  const value = record(input);
  const name = discoveryIdentifier(value['name']);
  const build = record(value['build_config'] ?? {});
  return {
    name,
    hosting: {
      provider: 'cloudflare',
      accountId: discoveryIdentifier(account),
      project: name,
      branch: text(value['production_branch']),
      directory: text(build['destination_dir'] || 'dist').replace(/^\.\//, ''),
    },
  };
}

export function cloudflareHeaders(credentials: Record<string, unknown>): Readonly<Record<string, string>> {
  if (credentials['type'] === 'api_key') {
    return {
      'X-Auth-Key': credential(credentials['key']),
      'X-Auth-Email': credential(credentials['email']),
    };
  }
  if (credentials['type'] !== 'oauth' && credentials['type'] !== 'api_token') {
    throw new Error('Unsupported Cloudflare authentication. Sign in with wrangler login.');
  }
  return { Authorization: `Bearer ${credential(credentials['token'])}` };
}
function credential(input: unknown): string {
  const value = text(input);
  if (!/^[\x21-\x7e]{1,8192}$/.test(value)) {
    throw new Error('Invalid Cloudflare credential. Sign in again.');
  }
  return value;
}

export async function cloudflareRequest(url: string, headers: Readonly<Record<string, string>>) {
  const response = await fetch(url, {
    method: 'GET',
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(DISCOVERY_LIMITS.timeoutMs),
  });
  if (!response.ok || !response.body) {
    throw new Error('Cloudflare could not list projects. Check your sign-in and connection.');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (let count = 0; count < 8192; count++) {
      const part = await reader.read();
      if (part.done) {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return value;
      }
      const chunk: unknown = part.value;
      if (!(chunk instanceof Uint8Array)) {
        throw new Error('Invalid Cloudflare response stream.');
      }
      bytes += chunk.byteLength;
      if (bytes > 1_048_576) {
        throw new Error('Cloudflare response exceeds 1 MiB.');
      }
      chunks.push(chunk);
    }
    throw new Error('Cloudflare response exceeds the stream limit.');
  } finally {
    await reader.cancel();
  }
}

export async function cloudflareWorkers(root: string, account: string): Promise<readonly PublishProject[]> {
  const credentials = record(await discoveryCommand(root, 'wrangler', ['auth', 'token', '--json']));
  const result = record(await cloudflareRequest(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts`, cloudflareHeaders(credentials)));
  if (result['success'] !== true) {
    throw new Error('Cloudflare could not list Workers. Check account permissions.');
  }
  return discoveryList(result['result']).map((input) => {
    const name = discoveryIdentifier(record(input)['id']);
    return { name, hosting: { provider: 'cloudflare-workers', accountId: account, project: name } };
  });
}
