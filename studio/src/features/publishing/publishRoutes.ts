import { gitWorkspaceBusy, gitWorkspaceNeedsRecovery } from '../history/gitWorkspaceLease';
import { parsePublishTarget } from '../../../vendor/stacki/shared/properties/publishConfig';
import { GITHUB_PROVIDER_ID, identityProvider } from '../../../vendor/stacki/shared/properties/memberIdentity';
import { requestPerson } from '../auth/requestPerson';
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
  const state = request.method === 'POST' ? publisher.start(target, publishEditor(request)) : publisher.state;
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

// The Worker names the person in `x-studio-identity` (trusted only with the container token); only a person who is not a
// GitHub person is named in the commit, and a request without a valid identity (a local Studio) names nobody.
function publishEditor(request: IncomingMessage): string | undefined {
  if (!process.env['STUDIO_CONTAINER_TOKEN']) {
    return undefined;
  }
  try {
    const person = requestPerson(request);
    return identityProvider(person.identity) === GITHUB_PROVIDER_ID ? undefined : person.identity;
  } catch {
    return undefined;
  }
}
