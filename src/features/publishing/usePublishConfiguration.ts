import { useEffect, useState } from 'react';
import { parsePublishSource, type PublishConfig } from '../../../shared/properties/publishConfig';
import type { PublishAvailability } from '../../../shared/properties/publishState';
import { readMetadata } from '../../ipc/projectMetadataBridge';
import { cachedPublishingDiscovery } from './publishDiscoveryCache';

type Configuration = { readonly kind: 'loading' | 'error' } | { readonly kind: 'saved' | 'detected' | 'missing'; readonly config: PublishConfig };

export function usePublishConfiguration(
  projectPath: string,
  refresh: {
    readonly open: boolean;
    readonly settings: boolean;
    readonly checking: boolean;
  },
) {
  const [state, setState] = useState<{
    readonly projectPath: string;
    readonly configuration: Configuration;
  }>({ projectPath, configuration: { kind: 'loading' } });
  useEffect(() => {
    let active = true;
    void readPublishConfiguration(projectPath)
      .then((configuration) => {
        if (active) {
          setState({ projectPath, configuration });
        }
      })
      .catch(() => {
        if (active) {
          setState({ projectPath, configuration: { kind: 'error' } });
        }
      });
    return () => {
      active = false;
    };
  }, [projectPath, refresh.open, refresh.settings, refresh.checking]);
  return state.projectPath === projectPath ? state.configuration : { kind: 'loading' as const };
}

export function configuredPublishAvailability(availability: PublishAvailability, configuration: Configuration): PublishAvailability {
  if (configuration.kind === 'saved') {
    if (configuration.config.hosting.provider === 'none') {
      return availability;
    }
    // Settings can finish saving before the background deployment check catches up.
    if (availability.hosting === 'unconfigured') {
      return { ...availability, hosting: 'unknown' };
    }
  } else if (configuration.kind === 'detected') {
    // A linked destination has no recorded Stacki deployment until its first publish.
    return availability.hosting === 'current' ? availability : { ...availability, hosting: 'pending' };
  } else if (configuration.kind !== 'missing' && availability.hosting === 'unconfigured') {
    return { ...availability, hosting: 'unknown' };
  }
  return availability;
}

async function readPublishConfiguration(projectPath: string): Promise<Configuration> {
  const file = await readMetadata(projectPath, 'publish');
  const config = parsePublishSource(file.source);
  if (file.source !== undefined) {
    return { kind: 'saved', config };
  }
  // Match the settings form's discovery without silently saving a deployment destination.
  const result = await cachedPublishingDiscovery(projectPath, { provider: 'linked', account: '' }, 'reuse');
  if (result.kind !== 'ready') {
    return { kind: 'error' };
  }
  const linked = result.projects.length === 1 ? result.projects[0] : undefined;
  return linked === undefined ? { kind: 'missing', config } : { kind: 'detected', config: { ...config, hosting: linked.hosting } };
}
