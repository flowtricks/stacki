// A destination's row in the Publish menu: its own action, status, last publish and site. Its tooltip says what
// pressing it sends where.
import { destinationBranch, destinationProvider, type Destination } from '../../../shared/properties/publishDestinations';
import type { DestinationStatus } from '../../../shared/properties/publishState';
import { useFormat, useTranslate } from '../../lib/i18n/useTranslate';
import { PublishProviderIcon } from './PublishProviderIcon';
import { OpenSiteLink } from './PublishSiteLink';

interface Props {
  readonly destination: Destination;
  /** Absent until a check has answered for this destination. */
  readonly status: DestinationStatus | undefined;
  readonly busy: boolean;
  readonly publish: () => void;
}

export function DestinationOption({ destination, status: known, busy, publish }: Props) {
  const translate = useTranslate();
  const format = useFormat();
  const { label } = destination;
  const { kind } = destination.target;
  // A script or a request can always be run again: only the host knows whether the last one worked.
  const current = known?.state === 'current' && kind !== 'script' && kind !== 'link';
  const descriptions = {
    current: translate('publish.destination.menu.current'),
    pending: translate('publish.destination.menu.pending'),
    unknown: translate('publish.destination.menu.unknown'),
  } as const;
  const sent = kind === 'script' ? 'publish.custom.scriptRan' : kind === 'link' ? 'publish.custom.requestSent' : undefined;
  const status = known?.state === 'current' && sent !== undefined ? translate(sent) : descriptions[known?.state ?? 'unknown'];
  const url = destination.siteUrl ?? known?.url;
  const branch = destinationBranch(destination.target);
  const title =
    branch === undefined ? translate('publish.destination.menu.deploysFromComputer') : translate('publish.destination.menu.pushesBranch', { branch });
  return (
    <span className="stacki-publish-option stacki-publish-hosting stacki-publish-destination" title={title}>
      <button disabled={busy || current} onClick={publish}>
        <PublishProviderIcon provider={destinationProvider(destination.target)} />
        <span>
          <span className="stacki-publish-destination-name">{translate('publish.destination.menu.publish', { label })}</span>
          <small>
            {known?.publishedAtMs === undefined
              ? status
              : translate('publish.destination.menu.published', { status, time: format.formatRelativeTime(known.publishedAtMs, Date.now()) })}
          </small>
        </span>
      </button>
      {url !== undefined && <OpenSiteLink url={url} label={translate('publish.destination.menu.openSite', { label })} />}
    </span>
  );
}
