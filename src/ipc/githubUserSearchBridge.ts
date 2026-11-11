// GitHub user suggestions for Settings → Roles' member picker, from the renderer.
// Desktop asks main (`github:searchUsers`), which holds the credential and makes every
// request; Stacki Studio replaces this module with its HTTP client
// (studio/scripts/shared-source.json, studio/src/features/roles/githubUserSearchClient.ts).
// The reply is parsed before a component sees it, and every failure, a stale main
// included, reads as "GitHub search unavailable": typing a username and pressing Add
// never depends on it.
import { assert } from '../../shared/core/assert';
import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import { GITHUB_USER_SEARCH_LIMITS, parseGitHubUserSearchResult, type GitHubUserSearchResult } from '../../shared/ipc/githubUserSearch';

export const GITHUB_USER_SEARCH_UNAVAILABLE: GitHubUserSearchResult = { users: [], github: 'unavailable' };

/** At most eight users matching `query` (already a parsed login query). Never throws. */
export async function searchGitHubUsers(projectPath: string, query: string): Promise<GitHubUserSearchResult> {
  assert(projectPath.length > 0, 'GitHub user search: a project is open');
  assert(query.length > 0, 'GitHub user search: a query is typed');
  // An older preload has no method; an older main has no handler.
  if (typeof window.avb.githubSearchUsers !== 'function') {
    return GITHUB_USER_SEARCH_UNAVAILABLE;
  }
  try {
    const result = parseGitHubUserSearchResult(await window.avb.githubSearchUsers(parseIpcPayload('github:searchUsers', { projectPath, query })));
    assert(result.users.length <= GITHUB_USER_SEARCH_LIMITS.usersMax, 'GitHub user search: the parsed reply is capped');
    return result;
  } catch {
    return GITHUB_USER_SEARCH_UNAVAILABLE;
  }
}
