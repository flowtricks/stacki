import { useEffect, useState } from 'react';
import type { Hosting, PublishConfig } from '../../../shared/properties/publishConfig';
import { cachedPublishingDiscovery } from './publishDiscoveryCache';

export function usePublishSettingsConfig(projectPath: string, stored: { readonly config: PublishConfig; readonly base: string | undefined }) {
  const [state, setState] = useState<{
    readonly config: PublishConfig;
    readonly hostingOrigin: 'discovering' | 'settled';
  }>({
    config: stored.config,
    hostingOrigin: stored.base === undefined ? 'discovering' : 'settled',
  });
  const { config, hostingOrigin } = state;
  useEffect(() => {
    if (hostingOrigin === 'settled') {
      return;
    }
    let active = true;
    // GitHub and the editable form can load while the existing hosting link is resolved.
    void cachedPublishingDiscovery(projectPath, { provider: 'linked', account: '' }, 'reuse')
      .then((result) => {
        if (active) {
          const linked = result.kind === 'ready' && result.projects.length === 1 ? result.projects[0] : undefined;
          setState((previous) => {
            if (previous.hostingOrigin === 'settled') {
              return previous;
            }
            return {
              config: linked ? { ...previous.config, hosting: linked.hosting } : previous.config,
              hostingOrigin: 'settled',
            };
          });
        }
      })
      .catch(() => {
        if (active) {
          setState((previous) => ({ ...previous, hostingOrigin: 'settled' }));
        }
      });
    return () => {
      active = false;
    };
  }, [projectPath, hostingOrigin]);
  function changeHosting(hosting: Hosting) {
    // An explicit choice, including None, cancels automatic prefilling.
    setState((previous) => ({
      config: { ...previous.config, hosting },
      hostingOrigin: 'settled',
    }));
  }
  function changeConfig(next: PublishConfig) {
    setState((previous) => ({
      config: next,
      hostingOrigin: next.hosting === previous.config.hosting ? previous.hostingOrigin : 'settled',
    }));
  }
  return {
    config,
    changeConfig,
    changeHosting,
    discoveringHosting: hostingOrigin === 'discovering',
  };
}
