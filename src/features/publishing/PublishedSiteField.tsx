import type { PublishConfig } from '../../../shared/properties/publishConfig';
import { savedPublishedSite } from '../../../shared/properties/publishSite';
import { useTranslate } from '../../lib/i18n/useTranslate';

export function PublishedSiteField({ config, change }: { readonly config: PublishConfig; readonly change: (config: PublishConfig) => void }) {
  const translate = useTranslate();
  const hosting = config.hosting;
  if (hosting.provider === 'none') {
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
