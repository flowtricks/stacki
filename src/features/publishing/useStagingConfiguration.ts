import { useEffect, useState } from 'react';
import { stagingDestination, type Destination } from '../../../shared/properties/publishDestinations';
import { STAGING_SUPPORT } from '../../ipc/publishCustomBridge';
import { readStoredDestinations } from './useStagingSettings';

/** The saved staging destination the Publish menu offers; none where this host cannot publish to staging. */
export function useStagingConfiguration(
  projectPath: string,
  refresh: { readonly open: boolean; readonly settings: boolean; readonly checking: boolean },
): Destination | undefined {
  const [state, setState] = useState<{ readonly projectPath: string; readonly staging: Destination | undefined }>();
  useEffect(() => {
    if (!STAGING_SUPPORT) {
      return undefined;
    }
    let active = true;
    void readStoredDestinations(projectPath).then((stored) => {
      if (active) {
        setState({ projectPath, staging: stored.kind === 'read' ? stagingDestination(stored.destinations) : undefined });
      }
    });
    return () => {
      active = false;
    };
  }, [projectPath, refresh.open, refresh.settings, refresh.checking]);
  return state?.projectPath === projectPath ? state.staging : undefined;
}
