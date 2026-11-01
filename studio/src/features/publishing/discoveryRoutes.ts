import { homedir } from 'node:os';
import { setToolPathHome } from '../../../vendor/stacki/electron/lib/nodeTools';
import { parseGitHubRepository } from '../../../vendor/stacki/shared/ipc/githubRepository';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { discoverPublishing } from '../../../vendor/stacki/electron/project/publishDiscovery';
import { parseDiscoveryRequest } from '../../../vendor/stacki/shared/properties/publishDiscovery';

export async function discoveryRoute(
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  readBody: () => Promise<string>,
): Promise<boolean> {
  if (pathname !== '/studio/api/publish/discover') {
    return false;
  }
  if (request.method !== 'POST') {
    response.writeHead(405, { Allow: 'POST' });
    response.end();
    return true;
  }
  setToolPathHome(homedir());
  const body: unknown = JSON.parse(await readBody());
  const input = parseDiscoveryRequest(body);
  const managed = process.env['GITHUB_REPOSITORY'];
  const owner = managed ? parseGitHubRepository(managed).split('/')[0] : undefined;
  const result =
    input.provider === 'github' && owner ? { kind: 'ready', accounts: [{ id: owner, name: owner }], projects: [] } : await discoverPublishing(root, input);
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(result));
  return true;
}
