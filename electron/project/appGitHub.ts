// GitHub releases as an app source: one repository's releases, one asset by
// name. Runs in Desktop's main process and on the Studio server, never in a
// renderer. A public repository is read with no credentials; a private one with
// the token of the account the person signed in with for publishing, which is
// sent only to api.github.com and never handed to an app.
//
// A download is held to: the asset's own stated size, APP_LIMITS.archiveBytesMax
// while streaming, redirects only to GitHub's release hosts (at most four, the
// token never following), a deadline, and the SHA-256 digest GitHub publishes
// for the asset when it does.
import { createHash } from 'node:crypto';
import { assert } from '../../shared/core/assert';
import { record, text } from '../../shared/core/boundary';
import { toArray } from '../../shared/core/record';
import { ReferencedError } from '../../shared/properties/i18n/referencedError';
import {
  APP_GITHUB_CHOICE_LIMITS,
  APP_LIMITS,
  rateLimitMessage,
  type AppGitHubSource,
  type AppRelease,
  type AppRepository,
} from '../../shared/properties/apps';

export type GitHubFetch = (url: string, init: RequestInit) => Promise<Response>;

export const APP_GITHUB_LIMITS = {
  /** A release or list JSON reply. */
  replyBytesMax: 4 * 1024 * 1024,
  assetsMax: 200,
  redirectsMax: 4,
  requestMsMax: 30_000,
  /** Pages of 100 repositories the chooser reads. */
  repositoryPagesMax: 3,
  /** Tagged repositories the one search page returns. */
  searchResultsMax: 100,
  /** Owners considered for the search query, before its length limit trims more. */
  searchOwnersMax: 300,
  /** GitHub allows twenty topics a repository; more is a malformed reply. */
  topicsMax: 20,
} as const satisfies Record<string, number>;

const API_ORIGIN = 'https://api.github.com';
// Where a release asset's download may lead: GitHub, then its release storage.
const DOWNLOAD_HOSTS: ReadonlySet<string> = new Set(['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

export interface ReleaseAsset {
  readonly tag: string;
  readonly name: string;
  readonly sizeBytes: number;
  /** The API address of the asset: it downloads private assets too, with a token. */
  readonly url: string;
  /** Lowercase hex SHA-256, when GitHub published one. */
  readonly sha256: string | undefined;
}

export interface DownloadedAsset {
  readonly asset: ReleaseAsset;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

/** The named asset of a release: the latest, or the one tagged `tag`. Throws with a reason a person can act on. */
export async function releaseAsset(
  fetcher: GitHubFetch,
  source: AppGitHubSource,
  options: { readonly tag?: string | undefined; readonly token?: string | undefined },
): Promise<ReleaseAsset> {
  const repository = `${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}`;
  const which = options.tag === undefined ? 'latest' : `tags/${encodeURIComponent(options.tag)}`;
  const response = await apiGet(fetcher, `${API_ORIGIN}/repos/${repository}/releases/${which}`, options.token);
  if (response.status === 404) {
    throw new ReferencedError('apps.error.gitHubNoRelease', { repository: `${source.owner}/${source.repository}` });
  }
  if (!response.ok) {
    throw new ReferencedError('apps.error.gitHubAnsweredRelease', { status: response.status, repository: `${source.owner}/${source.repository}` });
  }
  const release = record(await readJSON(response));
  const tag = text(release['tag_name']);
  if (tag.length === 0 || tag.length > APP_LIMITS.tagCharsMax) {
    throw new ReferencedError('apps.error.releaseNoTag');
  }
  const assets = toArray(release['assets']) ?? [];
  if (assets.length > APP_GITHUB_LIMITS.assetsMax) {
    throw new ReferencedError('apps.error.releaseTooManyAssets');
  }
  const found = assets.map((asset) => record(asset)).find((asset) => asset['name'] === source.asset);
  if (found === undefined) {
    throw new ReferencedError('apps.error.releaseNoAsset', { tag, asset: source.asset });
  }
  return parseAsset(found, tag, source);
}

/** The repository's releases, newest first as GitHub lists them, for the chooser. */
export async function listReleases(fetcher: GitHubFetch, owner: string, repository: string, token: string | undefined): Promise<readonly AppRelease[]> {
  const url = `${API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/releases?per_page=${APP_GITHUB_CHOICE_LIMITS.releasesMax}`;
  const response = await apiGet(fetcher, url, token);
  if (response.status === 404) {
    throw new ReferencedError('apps.error.repositoryNotFound', { repository: `${owner}/${repository}` });
  }
  if (!response.ok) {
    throw new ReferencedError('apps.error.gitHubAnsweredReleases', { status: response.status, repository: `${owner}/${repository}` });
  }
  const items = toArray(await readJSON(response)) ?? [];
  const releases = items.slice(0, APP_GITHUB_CHOICE_LIMITS.releasesMax).flatMap((item) => {
    const release = record(item);
    if (release['draft'] === true) {
      return [];
    }
    const assets = (toArray(release['assets']) ?? []).slice(0, APP_GITHUB_CHOICE_LIMITS.assetsMax).map((asset) => {
      const fields = record(asset);
      return { name: text(fields['name']), sizeBytes: typeof fields['size'] === 'number' ? fields['size'] : 0 };
    });
    return [
      {
        tag: text(release['tag_name']),
        name: typeof release['name'] === 'string' ? release['name'] : '',
        publishedAt: text(release['published_at'] ?? release['created_at']),
        prerelease: release['prerelease'] === true,
        assets,
      },
    ];
  });
  assert(releases.length <= APP_GITHUB_CHOICE_LIMITS.releasesMax, 'Releases are bounded');
  return releases;
}

/**
 * Whether a repository is private, as GitHub says (`GET /repos/{owner}/{repo}`).
 * Without a token GitHub answers 404 for a private repository, so an answer
 * read anonymously is only ever "public". Throws on any other reply.
 */
export async function repositoryVisibility(fetcher: GitHubFetch, owner: string, repository: string, token: string | undefined): Promise<'private' | 'public'> {
  const url = `${API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  const response = await apiGet(fetcher, url, token);
  if (!response.ok) {
    throw new ReferencedError('apps.error.gitHubAnsweredRepository', { status: response.status, repository: `${owner}/${repository}` });
  }
  const isPrivate = record(await readJSON(response))['private'];
  if (typeof isPrivate !== 'boolean') {
    throw new ReferencedError('apps.error.privateUnknown', { repository: `${owner}/${repository}` });
  }
  return isPrivate ? 'private' : 'public';
}

/** The GitHub topic that marks a repository as holding a Stacki app (docs/apps.md, Publishing). */
export const STACKI_APP_TOPIC = 'stacki-app';
/** GitHub refuses a search query longer than this. */
const SEARCH_QUERY_CHARS_MAX = 256;

/** An owner the chooser searches for tagged repositories: the account itself, or one of its organizations. */
export interface RepositoryOwner {
  readonly login: string;
  readonly kind: 'user' | 'organization';
}

/**
 * The search query for the account's Stacki app repositories: the topic, then a
 * `user:` or `org:` qualifier per owner (GitHub ORs repeated qualifiers). Owners
 * are added in order while the query fits GitHub's length limit; the ones left
 * out are still caught by the topics each listed repository carries.
 */
export function stackiAppSearchQuery(owners: readonly RepositoryOwner[]): string {
  assert(owners.length > 0, 'A tagged-repository search names at least one owner');
  let query = `topic:${STACKI_APP_TOPIC}`;
  const seen = new Set<string>();
  for (const owner of owners.slice(0, APP_GITHUB_LIMITS.searchOwnersMax)) {
    assert(owner.login.length > 0, 'An owner login is never empty');
    const key = owner.login.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const next = `${query} ${owner.kind === 'user' ? 'user' : 'org'}:${owner.login}`;
    if (next.length <= SEARCH_QUERY_CHARS_MAX) {
      query = next;
    }
  }
  assert(query.length <= SEARCH_QUERY_CHARS_MAX, 'The search query fits GitHub’s limit');
  return query;
}

/**
 * The repositories a signed-in account can read (its own, its collaborations and
 * its organizations'), each marked `stackiApp` when it carries the `stacki-app`
 * topic. The topic comes from a repository search over the account and its
 * organizations, sorted by update, which sees private repositories the token can
 * read; the topics `/user/repos` returns mark the rest. A tagged repository the
 * search finds outside the listing is added to it.
 */
export async function listRepositories(fetcher: GitHubFetch, token: string, login: string): Promise<readonly AppRepository[]> {
  assert(login.length > 0, 'The account login is known');
  const listed = await listAccountRepositories(fetcher, token);
  const owners: RepositoryOwner[] = [{ login, kind: 'user' }];
  for (const entry of listed) {
    if (entry.ownerKind === 'organization') {
      owners.push({ login: entry.repository.owner, kind: 'organization' });
    }
  }
  const tagged = await searchStackiApps(fetcher, token, stackiAppSearchQuery(owners));
  const keyOf = (repository: AppRepository) => `${repository.owner}/${repository.name}`.toLowerCase();
  const taggedKeys = new Set(tagged.map(keyOf));
  const repositories: AppRepository[] = listed.map((entry) =>
    taggedKeys.has(keyOf(entry.repository)) ? { ...entry.repository, stackiApp: true } : entry.repository,
  );
  const listedKeys = new Set(repositories.map(keyOf));
  for (const repository of tagged) {
    if (repositories.length < APP_GITHUB_CHOICE_LIMITS.repositoriesMax) {
      if (!listedKeys.has(keyOf(repository))) {
        repositories.push(repository);
      }
    }
  }
  assert(repositories.length <= APP_GITHUB_CHOICE_LIMITS.repositoriesMax, 'Repositories are bounded');
  assert(repositories.length >= listed.length, 'Marking keeps every listed repository');
  return repositories;
}

interface ListedRepository {
  readonly repository: AppRepository;
  readonly ownerKind: RepositoryOwner['kind'];
}

async function listAccountRepositories(fetcher: GitHubFetch, token: string): Promise<readonly ListedRepository[]> {
  const repositories: ListedRepository[] = [];
  for (let page = 1; page <= APP_GITHUB_LIMITS.repositoryPagesMax; page += 1) {
    const url = `${API_ORIGIN}/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`;
    const response = await apiGet(fetcher, url, token);
    if (!response.ok) {
      const limited = rateLimitReset(response);
      if (limited !== undefined) {
        throw new Error(rateLimitMessage(limited.resetAtMs));
      }
      throw new ReferencedError('apps.error.gitHubAnsweredAccountRepositories', { status: response.status });
    }
    const items = toArray(await readJSON(response)) ?? [];
    for (const item of items.slice(0, 100)) {
      const value = record(item);
      const owner = record(value['owner']);
      repositories.push({ repository: repositoryOf(value), ownerKind: owner['type'] === 'Organization' ? 'organization' : 'user' });
    }
    if (items.length < 100) {
      break;
    }
  }
  assert(repositories.length <= APP_GITHUB_CHOICE_LIMITS.repositoriesMax, 'Listed repositories are bounded');
  return repositories;
}

/** One page of tagged repositories. A refused search (rate limit, an unreadable org) falls back to the listing's own topics. */
async function searchStackiApps(fetcher: GitHubFetch, token: string, query: string): Promise<readonly AppRepository[]> {
  assert(query.startsWith(`topic:${STACKI_APP_TOPIC}`), 'The search is for the Stacki app topic');
  const url = `${API_ORIGIN}/search/repositories?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=${APP_GITHUB_LIMITS.searchResultsMax}`;
  const response = await apiGet(fetcher, url, token);
  if (!response.ok) {
    return [];
  }
  const items = toArray(record(await readJSON(response))['items']) ?? [];
  const found = items.slice(0, APP_GITHUB_LIMITS.searchResultsMax).map((item) => ({ ...repositoryOf(record(item)), stackiApp: true }));
  assert(found.length <= APP_GITHUB_LIMITS.searchResultsMax, 'Search results are bounded');
  return found;
}

/**
 * Whether a refusal is GitHub's rate limit, and when it lifts: a 429, or a 403
 * with no requests remaining. The reset comes from `x-ratelimit-reset` (epoch
 * seconds) or `retry-after` (seconds from now); undefined when neither is sane.
 */
export function rateLimitReset(
  response: Pick<Response, 'status' | 'headers'>,
  nowMs: number = Date.now(),
): { readonly resetAtMs: number | undefined } | undefined {
  // A 403 is also a plain refusal (no access); only one with nothing remaining is the limit.
  const limited = response.status === 429 ? true : response.status === 403 ? response.headers.get('x-ratelimit-remaining') === '0' : false;
  if (limited) {
    const resetSeconds = Number(response.headers.get('x-ratelimit-reset') ?? Number.NaN);
    if (Number.isSafeInteger(resetSeconds) && resetSeconds > 0) {
      return { resetAtMs: resetSeconds * 1000 };
    }
    const retrySeconds = Number(response.headers.get('retry-after') ?? Number.NaN);
    if (Number.isSafeInteger(retrySeconds) && retrySeconds >= 0) {
      return { resetAtMs: nowMs + retrySeconds * 1000 };
    }
    return { resetAtMs: undefined };
  }
  return undefined;
}

function repositoryOf(value: Readonly<Record<string, unknown>>): AppRepository {
  const topics = toArray(value['topics']) ?? [];
  return {
    owner: text(record(value['owner'])['login']),
    name: text(value['name']),
    private: value['private'] === true,
    updatedAt: text(value['pushed_at'] ?? value['updated_at']),
    stackiApp: topics.slice(0, APP_GITHUB_LIMITS.topicsMax).includes(STACKI_APP_TOPIC),
    organization: record(value['owner'])['type'] === 'Organization',
  };
}

function apiGet(fetcher: GitHubFetch, url: string, token: string | undefined): Promise<Response> {
  assert(url.startsWith(`${API_ORIGIN}/`), 'Only GitHub’s API is read with a token');
  return fetcher(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      // i18n-ignore: HTTP header value or request path, protocol text.
      'User-Agent': 'Stacki',
      // i18n-ignore: HTTP header value or request path, protocol text.
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(APP_GITHUB_LIMITS.requestMsMax),
  });
}

async function readJSON(response: Response): Promise<unknown> {
  const body = await readBounded(response, APP_GITHUB_LIMITS.replyBytesMax);
  const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
  return parsed;
}

function parseAsset(asset: Readonly<Record<string, unknown>>, tag: string, source: AppGitHubSource): ReleaseAsset {
  const sizeBytes = asset['size'];
  if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new ReferencedError('apps.error.assetNoSize');
  }
  if (sizeBytes > APP_LIMITS.archiveBytesMax) {
    throw new ReferencedError('apps.error.assetTooBig', { asset: source.asset, bytes: sizeBytes, max: APP_LIMITS.archiveBytesMax });
  }
  const url = text(asset['url']);
  const expected = `${API_ORIGIN}/repos/${source.owner}/${source.repository}/releases/assets/`;
  if (!url.toLowerCase().startsWith(expected.toLowerCase())) {
    throw new ReferencedError('apps.error.assetWrongRepository');
  }
  const digest = asset['digest'];
  let sha256: string | undefined;
  if (typeof digest === 'string' && digest.startsWith('sha256:')) {
    sha256 = digest.slice('sha256:'.length).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new ReferencedError('apps.error.digestMalformed');
    }
  }
  return { tag, name: source.asset, sizeBytes, url, sha256 };
}

/** Downloads an asset, following GitHub's redirects only, and checks its size and digest. The token goes to the API only. */
export async function downloadReleaseAsset(fetcher: GitHubFetch, asset: ReleaseAsset, token: string | undefined): Promise<DownloadedAsset> {
  let url = asset.url;
  for (let hop = 0; hop <= APP_GITHUB_LIMITS.redirectsMax; hop += 1) {
    const host = assertDownloadHost(url);
    // i18n-ignore: HTTP header value or request path, protocol text.
    const authorization = token !== undefined && host === 'api.github.com' ? { Authorization: `Bearer ${token}` } : {};
    const response = await fetcher(url, {
      // i18n-ignore: HTTP header value or request path, protocol text.
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'Stacki', ...authorization },
      redirect: 'manual',
      signal: AbortSignal.timeout(APP_GITHUB_LIMITS.requestMsMax),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location') ?? undefined;
      if (location === undefined) {
        throw new ReferencedError('apps.error.downloadRedirectNowhere');
      }
      url = new URL(location, url).toString();
      continue;
    }
    if (!response.ok) {
      throw new ReferencedError('apps.error.downloadStatus', { status: response.status });
    }
    const bytes = await readBounded(response, asset.sizeBytes);
    if (bytes.byteLength !== asset.sizeBytes) {
      throw new ReferencedError('apps.error.downloadSizeMismatch', { actual: bytes.byteLength, expected: asset.sizeBytes });
    }
    const sha256 = sha256Hex(bytes);
    if (asset.sha256 !== undefined && asset.sha256 !== sha256) {
      throw new ReferencedError('apps.error.downloadDigestMismatch');
    }
    return { asset, bytes, sha256 };
  }
  throw new ReferencedError('apps.error.downloadRedirectedTooMany');
}

function assertDownloadHost(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new ReferencedError('apps.error.downloadHTTPSOnly');
  }
  if (!DOWNLOAD_HOSTS.has(parsed.hostname)) {
    throw new ReferencedError('apps.error.downloadNotGitHub', { host: parsed.hostname });
  }
  assert(parsed.username === '', 'A download URL carries no credentials');
  return parsed.hostname;
}

/** The response body, refused past `bytesMax` while it streams. */
export async function readBounded(response: Response, bytesMax: number): Promise<Uint8Array> {
  const stated = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(stated) && stated > bytesMax) {
    throw new ReferencedError('apps.error.responseTooLarge', { max: bytesMax });
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return new Uint8Array(0);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Every chunk carries at least one byte, so bytesMax + 1 reads always reach the end or the bound.
  for (let reads = 0; reads <= bytesMax + 1; reads += 1) {
    const read: unknown = await reader.read();
    const result = record(read);
    if (result['done'] === true) {
      break;
    }
    const chunk = result['value'];
    if (!(chunk instanceof Uint8Array)) {
      throw new ReferencedError('apps.error.responseNotBytes');
    }
    total += chunk.byteLength;
    if (total > bytesMax) {
      await reader.cancel();
      throw new ReferencedError('apps.error.responseTooLarge', { max: bytesMax });
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  assert(offset === total, 'Every chunk was copied');
  return bytes;
}

export function sha256Hex(bytes: Uint8Array): string {
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert(digest.length === 64, 'A SHA-256 is 64 hex characters');
  return digest;
}
