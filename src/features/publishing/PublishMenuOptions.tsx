import type { Hosting, PublishConfig, PublishTarget } from '../../../shared/properties/publishConfig';
import { ExternalIcon, GearIcon, UploadCloudIcon } from '../../ui/Icons';
import { PublishProviderIcon } from './PublishProviderIcon';
import type { PublishAvailability } from '../../../shared/properties/publishState';
import { usePublishedSiteURL } from './usePublishedSiteURL';

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
  return (
    <>
      <GitHubPushOption availability={availability} repositoryURL={repositoryURL} busy={busy} publish={publish} />
      <HostingDeployOption projectPath={projectPath} provider={provider} config={config} availability={availability} busy={busy} publish={publish} />
      <hr />
      <button onClick={openSettings}>
        <GearIcon />
        <span>Publish settings…</span>
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
  const url = usePublishedSiteURL(projectPath, config);
  const current = availability.hosting === 'current';
  const descriptions = {
    current: 'Up to date',
    pending: 'Changes to deploy',
    unknown: 'Deployment status unavailable',
    unconfigured: 'Choose a hosting provider',
  } as const;
  return (
    <span className="stacki-publish-option stacki-publish-hosting" title={current ? 'All changes are up to date' : undefined}>
      <button disabled={busy || current} onClick={() => publish('hosting')}>
        {provider === 'none' ? <UploadCloudIcon /> : <PublishProviderIcon provider={provider} />}
        <span>
          Deploy to hosting
          <small>{descriptions[availability.hosting]}</small>
        </span>
      </button>
      {url !== undefined && (
        <a className="stacki-publish-repository" href={url} target="_blank" rel="noopener noreferrer" aria-label="Open published site" title={`Open ${url}`}>
          <ExternalIcon size={12} />
        </a>
      )}
    </span>
  );
}

function GitHubPushOption({ availability, repositoryURL, busy, publish }: Pick<Props, 'availability' | 'repositoryURL' | 'busy' | 'publish'>) {
  const current = availability.github === 'current';
  const details = availability.githubPush;
  const description = current
    ? 'No changes to push'
    : details === undefined
      ? 'Commit count unavailable'
      : `${details.commits} commit${details.commits === 1 ? '' : 's'} to push`;
  return (
    <span className="stacki-publish-option stacki-publish-github" title={current ? 'All changes are up to date' : undefined}>
      <button disabled={busy || current} onClick={() => publish('github')}>
        <PublishProviderIcon provider="github" />
        <span>
          Push to GitHub
          <small>{description}</small>
        </span>
      </button>
      {repositoryURL !== undefined && (
        <a
          className="stacki-publish-repository"
          href={repositoryURL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open GitHub repository"
          title="Open GitHub repository"
        >
          <ExternalIcon size={12} />
        </a>
      )}
    </span>
  );
}
