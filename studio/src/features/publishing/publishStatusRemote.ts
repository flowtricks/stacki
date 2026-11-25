// i18n-ignore-file: server-side diagnostics the Studio server returns as received text; the server has no language provider and the browser shows them as the failure detail (docs/i18n-playbook.md section 3, text from a server).
import { boundedText } from '../updates/catalog';
import { record, string } from '../../shared/validation';
import type { PublishConnection } from '../../shared/publishConnection';

export interface PublishedStatusTree {
  readonly sha: string;
  readonly files: ReadonlyMap<string, { readonly sha: string; readonly mode: string }>;
}

export async function readPublishedStatusTree(connection: PublishConnection, transport: typeof fetch = fetch): Promise<PublishedStatusTree> {
  const base = `https://api.github.com/repos/${connection.repository}`;
  const head = record(await githubJSON(`${base}/git/ref/heads/${encodeURIComponent(connection.branch)}`, connection, transport));
  const sha = statusRevision(record(head['object'])['sha']);
  const tree = await githubJSON(`${base}/git/trees/${sha}?recursive=1`, connection, transport);
  return { sha, files: parsePublishedStatusFiles(tree) };
}

export function parsePublishedStatusFiles(input: unknown): PublishedStatusTree['files'] {
  const value = record(input);
  const entries = value['tree'];
  if (value['truncated'] !== false || !Array.isArray(entries) || entries.length > 100_000) {
    throw new Error('GitHub returned an incomplete publishing tree.');
  }
  const files = new Map<string, { readonly sha: string; readonly mode: string }>();
  for (const input of entries) {
    const entry = record(input);
    if (entry['type'] === 'tree') {
      continue;
    }
    if (entry['type'] !== 'blob' && entry['type'] !== 'commit') {
      throw new Error('Invalid publishing tree entry.');
    }
    const name = string(entry['path'], 500);
    if (name.startsWith('/') || /[\\\x00-\x1f]/.test(name) || name.split('/').some((part) => ['', '.', '..', '.git'].includes(part.toLowerCase()))) {
      throw new Error('Invalid publishing path.');
    }
    const mode = string(entry['mode'], 6);
    if (!['100644', '100755', '120000', '160000'].includes(mode)) {
      throw new Error('Invalid publishing file mode.');
    }
    if (files.has(name)) {
      throw new Error('GitHub returned duplicate publishing paths.');
    }
    files.set(name, { sha: statusRevision(entry['sha']), mode });
  }
  return files;
}

export async function readDeployedStatusRevision(endpoint: string, transport: typeof fetch = fetch): Promise<string> {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Invalid deployment status endpoint.');
  }
  const response = await transport(url, {
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  return statusRevision(record(await statusJSON(response, 1000))['sha']);
}

export function statusRevision(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-f0-9]{40}$/.test(input)) {
    throw new Error('Invalid publishing revision.');
  }
  return input;
}

async function githubJSON(url: string, connection: PublishConnection, transport: typeof fetch) {
  const response = await transport(url, {
    headers: { Authorization: `Bearer ${connection.token}`, Accept: 'application/vnd.github+json' },
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  return statusJSON(response, 32 * 1024 ** 2);
}

async function statusJSON(response: Response, bytesMax: number): Promise<unknown> {
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('Could not read publishing status.');
  }
  const value: unknown = JSON.parse(await boundedText(response, bytesMax));
  return value;
}
