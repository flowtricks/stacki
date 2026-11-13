import { useEffect, useState } from 'react';
import { parsePublishSource, type PublishConfig } from '../../../shared/properties/publishConfig';
import { hostingSiteKey, savedPublishedSite } from '../../../shared/properties/publishSite';
import { readMetadata, writeMetadata } from '../../ipc/projectMetadataBridge';
import { reportErrorToast } from '../../ui/errorNotices';
import { readPublishedSiteURL } from './publishBridge';
import { useTranslate } from '../../lib/i18n/useTranslate';

export function usePublishedSiteURL(projectPath: string, config: PublishConfig | undefined) {
  const translate = useTranslate();
  const destination = config === undefined ? undefined : hostingSiteKey(config.hosting);
  const saved = config === undefined ? undefined : savedPublishedSite(config);
  const savedURL = saved?.url;
  const manual = saved?.source === 'manual';
  const [known, setKnown] = useState<{
    readonly projectPath: string;
    readonly destination: string;
    readonly url: string;
  }>();
  useEffect(() => {
    if (destination === undefined) {
      return undefined;
    }
    if (manual) {
      return undefined;
    }
    let active = true;
    void readPublishedSiteURL(projectPath).then(async (url) => {
      if (!active) {
        return;
      }
      if (url === undefined) {
        return;
      }
      const current = await rememberPublishedSite(projectPath, destination, url, () => active).catch(() => {
        reportErrorToast(translate('publish.site.saveFailed'));
        return false;
      });
      if (active) {
        if (current) {
          setKnown({ projectPath, destination, url });
        }
      }
    });
    return () => {
      active = false;
    };
  }, [projectPath, destination, manual, savedURL, translate]);
  if (manual) {
    return savedURL;
  }
  if (known?.projectPath === projectPath) {
    if (known.destination === destination) {
      return known.url;
    }
  }
  return savedURL;
}

async function rememberPublishedSite(projectPath: string, destination: string, url: string, active: () => boolean): Promise<boolean> {
  const file = await readMetadata(projectPath, 'publish');
  if (!active()) {
    return false;
  }
  // Merely inspecting an existing provider link must not create project settings.
  if (file.source === undefined) {
    return true;
  }
  const config = parsePublishSource(file.source);
  if (hostingSiteKey(config.hosting) !== destination) {
    return false;
  }
  if (config.hosting.provider === 'none') {
    return true;
  }
  const saved = savedPublishedSite(config);
  if (saved?.source === 'manual') {
    return false;
  }
  if (saved?.url === url) {
    return true;
  }
  await writeMetadata(projectPath, {
    kind: 'publish',
    base: file.source,
    source: JSON.stringify({ ...config, publishedSite: { hosting: config.hosting, source: 'discovered', url } }, undefined, 2) + '\n',
  });
  return true;
}
