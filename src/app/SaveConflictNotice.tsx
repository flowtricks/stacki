import { ErrorToast } from '../ui/ErrorToast';
// The notice for a refused save (plan §7, rejection UX contract). It never
// blocks: the page stays editable underneath and keeps every local edit. A
// refused edit request (step 6) names the actor's reason.
import { describeRejection, type RejectionReason } from '../../shared/engine/intent';

// Nothing is discarded and nothing is written over the outside change until the
// user picks an action — reloading and saving over are deliberate acts.

interface SaveConflictNoticeProps {
  readonly fileName: string;
  /** Why an edit request was refused; absent for a refused whole-page save. */
  readonly reason: RejectionReason | undefined;
  /** The code panel is open on this page, so the local text can be kept. */
  readonly reviewing: boolean;
  readonly onReload: () => void;
  readonly onReview: () => void;
  readonly onKeep: () => void;
}

export default function SaveConflictNotice({ fileName, reason, reviewing, onReload, onReview, onKeep }: SaveConflictNoticeProps) {
  const detail = reason === undefined ? 'changed on disk while you were editing.' : describeRejection(reason);
  return (
    <ErrorToast
      message={`${fileName}: ${detail} Your edits are kept here and are not being saved.`}
      recovery={[
        { label: 'Reload from disk', run: onReload },
        reviewing ? { label: 'Save this version', run: onKeep } : { label: 'Review in code', run: onReview },
      ]}
    />
  );
}
