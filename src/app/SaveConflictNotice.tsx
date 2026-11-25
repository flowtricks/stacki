import { ErrorToast } from '../ui/ErrorToast';
// The notice for a refused save (plan §7, rejection UX contract). It never
// blocks: the page stays editable underneath and keeps every local edit. A
// refused edit request (step 6) names the actor's reason.
import type { RejectionReason } from '../../shared/engine/intent';
import { useTranslate } from '../lib/i18n/useTranslate';
import { REJECTION_KEYS } from './rejectionMessages';

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
  const translate = useTranslate();
  const detail = reason === undefined ? translate('shell.saveConflict.changedOnDisk') : translate(REJECTION_KEYS[reason]);
  return (
    <ErrorToast
      message={translate('shell.saveConflict.message', { fileName, detail })}
      recovery={[
        { label: translate('shell.saveConflict.reload'), run: onReload },
        reviewing ? { label: translate('shell.saveConflict.keep'), run: onKeep } : { label: translate('shell.saveConflict.review'), run: onReview },
      ]}
    />
  );
}
