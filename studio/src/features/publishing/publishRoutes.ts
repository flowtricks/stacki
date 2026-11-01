import { gitWorkspaceBusy, gitWorkspaceNeedsRecovery } from '../history/gitWorkspaceLease';
import { parsePublishTarget } from '../../../vendor/stacki/shared/properties/publishConfig';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Publisher } from './publish';

export function publishRoute(publisher: Publisher, request: IncomingMessage, response: ServerResponse, pathname: string) {
  if (pathname !== '/studio/api/publish') {
    return false;
  }
  if (request.method !== 'GET' && request.method !== 'POST') {
    response.writeHead(405, { Allow: 'GET, POST' });
    response.end();
    return true;
  }
  const target = parsePublishTarget(new URL(request.url ?? '/', 'http://studio').searchParams.get('target') ?? 'all');
  const state = request.method === 'POST' ? publisher.start(target) : publisher.state;
  response.statusCode = state.kind === 'building' ? 202 : 200;
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  response.end(
    JSON.stringify({
      ...state,
      gitBusy: gitWorkspaceBusy(publisher.root) && !gitWorkspaceNeedsRecovery(publisher.root),
    }),
  );
  return true;
}
