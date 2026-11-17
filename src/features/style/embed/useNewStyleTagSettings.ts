// Reads the project's `newStyleTag` setting into the panel's store (model/newStyleTagSettings.ts)
// when a project opens, and again when the window returns, so a change made by the CLI, by git or in
// the other app is the one the next write uses. A project without the file gets Stacki's default.

import { useEffect } from 'react';
import { DEFAULT_NEW_STYLE_TAG } from '../../../../shared/properties/newStyleTag';
import { readNewStyleTag } from '../../../ipc/newStyleTagBridge';
import { getHost } from '../model/host';
import { publishNewStyleTagSettings } from '../model/newStyleTagSettings';

export function useNewStyleTagSettings(): void {
  const projectPath = getHost().projectPath;
  useEffect(() => {
    if (projectPath === undefined) {
      publishNewStyleTagSettings(DEFAULT_NEW_STYLE_TAG);
      return undefined;
    }
    let live = true;
    const load = (): void => {
      readNewStyleTag(projectPath).then(
        (settings) => {
          if (live) {
            publishNewStyleTagSettings(settings);
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
