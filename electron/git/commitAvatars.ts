// Which GitHub user wrote each commit, for the history panel's author pictures.
//
// Resolution, cheapest first: a cached answer for the commit, a cached picture for the
// author's email, a GitHub noreply address (no request at all), and only then one GraphQL
// query for the remaining commits of the page. The query runs only for a repository whose
// remote is on github.com and only with the app's existing GitHub credential; any other
// remote, a missing credential, a refusal, or a rate limit leaves those commits without a
// picture, and the panel shows initials. Nothing here throws for an operating failure:
// avatars are decoration, so every failure is quiet and bounded in time.
//
// Desktop main and the Studio server share this module; each supplies its own fetch,
// repository and credential.
import { assert } from '../../shared/core/assert';
import { toRecord } from '../../shared/core/record';
import {
  COMMIT_AVATAR_LIMITS,
  githubNoreplyAvatar,
  parseAvatarURL,
  parseCommitHash,
  type CommitAvatar,
  type CommitAvatarCommit,
  type CommitAvatarResult,
} from '../../shared/ipc/commitAvatars';

export const COMMIT_AVATAR_RESOLVER_LIMITS = {
  /** Commits and emails remembered; the oldest answer is forgotten first. */
  cacheEntriesMax: 2_000,
  /** Repositories with a remembered refusal or rate limit. */
  repositoriesMax: 64,
  responseBytesMax: 1_000_000,
  /** How long a refusal, failure or rate limit with no reset time silences a repository. */
  backoffMsDefault: 15 * 60_000,
  backoffMsMax: 60 * 60_000,
  timeoutMs: 10_000,
} as const;

const GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';

export interface CommitAvatarLookup {
  /** `owner/name` on github.com, or undefined for any other remote (no request is made). */
  readonly repository: () => Promise<string | undefined>;
  /** The app's existing GitHub credential, read only when a request is needed. */
  readonly token: () => Promise<string | undefined>;
  readonly commits: readonly CommitAvatarCommit[];
}

export interface CommitAvatarResolver {
  readonly resolve: (lookup: CommitAvatarLookup) => Promise<CommitAvatarResult>;
}

/** The `owner/name` of a github.com remote URL, or undefined for any other host. */
export function githubRepositoryFromRemote(remote: string | undefined): string | undefined {
  if (remote === undefined) {
    return undefined;
  }
  const value = remote.trim();
  if (value.length > 500) {
    return undefined;
  }
  const match =
    /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::22)?\/|git@github\.com:)([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([\w.-]{1,100}?)(?:\.git)?\/?$/.exec(
      value,
    );
  if (match === null) {
    return undefined;
  }
  const owner = match[1];
  const name = match[2];
  assert(owner !== undefined, 'Commit avatars: remote pattern captures an owner');
  assert(name !== undefined, 'Commit avatars: remote pattern captures a name');
  if (name === '.' || name === '..') {
    return undefined;
  }
  return `${owner}/${name}`;
}

export function createCommitAvatarResolver(options: { readonly fetch: typeof fetch; readonly now: () => number }): CommitAvatarResolver {
  // An absent picture is cached too (`undefined`), so a commit by someone with no
  // GitHub account is asked about once, not on every refresh.
  const byHash = new Map<string, string | undefined>();
  const byEmail = new Map<string, string>();
  const silencedUntil = new Map<string, number>();
  const resolve = async (lookup: CommitAvatarLookup): Promise<CommitAvatarResult> => {
    assert(lookup.commits.length <= COMMIT_AVATAR_LIMITS.commitsMax, 'Commit avatars: request exceeds its bound');
    const found = new Map<string, string>();
    const pending: CommitAvatarCommit[] = [];
    for (const commit of lookup.commits) {
      const known = knownAvatar(commit, byHash, byEmail);
      if (known.kind === 'found') {
        found.set(commit.hash, known.url);
      } else if (known.kind === 'unknown') {
        pending.push(commit);
      }
    }
    if (pending.length === 0) {
      return avatarList(found);
    }
    const repository = await lookup.repository();
    if (repository === undefined) {
      return avatarList(found);
    }
    const until = silencedUntil.get(repository);
    if (until !== undefined) {
      if (options.now() < until) {
        return avatarList(found);
      }
      silencedUntil.delete(repository);
    }
    const token = await lookup.token();
    if (token === undefined) {
      return avatarList(found);
    }
    const answer = await queryCommitAuthors({ fetch: options.fetch, now: options.now, repository, token, commits: pending });
    switch (answer.kind) {
      case 'authors': {
        for (const commit of pending) {
          const url = answer.authors.get(commit.hash);
          remember(byHash, COMMIT_AVATAR_RESOLVER_LIMITS.cacheEntriesMax, commit.hash, url);
          if (url !== undefined) {
            remember(byEmail, COMMIT_AVATAR_RESOLVER_LIMITS.cacheEntriesMax, emailKey(commit.email), url);
            found.set(commit.hash, url);
          }
        }
        if (answer.silenceUntil !== undefined) {
          remember(silencedUntil, COMMIT_AVATAR_RESOLVER_LIMITS.repositoriesMax, repository, answer.silenceUntil);
        }
        break;
      }
      case 'silenced':
        remember(silencedUntil, COMMIT_AVATAR_RESOLVER_LIMITS.repositoriesMax, repository, answer.until);
        break;
      default: {
        const exhaustive: never = answer;
        return exhaustive;
      }
    }
    assert(byHash.size <= COMMIT_AVATAR_RESOLVER_LIMITS.cacheEntriesMax, 'Commit avatars: commit cache exceeds its bound');
    assert(byEmail.size <= COMMIT_AVATAR_RESOLVER_LIMITS.cacheEntriesMax, 'Commit avatars: email cache exceeds its bound');
    return avatarList(found);
  };
  return { resolve };
}

type KnownAvatar = { readonly kind: 'found'; readonly url: string } | { readonly kind: 'none' } | { readonly kind: 'unknown' };

function knownAvatar(commit: CommitAvatarCommit, byHash: ReadonlyMap<string, string | undefined>, byEmail: ReadonlyMap<string, string>): KnownAvatar {
  const noreply = githubNoreplyAvatar(commit.email);
  if (noreply !== undefined) {
    return { kind: 'found', url: noreply };
  }
  if (byHash.has(commit.hash)) {
    const url = byHash.get(commit.hash);
    return url === undefined ? { kind: 'none' } : { kind: 'found', url };
  }
  const url = byEmail.get(emailKey(commit.email));
  return url === undefined ? { kind: 'unknown' } : { kind: 'found', url };
}

type AuthorsAnswer =
  | { readonly kind: 'authors'; readonly authors: ReadonlyMap<string, string>; readonly silenceUntil: number | undefined }
  | { readonly kind: 'silenced'; readonly until: number };

async function queryCommitAuthors(input: {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly repository: string;
  readonly token: string;
  readonly commits: readonly CommitAvatarCommit[];
}): Promise<AuthorsAnswer> {
  assert(input.commits.length > 0, 'Commit avatars: a query names at least one commit');
  assert(input.commits.length <= COMMIT_AVATAR_LIMITS.commitsMax, 'Commit avatars: a query names a bounded page');
  const [owner, name] = input.repository.split('/');
  assert(owner !== undefined, 'Commit avatars: repository has an owner');
  assert(name !== undefined, 'Commit avatars: repository has a name');
  const fallback = { kind: 'silenced', until: input.now() + COMMIT_AVATAR_RESOLVER_LIMITS.backoffMsDefault } as const;
  let response: Response;
  try {
    response = await input.fetch(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        // i18n-ignore: HTTP header, not shown to a person.
        Authorization: `Bearer ${input.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        // i18n-ignore: HTTP User-Agent, not shown to a person.
        'User-Agent': 'Stacki',
      },
      body: JSON.stringify({ query: commitAuthorsQuery(input.commits), variables: { owner, name } }),
      redirect: 'error',
      signal: AbortSignal.timeout(COMMIT_AVATAR_RESOLVER_LIMITS.timeoutMs),
    });
  } catch {
    return fallback;
  }
  const limitedUntil = rateLimitUntil(response.headers, input.now());
  if (response.status === 403 || response.status === 429) {
    return { kind: 'silenced', until: limitedUntil ?? fallback.until };
  }
  if (!response.ok) {
    return fallback;
  }
  const body = await readBoundedJSON(response, COMMIT_AVATAR_RESOLVER_LIMITS.responseBytesMax);
  if (body === undefined) {
    return fallback;
  }
  return parseCommitAuthors(body, input.commits, limitedUntil, fallback.until);
}

function commitAuthorsQuery(commits: readonly CommitAvatarCommit[]): string {
  // Each hash passed parseCommitHash at the boundary, so it is plain hexadecimal and
  // safe to splice; owner and name travel as variables.
  const fields = commits.map(
    (commit, index) =>
      `c${index}: object(oid: "${parseCommitHash(commit.hash)}") { ... on Commit { author { user { avatarUrl(size: ${COMMIT_AVATAR_LIMITS.sizePixels}) } } } }`,
  );
  return `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields.join(' ')} } }`;
}

function parseCommitAuthors(body: unknown, commits: readonly CommitAvatarCommit[], limitedUntil: number | undefined, fallbackUntil: number): AuthorsAnswer {
  const value = toRecord(body);
  if (value === undefined) {
    return { kind: 'silenced', until: fallbackUntil };
  }
  const errors = value['errors'];
  if (Array.isArray(errors) && errors.some((error: unknown) => toRecord(error)?.['type'] === 'RATE_LIMITED')) {
    return { kind: 'silenced', until: limitedUntil ?? fallbackUntil };
  }
  const repository = toRecord(toRecord(value['data'])?.['repository']);
  if (repository === undefined) {
    // No access, or no such repository: GitHub answers `repository: null`.
    return { kind: 'silenced', until: fallbackUntil };
  }
  const authors = new Map<string, string>();
  commits.forEach((commit, index) => {
    const url = commitAvatarURL(repository[`c${index}`]);
    if (url !== undefined) {
      authors.set(commit.hash, url);
    }
  });
  assert(authors.size <= commits.length, 'Commit avatars: only asked-for commits are answered');
  return { kind: 'authors', authors, silenceUntil: limitedUntil };
}

function commitAvatarURL(input: unknown): string | undefined {
  const user = toRecord(toRecord(toRecord(input)?.['author'])?.['user']);
  const avatar = user?.['avatarUrl'];
  if (avatar === undefined) {
    return undefined;
  }
  try {
    return parseAvatarURL(avatar);
  } catch {
    // A picture on any other host is dropped rather than shown.
    return undefined;
  }
}

/** When GitHub says the budget is spent: `retry-after`, or a reset time with nothing remaining. */
export function rateLimitUntil(headers: Headers, now: number): number | undefined {
  const retryAfter = Number(headers.get('retry-after') ?? Number.NaN);
  if (Number.isFinite(retryAfter)) {
    if (retryAfter >= 0) {
      return now + Math.min(retryAfter * 1000, COMMIT_AVATAR_RESOLVER_LIMITS.backoffMsMax);
    }
  }
  if (headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(headers.get('x-ratelimit-reset') ?? Number.NaN);
    if (Number.isFinite(reset)) {
      return Math.min(Math.max(reset * 1000, now), now + COMMIT_AVATAR_RESOLVER_LIMITS.backoffMsMax);
    }
    return now + COMMIT_AVATAR_RESOLVER_LIMITS.backoffMsDefault;
  }
  return undefined;
}

/** A GitHub API body as unknown JSON, or undefined when it is too large, broken or unreadable. */
export async function readBoundedJSON(response: Response, bytesMax: number): Promise<unknown> {
  assert(bytesMax > 0, 'Commit avatars: a body bound is positive');
  assert(bytesMax <= COMMIT_AVATAR_RESOLVER_LIMITS.responseBytesMax, 'Commit avatars: a body bound stays within the shared limit');
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > bytesMax) {
    return undefined;
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  let sizeBytes = 0;
  try {
    // Each read returns at least one byte, so the byte bound also bounds the loop.
    for (let index = 0; index <= bytesMax; index++) {
      const part = await reader.read();
      if (part.done) {
        const bytes = new Uint8Array(sizeBytes);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
        return parsed;
      }
      const chunk: unknown = part.value;
      if (!(chunk instanceof Uint8Array)) {
        return undefined;
      }
      sizeBytes += chunk.length;
      if (sizeBytes > bytesMax) {
        return undefined;
      }
      chunks.push(chunk);
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Insert as the newest entry, forgetting the oldest once the cache holds `bound` entries. */
export function remember<Key, Value>(cache: Map<Key, Value>, bound: number, key: Key, value: Value): void {
  assert(bound > 0, 'Commit avatars: a cache holds at least one entry');
  cache.delete(key);
  if (cache.size >= bound) {
    const oldest = cache.keys().next();
    if (oldest.done !== true) {
      cache.delete(oldest.value);
    }
  }
  cache.set(key, value);
  assert(cache.size <= bound, 'Commit avatars: cache exceeds its bound');
}

function emailKey(email: string): string {
  return email.trim().toLowerCase();
}

function avatarList(found: ReadonlyMap<string, string>): CommitAvatarResult {
  const avatars: CommitAvatar[] = [...found].map(([hash, url]) => ({ hash, url }));
  assert(avatars.length <= COMMIT_AVATAR_LIMITS.commitsMax, 'Commit avatars: reply exceeds its bound');
  return avatars;
}
