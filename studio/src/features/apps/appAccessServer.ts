// What apps reach beyond the editor, on the Studio server: project files
// (`files.*`) and OAuth sign-ins (`auth.*`), with the same modules and rules as
// Desktop's main process (vendor/stacki/electron/handlers/appAccessHandlers.ts):
// the file store refuses the same paths and keeps the same per-minute budget,
// and the sign-in engine runs the same PKCE flow and seals tokens in the same
// vault as secret settings (appSettingsVault.ts), never under the project.
//
// Files are written atomically beside their target (`.studio-tmp`, which the
// dev server's watcher ignores), so the watcher hears one change, and the
// collaboration rooms reload open editors from it (integration.ts). Writing needs
// `code:edit`, which serverAccess.ts gates and this module checks again, and the
// role's grant for the app itself.
//
// Sign-ins: Studio cannot open the person's browser itself, so `auth/connect`
// answers with the authorize URL, the editor opens it in a new window and
// waits on `auth/wait`; the provider comes back to `/studio/api/apps/oauth/callback`
// on this server. A hosted Studio refuses, as it refuses secret settings,
// because its vault does not outlive a deployment yet.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createAppFileBudget, runAppFileOperation } from '../../../vendor/stacki/electron/project/appFilesStore';
import { createAppSignIns, type AppSignIns } from '../../../vendor/stacki/electron/project/appSignIn';
import { appNetFetch, createAppNetRate } from '../../../vendor/stacki/electron/project/appNetFetch';
import { parseAppNetRequest } from '../../../vendor/stacki/shared/properties/appNet';
import { listInstalledApps } from '../../../vendor/stacki/electron/project/appStore';
import type { SecretVault } from '../../../vendor/stacki/electron/project/appSettingsStore';
import { parseAppFileOperation } from '../../../vendor/stacki/shared/properties/appFiles';
import { parseAuthProviderId } from '../../../vendor/stacki/shared/properties/appAuth';
import { stackiBrokerOrigin } from '../../../vendor/stacki/shared/properties/appConnections';
import { appsFailureMessage, parseAppId, type AppManifest, type AppsResult } from '../../../vendor/stacki/shared/properties/apps';
import { appAccessFeature } from '../../../vendor/stacki/shared/properties/appsRpc';
import { can } from '../../../vendor/stacki/shared/properties/projectRoles';
import { requestRole } from '../roles/serverAccess';
import { record } from '../../shared/validation';

/** The route the provider sends the browser back to. */
export const STUDIO_OAUTH_CALLBACK_PATH = '/studio/api/apps/oauth/callback';

export function appAccessRoutes(root: string, vault: SecretVault) {
  const budget = createAppFileBudget(() => Date.now());
  const signIns = createAppSignIns({ fetch: (url, init) => fetch(url, init), now: () => Date.now(), vault, broker: studioBroker() });
  const netRate = createAppNetRate(() => Date.now());
  const routes = async (request: IncomingMessage, response: ServerResponse, pathname: string, readBody: () => Promise<string>): Promise<boolean> => {
    if (pathname === STUDIO_OAUTH_CALLBACK_PATH && request.method === 'GET') {
      const url = new URL(request.url ?? '/', 'http://studio');
      const field = (name: string): string | undefined => url.searchParams.get(name) ?? undefined;
      const outcome = await signIns.complete({ state: field('state'), code: field('code'), error: field('error'), handoff: field('handoff') });
      response.writeHead(outcome.ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(callbackPage(outcome));
      return true;
    }
    if (request.method !== 'POST') {
      return false;
    }
    if (pathname === '/studio/api/apps/files') {
      send(response, await fileAction(root, budget, request, readBody));
      return true;
    }
    if (pathname === '/studio/api/apps/net/fetch') {
      send(response, await netAction(root, signIns, netRate, request, readBody));
      return true;
    }
    if (pathname.startsWith('/studio/api/apps/auth/')) {
      send(response, await authAction(root, signIns, pathname.slice('/studio/api/apps/auth/'.length), request, readBody));
      return true;
    }
    return false;
  };
  return { routes, signIns };
}

async function fileAction(
  root: string,
  budget: ReturnType<typeof createAppFileBudget>,
  request: IncomingMessage,
  readBody: () => Promise<string>,
): Promise<AppsResult<unknown>> {
  const role = await requestRole(root, request);
  const input = record(JSON.parse((await readBody()) || '{}'));
  const id = parseAppId(input['id']);
  if (!can(role, 'code:edit')) {
    return { ok: false, message: 'Your role cannot edit code, so apps cannot change project files for it.' };
  }
  if (!can(role, appAccessFeature(id))) {
    return { ok: false, message: 'Your role cannot use this app.' };
  }
  let operation;
  try {
    operation = parseAppFileOperation(input['operation'], id);
  } catch (error: unknown) {
    return { ok: false, message: appsFailureMessage(error) };
  }
  return runAppFileOperation(root, id, operation, { budget, writeFile: studioWriteFile });
}

// A request made for an app: anyone who may use the app, to the hosts its manifest declares (appNetFetch.ts).
async function netAction(
  root: string,
  signIns: AppSignIns,
  rate: ReturnType<typeof createAppNetRate>,
  request: IncomingMessage,
  readBody: () => Promise<string>,
): Promise<AppsResult<unknown>> {
  const role = await requestRole(root, request);
  const input = record(JSON.parse((await readBody()) || '{}'));
  const id = parseAppId(input['id']);
  if (!can(role, 'panel:apps') || !can(role, appAccessFeature(id))) {
    return { ok: false, message: 'Your role cannot use this app.' };
  }
  try {
    const manifest = installedManifest(root, id);
    const value = await appNetFetch(manifest, parseAppNetRequest(input['request']), rate, {
      fetch: (url, init) => fetch(url, init),
      now: () => Date.now(),
      accessToken: async (signedIn, provider) => (await signIns.token(root, signedIn, provider)).accessToken,
    });
    return { ok: true, value };
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('Assertion failed')) {
      throw error;
    }
    return { ok: false, message: appsFailureMessage(error) };
  }
}

async function authAction(
  root: string,
  signIns: AppSignIns,
  action: string,
  request: IncomingMessage,
  readBody: () => Promise<string>,
): Promise<AppsResult<unknown>> {
  const role = await requestRole(root, request);
  const input = record(JSON.parse((await readBody()) || '{}'));
  const id = parseAppId(input['id']);
  if (!can(role, 'panel:apps') || !can(role, appAccessFeature(id))) {
    return { ok: false, message: 'Your role cannot use this app.' };
  }
  try {
    const manifest = installedManifest(root, id);
    switch (action) {
      case 'status':
        return { ok: true, value: await signIns.checkedStatus(root, manifest) };
      case 'token':
        return { ok: true, value: await signIns.token(root, manifest, parseAuthProviderId(input['provider'])) };
      case 'disconnect':
        signIns.disconnect(root, id, parseAuthProviderId(input['provider']));
        return { ok: true, value: signIns.status(root, manifest) };
      case 'connect': {
        const host = request.headers.host ?? 'localhost';
        const scheme = request.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
        const provider = parseAuthProviderId(input['provider']);
        // A broker that cannot sign in now answers at once, before any window opens (`unconfigured`).
        const unconfigured = await signIns.unconfigured(root, manifest, provider);
        if (unconfigured !== undefined) {
          return { ok: true, value: { kind: 'unconfigured', status: unconfigured } };
        }
        const flow = signIns.begin(root, manifest, provider, `${scheme}://${host}${STUDIO_OAUTH_CALLBACK_PATH}`);
        // The outcome is collected by the editor's `wait` request, not this one.
        return { ok: true, value: { kind: 'started', authorizeURL: flow.authorizeURL } };
      }
      case 'wait': {
        const waiting = signIns.waiting(root, id);
        if (waiting === undefined) {
          return { ok: false, message: 'No sign-in is waiting for this app.' };
        }
        const outcome = await waiting;
        return outcome.ok ? { ok: true, value: outcome.value } : outcome;
      }
      case 'cancel':
        signIns.cancel(root, id);
        return { ok: true, value: signIns.status(root, manifest) };
      default:
        return { ok: false, message: 'Unknown sign-in action' };
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('Assertion failed')) {
      throw error;
    }
    return { ok: false, message: appsFailureMessage(error) };
  }
}

// Studio's atomic write: the bytes land beside the file and replace it in one rename.
function studioWriteFile(absolute: string, bytes: Uint8Array): void {
  const temporary = `${absolute}.${randomBytes(6).toString('hex')}.studio-tmp`;
  fs.writeFileSync(temporary, bytes, { flag: 'wx' });
  fs.renameSync(temporary, absolute);
}

function installedManifest(root: string, id: string): AppManifest {
  const app = listInstalledApps(root).find((summary) => summary.manifest.id === id);
  if (app === undefined) {
    throw new Error(`The app "${id}" is not installed.`);
  }
  return app.manifest;
}

/** The page the browser shows after the callback: nothing the provider sent is echoed back. */
function callbackPage(outcome: { readonly ok: boolean }): string {
  const message = outcome.ok
    ? 'Signed in. You can close this window and return to Stacki Studio.'
    : 'The sign-in did not finish. Return to Stacki Studio to see why.';
  return `<!doctype html><meta charset="utf-8"><title>Stacki Studio</title><p style="font:16px system-ui;margin:3em">${message}</p>`;
}

function send(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

/** The connections broker: stacki.build, or a local `wrangler dev` for a Studio run in development. */
export function studioBroker(): string {
  return stackiBrokerOrigin(process.env, process.env['NODE_ENV'] === 'development' && !process.env['STUDIO_CONTAINER_TOKEN'] ? 'development' : 'release');
}
