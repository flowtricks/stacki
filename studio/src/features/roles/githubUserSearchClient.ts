// GitHub user suggestions in Studio: the same call as Desktop's bridge
// (src/ipc/githubUserSearchBridge.ts, which this module replaces in Studio), over HTTP.
// The server (githubUserSearchServer.ts) holds the credential; only the typed query is sent.
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { GITHUB_USER_SEARCH_LIMITS, parseGitHubUserSearchResult, type GitHubUserSearchResult } from '../../../vendor/stacki/shared/ipc/githubUserSearch';
import { parseGitHubLoginQuery } from '../../../vendor/stacki/shared/properties/projectRoles';
import { request } from '../project/projectClient';

export const GITHUB_USER_SEARCH_UNAVAILABLE: GitHubUserSearchResult = { users: [], github: 'unavailable' };

/** At most eight users matching `query`. The project is the server's own; `_projectPath` keeps Desktop's signature. Never throws. */
export async function searchGitHubUsers(_projectPath: string, query: string): Promise<GitHubUserSearchResult> {
  assert(query.length > 0, 'GitHub user search: a query is typed');
  try {
    const result = parseGitHubUserSearchResult(await request(`/studio/api/github/users?q=${encodeURIComponent(parseGitHubLoginQuery(query))}`));
    assert(result.users.length <= GITHUB_USER_SEARCH_LIMITS.usersMax, 'GitHub user search: the parsed reply is capped');
    return result;
  } catch {
    return GITHUB_USER_SEARCH_UNAVAILABLE;
  }
}
