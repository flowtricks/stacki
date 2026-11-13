// GitHub user suggestions for the Roles tab's member picker.
//
// Three sources, likeliest first: the repository's collaborators (one cached request per
// repository), its recent commit authors with GitHub noreply addresses (read from git, no
// request), and GitHub's user search (`/search/users?q=<query>+in:login`). Only the typed
// query is sent to the search; the collaborator list is asked for without it. Search answers
// are cached per query, and a rate limit, refusal or network failure silences the search
// until GitHub's reset time: the picker then shows the local matches and a quiet "Can't
// search GitHub right now" row. Nothing here throws for an operating failure.
//
// Desktop main and the Studio server share this module; each supplies its own fetch,
// repository, credential and commit authors.
import { assert } from '../../shared/core/assert';
import { toArray, toRecord } from '../../shared/core/record';
import { githubNoreplyAvatar, parseAvatarURL } from '../../shared/ipc/commitAvatars';
import {
  GITHUB_USER_SEARCH_LIMITS,
  type GitHubSearchState,
  type GitHubUserSearchResult,
  type GitHubUserSource,
  type GitHubUserSuggestion,
} from '../../shared/ipc/githubUserSearch';
import { parseGitHubLogin, parseGitHubLoginQuery } from '../../shared/properties/projectRoles';
import { readBoundedJSON, rateLimitUntil, remember } from './commitAvatars';

export const GITHUB_USER_SEARCH_RESOLVER_LIMITS = {
  /** Search answers remembered, one per query; the oldest is forgotten first. */
  queriesMax: 256,
  queryCacheMs: 10 * 60_000,
  /** Repositories whose collaborators are remembered. */
  repositoriesMax: 16,
  collaboratorCacheMs: 10 * 60_000,
  /** One page of collaborators; a larger team is still found through the search. */
  collaboratorsMax: 100,
  /** Items accepted from one search page (GitHub's own page maximum). */
  searchItemsMax: 100,
  /** Commit authors considered; the caller reads at most this many recent commits. */
  authorsMax: 200,
  responseBytesMax: 1_000_000,
  /** How long a failure with no reset time silences the search. GitHub's search budget resets each minute. */
  backoffMsDefault: 60_000,
  timeoutMs: 8_000,
} as const satisfies Record<string, number>;

const API_ORIGIN = 'https://api.github.com';

/** A GitHub account as the REST API lists it. */
export interface GitHubAccount {
  readonly login: string;
  readonly avatarURL: string | undefined;
}

/** A commit's author as git records it. */
export interface GitHubCommitAuthor {
  readonly name: string;
  readonly email: string;
}

export interface GitHubUserSearchLookup {
  /** Already parsed by `parseGitHubLoginQuery`. */
  readonly query: string;
  /** `owner/name` on github.com, or undefined for any other remote (no collaborator request). */
  readonly repository: () => Promise<string | undefined>;
  /** The app's existing GitHub credential, or undefined to search without one. */
  readonly token: () => Promise<string | undefined>;
  /** Recent commit authors, newest first. */
  readonly authors: () => Promise<readonly GitHubCommitAuthor[]>;
}

export interface GitHubUserSearch {
  readonly search: (lookup: GitHubUserSearchLookup) => Promise<GitHubUserSearchResult>;
}

/** The items of a `/search/users` answer: users only (organizations cannot be members). */
export function parseGitHubUserSearchResponse(input: unknown): readonly GitHubAccount[] {
  const value = toRecord(input);
  if (value === undefined) {
    throw new Error('GitHub user search: expected an object');
  }
  const total = value['total_count'];
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) {
    throw new Error('GitHub user search: expected a total count');
  }
  const items = toArray(value['items']);
  if (items === undefined) {
    throw new Error('GitHub user search: expected items');
  }
  if (items.length > GITHUB_USER_SEARCH_RESOLVER_LIMITS.searchItemsMax) {
    throw new Error('GitHub user search: too many items');
  }
  return parseAccounts(items);
}

/** A `/repos/{owner}/{name}/collaborators` page. */
export function parseGitHubCollaboratorsResponse(input: unknown): readonly GitHubAccount[] {
  const items = toArray(input);
  if (items === undefined) {
    throw new Error('GitHub collaborators: expected a list');
  }
  if (items.length > GITHUB_USER_SEARCH_RESOLVER_LIMITS.collaboratorsMax) {
    throw new Error('GitHub collaborators: too many items');
  }
  return parseAccounts(items);
}

/** The login a GitHub noreply address names (`12345+login@…` or `login@…`), or undefined. */
export function githubNoreplyLogin(email: string): string | undefined {
  if (githubNoreplyAvatar(email) === undefined) {
    return undefined;
  }
  const match = /^(?:\d{1,12}\+)?([^@\s]+)@users\.noreply\.github\.com$/i.exec(email.trim());
  assert(match !== null, 'GitHub user search: a noreply address matches its own pattern');
  try {
    return parseGitHubLogin(match[1]);
  } catch {
    // A bot (`name[bot]`) has a picture but no login a role can name.
    return undefined;
  }
}

export function createGitHubUserSearch(options: { readonly fetch: typeof fetch; readonly now: () => number }): GitHubUserSearch {
  const answers = new Map<string, { readonly accounts: readonly GitHubAccount[]; readonly until: number }>();
  const collaborators = new Map<string, { readonly accounts: readonly GitHubAccount[]; readonly until: number }>();
  let silencedUntil = 0;
  const search = async (lookup: GitHubUserSearchLookup): Promise<GitHubUserSearchResult> => {
    const query = parseGitHubLoginQuery(lookup.query);
    assert(query === lookup.query, 'GitHub user search: the query arrives parsed');
    // The credential is read at most once per search, and only when a request needs it.
    let token: Promise<string | undefined> | undefined;
    const credential = () => (token ??= lookup.token().catch(() => undefined));
    const [local, remote] = await Promise.all([
      localCandidates(lookup, query, credential),
      (async (): Promise<RemoteAnswer> => {
        const key = query.toLowerCase();
        const cached = answers.get(key);
        if (cached !== undefined) {
          if (options.now() < cached.until) {
            return { kind: 'accounts', accounts: cached.accounts };
          }
          answers.delete(key);
        }
        if (options.now() < silencedUntil) {
          return { kind: 'silenced', until: silencedUntil };
        }
        const url = `${API_ORIGIN}/search/users?q=${encodeURIComponent(query)}+in:login&per_page=${GITHUB_USER_SEARCH_LIMITS.usersMax}`;
        const answer = await requestAccounts(options, url, await credential(), parseGitHubUserSearchResponse);
        if (answer.kind === 'accounts') {
          remember(answers, GITHUB_USER_SEARCH_RESOLVER_LIMITS.queriesMax, key, {
            accounts: answer.accounts,
            until: options.now() + GITHUB_USER_SEARCH_RESOLVER_LIMITS.queryCacheMs,
          });
        } else {
          silencedUntil = answer.until;
        }
        return answer;
      })(),
    ]);
    assert(answers.size <= GITHUB_USER_SEARCH_RESOLVER_LIMITS.queriesMax, 'GitHub user search: query cache exceeds its bound');
    return rankSuggestions(query, local, remote);
  };

  const localCandidates = async (
    lookup: GitHubUserSearchLookup,
    query: string,
    credential: () => Promise<string | undefined>,
  ): Promise<readonly GitHubUserSuggestion[]> => {
    const [team, authors] = await Promise.all([repositoryCollaborators(lookup, credential), lookup.authors().catch((): readonly GitHubCommitAuthor[] => [])]);
    const needle = query.toLowerCase();
    const found: GitHubUserSuggestion[] = [];
    for (const account of team) {
      if (account.login.toLowerCase().includes(needle)) {
        found.push({ login: account.login, name: undefined, avatarURL: account.avatarURL, source: 'collaborator' });
      }
    }
    for (const author of authors.slice(0, GITHUB_USER_SEARCH_RESOLVER_LIMITS.authorsMax)) {
      const login = githubNoreplyLogin(author.email);
      if (login !== undefined) {
        if (login.toLowerCase().includes(needle)) {
          const name = author.name.trim().slice(0, GITHUB_USER_SEARCH_LIMITS.nameCharsMax);
          found.push({ login, name: name.length === 0 ? undefined : name, avatarURL: githubNoreplyAvatar(author.email), source: 'author' });
        }
      }
    }
    return found;
  };

  const repositoryCollaborators = async (lookup: GitHubUserSearchLookup, credential: () => Promise<string | undefined>): Promise<readonly GitHubAccount[]> => {
    const repository = await lookup.repository().catch(() => undefined);
    if (repository === undefined) {
      return [];
    }
    const cached = collaborators.get(repository);
    if (cached !== undefined) {
      if (options.now() < cached.until) {
        return cached.accounts;
      }
      collaborators.delete(repository);
    }
    const token = await credential();
    if (token === undefined) {
      // The list is private to the repository's members: without a credential there is nothing to ask.
      return [];
    }
    const url = `${API_ORIGIN}/repos/${repository}/collaborators?per_page=${GITHUB_USER_SEARCH_RESOLVER_LIMITS.collaboratorsMax}`;
    const answer = await requestAccounts(options, url, token, parseGitHubCollaboratorsResponse);
    // A refusal (no push access) is remembered as an empty team for as long as a list would be.
    const accounts = answer.kind === 'accounts' ? answer.accounts : [];
    remember(collaborators, GITHUB_USER_SEARCH_RESOLVER_LIMITS.repositoriesMax, repository, {
      accounts,
      until: Math.max(options.now() + GITHUB_USER_SEARCH_RESOLVER_LIMITS.collaboratorCacheMs, answer.kind === 'silenced' ? answer.until : 0),
    });
    return accounts;
  };

  return { search };
}

type RemoteAnswer = { readonly kind: 'accounts'; readonly accounts: readonly GitHubAccount[] } | { readonly kind: 'silenced'; readonly until: number };

/** Local matches first (prefix before substring, collaborators before authors), then the search; one row per login, at most eight. */
export function rankSuggestions(query: string, local: readonly GitHubUserSuggestion[], remote: RemoteAnswer): GitHubUserSearchResult {
  assert(query.length > 0, 'GitHub user search: a ranking has a query');
  const needle = query.toLowerCase();
  const rank = (user: GitHubUserSuggestion) => (user.login.toLowerCase().startsWith(needle) ? 0 : 2) + (user.source === 'collaborator' ? 0 : 1);
  const ordered = [...local].sort((left, right) => rank(left) - rank(right));
  const searched = remote.kind === 'accounts' ? remote.accounts.map((account) => searchSuggestion(account, 'search')) : [];
  const users: GitHubUserSuggestion[] = [];
  const seen = new Map<string, number>();
  for (const user of [...ordered, ...searched]) {
    if (users.length < GITHUB_USER_SEARCH_LIMITS.usersMax) {
      const key = user.login.toLowerCase();
      const index = seen.get(key);
      if (index === undefined) {
        seen.set(key, users.length);
        users.push(user);
      } else {
        // The same person from two sources keeps the first rank and fills in what it lacked.
        const first = users[index];
        assert(first !== undefined, 'GitHub user search: a seen login has a row');
        users[index] = { ...first, name: first.name ?? user.name, avatarURL: first.avatarURL ?? user.avatarURL };
      }
    }
  }
  assert(users.length <= GITHUB_USER_SEARCH_LIMITS.usersMax, 'GitHub user search: the answer is capped');
  const github: GitHubSearchState = remote.kind === 'accounts' ? 'searched' : 'unavailable';
  return { users, github };
}

function searchSuggestion(account: GitHubAccount, source: GitHubUserSource): GitHubUserSuggestion {
  return { login: account.login, name: undefined, avatarURL: account.avatarURL, source };
}

async function requestAccounts(
  options: { readonly fetch: typeof fetch; readonly now: () => number },
  url: string,
  token: string | undefined,
  parse: (body: unknown) => readonly GitHubAccount[],
): Promise<RemoteAnswer> {
  assert(url.startsWith(`${API_ORIGIN}/`), 'GitHub user search: requests go to the GitHub API only');
  const fallback: RemoteAnswer = { kind: 'silenced', until: options.now() + GITHUB_USER_SEARCH_RESOLVER_LIMITS.backoffMsDefault };
  // i18n-ignore: HTTP User-Agent, not shown to a person.
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'Stacki', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token !== undefined) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  let response: Response;
  try {
    response = await options.fetch(url, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(GITHUB_USER_SEARCH_RESOLVER_LIMITS.timeoutMs),
    });
  } catch {
    return fallback;
  }
  const limitedUntil = rateLimitUntil(response.headers, options.now());
  if (response.status === 403 || response.status === 429) {
    await response.body?.cancel().catch(() => undefined);
    return { kind: 'silenced', until: limitedUntil ?? fallback.until };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return fallback;
  }
  const body = await readBoundedJSON(response, GITHUB_USER_SEARCH_RESOLVER_LIMITS.responseBytesMax);
  try {
    return { kind: 'accounts', accounts: parse(body) };
  } catch {
    return fallback;
  }
}

function parseAccounts(items: readonly unknown[]): readonly GitHubAccount[] {
  const accounts: GitHubAccount[] = [];
  for (const item of items) {
    const value = toRecord(item);
    if (value === undefined) {
      throw new Error('GitHub account: expected an object');
    }
    const type = value['type'];
    if (type !== undefined && typeof type !== 'string') {
      throw new Error('GitHub account: expected a type name');
    }
    const login = parseGitHubLogin(value['login']);
    const avatar = value['avatar_url'];
    const avatarURL = avatar === undefined ? undefined : sizedAvatar(parseAvatarURL(avatar));
    if (type === undefined || type === 'User') {
      accounts.push({ login, avatarURL });
    }
  }
  assert(accounts.length <= items.length, 'GitHub account: parsing never adds accounts');
  return accounts;
}

/** GitHub's avatar host takes `s`: ask for the 40px the picker draws, not the 460px default. */
function sizedAvatar(url: string): string {
  const parsed = new URL(url);
  if (parsed.hostname === 'avatars.githubusercontent.com') {
    parsed.searchParams.set('s', '40');
  }
  return parseAvatarURL(parsed.href);
}
