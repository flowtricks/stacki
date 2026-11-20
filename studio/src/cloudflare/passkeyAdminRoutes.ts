// Goal: the Worker's two auth routes for the Roles panel, behind the same session and Studio-origin checks as every other
// route (worker.ts runs them first):
//   GET  /studio/api/auth/info      which sign-in method this site uses and whether the signed-in person may manage it,
//                                   so the Roles panel offers the invite form for THAT provider only
//   POST /studio/api/auth/passkeys  passkey administration (invite, list, revoke), `canManage` only, run in the Durable Object
// The client is never trusted: a non-manager is refused here whatever the panel showed.
import { mayManage } from '../features/auth/authRuntime';
import { activeAuthRuntime } from './activeAuthRuntime';
import type { Principal } from '../features/auth/authProvider';
import type { Environment } from './environment';

const BODY_BYTES_MAX = 4_096;

// A roles lookup that fails (GitHub unreachable) shows the panel as read-only; the mutation routes re-check and refuse.
export async function passkeyAdminRoute(request: Request, url: URL, environment: Environment, identity: Principal): Promise<Response | undefined> {
  const runtime = activeAuthRuntime(environment);
  if (url.pathname === '/studio/api/auth/info' && request.method === 'GET') {
    return Response.json(
      {
        provider: runtime.providerId,
        displayName: runtime.provider.displayName,
        // `custom` providers get a generic identifier field; the built-in ones have a form of their own.
        kind: runtime.installed,
        ...(runtime.installed === 'custom' && runtime.provider.inviteHint !== undefined ? { inviteHint: runtime.provider.inviteHint } : {}),
        canManage: await mayManage(runtime, identity).catch(() => false),
        origin: environment.STUDIO_ORIGIN,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (url.pathname !== '/studio/api/auth/passkeys') {
    return undefined;
  }
  if (runtime.installed !== 'built-in' || runtime.providerId !== 'passkey') {
    return Response.json({ ok: false, error: 'not-passkey' }, { status: 404 });
  }
  if (!(await mayManage(runtime, identity))) {
    return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }
  let command: unknown = { action: 'list' };
  if (request.method === 'POST') {
    const text = await request.text();
    if (text.length > BODY_BYTES_MAX) {
      return Response.json({ ok: false, error: 'invalid' }, { status: 413 });
    }
    try {
      command = JSON.parse(text);
    } catch {
      return Response.json({ ok: false, error: 'invalid' }, { status: 400 });
    }
  } else if (request.method !== 'GET') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
  }
  const answer = await environment.PREVIEW.getByName('project').passkeyAdmin(identity.identity, command);
  return Response.json(answer, { status: answer.ok ? 200 : 400, headers: { 'Cache-Control': 'no-store' } });
}
