// A reply that failed for a reason other than signing in.
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { WarningTriangleIcon } from '../../../ui/Icons';
import { useCopy } from './copyText';
import './chrome.css';

/**
 * A turn that failed for a reason other than signing in: one quiet row, on a plain fill (never the
 * red or amber of a warning), with Retry when the message can be sent again and the agent's own words
 * behind Details, which can be copied for a bug report. Auth failures never come here; they are the
 * sign-in card.
 */
export function ErrorRow({ message, onRetry }: { readonly message: string | undefined; readonly onRetry: (() => void) | undefined }) {
  const details = message !== undefined && message.trim() !== '' ? message : undefined;
  const translate = useTranslate();
  const { state, copy } = useCopy();
  return (
    <div className="ai-error-row">
      <WarningTriangleIcon size={14} />
      <div className="ai-error-body">
        <span className="ai-error-title">{translate('ai.error.title')}</span>
        {onRetry !== undefined && (
          <button className="ghost" onClick={onRetry}>
            {translate('ui.retry')}
          </button>
        )}
        {details !== undefined && (
          <details className="ai-details">
            <summary>{translate('ai.common.details')}</summary>
            <pre>{details}</pre>
            <button className="ghost ai-error-copy" onClick={() => copy(details)}>
              {state === 'copied' ? translate('ai.common.copied') : state === 'failed' ? translate('ai.common.copyFailed') : translate('ai.common.copyDetails')}
            </button>
          </details>
        )}
      </div>
    </div>
  );
}
