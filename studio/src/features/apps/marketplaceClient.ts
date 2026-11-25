// The official app marketplace and the auto-update switch from the Studio editor:
// the same calls as Desktop's bridge (src/ipc/appMarketplaceBridge.ts, which this
// module replaces in Studio through scripts/shared-source.json), over HTTP to the
// Studio server (appsServer.ts), which fetches the index and the approved
// downloads. The browser never reaches the index itself; it loads only the
// reviewed icons the index names.
import { parseAppSummary, parseAppsResult, type AppSummary, type AppsResult } from '../../../vendor/stacki/shared/properties/apps';
import { parseReadableAppSummaries } from '../../../vendor/stacki/shared/properties/appFolders';
import { parseMarketplaceIndex, type MarketplaceIndex } from '../../../vendor/stacki/shared/properties/appMarketplace';
import { parseAppRepositoryPlaceReply, type AppRepositoryPlaceReply } from '../../../vendor/stacki/shared/properties/appPlace';
import { request } from '../project/projectClient';
import { readStudioHostVersion } from './appDataClient';

async function post(url: string, body: unknown): Promise<unknown> {
  return request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export async function loadMarketplace(_projectPath: string, freshness: { readonly refresh: boolean }): Promise<AppsResult<MarketplaceIndex>> {
  return parseAppsResult(await post('/studio/api/apps/marketplace', { refresh: freshness.refresh }), parseMarketplaceIndex);
}

export async function installMarketplaceApp(_projectPath: string, id: string, version: string): Promise<AppsResult<AppSummary>> {
  return parseAppsResult(await post('/studio/api/apps/marketplace/install', { id, version }), parseAppSummary);
}

export async function setAppAutoUpdate(_projectPath: string, id: string, policy: { readonly autoUpdate: boolean }): Promise<AppsResult<readonly AppSummary[]>> {
  return parseAppsResult(await post('/studio/api/apps/auto-update', { id, autoUpdate: policy.autoUpdate }), parseReadableAppSummaries);
}

/** An installed app's GitHub repository; Studio reads it anonymously, so it says "public" only when GitHub confirms it. */
export async function loadAppRepositoryPlace(_projectPath: string, id: string): Promise<AppsResult<AppRepositoryPlaceReply>> {
  return parseAppsResult(await post('/studio/api/apps/visibility', { id }), parseAppRepositoryPlaceReply);
}

/** This Studio's version, so a marketplace row can say an app needs a newer one; `unknown` when the server cannot say. */
export async function readStackiVersion(): Promise<string> {
  return readStudioHostVersion();
}
