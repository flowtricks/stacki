import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { setToolPathHome } from '../../../vendor/stacki/electron/lib/nodeTools';
import { PublishingAccount } from '../../../vendor/stacki/electron/project/publishAccount';
import { parseAccountRequest } from '../../../vendor/stacki/shared/ipc/publishAccount';

const account = new PublishingAccount();

export async function accountRoute(
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  readBody: () => Promise<string>,
): Promise<boolean> {
  if (pathname !== '/studio/api/publish/account') {
    return false;
  }
  if (request.method !== 'POST') {
    response.writeHead(405, { Allow: 'POST' });
    response.end();
    return true;
  }
  const body: unknown = JSON.parse(await readBody());
  const input = parseAccountRequest(body);
  setToolPathHome(homedir());
  // Hosted Studio owns its publishing credentials; visitors must never replace server logins.
  const result = process.env['GITHUB_REPOSITORY']
    ? {
        kind: 'failed',
        message: 'This Studio uses managed publishing credentials. Add accounts in Desktop or local Studio.',
      }
    : account.request(root, input);
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(result));
  return true;
}
