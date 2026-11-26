// The merge review of the shared git session (useGitSession.ts), mounted beside whatever starts git actions so it
// works with the History panel closed: the title bar's pull button and the pull shortcut can meet a conflict too.
import { assert } from '../../../shared/core/assert';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';
import { translateReference } from '../../lib/i18n/translateErrorText';
import { tidyUp } from './gitActions';
import { resolveGitMerge } from './gitChipBridge';
import type { ConflictChoices } from './gitConflictModel';
import MergeConflictModal from './MergeConflictModal';
import { gitValue, type GitSession, type PendingConflict } from './useGitSession';

export function GitSessionDialogs({ session }: { readonly session: GitSession }) {
  const translate = useTranslate();
  const { conflict, host } = session;
  if (conflict === undefined || !host.info?.isRepo) {
    return undefined;
  }
  const resolve = async (choices: ConflictChoices): Promise<void> => {
    const done = await session.runAction(() => resolveConflict({ session, conflict, translate }, choices), undefined, translate('git.busy.merging'));
    if (done) {
      session.setConflict(undefined);
    }
  };
  return (
    <MergeConflictModal
      conflict={conflict}
      branches={host.info.branches}
      trunk={host.info.trunk ?? 'main'}
      busy={session.busy}
      onCancel={() => session.setConflict(undefined)}
      onResolve={(choices) => {
        // runAction reports its own failures (a toast and the panel's error).
        void resolve(choices);
      }}
    />
  );
}

interface Resolution {
  readonly session: GitSession;
  readonly conflict: PendingConflict;
  readonly translate: Translator;
}

async function resolveConflict({ session, conflict, translate }: Resolution, choices: ConflictChoices): Promise<void> {
  const { project, showToast, onPulled } = session.host;
  const result = await gitValue(resolveGitMerge(project.path, conflict.branch, choices));
  assert(result.ok, 'Merge resolution must complete');
  assert(result.into !== undefined, 'Merge resolution requires a target branch');
  if (result.parkedError !== undefined) {
    showToast(translateReference(result.parkedError, result.parkedErrorRef, translate), 'error');
  }
  // A pull's review merges the remote tracking ref, so finishing it brings in everything that was incoming.
  if (conflict.branch === `refs/remotes/origin/${result.into}`) {
    onPulled?.();
  }
  if (conflict.deleteAfter) {
    await tidyUp({ projectPath: project.path, branch: conflict.branch, into: result.into, changed: true, showToast, translate });
  } else {
    showToast(translate('git.action.merge.done', { branch: conflict.branch, into: result.into }), 'success');
  }
}
