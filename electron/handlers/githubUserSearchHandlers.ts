// Settings → Roles' member suggestions (`github:searchUsers`). The renderer sends the typed
// start of a username; this answers with at most eight GitHub users, the project's
// collaborators and recent commit authors first (electron/git/githubUserSearch.ts). The
// credential is the GitHub CLI sign-in publishing uses (gitAvatarHandlers.ts), read here
// and never sent to the renderer; without one the search runs unauthenticated.
import { assert } from '../../shared/core/assert';
import { createGitHubUserSearch, GITHUB_USER_SEARCH_RESOLVER_LIMITS, type GitHubCommitAuthor } from '../git/githubUserSearch';
import { git } from '../lib/nodeTools';
import { githubToken, originRepository } from './gitAvatarHandlers';
import type { MainHost } from './mainHost';

export const GITHUB_USER_SEARCH_HANDLER_LIMITS = {
  /** How long a project's credential is reused: typing sends a search every pause, and `gh` is a process each time. */
  tokenCacheMs: 60_000,
  /** Projects whose credential is cached at once; the app opens one at a time. */
  tokenCacheEntriesMax: 16,
  gitTimeoutMs: 10_000,
} as const satisfies Record<string, number>;

export function registerGitHubUserSearchHandler({ ipcMain }: Pick<MainHost, 'ipcMain'>): void {
  // One search cache for the app's lifetime, like the commit avatars'.
  const users = createGitHubUserSearch({ fetch, now: Date.now });
  const tokens = new Map<string, { readonly token: Promise<string | undefined>; readonly until: number }>();
  const token = (projectPath: string): Promise<string | undefined> => {
    const cached = tokens.get(projectPath);
    if (cached !== undefined) {
      if (Date.now() < cached.until) {
        return cached.token;
      }
      tokens.delete(projectPath);
    }
    if (tokens.size >= GITHUB_USER_SEARCH_HANDLER_LIMITS.tokenCacheEntriesMax) {
      tokens.clear();
    }
    const read = githubToken(projectPath);
    tokens.set(projectPath, { token: read, until: Date.now() + GITHUB_USER_SEARCH_HANDLER_LIMITS.tokenCacheMs });
    assert(tokens.size <= GITHUB_USER_SEARCH_HANDLER_LIMITS.tokenCacheEntriesMax, 'GitHub user search: token cache exceeds its bound');
    return read;
  };
  ipcMain.handle('github:searchUsers', async (_event, { projectPath, query }) =>
    users.search({
      query,
      repository: () => originRepository(projectPath),
      token: () => token(projectPath),
      authors: () => recentAuthors(projectPath),
    }),
  );
}

/** The authors of the project's most recent commits, newest first; empty outside a repository. */
async function recentAuthors(projectPath: string): Promise<readonly GitHubCommitAuthor[]> {
  assert(projectPath.length > 0, 'GitHub user search: authors are read for a project');
  let output: string;
  try {
    output = (
      await git(projectPath, ['log', `--max-count=${GITHUB_USER_SEARCH_RESOLVER_LIMITS.authorsMax}`, '--no-merges', '--format=%an%x1f%ae'], {
        timeout: GITHUB_USER_SEARCH_HANDLER_LIMITS.gitTimeoutMs,
      })
    ).stdout;
  } catch {
    return [];
  }
  const authors: GitHubCommitAuthor[] = [];
  for (const line of output.split('\n').slice(0, GITHUB_USER_SEARCH_RESOLVER_LIMITS.authorsMax)) {
    const [name, email] = line.split('\x1f');
    if (name !== undefined) {
      if (email !== undefined) {
        authors.push({ name, email });
      }
    }
  }
  assert(authors.length <= GITHUB_USER_SEARCH_RESOLVER_LIMITS.authorsMax, 'GitHub user search: authors are bounded');
  return authors;
}
