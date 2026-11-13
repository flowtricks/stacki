import { useTranslate } from '../../lib/i18n/useTranslate';
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
  const translate = useTranslate();
  if (branch === current) {
    return undefined;
  }
  return (
    <>
      {onMerge && (
        <button
          className="row-action merge"
          title={translate('git.branch.mergeInto', { branch, current })}
          aria-label={translate('git.branch.mergeInto', { branch, current })}
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
          title={translate('git.branch.delete', { branch })}
          aria-label={translate('git.branch.delete', { branch })}
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
