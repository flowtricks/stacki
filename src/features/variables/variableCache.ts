// The Variables panel's last read per project, outside the panel's lazy chunk,
// so the app can fill it before the panel first opens (panelPrefetch.ts).
import { createPanelCache, prewarmPanelCache } from '../../lib/usePanelData';
import { readCSSVariables, type VariablesSnapshot } from '../../ipc/variablesBridge';

export const variableCache = createPanelCache<VariablesSnapshot>();

/** Reads the project's variables into the cache the panel opens on. */
export function prewarmVariables(projectPath: string): Promise<void> {
  return prewarmPanelCache(variableCache, projectPath, () => readCSSVariables(projectPath));
}
