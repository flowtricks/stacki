import Popup from '../../ui/Popup';
import { CheckIcon, CloseIcon, UploadCloudIcon } from '../../ui/Icons';
import { PublishProviderIcon } from './PublishProviderIcon';
import type { DesktopPublishState } from '../../../shared/properties/publishState';
import { assert } from '../../../shared/core/assert';
import './publishing.css';

// The one publish progress popup. Desktop renders it directly and Studio vendors it, so both
// hosts show the same steps, progress, success, review and failure states; each host only maps
// its own job status onto `DesktopPublishState`, the contract this popup accepts.

export const PUBLISH_STATUS_RUNNING_NOTE = 'Keep Stacki open until publishing finishes.';

interface Props {
  readonly state: DesktopPublishState;
  readonly close: () => void;
  /** A host-specific sentence under the result, such as an unconfirmed deployment. */
  readonly note?: string;
  /** The footer line while publishing; it says whether the host must stay open. */
  readonly runningNote?: string;
}

export function PublishStatus({ state, close, note, runningNote = PUBLISH_STATUS_RUNNING_NOTE }: Props) {
  assert(runningNote.length > 0, 'A running publish always explains what to keep open');
  const busy = publishStatusBusy(state);
  const title = publishStatusTitle(state);
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
                {state.kind === 'failed' && <p role="alert">{state.message}</p>}
                {state.kind === 'review-open' && (
                  <p>
                    <a href={state.url} target="_blank" rel="noreferrer">
                      Open pull request
                    </a>{' '}
                    Your live site and current branch are unchanged.
                  </p>
                )}
                <PublishResults state={state} />
              </>
            )}
            {note !== undefined && <p className="publish-status-note">{note}</p>}
          </div>
          <div className="modal-footer">
            {busy ? (
              <span>{runningNote}</span>
            ) : (
              <button className="primary" onClick={dismiss}>
                {state.kind === 'done' ? 'Done' : 'Close'}
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

export function publishStatusTitle(state: DesktopPublishState): string {
  switch (state.kind) {
    case 'idle':
    case 'running':
      return 'Publishing';
    case 'review-open':
      return 'Ready for review';
    case 'done':
      return 'Published successfully';
    case 'failed':
      return 'Publish needs attention';
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
  const message = state.kind === 'running' ? state.step : 'Preparing publish…';
  const progress = state.kind === 'running' ? state.progress : undefined;
  if (progress !== undefined) {
    assert(progress.completed < progress.total, 'A running publish has a step left to finish');
  }
  return (
    <div className="publish-status-running" aria-busy="true">
      <p role="status" aria-live="polite">
        {message}
      </p>
      <progress max={progress?.total ?? 1} value={progress?.completed} aria-label="Publish progress" aria-valuetext={message} />
      <small>{progress ? `Step ${progress.completed + 1} of ${progress.total}` : 'Preparing your project'}</small>
    </div>
  );
}

function PublishResults({ state }: { readonly state: DesktopPublishState }) {
  if (state.kind === 'done' || state.kind === 'failed') {
    return (
      <div className="publish-status-results" role="status" aria-live="polite">
        {state.github && (
          <div>
            <PublishProviderIcon provider="github" />
            <span>Changes pushed to GitHub</span>
            <CheckIcon size={14} />
          </div>
        )}
        {state.hosting && (
          <div>
            <UploadCloudIcon />
            <span>Hosting deployment completed</span>
            <CheckIcon size={14} />
          </div>
        )}
      </div>
    );
  }
  return undefined;
}
