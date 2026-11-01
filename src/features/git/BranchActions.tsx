import { MergeIcon, TrashIcon } from '../../ui/Icons';

interface BranchActionsProps {
  readonly branch: string;
  readonly current: string;
  readonly trunk?: string | undefined;
  readonly onMerge?: (branch: string) => void;
  readonly onDelete?: (branch: string) => void;
  readonly disabled?: boolean;
}

// Hide actions that cannot apply to this branch; temporary work only disables
// available actions so the row does not shift while an operation is running.
export default function BranchActions({ branch, current, trunk, onMerge, onDelete, disabled }: BranchActionsProps) {
  if (branch === current) {
    return undefined;
  }
  return (
    <>
      {onMerge && (
        <button
          className="row-action merge"
          title={`Merge ${branch} into ${current}`}
          aria-label={`Merge ${branch} into ${current}`}
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation();
            onMerge(branch);
          }}
        >
          <MergeIcon size={12} />
        </button>
      )}
      {branch !== trunk && onDelete && (
        <button
          className="row-action branch-action"
          title={`Delete ${branch}`}
          aria-label={`Delete ${branch}`}
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation();
            onDelete(branch);
          }}
        >
          <TrashIcon size={12} />
        </button>
      )}
    </>
  );
}
