import { homedir } from 'node:os';
import { setToolPathHome } from '../../../vendor/stacki/electron/lib/nodeTools';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { publishingRepositories } from '../../../vendor/stacki/electron/project/publishRepositories';
import { parseRepositoryRequest, parseRepositoryResult } from '../../../vendor/stacki/shared/ipc/publishRepository';
import { parseGitHubRepository } from '../../../vendor/stacki/shared/ipc/githubRepository';
import { described } from '../../../vendor/stacki/shared/properties/i18n/messageRef';

export async function repositoryRoute(
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  readBody: () => Promise<string>,
): Promise<boolean> {
  if (pathname !== '/studio/api/publish/repository') {
    return false;
  }
  if (request.method !== 'POST') {
    response.writeHead(405, { Allow: 'POST' });
    response.end();
    return true;
  }
  setToolPathHome(homedir());
  const input: unknown = JSON.parse(await readBody());
  const action = parseRepositoryRequest(input);
  const managed = process.env['GITHUB_REPOSITORY'];
  const result = managed ? managedRepository(managed, action.action) : await publishingRepositories(root, action);
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(result));
  return true;
}
function managedRepository(repository: string, action: string) {
  const connected = parseGitHubRepository(repository);
  if (action !== 'list') {
    const problem = described('publish.repositories.managedLinked');
    return { ok: false, error: problem.message, errorRef: problem.messageRef };
  }
  const notice = described('publish.repositories.managedNotice');
  return parseRepositoryResult({
    ok: true,
    value: {
      connected,
      repositories: [connected],
      mode: 'managed',
      revision: createHash('sha256').update(connected).digest('hex'),
      notice: notice.message,
      noticeRef: notice.messageRef,
    },
  });
}
