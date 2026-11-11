// The Studio server's half of the Roles member picker: `GET /studio/api/github/users?q=`,
// the same search Desktop answers over `github:searchUsers` (electron/git/githubUserSearch.ts).
// The credential is the repository connection's installation token, read here and never
// sent to the page. A GET takes no Git workspace lease, so typing never waits on a save.
// Only people who may edit roles can search: the search spends the project's GitHub budget.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createGitHubUserSearch } from '../../../vendor/stacki/electron/git/githubUserSearch';
import { parseGitHubUserSearchRequest } from '../../../vendor/stacki/shared/ipc/githubUserSearch';
import { can } from '../../../vendor/stacki/shared/properties/projectRoles';
import type { NativeRepository } from '../github/nativeRepository';
import { requestRole } from './serverAccess';

export const GITHUB_USERS_ROUTE = '/studio/api/github/users';

export function githubUserSearchRoute(root: string, repository: NativeRepository | undefined) {
  const users = createGitHubUserSearch({ fetch, now: Date.now });
  const connection = async () => {
    const value = repository ? await repository.historyConnection().catch(() => undefined) : undefined;
    return value?.ok ? value.value : undefined;
  };
  return async (request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> => {
    if (pathname !== GITHUB_USERS_ROUTE) {
      return false;
    }
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET') {
      response.statusCode = 405;
      response.end(JSON.stringify({ error: 'Unsupported GitHub user request.' }));
      return true;
    }
    if (!can(await requestRole(root, request), 'settings:roles')) {
      response.statusCode = 403;
      response.end(JSON.stringify({ error: 'Only admins can search for role members.' }));
      return true;
    }
    let query: string;
    try {
      const search = new URL(request.url ?? '/', 'http://studio').searchParams;
      query = parseGitHubUserSearchRequest({ projectPath: root, query: search.get('q') ?? '' }).query;
    } catch (error: unknown) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Invalid GitHub user search.' }));
      return true;
    }
    // Read lazily (only when a request needs it) and at most once per search.
    let connected: ReturnType<typeof connection> | undefined;
    const connect = () => (connected ??= connection());
    const result = await users.search({
      query,
      repository: async () => (await connect())?.repository,
      token: async () => (await connect())?.token,
      // Studio's history is fetched on demand into a private store; reading it per keystroke would cost a fetch.
      authors: () => Promise.resolve([]),
    });
    response.end(JSON.stringify(result));
    return true;
  };
}
