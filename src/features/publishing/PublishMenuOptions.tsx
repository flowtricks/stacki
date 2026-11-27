import { deploysFromStacki, type Hosting, type PublishConfig } from '../../../shared/properties/publishConfig';
import { stagingBranchOf, type Destination, type PublishRequestTarget } from '../../../shared/properties/publishDestinations';
import { ExternalIcon, GearIcon, UploadCloudIcon } from '../../ui/Icons';
import { PublishProviderIcon } from './PublishProviderIcon';
import type { PublishAvailability } from '../../../shared/properties/publishState';
import { usePublishedSiteURL } from './usePublishedSiteURL';
import { useFormat, useTranslate } from '../../lib/i18n/useTranslate';
import { CustomHostOption } from './PublishCustomOption';
import { OpenSiteLink } from './PublishSiteLink';
import { StagingOption } from './PublishStagingOption';

interface Props {
  readonly projectPath: string;
  readonly publish: (target: PublishRequestTarget) => void;
  readonly openSettings: () => void;
  readonly availability: PublishAvailability;
  readonly repositoryURL: string | undefined;
  readonly busy: boolean;
  readonly provider: Hosting['provider'];
  readonly config: PublishConfig | undefined;
  readonly staging: Destination | undefined;
}

export function PublishMenuOptions(props: Props) {
  const translate = useTranslate();
  const { staging, config } = props;
  // With staging, a production that is GitHub alone is the push row: there is no host to offer a deploy to.
  const gitHubOnly = config !== undefined && config.customHosting === undefined && !deploysFromStacki(config);
  return (
    <>
      <GitHubPushOption availability={props.availability} repositoryURL={props.repositoryURL} busy={props.busy} publish={props.publish} />
      {staging !== undefined && (
        <StagingOption
          staging={staging}
          availability={props.availability}
          busy={props.busy}
          publish={() => props.publish('staging')}
          pushes={stagingBranchOf(staging.target)}
        />
      )}
      {staging !== undefined && gitHubOnly ? undefined : <HostingDeployOption {...props} />}
      <hr />
      <button onClick={props.openSettings}>
        <GearIcon />
        <span>{translate('publish.menu.settings')}</span>
      </button>
    </>
  );
}

function HostingDeployOption({ projectPath, availability, busy, publish, provider, config, staging }: Props) {
  const translate = useTranslate();
  const format = useFormat();
  const url = usePublishedSiteURL(projectPath, config);
  if (config?.customHosting !== undefined) {
    return (
      <CustomHostOption
        custom={config.customHosting}
        availability={availability}
        busy={busy}
        publish={() => publish('hosting')}
        url={url}
        staged={staging !== undefined}
      />
    );
  }
  const current = availability.hosting === 'current';
  const descriptions = {
    current: translate('publish.menu.hostingCurrent'),
    pending: translate('publish.menu.hostingPending'),
    unknown: translate('publish.menu.hostingUnknown'),
    unconfigured: translate('publish.menu.hostingChoose'),
  } as const;
  const status = descriptions[availability.hosting];
  // Last published is shown beside staging's, so the two can be told apart at a glance.
  const publishedAtMs = staging === undefined ? undefined : availability.hostingPublishedAtMs;
  const title = current ? translate('publish.upToDate') : staging === undefined ? undefined : translate('publish.staging.menu.productionTip');
  return (
    <span className="stacki-publish-option stacki-publish-hosting" title={title}>
      <button disabled={busy || current} onClick={() => publish('hosting')}>
        {provider === 'none' ? <UploadCloudIcon /> : <PublishProviderIcon provider={provider} />}
        <span>
          {translate(staging === undefined ? 'publish.menu.deploy' : 'publish.staging.menu.production')}
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

function GitHubPushOption({ availability, repositoryURL, busy, publish }: Pick<Props, 'availability' | 'repositoryURL' | 'busy' | 'publish'>) {
  const translate = useTranslate();
  const current = availability.github === 'current';
  const details = availability.githubPush;
  const description = current
    ? translate('publish.menu.noChangesToPush')
    : details === undefined
      ? translate('publish.menu.commitsUnavailable')
      : translate('publish.menu.commitsToPush', { count: details.commits });
  return (
    <span className="stacki-publish-option stacki-publish-github" title={current ? translate('publish.upToDate') : undefined}>
      <button disabled={busy || current} onClick={() => publish('github')}>
        <PublishProviderIcon provider="github" />
        <span>
          {translate('publish.menu.pushToGitHub')}
          <small>{description}</small>
        </span>
      </button>
      {repositoryURL !== undefined && (
        <a
          className="stacki-publish-repository"
          href={repositoryURL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={translate('publish.menu.openRepository')}
          title={translate('publish.menu.openRepository')}
        >
          <ExternalIcon size={12} />
        </a>
      )}
    </span>
  );
}
