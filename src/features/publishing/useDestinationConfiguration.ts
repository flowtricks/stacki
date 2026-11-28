import { useEffect, useState } from 'react';
import type { Destination } from '../../../shared/properties/publishDestinations';
import { DESTINATION_SUPPORT } from '../../ipc/publishCustomBridge';
import { readStoredDestinations } from './useDestinationSettings';

const NONE: readonly Destination[] = [];

/** The saved destinations the Publish menu offers; none where this host cannot publish to them. */
export function useDestinationConfiguration(
  projectPath: string,
  refresh: { readonly open: boolean; readonly settings: boolean; readonly checking: boolean },
): readonly Destination[] {
  const [state, setState] = useState<{ readonly projectPath: string; readonly destinations: readonly Destination[] }>();
  useEffect(() => {
    if (!DESTINATION_SUPPORT) {
      return undefined;
    }
    let active = true;
    void readStoredDestinations(projectPath).then((stored) => {
      if (active) {
        setState({ projectPath, destinations: stored.kind === 'read' ? stored.destinations.destinations : NONE });
      }
    });
    return () => {
      active = false;
    };
  }, [projectPath, refresh.open, refresh.settings, refresh.checking]);
  return state?.projectPath === projectPath ? state.destinations : NONE;
}
