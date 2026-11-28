// Staging's row in the Publish menu: its own action, status, last publish and site. Its tooltip says what pressing
// it sends where.
import type { Destination } from '../../../shared/properties/publishDestinations';
import type { PublishAvailability } from '../../../shared/properties/publishState';
import { useFormat, useTranslate } from '../../lib/i18n/useTranslate';
import { UploadCloudIcon } from '../../ui/Icons';
import { OpenSiteLink } from './PublishSiteLink';

interface Props {
  readonly staging: Destination;
  readonly availability: PublishAvailability;
  readonly busy: boolean;
  readonly publish: () => void;
  /** The staging branch, for a destination whose publish pushes it. */
  readonly pushes: string | undefined;
}

export function StagingOption({ staging, availability, busy, publish, pushes }: Props) {
  const translate = useTranslate();
  const format = useFormat();
  const known = availability.staging;
  const kind = staging.target.kind;
  // A script or a request can always be run again: only the host knows whether the last one worked.
  const current = known?.state === 'current' && kind !== 'script' && kind !== 'link';
  const descriptions = {
    current: translate('publish.staging.menu.current'),
    pending: translate('publish.staging.menu.pending'),
    unknown: translate('publish.staging.menu.unknown'),
  } as const;
  const sent = kind === 'script' ? 'publish.custom.scriptRan' : kind === 'link' ? 'publish.custom.requestSent' : undefined;
  const status = known?.state === 'current' && sent !== undefined ? translate(sent) : descriptions[known?.state ?? 'unknown'];
  const url = staging.siteUrl ?? known?.url;
  const title =
    pushes === undefined ? translate('publish.staging.menu.deploysFromComputer') : translate('publish.staging.menu.pushesBranch', { branch: pushes });
  return (
    <span className="stacki-publish-option stacki-publish-hosting stacki-publish-staging" title={title}>
      <button disabled={busy || current} onClick={publish}>
        <UploadCloudIcon />
        <span>
          {staging.name === undefined ? translate('publish.staging.menu.publish') : translate('publish.staging.menu.publishNamed', { name: staging.name })}
          <small>
            {known?.publishedAtMs === undefined
              ? status
              : translate('publish.staging.menu.published', { status, time: format.formatRelativeTime(known.publishedAtMs, Date.now()) })}
          </small>
        </span>
      </button>
      {url !== undefined && <OpenSiteLink url={url} label={translate('publish.staging.menu.openSite')} />}
    </span>
  );
}
