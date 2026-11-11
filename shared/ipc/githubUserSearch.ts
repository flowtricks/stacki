// GitHub user suggestions for Settings → Roles' member picker (`github:searchUsers`;
// Studio: `GET /studio/api/github/users?q=`). The renderer sends the typed text and,
// on Desktop, the open project so main can find its GitHub account and repository;
// nothing else is sent to GitHub. Main (or the Studio server) answers with at most
// eight users, the repository's collaborators and recent commit authors first.
// Every login follows GitHub's rules and every picture is on a GitHub avatar host
// (shared/ipc/commitAvatars.ts), so a reply cannot make the renderer load anything else.
import { assert } from '../core/assert';
import { list, optional, pathText, record, text } from '../core/boundary';
import { parseGitHubLogin, parseGitHubLoginQuery } from '../properties/projectRoles';
import { parseAvatarURL } from './commitAvatars';

export const GITHUB_USER_SEARCH_LIMITS = {
  /** Suggestions in one answer, and rows in the picker. */
  usersMax: 8,
  /** GitHub's profile name limit. */
  nameCharsMax: 255,
  /** How long typing must pause before a search is sent. */
  debounceMs: 250,
} as const satisfies Record<string, number>;

export const GITHUB_USER_SOURCES = ['collaborator', 'author', 'search'] as const;
/** Where a suggestion came from: the repository's collaborators, its recent commit authors, or GitHub's search. */
export type GitHubUserSource = (typeof GITHUB_USER_SOURCES)[number];

export const GITHUB_SEARCH_STATES = ['searched', 'unavailable'] as const;
/** Whether GitHub's search answered; rate limits, refusals and being offline are `unavailable`. */
export type GitHubSearchState = (typeof GITHUB_SEARCH_STATES)[number];

export interface GitHubUserSuggestion {
  readonly login: string;
  readonly name: string | undefined;
  readonly avatarURL: string | undefined;
  readonly source: GitHubUserSource;
}

export interface GitHubUserSearchRequest {
  readonly projectPath: string;
  readonly query: string;
}

export interface GitHubUserSearchResult {
  readonly users: readonly GitHubUserSuggestion[];
  readonly github: GitHubSearchState;
}

/** The searchable form of what was typed, or undefined when nothing could match a login. */
export function githubUserQuery(typed: string): string | undefined {
  try {
    return parseGitHubLoginQuery(typed);
  } catch {
    return undefined;
  }
}

export function parseGitHubUserSearchRequest(input: unknown): GitHubUserSearchRequest {
  const value = record(input);
  const projectPath = pathText(value['projectPath']);
  assert(projectPath.length > 0, 'GitHub user search: project path is required');
  return { projectPath, query: parseGitHubLoginQuery(value['query']) };
}

export function parseGitHubUserSearchResult(input: unknown): GitHubUserSearchResult {
  const value = record(input);
  const users = list(parseGitHubUserSuggestion)(value['users']);
  if (users.length > GITHUB_USER_SEARCH_LIMITS.usersMax) {
    throw new Error('GitHub user search: reply exceeds limit');
  }
  const logins = new Set(users.map((user) => user.login.toLowerCase()));
  if (logins.size !== users.length) {
    throw new Error('GitHub user search: duplicate login');
  }
  const github = GITHUB_SEARCH_STATES.find((state) => state === value['github']);
  if (github === undefined) {
    throw new Error('GitHub user search: unknown search state');
  }
  return { users, github };
}

export function parseGitHubUserSuggestion(input: unknown): GitHubUserSuggestion {
  const value = record(input);
  const source = GITHUB_USER_SOURCES.find((item) => item === value['source']);
  if (source === undefined) {
    throw new Error('GitHub user search: unknown source');
  }
  return {
    login: parseGitHubLogin(value['login']),
    name: optional(parseGitHubName)(value['name']),
    avatarURL: optional(parseAvatarURL)(value['avatarURL']),
    source,
  };
}

/** A profile name: trimmed, bounded, and absent when blank. */
export function parseGitHubName(input: unknown): string | undefined {
  const name = text(input).trim();
  if (name.length > GITHUB_USER_SEARCH_LIMITS.nameCharsMax) {
    throw new Error('GitHub user search: name exceeds limit');
  }
  return name.length === 0 ? undefined : name;
}
