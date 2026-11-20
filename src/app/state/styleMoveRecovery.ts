// When a project opens: a "Move styles" left part way by a crash, a power cut or a quit is found from main's journal
// (shared/properties/styleMoveJournal.ts) and the person chooses to finish it or undo it, both exact. A move that
// never wrote anything, or that is whole, leaves no question: its journal just goes. One someone edited since cannot
// be resolved exactly, so nothing is written and the person is told which files to look at. Closing the dialog keeps
// the journal: the question comes back the next time the project opens.

import { createElement } from 'react';
import { assert } from '../../../shared/core/assert';
import type { PendingStyleMove } from '../../../shared/properties/styleMoveJournal';
import { clearStyleMove, pendingStyleMove, resolveStyleMove } from '../../ipc/appBridge';
import { cleanError } from '../../lib/cleanError';
import type { Translator } from '../../lib/i18n/localeContext';
import { choiceDialog } from '../../ui/ConfirmDialog';
import { StyleMoveFiles } from '../shell/StyleMoveFiles';

export interface StyleMoveRecoveryDeps {
  readonly translate: Translator;
  readonly showToast: (message: string, kind: 'info' | 'success' | 'warning' | 'error') => void;
  /** Re-reads the project once files changed, so the panels show the component as it now is. */
  readonly rescan: (projectPath: string) => Promise<unknown>;
}

/** Asks about a move this project left part way, if there is one, and resolves it as the person chooses. */
export async function offerStyleMoveRecovery(projectPath: string, deps: StyleMoveRecoveryDeps): Promise<void> {
  let pending: PendingStyleMove | undefined;
  try {
    pending = await pendingStyleMove(projectPath);
  } catch (error: unknown) {
    deps.showToast(cleanError(error), 'error');
    return;
  }
  if (pending === undefined) {
    return;
  }
  const { journal, state } = pending;
  switch (state.kind) {
    case 'untouched':
    case 'done':
      // Nothing to finish or undo: the move never wrote, or it is whole.
      await clearStyleMove(projectPath, journal.id);
      return;
    case 'interrupted':
      await askInterrupted(projectPath, pending, state, deps);
      return;
    case 'changed':
      await askChanged(projectPath, pending, state.changed, deps);
      return;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

async function askInterrupted(
  projectPath: string,
  pending: PendingStyleMove,
  state: Extract<PendingStyleMove['state'], { readonly kind: 'interrupted' }>,
  deps: StyleMoveRecoveryDeps,
): Promise<void> {
  const { translate } = deps;
  assert(state.done.length > 0, 'askInterrupted: an interrupted move did something');
  assert(state.left.length > 0, 'askInterrupted: an interrupted move has something left');
  const name = pending.journal.component;
  // A move stopped before its page was saved cannot be finished (styleMoveCanFinish): undoing is the one way back.
  const finish = { id: 'moved', label: translate('shell.styleMove.finish'), hint: translate('shell.styleMove.finishHint'), recommended: true };
  const undo = { id: 'original', label: translate('shell.styleMove.undo'), hint: translate('shell.styleMove.undoHint'), recommended: !pending.canFinish };
  const choice = await choiceDialog({
    title: translate('shell.styleMove.title'),
    body: createElement(StyleMoveFiles, {
      sentence: translate('shell.styleMove.interrupted', { name }),
      label: translate('shell.styleMove.files'),
      groups: [
        { label: translate('shell.styleMove.left'), files: state.left },
        { label: translate('shell.styleMove.done'), files: state.done },
      ],
    }),
    choices: pending.canFinish ? [finish, { ...undo, recommended: false }] : [undo],
    cancelLabel: translate('shell.styleMove.later'),
  });
  if (choice !== 'moved' && choice !== 'original') {
    return; // Asked again the next time the project opens.
  }
  let resolution;
  try {
    resolution = await resolveStyleMove(projectPath, pending.journal.id, choice);
  } catch (error: unknown) {
    deps.showToast(cleanError(error), 'error');
    return;
  }
  if (!resolution.ok) {
    deps.showToast(translate('shell.component.sheetsChanged', { files: resolution.changed.join(', ') }), 'error');
    return;
  }
  await deps.rescan(projectPath);
  deps.showToast(translate(choice === 'moved' ? 'shell.styleMove.finished' : 'shell.styleMove.undone', { name }), 'success');
}

async function askChanged(projectPath: string, pending: PendingStyleMove, changed: readonly string[], deps: StyleMoveRecoveryDeps): Promise<void> {
  const { translate } = deps;
  assert(changed.length > 0, 'askChanged: a changed move names its files');
  const choice = await choiceDialog({
    title: translate('shell.styleMove.title'),
    body: createElement(StyleMoveFiles, {
      sentence: translate('shell.styleMove.changed', { name: pending.journal.component }),
      label: translate('shell.styleMove.files'),
      groups: [{ label: translate('shell.styleMove.edited'), files: changed }],
    }),
    choices: [{ id: 'dismiss', label: translate('shell.styleMove.dismiss'), hint: translate('shell.styleMove.dismissHint') }],
    cancelLabel: translate('shell.styleMove.later'),
  });
  if (choice === 'dismiss') {
    await clearStyleMove(projectPath, pending.journal.id);
  }
}
