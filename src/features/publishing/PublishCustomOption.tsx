// A custom host's row in the Publish menu. It says only what Stacki can know: that a script ran or a request was
// sent, never that the site is live. A host that deploys from GitHub has nothing here to press.
import type { CustomHosting } from '../../../shared/properties/publishConfig';
import type { PublishAvailability } from '../../../shared/properties/publishState';
import { useFormat, useTranslate } from '../../lib/i18n/useTranslate';
import { PublishProviderIcon } from './PublishProviderIcon';
import { OpenSiteLink } from './PublishSiteLink';

interface Props {
  readonly custom: CustomHosting;
  readonly availability: PublishAvailability;
  readonly busy: boolean;
  readonly publish: () => void;
  readonly url: string | undefined;
  /** Whether the menu also offers staging, which is when this row has to say it is production. */
  readonly staged: boolean;
}

export function CustomHostOption({ custom, availability, busy, publish, url, staged }: Props) {
  const translate = useTranslate();
  const format = useFormat();
  const fromGitHub = custom.deploy === 'github';
  const sent = translate(custom.deploy === 'script' ? 'publish.custom.scriptRan' : 'publish.custom.requestSent');
  const descriptions = {
    current: sent,
    pending: translate('publish.menu.hostingPending'),
    unknown: translate('publish.menu.hostingUnknown'),
    unconfigured: translate('publish.menu.hostingUnknown'),
  } as const;
  const status = fromGitHub ? translate('publish.custom.updatesFromGitHub') : descriptions[availability.hosting];
  const publishedAtMs = fromGitHub || !staged ? undefined : availability.hostingPublishedAtMs;
  const named = custom.hostName === undefined ? undefined : translate('publish.custom.deployTo', { host: custom.hostName });
  const deploy = staged ? translate('publish.staging.menu.production') : (named ?? translate('publish.menu.deploy'));
  const title = fromGitHub
    ? translate('publish.custom.updatesFromGitHubTip')
    : custom.deploy === 'link'
      ? translate('publish.custom.linkBuildsGitHub')
      : undefined;
  return (
    <span className="stacki-publish-option stacki-publish-hosting" title={title}>
      {/* Deploying again stays possible: only the host knows whether the last one worked. */}
      <button disabled={busy || fromGitHub} onClick={publish}>
        <PublishProviderIcon provider="custom" />
        <span>
          {fromGitHub ? (custom.hostName ?? translate('publish.custom.yourHost')) : deploy}
          <small>
            {publishedAtMs === undefined
              ? status
              : translate('publish.staging.menu.published', { status, time: format.formatRelativeTime(publishedAtMs, Date.now()) })}
          </small>
        </span>
      </button>
      {url !== undefined && <OpenSiteLink url={url} label={translate('publish.menu.openSite')} />}
    </span>
  );
}
