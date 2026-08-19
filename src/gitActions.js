// Merging and deleting a branch, as the user experiences them.
//
// Two places offer these now — the chip in the title bar and the History
// panel — and they are the same actions, so they are asked the same way from
// one place. What differs between the two callers is only how the work is run
// (the chip has a busy state and an error box; the panel does not), so that is
// the one thing passed in.
//
// The refusals these can hit are worded in electron/gitBranches.js. What lives
// here is the asking: which questions get put to the user, in what order, and
// in what words.

import { confirmDialog } from './ui/ConfirmDialog.jsx';

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
}) {
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
    title: `Merge “${branch}” into “${into}”?`,
    body: `Everything on ${branch} becomes part of ${into}.`,
    confirmLabel: `Merge into ${into}`,
    checkbox: isTrunk
      ? null
      : {
          label: `Delete “${branch}” afterwards`,
          hint: 'Its work will be on ' + into + ', so the branch has nothing left of its own.',
          defaultChecked: true,
        },
  });
  if (!answer) return;
  const deleteAfter = !isTrunk && !!answer.checked;
  run(async () => {
    const r = await window.avb.gitMerge({ projectPath, branch });
    // Both branches changed the same files. That is a question for the user,
    // not a failure — it comes back with both versions of each file so the app
    // can ask which to keep. Telling someone to open a terminal here would be
    // the app giving up on the one job it exists to do.
    // Unsaved work in a file the merge needs to write. Not an error — git
    // stopped without moving anything — so it is offered as the choice it is:
    // set the work aside and go ahead, or leave it and deal with it first.
    if (r?.dirty) {
      const named = r.files?.length ? r.files.slice(0, 3).join(', ') : 'a file the merge needs';
      const park = await confirmDialog({
        title: 'You have unsaved work in the way',
        body: `${named} ${r.files?.length === 1 ? 'has' : 'have'} changes that aren’t saved, and the merge needs to write there. Your work can be set aside and put back afterwards — nothing is lost either way.`,
        confirmLabel: 'Set it aside and merge',
      });
      if (!park) return;
      const parked = await window.avb.gitPark({ projectPath });
      if (!parked?.ok) {
        showToast(parked?.error || 'Could not set your work aside.', 'error');
        return;
      }
      const again = await window.avb.gitMerge({ projectPath, branch });
      // Whatever happens next, the work comes back out — including when the
      // merge then clashes, since the clash is resolved against the files
      // rather than the working tree.
      const back = await window.avb.gitUnpark({ projectPath });
      if (again?.conflicted) {
        onConflict?.({ ...again, deleteAfter });
        return;
      }
      if (again?.dirty) {
        showToast('Still blocked — your work is back where it was.', 'error');
        return;
      }
      if (back?.error) showToast(back.error, 'error');
      if (deleteAfter) {
        await tidyUp({ projectPath, branch, into, changed: again?.changed, showToast });
        return;
      }
      showToast(
        again?.changed ? `Merged ${branch} into ${into} — your work is back` : `${into} already had everything from ${branch}`,
        'success'
      );
      return;
    }
    if (r?.conflicted) {
      // The tidy-up was asked for before anyone knew there would be a clash;
      // it still applies once the clash is settled.
      onConflict?.({ ...r, deleteAfter });
      return;
    }
    if (deleteAfter) {
      await tidyUp({ projectPath, branch, into, changed: r?.changed, showToast });
      return;
    }
    // Said from in here because the caller's success message has no way to
    // know whether anything actually moved — a merge with nothing to bring is
    // a success, and calling it "merged" would suggest work arrived that was
    // already there.
    showToast(
      r?.changed
        ? `Merged ${branch} into ${r.into}`
        : `${into} already has everything from ${branch}`,
      'success'
    );
  }, 'Merging…');
}

/**
 * Delete a branch that has just been folded in.
 *
 * The safe form of the delete, deliberately: it has only just been merged, so
 * git will allow it — and if for any reason git objects, that objection is
 * worth hearing rather than forcing past. The merge already worked either way,
 * so a failure here is reported without taking the merge down with it.
 */
export async function tidyUp({ projectPath, branch, into, changed, showToast }) {
  const merged = changed
    ? `Merged ${branch} into ${into}`
    : `${into} already had everything from ${branch}`;
  try {
    const r = await window.avb.gitDeleteBranch({ projectPath, branch });
    if (r?.unmerged) {
      // Should not happen straight after a merge, and if it does the branch is
      // holding something the merge did not take — which is a thing to say,
      // not to force past.
      showToast(`${merged}. ${branch} was kept — it still has commits of its own.`, 'info');
      return;
    }
    showToast(`${merged}, and deleted ${branch}`, 'success');
  } catch (err) {
    showToast(`${merged}. ${branch} could not be deleted: ${err?.message || err}`, 'info');
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
export async function deleteBranchAction({ projectPath, branch, parked, run, showToast }) {
  const waiting = parked
    ? '\n\nChanges are waiting on it. They stay parked and won’t be deleted, but nothing will ' +
      'bring them back once the branch is gone.'
    : '';
  const yes = await confirmDialog({
    title: `Delete the branch “${branch}”?`,
    body: `Anything saved only on ${branch} goes with it.${waiting}`,
    confirmLabel: 'Delete branch',
    danger: true,
  });
  if (!yes) return;
  run(async () => {
    const r = await window.avb.gitDeleteBranch({ projectPath, branch });
    if (r?.unmerged) {
      // A different question from the first — "this loses work" rather than
      // "are you sure" — so it is asked in those terms and in its own dialog.
      const anyway = await confirmDialog({
        title: 'This would lose work',
        body: r.message,
        confirmLabel: 'Delete anyway',
        danger: true,
      });
      if (!anyway) return;
      await window.avb.gitDeleteBranch({ projectPath, branch, force: true });
    }
    showToast(`Deleted ${branch}`, 'success');
  }, 'Deleting branch…');
}
