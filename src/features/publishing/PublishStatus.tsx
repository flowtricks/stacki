import Popup from '../../ui/Popup';
import { CheckIcon, CloseIcon, UploadCloudIcon } from '../../ui/Icons';
import { PublishProviderIcon } from './PublishProviderIcon';
import type { DesktopPublishState } from '../../../shared/properties/publishState';
import { assert } from '../../../shared/core/assert';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../../shared/properties/i18n/messageRef';
import './publishing.css';

// The one publish progress popup. Desktop renders it directly and Studio vendors it, so both
// hosts show the same steps, progress, success, review and failure states; each host only maps
// its own job status onto `DesktopPublishState`, the contract this popup accepts.

interface Props {
  readonly state: DesktopPublishState;
  readonly close: () => void;
  /** A host-specific sentence under the result, such as an unconfirmed deployment. */
  readonly note?: string;
  /** The footer line while publishing, already translated; it says whether the host must stay open. Desktop's default asks to keep Stacki open. */
  readonly runningNote?: string;
}

export function PublishStatus({ state, close, note, runningNote }: Props) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const footerNote = runningNote ?? translate('publish.status.keepOpen');
  assert(footerNote.length > 0, 'A running publish always explains what to keep open');
  const busy = publishStatusBusy(state);
  const title = publishStatusTitle(state, translate);
  return (
    <Popup className="modal publish-status" label={title} onClose={close} dismissible={!busy}>
      {({ close: dismiss }) => (
        <>
          <div className="modal-body publish-status-body" data-state={state.kind}>
            <div className="publish-status-symbol" aria-hidden="true">
              <PublishStatusSymbol state={state} />
            </div>
            <h2>{title}</h2>
            {busy ? (
              <PublishRunning state={state} />
            ) : (
              <>
                {state.kind === 'failed' && <p role="alert">{translateDescribed(state)}</p>}
                {state.kind === 'review-open' && (
                  <p>
                    <a href={state.url} target="_blank" rel="noreferrer">
                      {translate('publish.status.openPullRequest')}
                    </a>{' '}
                    {translate('publish.status.unchanged')}
                  </p>
                )}
                <PublishResults state={state} />
              </>
            )}
            {note !== undefined && <p className="publish-status-note">{note}</p>}
          </div>
          <div className="modal-footer">
            {busy ? (
              <span>{footerNote}</span>
            ) : (
              <button className="primary" onClick={dismiss}>
                {state.kind === 'done' ? translate('publish.common.done') : translate('ui.close')}
              </button>
            )}
          </div>
        </>
      )}
    </Popup>
  );
}

/** Idle shows as running: the popup only opens once a publish has been requested. */
export function publishStatusBusy(state: DesktopPublishState): boolean {
  switch (state.kind) {
    case 'idle':
    case 'running':
      return true;
    case 'done':
    case 'failed':
    case 'review-open':
      return false;
  }
}

export function publishStatusTitle(state: DesktopPublishState, translate: Translator): string {
  switch (state.kind) {
    case 'idle':
    case 'running':
      return translate('publish.status.title.running');
    case 'review-open':
      return translate('publish.status.title.review');
    case 'done':
      return translate('publish.status.title.done');
    case 'failed':
      return translate('publish.status.title.failed');
  }
}

function PublishStatusSymbol({ state }: { readonly state: DesktopPublishState }) {
  switch (state.kind) {
    case 'done':
      return <CheckIcon size={24} />;
    case 'failed':
      return <CloseIcon size={24} />;
    case 'idle':
    case 'running':
    case 'review-open':
      return <UploadCloudIcon size={24} />;
  }
}

function PublishRunning({ state }: { readonly state: DesktopPublishState }) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const message =
    state.kind === 'running'
      ? translateDescribed({
          message: state.step,
          messageRef: state.stepRef,
        })
      : translate('publish.status.preparing');
  const progress = state.kind === 'running' ? state.progress : undefined;
  if (progress !== undefined) {
    assert(progress.completed < progress.total, 'A running publish has a step left to finish');
  }
  return (
    <div className="publish-status-running" aria-busy="true">
      <p role="status" aria-live="polite">
        {message}
      </p>
      <progress max={progress?.total ?? 1} value={progress?.completed} aria-label={translate('publish.status.progress')} aria-valuetext={message} />
      <small>
        {progress
          ? translate('publish.status.stepOf', { current: progress.completed + 1, total: progress.total })
          : translate('publish.status.preparingProject')}
      </small>
    </div>
  );
}

function PublishResults({ state }: { readonly state: DesktopPublishState }) {
  const translate = useTranslate();
  if (state.kind === 'done' || state.kind === 'failed') {
    return (
      <div className="publish-status-results" role="status" aria-live="polite">
        {state.github && (
          <div>
            <PublishProviderIcon provider="github" />
            <span>{translate('publish.status.githubDone')}</span>
            <CheckIcon size={14} />
          </div>
        )}
        {state.hosting && (
          <div>
            <UploadCloudIcon />
            <span>{translate('publish.status.hostingDone')}</span>
            <CheckIcon size={14} />
          </div>
        )}
      </div>
    );
  }
  return undefined;
}
