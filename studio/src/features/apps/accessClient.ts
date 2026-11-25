// Project files and OAuth sign-ins for apps from the Studio editor: the same
// calls as Desktop's bridge (src/ipc/appAccessBridge.ts, which this module
// replaces in Studio through scripts/shared-source.json), over HTTP to the
// Studio server (appAccessServer.ts). Every reply is parsed before an app or a
// panel sees it.
//
// A sign-in opens the provider in a new window. The window is opened before the
// first request, while the click that asked is still the current gesture, so a
// popup blocker lets it through; it is pointed at the authorize URL once the
// server answers, and the call then waits for the server to hear the callback.
import { parseAppsResult, type AppsResult } from '../../../vendor/stacki/shared/properties/apps';
import { parseAppFileAnswer, type AppFileAnswer, type AppFileOperation } from '../../../vendor/stacki/shared/properties/appFiles';
import {
  APP_AUTH_LIMITS,
  parseAppAccessToken,
  parseAppAuthStatus,
  parseAppAuthStatuses,
  parseEndpointURL,
  type AppAccessToken,
  type AppAuthStatus,
} from '../../../vendor/stacki/shared/properties/appAuth';
import { record } from '../../shared/validation';
import { APP_NET_LIMITS, parseAppNetResponse, type AppNetRequest, type AppNetResponse } from '../../../vendor/stacki/shared/properties/appNet';
import { request } from '../project/projectClient';

/** Listeners of sign-in changes in this tab: Studio has no push channel for them, so the calls here announce them. */
const authListeners = new Set<(appId: string) => void>();

async function post(url: string, body: unknown, options: { readonly timeoutMs: number } = { timeoutMs: 60_000 }): Promise<unknown> {
  return request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
}

export async function runAppFileCall(_projectPath: string, appId: string, operation: AppFileOperation): Promise<AppsResult<AppFileAnswer>> {
  return parseAppsResult(await post('/studio/api/apps/files', { id: appId, operation }), (value) => parseAppFileAnswer(value, appId));
}

export async function connectAppAuth(_projectPath: string, appId: string, provider: string): Promise<AppsResult<AppAuthStatus>> {
  const opened = window.open('', '_blank') ?? undefined;
  const started = parseAppsResult(await post('/studio/api/apps/auth/connect', { id: appId, provider }), parseConnectStart);
  if (!started.ok) {
    opened?.close();
    return started;
  }
  if (started.value.kind === 'unconfigured') {
    opened?.close();
    return { ok: true, value: started.value.status };
  }
  if (opened === undefined) {
    window.location.assign(started.value.authorizeURL);
  } else {
    opened.location.href = started.value.authorizeURL;
  }
  const answer = parseAppsResult(
    await post('/studio/api/apps/auth/wait', { id: appId }, { timeoutMs: APP_AUTH_LIMITS.flowTimeoutMs + 10_000 }),
    parseAppAuthStatus,
  );
  if (answer.ok) {
    announce(appId);
  }
  return answer;
}

export async function readAppAuthStatus(_projectPath: string, appId: string): Promise<AppsResult<readonly AppAuthStatus[]>> {
  return parseAppsResult(await post('/studio/api/apps/auth/status', { id: appId }), parseAppAuthStatuses);
}

export async function readAppAccessToken(_projectPath: string, appId: string, provider: string): Promise<AppsResult<AppAccessToken>> {
  return parseAppsResult(await post('/studio/api/apps/auth/token', { id: appId, provider }), parseAppAccessToken);
}

export async function disconnectAppAuth(_projectPath: string, appId: string, provider: string): Promise<AppsResult<readonly AppAuthStatus[]>> {
  const answer = parseAppsResult(await post('/studio/api/apps/auth/disconnect', { id: appId, provider }), parseAppAuthStatuses);
  if (answer.ok) {
    announce(appId);
  }
  return answer;
}

export async function runAppNetFetch(_projectPath: string, appId: string, request: AppNetRequest): Promise<AppsResult<AppNetResponse>> {
  return parseAppsResult(
    await post('/studio/api/apps/net/fetch', { id: appId, request }, { timeoutMs: APP_NET_LIMITS.timeoutMs + 10_000 }),
    parseAppNetResponse,
  );
}

export function onAppAuthChanged(listener: (appId: string) => void): () => void {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

// The server's answer to a connect: the authorize page to open, or why the connection cannot sign in now.
function parseConnectStart(
  input: unknown,
): { readonly kind: 'started'; readonly authorizeURL: string } | { readonly kind: 'unconfigured'; readonly status: AppAuthStatus } {
  const value = record(input);
  if (value['kind'] === 'unconfigured') {
    return { kind: 'unconfigured', status: parseAppAuthStatus(value['status']) };
  }
  return { kind: 'started', authorizeURL: parseEndpointURL(value['authorizeURL'], 'authorizeURL') };
}

function announce(appId: string): void {
  for (const listener of authListeners) {
    listener(appId);
  }
}
