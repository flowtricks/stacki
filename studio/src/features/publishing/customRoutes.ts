import type { IncomingMessage, ServerResponse } from 'node:http';
import { readPackageScripts } from '../../../vendor/stacki/electron/project/publishCustom';
import type { CustomPublishResult } from '../../../vendor/stacki/shared/properties/publishDeployLink';

// The script names a Custom host's deploy script is chosen from. Read-only, so it needs no publish permission of its
// own: saving the choice goes through the metadata route, which asks for it, and so does starting a publish.
export async function customRoute(root: string, request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
  if (pathname !== '/studio/api/publish/custom') {
    return false;
  }
  if (request.method !== 'GET') {
    response.writeHead(405, { Allow: 'GET' });
    response.end();
    return true;
  }
  const result: CustomPublishResult = {
    kind: 'ready',
    scripts: await readPackageScripts(root),
    environments: [],
    links: { production: { kind: 'unsupported' }, destinations: {}, unsaved: { kind: 'unsupported' } },
  };
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(result));
  return true;
}
