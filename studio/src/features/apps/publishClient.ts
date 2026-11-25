// Sharing, publishing and app settings from the Studio editor: the same calls as
// Desktop's bridge (src/ipc/appPublishBridge.ts, which this module replaces in
// Studio through scripts/shared-source.json), over HTTP to the Studio server
// (appsServer.ts). Studio holds no GitHub sign-in, so the server reads public
// repositories and the marketplace, and answers that creating or changing a
// repository needs Stacki Desktop. Every reply is parsed before a component sees it.
import { parseAppSummary, parseAppsResult, type AppGitHubSource, type AppSummary, type AppsResult } from '../../../vendor/stacki/shared/properties/apps';
import { parseAppSecretScan, type AppSecretScan } from '../../../vendor/stacki/shared/properties/appSecrets';
import { parseAppSettingValuesReply, type AppSettingValues } from '../../../vendor/stacki/shared/properties/appSettings';
import {
  parseAppRepositoryStatus,
  parseAppShareOutcome,
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
} from '../../../vendor/stacki/shared/properties/appPublish';
import { request } from '../project/projectClient';

async function post(url: string, body: unknown): Promise<unknown> {
  return request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export async function scanAppSecrets(_projectPath: string, target: AppScanTarget): Promise<AppsResult<AppSecretScan>> {
  return parseAppsResult(await post('/studio/api/apps/publish/scan', { target }), parseAppSecretScan);
}

export async function appRepositoryStatus(_projectPath: string, repository: AppRepositoryRef): Promise<AppsResult<AppRepositoryStatus>> {
  return parseAppsResult(await post('/studio/api/apps/publish/status', { repository }), parseAppRepositoryStatus);
}

export async function makeRepositoryPublic(_projectPath: string, repository: AppRepositoryRef): Promise<AppsResult<AppVisibilityOutcome>> {
  return parseAppsResult(await post('/studio/api/apps/publish/make-public', { repository }), parseAppVisibilityOutcome);
}

export async function addAppLicense(_projectPath: string, repository: AppRepositoryRef): Promise<AppsResult<AppRepositoryStatus>> {
  return parseAppsResult(await post('/studio/api/apps/publish/add-license', { repository }), parseAppRepositoryStatus);
}

/** Studio's server cannot create repositories, so no step ever starts; the reply says why. */
export async function shareApp(_projectPath: string, share: AppShareRequest, _onStep: (step: AppShareStep) => void): Promise<AppsResult<AppShareOutcome>> {
  return parseAppsResult(await post('/studio/api/apps/publish/share', { share }), parseAppShareOutcome);
}

export async function switchAppSource(_projectPath: string, id: string, source: AppGitHubSource & { readonly tag: string }): Promise<AppsResult<AppSummary>> {
  return parseAppsResult(await post('/studio/api/apps/publish/switch-source', { id, source }), parseAppSummary);
}

export async function checkMarketplaceApp(_projectPath: string, repository: AppRepositoryRef): Promise<AppsResult<MarketplacePrecheck>> {
  return parseAppsResult(await post('/studio/api/apps/publish/check', { repository }), parseMarketplacePrecheck);
}

export async function submitMarketplaceApp(_projectPath: string, submission: MarketplaceSubmission): Promise<AppsResult<MarketplaceSubmissionOutcome>> {
  return parseAppsResult(await post('/studio/api/apps/publish/submit', { submission }), parseSubmissionOutcome);
}

export async function readAppSettings(_projectPath: string, id: string): Promise<AppsResult<AppSettingValues>> {
  return parseAppsResult(await post('/studio/api/apps/settings/read', { id }), parseAppSettingValuesReply);
}

export async function writeAppSettings(_projectPath: string, id: string, values: AppSettingValues): Promise<AppsResult<AppSettingValues>> {
  return parseAppsResult(await post('/studio/api/apps/settings/write', { id, values }), parseAppSettingValuesReply);
}
