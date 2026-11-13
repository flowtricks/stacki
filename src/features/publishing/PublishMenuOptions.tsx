import type { Hosting, PublishConfig, PublishTarget } from '../../../shared/properties/publishConfig';
import { ExternalIcon, GearIcon, UploadCloudIcon } from '../../ui/Icons';
import { PublishProviderIcon } from './PublishProviderIcon';
import type { PublishAvailability } from '../../../shared/properties/publishState';
import { usePublishedSiteURL } from './usePublishedSiteURL';
import { useTranslate } from '../../lib/i18n/useTranslate';

interface Props {
  readonly projectPath: string;
  readonly publish: (target: PublishTarget) => void;
  readonly openSettings: () => void;
  readonly availability: PublishAvailability;
  readonly repositoryURL: string | undefined;
  readonly busy: boolean;
  readonly provider: Hosting['provider'];
  readonly config: PublishConfig | undefined;
}

export function PublishMenuOptions({ projectPath, publish, openSettings, availability, repositoryURL, busy, provider, config }: Props) {
  const translate = useTranslate();
  return (
    <>
      <GitHubPushOption availability={availability} repositoryURL={repositoryURL} busy={busy} publish={publish} />
      <HostingDeployOption projectPath={projectPath} provider={provider} config={config} availability={availability} busy={busy} publish={publish} />
      <hr />
      <button onClick={openSettings}>
        <GearIcon />
        <span>{translate('publish.menu.settings')}</span>
      </button>
    </>
  );
}

function HostingDeployOption({
  projectPath,
  availability,
  busy,
  publish,
  provider,
  config,
}: Pick<Props, 'projectPath' | 'availability' | 'busy' | 'publish' | 'provider' | 'config'>) {
  const translate = useTranslate();
  const url = usePublishedSiteURL(projectPath, config);
  const current = availability.hosting === 'current';
  const descriptions = {
    current: translate('publish.menu.hostingCurrent'),
    pending: translate('publish.menu.hostingPending'),
    unknown: translate('publish.menu.hostingUnknown'),
    unconfigured: translate('publish.menu.hostingChoose'),
  } as const;
  return (
    <span className="stacki-publish-option stacki-publish-hosting" title={current ? translate('publish.upToDate') : undefined}>
      <button disabled={busy || current} onClick={() => publish('hosting')}>
        {provider === 'none' ? <UploadCloudIcon /> : <PublishProviderIcon provider={provider} />}
        <span>
          {translate('publish.menu.deploy')}
          <small>{descriptions[availability.hosting]}</small>
        </span>
      </button>
      {url !== undefined && (
        <a
          className="stacki-publish-repository"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={translate('publish.menu.openSite')}
          title={translate('publish.menu.openUrl', { url })}
        >
          <ExternalIcon size={12} />
        </a>
      )}
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
