// The Assets panel's last listing per project, in its own module so the app can
// fill it before the panel first opens (panelPrefetch.ts), and so tests that
// stub the panel still reach it.
import { createPanelCache, prewarmPanelCache } from '../../lib/usePanelData';
import { readAssetListing, type AssetPanelEntry } from './assetPanelBridge';

export interface AssetListing {
  readonly entries: readonly AssetPanelEntry[];
  readonly missing: boolean;
}

export const assetCache = createPanelCache<AssetListing>();

/** Reads the project's assets into the cache the panel opens on. */
export function prewarmAssetListing(projectPath: string): Promise<void> {
  return prewarmPanelCache(assetCache, projectPath, () => readAssetListing(projectPath));
}
