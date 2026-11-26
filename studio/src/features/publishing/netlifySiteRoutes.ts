import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { ensureToolPath, setToolPathHome } from '../../../vendor/stacki/electron/lib/nodeTools';
import { createNetlifySite } from '../../../vendor/stacki/electron/project/publishNetlify';
import { described } from '../../../vendor/stacki/shared/properties/i18n/messageRef';
import { parseNetlifySiteRequest } from '../../../vendor/stacki/shared/properties/publishNetlify';

// Add site in Studio runs Desktop's request on the server, with the server's Netlify sign-in.
export async function netlifySiteRoute(
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  readBody: () => Promise<string>,
): Promise<boolean> {
  if (pathname !== '/studio/api/publish/netlify-site') {
    return false;
  }
  if (request.method !== 'POST') {
    response.writeHead(405, { Allow: 'POST' });
    response.end();
    return true;
  }
  const body: unknown = JSON.parse(await readBody());
  const input = parseNetlifySiteRequest(body);
  setToolPathHome(homedir());
  await ensureToolPath();
  // Hosted Studio publishes with the server's credentials; visitors must never create sites in that account.
  const result = process.env['GITHUB_REPOSITORY']
    ? { kind: 'failed', ...described('publish.studio.error.managedCredentials') }
    : await createNetlifySite(root, input);
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(result));
  return true;
}
