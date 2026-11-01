import { canEdit, type AccessConfig } from './repositoryAccess';
import { verifySession } from './session';
import { record, string } from '../../shared/validation';

export async function authorizeConnection(request: Request, environment: AccessConfig & { readonly SESSION_SECRET: string }) {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405 });
  }
  const input = record(await request.json());
  const audience = input['audience'] ?? 'studio';
  if (audience !== 'studio' && audience !== 'preview') {
    return new Response(null, { status: 400 });
  }
  const identity = await verifySession(string(input['session'], 4096), environment.SESSION_SECRET, audience);
  if (!identity) {
    return new Response(null, { status: 401 });
  }
  const allowed = await canEdit(identity, environment, true);
  return new Response(null, {
    status: allowed ? 204 : 403,
    headers: { 'Cache-Control': 'no-store' },
  });
}
