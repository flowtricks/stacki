import React from 'react';
import { MergeIcon, TrashIcon } from './Icons.jsx';

// The merge and delete buttons on a branch row.
//
// Shared, because the chip and the History panel both list branches and a row
// that behaves differently in two places is two things to learn.
//
// Two decisions here, both of them about being honest rather than tidy:
//
// ALWAYS SHOWN. They used to appear on hover, which meant that until you
// happened to hover a row there was no sign the app could merge or delete
// anything at all. A feature nobody can find is not a feature. They sit dim
// and come up on hover, so the row stays quiet without the actions being a
// secret.
//
// SHOWN EVEN WHERE THEY CANNOT BE USED, disabled and with the reason on them.
// The alternative — hiding them — asks the reader to work out why a row is
// missing something, and "why does this branch have no delete button?" is a
// worse question than a greyed button that says "you're on this branch".
//
// What each button is refused for:
//
//   merge   only into a DIFFERENT branch. Merging main into the branch you are
//           working on is completely ordinary and stays available — it is how
//           you catch up with the trunk — so the only refusal is a branch
//           against itself.
//   delete  not the branch you are standing on (git refuses), and not the
//           trunk. Git will delete main as readily as anything else the moment
//           it is merged into where you are, and it is the one branch
//           everything comes back to.
export default function BranchActions({ branch, current, trunk, onMerge, onDelete, disabled }) {
  const isCurrent = branch === current;
  const isTrunk = !!trunk && branch === trunk;

  const mergeWhy = isCurrent
    ? `You’re on ${branch} — a branch can’t be merged into itself`
    : `Merge ${branch} into ${current}`;

  const deleteWhy = isCurrent
    ? `You’re on ${branch} — switch to another branch first`
    : isTrunk
      ? `${branch} is the branch everything comes back to — it isn’t meant to be deleted`
      : `Delete ${branch}`;

  return (
    <>
      <button
        className="row-action merge"
        title={mergeWhy}
        disabled={disabled || isCurrent}
        onClick={(e) => {
          e.stopPropagation();
          onMerge?.(branch);
        }}
      >
        <MergeIcon size={12} />
      </button>
      <button
        className="row-action branch-action"
        title={deleteWhy}
        disabled={disabled || isCurrent || isTrunk}
        onClick={(e) => {
          e.stopPropagation();
          onDelete?.(branch);
        }}
      >
        <TrashIcon size={12} />
      </button>
    </>
  );
}
