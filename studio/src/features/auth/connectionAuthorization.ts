import { mayEdit, principalFromToken } from './authRuntime';
import { record, string } from '../../shared/validation';
import type { AuthRuntime } from './authRuntime';

// The container asks, with a session it was handed, whether that person may still edit. Core answers from the same
// runtime as every request, so a provider's policy (not just GitHub's) governs open collaboration connections too.
export async function authorizeConnection(request: Request, runtime: AuthRuntime) {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405 });
  }
  const input = record(await request.json());
  const audience = input['audience'] ?? 'studio';
  if (audience !== 'studio' && audience !== 'preview') {
    return new Response(null, { status: 400 });
  }
  const principal = await principalFromToken(runtime, string(input['session'], 4096), audience);
  if (!principal) {
    return new Response(null, { status: 401 });
  }
  const allowed = await mayEdit(runtime, principal, 'fresh');
  return new Response(null, {
    status: allowed ? 204 : 403,
    headers: { 'Cache-Control': 'no-store' },
  });
}
