import type { WireGitInfo } from '../../../shared/ipc/ipcResults';
import type { GitIncomingState } from './useGitIncoming';
import { PullIcon } from '../../ui/PullIcon';
import { GitHubIcon } from '../../ui/Icons';

export function GitPullControl({
  incoming,
  busy,
  info,
  onPull,
}: {
  readonly incoming: GitIncomingState;
  readonly busy: string | undefined;
  readonly info: WireGitInfo;
  readonly onPull: () => void;
}) {
  const canPull = incoming.kind === 'ready' && incoming.commits > 0;
  const description = pullDescription(incoming);
  return (
    <div className="dropdown-row git-pull-control" title={description}>
      <button className="git-pull" disabled={busy !== undefined || !canPull || info.branch === 'HEAD' || !info.head} onClick={onPull} title={description}>
        <GitHubIcon size={14} />
        <span className="git-pull-label">{busy === 'Pulling…' ? 'Pulling…' : 'Pull from GitHub'}</span>
        {busy === 'Pulling…' ? <span className="mini-spinner" /> : <PullIcon size={14} />}
      </button>
    </div>
  );
}

function pullDescription(incoming: GitIncomingState): string {
  switch (incoming.kind) {
    case 'checking':
      return 'Checking GitHub for incoming changes…';
    case 'unavailable':
      return `Could not check GitHub. Retrying automatically. ${incoming.message}`;
    case 'ready':
      return incoming.commits === 0 ? 'No changes to pull' : `${incoming.commits} commit${incoming.commits === 1 ? '' : 's'} to pull`;
  }
}
