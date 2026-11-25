// Stacki Apps from the Studio editor: the same calls as Desktop's bridge
// (src/ipc/appsBridge.ts, which this module replaces in Studio through
// scripts/shared-source.json), over HTTP to the Studio server
// (appsServer.ts). App frames load from the server's file route; an uploaded
// zip is chosen with the browser's own chooser and sent as one request.
import {
  parseAppReleases,
  parseAppStaged,
  parseAppSummary,
  parseAppsResult,
  parseUpdateOutcomes,
  type AppGitHubSource,
  type AppRelease,
  type AppRepositoryListing,
  type AppStaged,
  type AppSummary,
  type AppUpdateOutcome,
  type AppsResult,
} from '../../../vendor/stacki/shared/properties/apps';
import { parseInstalledAppList, parseReadableAppSummaries, type InstalledAppList } from '../../../vendor/stacki/shared/properties/appFolders';
import { described } from '../../../vendor/stacki/shared/properties/i18n/messageRef';
import { request } from '../project/projectClient';
import { APP_FILES_PREFIX_PATH } from './appsPaths';

export function appFrameURL(appId: string, filePath: string): string {
  return `${APP_FILES_PREFIX_PATH}${appId}/${filePath.split('/').map(encodeURIComponent).join('/')}`;
}

export const APPS_UNAVAILABLE = described('apps.error.studioNoServer');

async function post(url: string, body: unknown): Promise<unknown> {
  return request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

/** The installed apps this editor can run; an app it cannot read is left out here and listed as broken by `listInstalledAppList`. */
export async function listApps(projectPath: string): Promise<AppsResult<readonly AppSummary[]>> {
  const answer = await listInstalledAppList(projectPath);
  return answer.ok ? { ok: true, value: answer.value.apps } : answer;
}

/** The Installed list, read one app at a time: one unreadable app is a broken row, never the whole list's failure. */
export async function listInstalledAppList(_projectPath: string): Promise<AppsResult<InstalledAppList>> {
  let reply: unknown;
  try {
    reply = await request('/studio/api/apps');
  } catch {
    return { ok: false, ...APPS_UNAVAILABLE };
  }
  return parseAppsResult(reply, parseInstalledAppList);
}

/** Asks for a zip in the browser and checks it on the server; undefined when cancelled. */
export async function chooseAppFile(_projectPath: string): Promise<AppsResult<AppStaged | undefined>> {
  const file = await chooseZip();
  if (file === undefined) {
    return { ok: true, value: undefined };
  }
  const reply = await request(`/studio/api/apps/upload?${new URLSearchParams({ name: file.name })}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: file,
  });
  return parseAppsResult(reply, parseAppStaged);
}

export async function stageGitHubApp(_projectPath: string, source: AppGitHubSource, tag: string | undefined): Promise<AppsResult<AppStaged>> {
  return parseAppsResult(await post('/studio/api/apps/github', { source, tag }), parseAppStaged);
}

/** Studio has no personal GitHub sign-in; the chooser never asks (it takes a pasted public repository), and this answers in kind. */
export async function listAppRepositories(_projectPath: string, _account: string): Promise<AppRepositoryListing> {
  return { kind: 'failed', ...described('apps.connect.pasteToConnect') };
}

export async function listAppReleases(_projectPath: string, source: AppGitHubSource): Promise<AppsResult<readonly AppRelease[]>> {
  return parseAppsResult(await post('/studio/api/apps/releases', { source }), parseAppReleases);
}

export async function commitApp(_projectPath: string, token: string): Promise<AppsResult<AppSummary>> {
  return parseAppsResult(await post('/studio/api/apps/commit', { token }), parseAppSummary);
}

export async function discardApp(_projectPath: string, token: string): Promise<void> {
  await post('/studio/api/apps/discard', { token });
}

export async function uninstallApp(_projectPath: string, id: string): Promise<AppsResult<readonly AppSummary[]>> {
  return parseAppsResult(await post('/studio/api/apps/uninstall', { id }), parseReadableAppSummaries);
}

export async function checkAppUpdates(_projectPath: string, force: { readonly force: boolean }): Promise<AppsResult<readonly AppUpdateOutcome[]>> {
  return parseAppsResult(await post('/studio/api/apps/updates', { force: force.force }), parseUpdateOutcomes);
}

export async function applyAppUpdate(_projectPath: string, id: string): Promise<AppsResult<AppSummary>> {
  return parseAppsResult(await post('/studio/api/apps/update', { id }), parseAppSummary);
}

function chooseZip(): Promise<File | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,application/zip';
    input.addEventListener('change', () => resolve(input.files?.[0] ?? undefined), { once: true });
    input.addEventListener('cancel', () => resolve(undefined), { once: true });
    input.click();
  });
}
