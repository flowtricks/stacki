import { useEffect, useMemo, useState } from 'react';
import { readCSSVariables, type VariablesSnapshot } from '../../ipc/variablesBridge';
import { getHost } from './model/host';
import { panelListing, type PanelListing } from './model/panelVariableList';
import type { ProjectVariable } from './model/webflow';

// The Variables panel's snapshot for a chooser that lists the panel's variables (panelVariableList.ts),
// read through the panel's own reader (readCSSVariables). It opens on the last snapshot this module
// read for the project, so a second opening is drawn at once, and reads the project again as it
// opens, the way the panel revalidates, swapping the fresh snapshot in place. (The panel's own cache
// lives in the Variables feature, which the Style feature does not import.)

// The last snapshot read, for one project: a chooser is about the project that is open.
let last: { readonly projectPath: string; readonly snapshot: VariablesSnapshot } | undefined = undefined;

/**
 * The panel's listing while `active`, leaving out `self`; undefined until the project has a snapshot,
 * or when not active. `known` lends the picker's inferred types.
 */
export function usePanelListing(active: { readonly active: boolean }, self: string | undefined, known: readonly ProjectVariable[]): PanelListing | undefined {
  const projectPath = getHost().projectPath ?? '';
  const [snapshot, setSnapshot] = useState<VariablesSnapshot | undefined>(() => cachedSnapshot(projectPath));
  const enabled = active.active && projectPath !== '';
  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    let live = true;
    setSnapshot(cachedSnapshot(projectPath));
    void readCSSVariables(projectPath).then((result) => {
      if (live && result.ok) {
        last = { projectPath, snapshot: result.value };
        setSnapshot(result.value);
      }
    });
    return () => {
      live = false;
    };
  }, [enabled, projectPath]);
  return useMemo(() => (enabled && snapshot !== undefined ? panelListing(snapshot, { self, known }) : undefined), [enabled, snapshot, self, known]);
}

function cachedSnapshot(projectPath: string): VariablesSnapshot | undefined {
  if (projectPath === '') {
    return undefined;
  }
  return last?.projectPath === projectPath ? last.snapshot : undefined;
}
