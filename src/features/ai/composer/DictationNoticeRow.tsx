// The line under the composer when dictation cannot run. A microphone the system keeps off is
// fixable from here: the notice names the application to switch on and opens the right
// System Settings pane. Every notice can be dismissed; it is never permanent.
import { microphoneAdvice } from '../../../../shared/properties/microphone';
import { CloseIcon, ExternalIcon } from '../../../ui/Icons';
import type { DictationNotice } from '../useDictation';

export function DictationNoticeRow({
  notice,
  onDismiss,
  onOpenSettings,
}: {
  readonly notice: DictationNotice;
  readonly onDismiss: () => void;
  readonly onOpenSettings: () => void;
}) {
  const advice = notice.kind === 'blocked' ? microphoneAdvice(notice.report) : undefined;
  return (
    <div className="ai-dictation-notice" role="alert">
      <div className="ai-dictation-notice-text">
        <span className="ai-compose-problem">{advice?.message ?? (notice.kind === 'message' ? notice.text : '')}</span>
        {advice !== undefined && <span className="ai-compose-hint">{advice.hint}</span>}
        {notice.kind === 'blocked' && notice.report.settingsAvailable && notice.report.status === 'denied' && (
          <button type="button" className="ai-dictation-settings" onClick={onOpenSettings}>
            <ExternalIcon size={12} /> Open System Settings
          </button>
        )}
      </div>
      <button type="button" className="ghost ai-dictation-dismiss" aria-label="Dismiss" onClick={onDismiss}>
        <CloseIcon size={12} />
      </button>
    </div>
  );
}
