// Stacki Apps from the renderer: install, update and remove apps, and the
// address an app's frame loads from. Desktop asks the main process, which holds
// the GitHub calls and the files (electron/handlers/appsHandlers.ts); Stacki
// Studio replaces this module with its HTTP client (studio/scripts/shared-source.json,
// studio/src/features/apps/appsClient.ts). Every reply is parsed before a component sees it.
import { assert } from '../../shared/core/assert';
import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import {
  parseAppReleases,
  parseAppRepositories,
  parseAppStaged,
  parseAppSummary,
  parseAppsResult,
  parseRateLimitMessage,
  parseUpdateOutcomes,
  type AppGitHubSource,
  type AppRelease,
  type AppRepository,
  type AppRepositoryListing,
  type AppStaged,
  type AppSummary,
  type AppUpdateOutcome,
  type AppsResult,
} from '../../shared/properties/apps';
import { parseInstalledAppList, parseReadableAppSummaries, type InstalledAppList } from '../../shared/properties/appFolders';

/** Where app frames load from: one origin per app. */
export function appFrameURL(appId: string, filePath: string): string {
  return `stacki-app://${appId}/${filePath.split('/').map(encodeURIComponent).join('/')}`;
}

/** What the panel says when the main process predates Apps (a renderer reloaded without a restart). */
export const APPS_UNAVAILABLE_MESSAGE = 'Restart Stacki to use Apps.';

/** The installed apps this editor can run; an app it cannot read is left out here and listed as broken by `listInstalledAppList`. */
export async function listApps(projectPath: string): Promise<AppsResult<readonly AppSummary[]>> {
  const answer = await listInstalledAppList(projectPath);
  return answer.ok ? { ok: true, value: answer.value.apps } : answer;
}

/** The Installed list, read one app at a time: one unreadable app is a broken row, never the whole list's failure. */
export async function listInstalledAppList(projectPath: string): Promise<AppsResult<InstalledAppList>> {
  // An older preload has no method; an older main has no handler. Both mean the same to the person: restart.
  if (typeof window.avb.listApps !== 'function') {
    return { ok: false, message: APPS_UNAVAILABLE_MESSAGE };
  }
  const input = parseIpcPayload('apps:list', { projectPath });
  let reply: unknown;
  try {
    reply = await window.avb.listApps(input);
  } catch (error: unknown) {
    if (String(error).includes('No handler registered')) {
      return { ok: false, message: APPS_UNAVAILABLE_MESSAGE };
    }
    throw error;
  }
  return parseAppsResult(reply, parseInstalledAppList);
}

/** Opens the system file dialog and checks the chosen zip; undefined when cancelled. */
export async function chooseAppFile(projectPath: string): Promise<AppsResult<AppStaged | undefined>> {
  const input = parseIpcPayload('apps:pickFile', { projectPath });
  return parseAppsResult(await window.avb.pickAppFile(input), (value) => (value === undefined ? undefined : parseAppStaged(value)));
}

/** Downloads a release's app bundle (the latest release, or `tag`) and checks it; nothing is installed yet. */
export async function stageGitHubApp(projectPath: string, source: AppGitHubSource, tag: string | undefined): Promise<AppsResult<AppStaged>> {
  const input = parseIpcPayload('apps:stageGitHub', { projectPath, source, tag });
  return parseAppsResult(await window.avb.stageGitHubApp(input), parseAppStaged);
}

/**
 * The repositories a signed-in GitHub account can read (the publish flow's
 * account). A main process older than this renderer (no method, no handler, or a
 * reply this parser no longer accepts) answers `restart` rather than a parse
 * error, and GitHub's rate limit answers `rate-limited` with its reset time.
 */
export async function listAppRepositories(projectPath: string, account: string): Promise<AppRepositoryListing> {
  if (typeof window.avb.appRepositories !== 'function') {
    return { kind: 'restart' };
  }
  const input = parseIpcPayload('apps:githubRepositories', { projectPath, account });
  let reply: unknown;
  try {
    reply = await window.avb.appRepositories(input);
  } catch (error: unknown) {
    if (String(error).includes('No handler registered')) {
      return { kind: 'restart' };
    }
    throw error;
  }
  return repositoryListing(reply);
}

/** A repository-list reply as the chooser's listing. Exported for its test. */
export function repositoryListing(reply: unknown): AppRepositoryListing {
  let result: AppsResult<readonly AppRepository[]>;
  try {
    result = parseAppsResult(reply, parseAppRepositories);
  } catch (error: unknown) {
    // The reply is the main process's own: a shape this renderer refuses means
    // the two are different versions, which only a restart makes one again.
    if (error instanceof Error && error.message.startsWith('Assertion failed')) {
      throw error; // A broken invariant is a bug to crash on, never a version mismatch (AGENTS.md §3).
    }
    return { kind: 'restart' };
  }
  if (result.ok) {
    return { kind: 'ready', repositories: result.value };
  }
  const limited = parseRateLimitMessage(result.message);
  if (limited !== undefined) {
    return { kind: 'rate-limited', resetAtMs: limited.resetAtMs };
  }
  assert(result.message.length > 0, 'A failure says what failed');
  return { kind: 'failed', message: result.message };
}

/** A repository's releases; `source.account` reads a private one. The asset name is not used. */
export async function listAppReleases(projectPath: string, source: AppGitHubSource): Promise<AppsResult<readonly AppRelease[]>> {
  const input = parseIpcPayload('apps:githubReleases', { projectPath, source });
  return parseAppsResult(await window.avb.appReleases(input), parseAppReleases);
}

export async function commitApp(projectPath: string, token: string): Promise<AppsResult<AppSummary>> {
  const input = parseIpcPayload('apps:commit', { projectPath, token });
  return parseAppsResult(await window.avb.commitApp(input), parseAppSummary);
}

export async function discardApp(projectPath: string, token: string): Promise<void> {
  const input = parseIpcPayload('apps:discard', { projectPath, token });
  await window.avb.discardApp(input);
}

export async function uninstallApp(projectPath: string, id: string): Promise<AppsResult<readonly AppSummary[]>> {
  const input = parseIpcPayload('apps:uninstall', { projectPath, id });
  return parseAppsResult(await window.avb.uninstallApp(input), parseReadableAppSummaries);
}

export async function checkAppUpdates(projectPath: string, force: { readonly force: boolean }): Promise<AppsResult<readonly AppUpdateOutcome[]>> {
  const input = parseIpcPayload('apps:checkUpdates', { projectPath, force: force.force });
  return parseAppsResult(await window.avb.checkAppUpdates(input), parseUpdateOutcomes);
}

/** Installs the update a check found, from the bytes that were checked. */
export async function applyAppUpdate(projectPath: string, id: string): Promise<AppsResult<AppSummary>> {
  const input = parseIpcPayload('apps:applyUpdate', { projectPath, id });
  return parseAppsResult(await window.avb.applyAppUpdate(input), parseAppSummary);
}
