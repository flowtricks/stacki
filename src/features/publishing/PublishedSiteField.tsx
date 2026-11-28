import type { PublishConfig } from '../../../shared/properties/publishConfig';
import { savedPublishedSite } from '../../../shared/properties/publishSite';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { withDetail } from './customHosting';
import { hostingKey } from './PublishHosting';

export function PublishedSiteField({ config, change }: { readonly config: PublishConfig; readonly change: (config: PublishConfig) => void }) {
  const translate = useTranslate();
  const hosting = config.hosting;
  const custom = config.customHosting;
  if (custom !== undefined) {
    // A custom host keeps its address with its own settings: `publishedSite` belongs to a provider destination.
    return (
      <label className="publish-field">
        <span className="publish-label">{translate('publish.site.label')}</span>
        <input
          type="url"
          value={custom.siteUrl ?? ''}
          placeholder="https://example.com"
          maxLength={2048}
          onChange={(event) => change({ ...config, customHosting: withDetail(custom, 'siteUrl', event.currentTarget.value.trim()) })}
        />
      </label>
    );
  }
  // The address belongs to a hosting project, so there is nothing to ask until one is chosen.
  if (hosting.provider === 'none' || hostingKey(hosting) === '') {
    return undefined;
  }
  return (
    <label className="publish-field">
      <span className="publish-label">{translate('publish.site.label')}</span>
      <input
        type="url"
        value={savedPublishedSite(config)?.url ?? ''}
        placeholder="https://example.com"
        maxLength={2048}
        onChange={(event) => {
          const url = event.currentTarget.value.trim();
          const { publishedSite: previous, ...withoutSite } = config;
          void previous;
          change(url === '' ? withoutSite : { ...withoutSite, publishedSite: { hosting, source: 'manual', url } });
        }}
      />
      <small>{translate('publish.site.hint')}</small>
    </label>
  );
}
