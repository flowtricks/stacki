// Project files and OAuth sign-ins for apps, from the renderer (docs/apps.md,
// "Project files" and "Signing in"): Desktop asks the main process
// (electron/handlers/appAccessHandlers.ts), which checks every path and keeps
// every token. Studio replaces this module with studio/src/features/apps/
// accessClient.ts (scripts/shared-source.json), which asks its server. Every
// reply is parsed before an app or a panel sees it. A main process older than
// this renderer answers with a reason to restart rather than a crash.
import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import { parseAppId, parseAppsResult, type AppsResult } from '../../shared/properties/apps';
import { parseAppFileAnswer, type AppFileAnswer, type AppFileOperation } from '../../shared/properties/appFiles';
import { parseAppAccessToken, parseAppAuthStatus, parseAppAuthStatuses, type AppAccessToken, type AppAuthStatus } from '../../shared/properties/appAuth';
import { record } from '../../shared/core/boundary';
import { parseAppNetResponse, type AppNetRequest, type AppNetResponse } from '../../shared/properties/appNet';

const RESTART = 'Restart Stacki to use this app feature.';

/** One file call for an app, answered by the host's store. */
export async function runAppFileCall(projectPath: string, appId: string, operation: AppFileOperation): Promise<AppsResult<AppFileAnswer>> {
  const input = parseIpcPayload('apps:files', { projectPath, id: appId, operation });
  return parseAppsResult(await invoke(() => window.avb.appFiles(input)), (value) => parseAppFileAnswer(value, appId));
}

/** Signs in to one of an app's providers: the browser opens, and this answers once the sign-in finishes or times out. */
export async function connectAppAuth(projectPath: string, appId: string, provider: string): Promise<AppsResult<AppAuthStatus>> {
  const input = parseIpcPayload('apps:authConnect', { projectPath, id: appId, provider });
  return parseAppsResult(await invoke(() => window.avb.connectAppAuth(input)), parseAppAuthStatus);
}

export async function readAppAuthStatus(projectPath: string, appId: string): Promise<AppsResult<readonly AppAuthStatus[]>> {
  const input = parseIpcPayload('apps:authStatus', { projectPath, id: appId });
  return parseAppsResult(await invoke(() => window.avb.appAuthStatus(input)), parseAppAuthStatuses);
}

/** The app's access token for a provider, refreshed by the host when it is about to lapse. */
export async function readAppAccessToken(projectPath: string, appId: string, provider: string): Promise<AppsResult<AppAccessToken>> {
  const input = parseIpcPayload('apps:authToken', { projectPath, id: appId, provider });
  return parseAppsResult(await invoke(() => window.avb.appAuthToken(input)), parseAppAccessToken);
}

export async function disconnectAppAuth(projectPath: string, appId: string, provider: string): Promise<AppsResult<readonly AppAuthStatus[]>> {
  const input = parseIpcPayload('apps:authDisconnect', { projectPath, id: appId, provider });
  return parseAppsResult(await invoke(() => window.avb.disconnectAppAuth(input)), parseAppAuthStatuses);
}

/** A request the host makes for an app, to its declared hosts only. */
export async function runAppNetFetch(projectPath: string, appId: string, request: AppNetRequest): Promise<AppsResult<AppNetResponse>> {
  const input = parseIpcPayload('apps:netFetch', { projectPath, id: appId, request });
  return parseAppsResult(await invoke(() => window.avb.appNetFetch(input)), parseAppNetResponse);
}

/** Hears an app's sign-in change (connected or disconnected, from any window); returns the stop. */
export function onAppAuthChanged(listener: (appId: string) => void): () => void {
  if (typeof window.avb.onAppAuthChanged !== 'function') {
    return () => undefined; // An older preload: nothing to hear until Stacki restarts.
  }
  return window.avb.onAppAuthChanged((data) => {
    let appId: string;
    try {
      appId = parseAppId(record(data)['id']);
    } catch {
      return; // A notice this renderer cannot read is dropped; the details read the status again when opened.
    }
    listener(appId);
  });
}

async function invoke(call: () => Promise<unknown>): Promise<unknown> {
  try {
    return await call();
  } catch (error: unknown) {
    if (error instanceof TypeError || String(error).includes('No handler registered')) {
      return { ok: false, message: RESTART };
    }
    throw error;
  }
}
