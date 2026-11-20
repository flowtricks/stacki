// Reads the project's new-style locations into the panel's store (model/newStyleTagSettings.ts)
// when a project opens, and again when the window returns, so a change made by the CLI, by git or in
// the other app is the one the next write uses. A project without the section gets the older single
// template for both scopes, or Stacki's default.

import { useEffect } from 'react';
import { DEFAULT_NEW_STYLE_LOCATIONS } from '../../../../shared/properties/newStyleLocations';
import { readNewStyleLocations } from '../../../ipc/newStyleTagBridge';
import { getHost } from '../model/host';
import { publishNewStyleLocations } from '../model/newStyleTagSettings';

export function useNewStyleTagSettings(): void {
  const projectPath = getHost().projectPath;
  useEffect(() => {
    if (projectPath === undefined) {
      publishNewStyleLocations(DEFAULT_NEW_STYLE_LOCATIONS);
      return undefined;
    }
    let live = true;
    const load = (): void => {
      readNewStyleLocations(projectPath).then(
        (locations) => {
          if (live) {
            publishNewStyleLocations(locations);
          }
        },
        () => {
          // An unreadable file leaves the last known setting; the Settings page shows the reason.
        },
      );
    };
    load();
    window.addEventListener('focus', load);
    return () => {
      live = false;
      window.removeEventListener('focus', load);
    };
  }, [projectPath]);
}
