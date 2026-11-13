import type { WireMergeOutcome } from '../../../shared/ipc/ipcResults';
import { ENGLISH_TRANSLATE } from '../../../shared/properties/i18n/englishTranslator';
import type { Translator } from '../../../shared/properties/i18n/messageRef';
import { cleanErrorKeepingReference } from '../../lib/cleanError';
import { translateErrorText, translateReference } from '../../lib/i18n/translateErrorText';
type Conflict = Extract<WireMergeOutcome, { readonly conflicted: true }> & {
  readonly deleteAfter: boolean;
};
interface ActionOptions {
  readonly projectPath: string;
  readonly branch: string;
  readonly showToast: (message: string, kind: 'error' | 'success' | 'info') => void;
  readonly run: (work: () => Promise<void>, label: string) => void;
  /** The hook's `translate`; pure code cannot call hooks. English when the caller has none. */
  readonly translate?: Translator;
}
interface MergeOptions extends ActionOptions {
  readonly into: string;
  readonly trunk?: string | undefined;
  readonly onConflict?: ((conflict: Conflict) => void) | undefined;
}
interface DeleteOptions extends ActionOptions {
  readonly parked?: boolean;
}
interface TidyOptions extends Pick<ActionOptions, 'projectPath' | 'branch' | 'showToast' | 'translate'> {
  readonly into: string;
  readonly changed?: boolean;
}
interface DirtyOptions extends TidyOptions {
  readonly deleteAfter: boolean;
  readonly onConflict?: ((conflict: Conflict) => void) | undefined;
}

// Merging and deleting a branch, as the user experiences them.
//
// Two places offer these now — the chip in the title bar and the History
// panel — and they are the same actions, so they are asked the same way from
// one place. What differs between the two callers is only how the work is run
// (the chip has a busy state and an error box; the panel does not), so that is
// the one thing passed in.
//
// The refusals these can hit are worded in electron/git/gitBranches.ts. What lives
// here is the asking: which questions get put to the user, in what order, and
// in what words.

import { confirmDialog } from '../../ui/ConfirmDialog';
import { gitMerge, gitDeleteBranch, gitPark, gitUnpark } from './gitBridge';

/**
 * Fold `branch` into the branch currently checked out.
 *
 * The confirm names both branches because the direction is the whole decision
 * and neither an icon on a row nor a menu item can show it.
 */
export async function mergeBranchAction({
  projectPath,
  branch,
  into,
  trunk,
  run,
  showToast,
  onConflict,
  translate = ENGLISH_TRANSLATE,
}: MergeOptions): Promise<void> {
  // Once a branch has been folded in, it is usually finished — its work lives
  // on the other branch now and the name is clutter. So the offer to tidy it
  // up belongs WITH the merge, ticked, rather than as a second thing to
  // remember afterwards.
  //
  // Except for the trunk. Merging main INTO the branch you are working on is
  // the commonest merge there is — it is how you catch up — and main is not
  // finished afterwards; it is the thing everything comes back to. Offering to
  // delete it there would be offering to destroy the project's main line as a
  // side effect of routine housekeeping.
  const isTrunk = !!trunk && branch === trunk;
  const answer = await confirmDialog({
    title: translate('git.action.merge.title', { branch, into }),
    confirmLabel: translate('git.action.merge.confirm', { into }),
    ...(isTrunk
      ? {}
      : {
          checkbox: {
            label: translate('git.action.merge.deleteAfter', { branch }),
            hint: translate('git.action.merge.deleteHint', { into }),
            defaultChecked: true,
          },
        }),
  });
  if (!answer) {
    return;
  }
  const deleteAfter = !isTrunk && typeof answer === 'object' && answer.checked;
  run(async () => {
    const merged = await gitMerge({ projectPath, branch });
    // Both branches changed the same files. That is a question for the user,
    // not a failure — it comes back with both versions of each file so the app
    // can ask which to keep. Telling someone to open a terminal here would be
    // the app giving up on the one job it exists to do.
    // Unsaved work in a file the merge needs to write. Not an error — git
    // stopped without moving anything — so it is offered as the choice it is:
    // set the work aside and go ahead, or leave it and deal with it first.
    if ('dirty' in merged) {
      await mergeDirtyWork({ projectPath, branch, into, showToast, onConflict, deleteAfter, translate }, merged.files);
      return;
    }
    if ('conflicted' in merged) {
      // The tidy-up was asked for before anyone knew there would be a clash;
      // it still applies once the clash is settled.
      onConflict?.({ ...merged, deleteAfter });
      return;
    }
    if (deleteAfter) {
      await tidyUp({ projectPath, branch, into, changed: merged?.changed, showToast, translate });
      return;
    }
    // Said from in here because the caller's success message has no way to
    // know whether anything actually moved — a merge with nothing to bring is
    // a success, and calling it "merged" would suggest work arrived that was
    // already there.
    showToast(
      merged?.changed ? translate('git.action.merge.done', { branch, into: merged.into ?? into }) : translate('git.action.merge.alreadyHas', { branch, into }),
      'success',
    );
  }, translate('git.busy.merging'));
}

/**
 * Delete a branch that has just been folded in.
 *
 * The safe form of the delete, deliberately: it has only just been merged, so
 * git will allow it — and if for any reason git objects, that objection is
 * worth hearing rather than forcing past. The merge already worked either way,
 * so a failure here is reported without taking the merge down with it.
 */
export async function tidyUp({ projectPath, branch, into, changed, showToast, translate = ENGLISH_TRANSLATE }: TidyOptions): Promise<void> {
  // Each outcome is one whole sentence per case: word order differs between languages, so nothing is stitched together.
  const params = { branch, into } as const;
  try {
    const deleted = await gitDeleteBranch({ projectPath, branch });
    if (!deleted.ok) {
      // Should not happen straight after a merge, and if it does the branch is
      // holding something the merge did not take — which is a thing to say,
      // not to force past.
      showToast(translate(changed ? 'git.action.tidy.keptChanged' : 'git.action.tidy.keptUnchanged', params), 'info');
      return;
    }
    showToast(translate(changed ? 'git.action.tidy.deletedChanged' : 'git.action.tidy.deletedUnchanged', params), 'success');
  } catch (error: unknown) {
    const message = translateErrorText(cleanErrorKeepingReference(error), translate);
    showToast(translate(changed ? 'git.action.tidy.failedChanged' : 'git.action.tidy.failedUnchanged', { ...params, message }), 'info');
  }
}

/**
 * Delete `branch`.
 *
 * Asks once, and a second time only if git refuses because the branch holds
 * commits found nowhere else. That second question is a different question —
 * "this loses work" rather than "are you sure" — so it is asked in those terms
 * rather than bundled into the first, where it would be a warning about
 * something that usually isn't true.
 */
export async function deleteBranchAction({ projectPath, branch, parked, run, showToast, translate = ENGLISH_TRANSLATE }: DeleteOptions): Promise<void> {
  const yes = await confirmDialog({
    title: translate('git.action.delete.title', { branch }),
    body: translate(parked ? 'git.action.delete.bodyParked' : 'git.action.delete.body', { branch }),
    confirmLabel: translate('git.action.delete.confirm'),
    cancelLabel: translate('ui.cancel'),
    danger: true,
  });
  // Deletion requires the affirmative button, never a dismissal or checkbox answer.
  if (yes !== true) {
    return;
  }
  run(async () => {
    const deleted = await gitDeleteBranch({ projectPath, branch });
    if (!deleted.ok) {
      // A different question from the first — "this loses work" rather than
      // "are you sure" — so it is asked in those terms and in its own dialog.
      const anyway = await confirmDialog({
        title: translate('git.action.delete.loseTitle'),
        // The electron refusal text is English; this dialog is shown by the renderer, so it says the same thing in the active language.
        body: translate('git.action.delete.unmerged', { branch }),
        confirmLabel: translate('git.action.delete.anyway'),
        danger: true,
      });
      if (anyway !== true) {
        return;
      }
      await gitDeleteBranch({ projectPath, branch, force: true });
    }
    showToast(translate('git.action.delete.done', { branch }), 'success');
  }, translate('git.busy.deleting'));
}

async function mergeDirtyWork(
  { projectPath, branch, into, showToast, onConflict, deleteAfter, translate = ENGLISH_TRANSLATE }: DirtyOptions,
  files: readonly string[],
): Promise<void> {
  const park = await confirmDialog({
    title: translate('git.action.dirty.title'),
    body: files?.length
      ? translate('git.action.dirty.body', { count: files.length, files: files.slice(0, 3).join(', ') })
      : translate('git.action.dirty.bodyUnknown'),
    confirmLabel: translate('git.action.dirty.confirm'),
  });
  if (!park) {
    return;
  }
  const parked = await gitPark({ projectPath });
  if (!parked?.ok) {
    showToast(parked?.error || translate('git.action.dirty.parkFailed'), 'error');
    return;
  }
  const again = await gitMerge({ projectPath, branch });
  // Whatever happens next, the work comes back out — including when the
  // merge then clashes, since the clash is resolved against the files
  // rather than the working tree.
  const back = await gitUnpark({ projectPath });
  if ('conflicted' in again) {
    onConflict?.({ ...again, deleteAfter });
    return;
  }
  if ('dirty' in again) {
    showToast(translate('git.action.dirty.stillBlocked'), 'error');
    return;
  }
  if (back?.error) {
    showToast(translateReference(back.error, back.errorRef, translate), 'error');
  }
  if (deleteAfter) {
    await tidyUp({ projectPath, branch, into, changed: again?.changed, showToast, translate });
    return;
  }
  showToast(again?.changed ? translate('git.action.merge.doneBack', { branch, into }) : translate('git.action.merge.alreadyHad', { branch, into }), 'success');
  return;
}
