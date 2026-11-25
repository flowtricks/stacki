import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { ensureToolPath, setToolPathHome } from '../../../vendor/stacki/electron/lib/nodeTools';
import { setUpWorkerHosting } from '../../../vendor/stacki/electron/project/publishWorkerSetup';
import { described } from '../../../vendor/stacki/shared/properties/i18n/messageRef';
import { parseWorkerSetupRequest } from '../../../vendor/stacki/shared/properties/publishWorkerSetup';

// Add Worker in Studio runs Desktop's setup on the server's copy of the site, so both hosts configure a site the same way.
export async function workerRoute(
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  readBody: () => Promise<string>,
): Promise<boolean> {
  if (pathname !== '/studio/api/publish/worker') {
    return false;
  }
  if (request.method !== 'POST') {
    response.writeHead(405, { Allow: 'POST' });
    response.end();
    return true;
  }
  const body: unknown = JSON.parse(await readBody());
  const input = parseWorkerSetupRequest(body);
  setToolPathHome(homedir());
  await ensureToolPath();
  // Hosted Studio deploys through its connected GitHub build; visitors must not change how that build deploys.
  const result = process.env['GITHUB_REPOSITORY']
    ? { kind: 'failed', ...described('publish.studio.error.managedCredentials') }
    : await setUpWorkerHosting(root, input);
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(result));
  return true;
}
