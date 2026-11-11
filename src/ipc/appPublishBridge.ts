// Sharing apps to GitHub, publishing them to the marketplace, and app settings,
// from the renderer. Desktop asks the main process, which holds the GitHub
// sign-in and the secret vault (electron/handlers/appsHandlers.ts); Stacki Studio
// replaces this module with its HTTP client (studio/scripts/shared-source.json,
// studio/src/features/apps/publishClient.ts). Every reply is parsed before a
// component sees it.
import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import { parseAppSummary, parseAppsResult, type AppGitHubSource, type AppSummary, type AppsResult } from '../../shared/properties/apps';
import { parseAppSecretScan, type AppSecretScan } from '../../shared/properties/appSecrets';
import { parseAppSettingValuesReply, type AppSettingValues } from '../../shared/properties/appSettings';
import {
  parseAppRepositoryStatus,
  parseAppShareOutcome,
  parseAppShareProgress,
  parseAppVisibilityOutcome,
  parseMarketplacePrecheck,
  parseSubmissionOutcome,
  type AppRepositoryRef,
  type AppRepositoryStatus,
  type AppScanTarget,
  type AppShareOutcome,
  type AppShareRequest,
  type AppShareStep,
  type AppVisibilityOutcome,
  type MarketplacePrecheck,
  type MarketplaceSubmission,
  type MarketplaceSubmissionOutcome,
} from '../../shared/properties/appPublish';
import { APPS_UNAVAILABLE_MESSAGE } from './appsBridge';

/** Scans an installed app's files, or a repository's latest release, for secrets. */
export async function scanAppSecrets(projectPath: string, target: AppScanTarget): Promise<AppsResult<AppSecretScan>> {
  if (typeof window.avb.scanAppSecrets !== 'function') {
    return { ok: false, message: APPS_UNAVAILABLE_MESSAGE };
  }
  const input = parseIpcPayload('apps:scanSecrets', { projectPath, target });
  return parseAppsResult(await window.avb.scanAppSecrets(input), parseAppSecretScan);
}

/** What the marketplace checklist needs to know about a repository. */
export async function appRepositoryStatus(projectPath: string, repository: AppRepositoryRef): Promise<AppsResult<AppRepositoryStatus>> {
  const input = parseIpcPayload('apps:repositoryStatus', { projectPath, repository });
  return parseAppsResult(await window.avb.appRepositoryStatus(input), parseAppRepositoryStatus);
}

/** Makes a repository public; main scans it first and refuses unless clean. */
export async function makeRepositoryPublic(projectPath: string, repository: AppRepositoryRef): Promise<AppsResult<AppVisibilityOutcome>> {
  const input = parseIpcPayload('apps:makePublic', { projectPath, repository });
  return parseAppsResult(await window.avb.makeAppRepositoryPublic(input), parseAppVisibilityOutcome);
}

/** Commits the MIT license to a repository; answers its status afterwards. */
export async function addAppLicense(projectPath: string, repository: AppRepositoryRef): Promise<AppsResult<AppRepositoryStatus>> {
  const input = parseIpcPayload('apps:addLicense', { projectPath, repository });
  return parseAppsResult(await window.avb.addAppLicense(input), parseAppRepositoryStatus);
}

/** Shares an uploaded app to GitHub; `onStep` hears each step as main starts it. */
export async function shareApp(projectPath: string, share: AppShareRequest, onStep: (step: AppShareStep) => void): Promise<AppsResult<AppShareOutcome>> {
  const input = parseIpcPayload('apps:share', { projectPath, share });
  const stop = window.avb.onAppShareProgress((data) => {
    const progress = parseAppShareProgress(data);
    if (progress.id === share.id) {
      onStep(progress.step);
    }
  });
  try {
    return parseAppsResult(await window.avb.shareApp(input), parseAppShareOutcome);
  } finally {
    stop();
  }
}

/** Switches an uploaded app to the release it was shared as. */
export async function switchAppSource(projectPath: string, id: string, source: AppGitHubSource & { readonly tag: string }): Promise<AppsResult<AppSummary>> {
  const input = parseIpcPayload('apps:switchSource', { projectPath, id, source });
  return parseAppsResult(await window.avb.switchAppSource(input), parseAppSummary);
}

/** Asks the marketplace whether it would accept a repository, after the local checks. */
export async function checkMarketplaceApp(projectPath: string, repository: AppRepositoryRef): Promise<AppsResult<MarketplacePrecheck>> {
  const input = parseIpcPayload('apps:checkMarketplace', { projectPath, repository });
  return parseAppsResult(await window.avb.checkMarketplaceApp(input), parseMarketplacePrecheck);
}

/** Submits a repository's latest release to the marketplace. */
export async function submitMarketplaceApp(projectPath: string, submission: MarketplaceSubmission): Promise<AppsResult<MarketplaceSubmissionOutcome>> {
  const input = parseIpcPayload('apps:submitMarketplace', { projectPath, submission });
  return parseAppsResult(await window.avb.submitMarketplaceApp(input), parseSubmissionOutcome);
}

/** One app's settings, secrets included, for its details panel and `stacki.settings.get()`. */
export async function readAppSettings(projectPath: string, id: string): Promise<AppsResult<AppSettingValues>> {
  if (typeof window.avb.readAppSettings !== 'function') {
    return { ok: false, message: APPS_UNAVAILABLE_MESSAGE };
  }
  const input = parseIpcPayload('apps:readSettings', { projectPath, id });
  return parseAppsResult(await window.avb.readAppSettings(input), parseAppSettingValuesReply);
}

/** Replaces one app's settings; secrets go to the vault outside the project. */
export async function writeAppSettings(projectPath: string, id: string, values: AppSettingValues): Promise<AppsResult<AppSettingValues>> {
  const input = parseIpcPayload('apps:writeSettings', { projectPath, id, values });
  return parseAppsResult(await window.avb.writeAppSettings(input), parseAppSettingValuesReply);
}
