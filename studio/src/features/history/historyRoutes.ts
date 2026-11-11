import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommitDiffRequest } from '../../../vendor/stacki/shared/ipc/gitCommitDiff';
import { record } from '../../shared/validation';
import { HistoryRepository } from './historyRepository';
import { createCommitAvatarResolver } from '../../../vendor/stacki/electron/git/commitAvatars';
import { parseCommitAvatarRequest } from '../../../vendor/stacki/shared/ipc/commitAvatars';
import type { NativeRepository } from '../github/nativeRepository';

export function historyRoutes(root: string, repository: NativeRepository | undefined) {
  const history = new HistoryRepository(root, () =>
    repository
      ? repository.historyConnection()
      : Promise.resolve({
          ok: false,
          error: {
            code: 'repository',
            message: 'Connect a GitHub repository to view published history.',
          },
        }),
  );
  // Author pictures for the shared history panel. Studio's history is always a GitHub
  // repository; the connection's token stays on the server and only avatar URLs return.
  const avatars = createCommitAvatarResolver({ fetch, now: Date.now });
  const avatarConnection = async () => {
    const connection = repository ? await repository.historyConnection().catch(() => undefined) : undefined;
    return connection?.ok ? connection.value : undefined;
  };
  return async (request: IncomingMessage, response: ServerResponse, pathname: string, readBody: () => Promise<string>): Promise<boolean> => {
    if (!pathname.startsWith('/studio/api/history/')) {
      return false;
    }
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    try {
      if (pathname === '/studio/api/history/log' && request.method === 'GET') {
        const search = new URL(request.url ?? '/', 'http://studio').searchParams;
        const skip = Number(search.get('skip') ?? 0);
        if (!Number.isSafeInteger(skip) || skip < 0 || skip > 270 || skip % 30 !== 0) {
          throw new Error('Invalid history page.');
        }
        const scope = search.get('scope') ?? 'all';
        if (scope !== 'all' && scope !== 'current') {
          throw new Error('Invalid history scope.');
        }
        response.end(JSON.stringify(await history.read(skip, scope)));
      } else if (pathname === '/studio/api/history/commit' && request.method === 'GET') {
        const search = new URL(request.url ?? '/', 'http://studio').searchParams;
        response.end(JSON.stringify(await history.commit(search.get('hash') ?? '')));
      } else if (pathname === '/studio/api/history/avatars' && request.method === 'POST') {
        const input: unknown = JSON.parse(await readBody());
        const query = parseCommitAvatarRequest({ ...record(input), projectPath: root });
        // Read lazily (only when a commit is not cached) and at most once per request.
        let connection: ReturnType<typeof avatarConnection> | undefined;
        const connect = () => (connection ??= avatarConnection());
        const result = await avatars.resolve({
          repository: async () => (await connect())?.repository,
          token: async () => (await connect())?.token,
          commits: query.commits,
        });
        response.end(JSON.stringify(result));
      } else if (pathname === '/studio/api/history/diff' && request.method === 'POST') {
        const input: unknown = JSON.parse(await readBody());
        const data = record(input);
        const query = parseCommitDiffRequest({ ...data, projectPath: root });
        response.end(JSON.stringify(await history.diff(query)));
      } else {
        response.statusCode = 405;
        response.end(JSON.stringify({ error: 'Unsupported history request.' }));
      }
    } catch (error: unknown) {
      response.statusCode = 409;
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : 'Could not read repository history.',
        }),
      );
    }
    return true;
  };
}
