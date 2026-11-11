// The official app marketplace and the auto-update switch, from the renderer.
// Desktop asks the main process, which fetches the index and downloads approved
// versions (electron/handlers/appsHandlers.ts, electron/project/appMarketplace.ts);
// Stacki Studio replaces this module with its HTTP client
// (studio/scripts/shared-source.json, studio/src/features/apps/marketplaceClient.ts).
// Every reply is parsed before a component sees it.
import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import { parseAppSummary, parseAppsResult, type AppSummary, type AppsResult } from '../../shared/properties/apps';
import { parseReadableAppSummaries } from '../../shared/properties/appFolders';
import { parseMarketplaceIndex, type MarketplaceIndex } from '../../shared/properties/appMarketplace';
import { parseAppRepositoryPlaceReply, type AppRepositoryPlaceReply } from '../../shared/properties/appPlace';
import { readHostVersion } from './appDataBridge';
import { APPS_UNAVAILABLE_MESSAGE } from './appsBridge';

/** The marketplace index; `refresh` reads it again instead of reusing a recent copy. */
export async function loadMarketplace(projectPath: string, freshness: { readonly refresh: boolean }): Promise<AppsResult<MarketplaceIndex>> {
  // A main process from before the marketplace has no such method: the person restarts.
  if (typeof window.avb.appMarketplace !== 'function') {
    return { ok: false, message: APPS_UNAVAILABLE_MESSAGE };
  }
  const input = parseIpcPayload('apps:marketplace', { projectPath, refresh: freshness.refresh });
  return parseAppsResult(await window.avb.appMarketplace(input), parseMarketplaceIndex);
}

/** Installs an approved version; main refuses it unless its SHA-256 matches the index. */
export async function installMarketplaceApp(projectPath: string, id: string, version: string): Promise<AppsResult<AppSummary>> {
  const input = parseIpcPayload('apps:installMarketplace', { projectPath, id, version });
  return parseAppsResult(await window.avb.installMarketplaceApp(input), parseAppSummary);
}

/** Switches one app's auto-update; replies with the installed apps as they now are. */
export async function setAppAutoUpdate(projectPath: string, id: string, policy: { readonly autoUpdate: boolean }): Promise<AppsResult<readonly AppSummary[]>> {
  const input = parseIpcPayload('apps:setAutoUpdate', { projectPath, id, autoUpdate: policy.autoUpdate });
  return parseAppsResult(await window.avb.setAppAutoUpdate(input), parseReadableAppSummaries);
}

/**
 * An installed app's GitHub repository and its visibility, for the row's pills.
 * Main reads it with the publishing account's token and caches it; a main
 * process from before the lookup answers nothing, as a failed lookup does.
 */
export async function loadAppRepositoryPlace(projectPath: string, id: string): Promise<AppsResult<AppRepositoryPlaceReply>> {
  if (typeof window.avb.appRepositoryVisibility !== 'function') {
    return { ok: true, value: { place: undefined } };
  }
  const input = parseIpcPayload('apps:repositoryVisibility', { projectPath, id });
  return parseAppsResult(await window.avb.appRepositoryVisibility(input), parseAppRepositoryPlaceReply);
}

/** This Stacki's version, so a marketplace row can say an app needs a newer one; `unknown` when main cannot say. */
export async function readStackiVersion(): Promise<string> {
  return readHostVersion();
}
