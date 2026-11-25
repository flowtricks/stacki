import { translateReference } from '../../lib/i18n/translateErrorText';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';
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
  const translate = useTranslate();
  const canPull = incoming.kind === 'ready' && incoming.commits > 0;
  // The busy label is the translated text itself, so it is compared with the translation, not an English literal.
  const pulling = busy === translate('git.busy.pulling');
  const description = pullDescription(incoming, translate);
  return (
    <div className="dropdown-row git-pull-control" title={description}>
      <button className="git-pull" disabled={busy !== undefined || !canPull || info.branch === 'HEAD' || !info.head} onClick={onPull} title={description}>
        <GitHubIcon size={14} />
        <span className="git-pull-label">{pulling ? translate('git.busy.pulling') : translate('git.pull.label')}</span>
        {pulling ? <span className="mini-spinner" /> : <PullIcon size={14} />}
      </button>
    </div>
  );
}

function pullDescription(incoming: GitIncomingState, translate: Translator): string {
  switch (incoming.kind) {
    case 'checking':
      return translate('git.pull.checking');
    case 'unavailable':
      return translate('git.pull.unavailable', { message: translateReference(incoming.message, incoming.messageRef, translate) });
    case 'ready':
      return incoming.commits === 0 ? translate('git.pull.none') : translate('git.pull.commits', { count: incoming.commits });
  }
}
