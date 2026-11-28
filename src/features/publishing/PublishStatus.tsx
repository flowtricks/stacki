import { ErrorToast } from '../../ui/ErrorToast';
import { NoticeToast } from '../../ui/NoticeToast';
import Popup from '../../ui/Popup';
import { CheckIcon, CloseIcon, UploadCloudIcon } from '../../ui/Icons';
import { PublishProviderIcon } from './PublishProviderIcon';
import type { DesktopPublishState } from '../../../shared/properties/publishState';
import { publishNeedsWorkerSetup } from '../../../shared/properties/publishWorkerSetup';
import { WorkerSetupButton } from './PublishWorker';
import { useState } from 'react';
import { assert } from '../../../shared/core/assert';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import type { MessageKey, Translator } from '../../../shared/properties/i18n/messageRef';
import './publishing.css';

// The one publish progress popup. Desktop renders it directly and Studio vendors it, so both
// hosts show the same steps, progress, success, review and failure states; each host only maps
// its own job status onto `DesktopPublishState`, the contract this popup accepts.

interface Props {
  readonly state: DesktopPublishState;
  readonly close: () => void;
  /** A host-specific sentence about the result, such as an unconfirmed deployment: told once as a toast, never a row in the popup. */
  readonly note?: string;
  /** The footer line while publishing, already translated; it says whether the host must stay open. Desktop's default asks to keep Stacki open. */
  readonly runningNote?: string;
  /**
   * Sets the site up for Cloudflare Workers when that is what stopped the publish; it reports its own outcome as toasts.
   * A host that cannot set a site up leaves it out, and the dialog then only says what is missing.
   */
  readonly setUpWorker?: (() => Promise<void>) | undefined;
}

export function PublishStatus({ state, close, note, runningNote, setUpWorker }: Props) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const [settingUp, setSettingUp] = useState(false);
  const footerNote = runningNote ?? translate('publish.status.keepOpen');
  assert(footerNote.length > 0, 'A running publish always explains what to keep open');
  const busy = publishStatusBusy(state);
  const title = publishStatusTitle(state, translate);
  const label = unnamedDestination(state);
  // The one failure with a fix: the body says what is missing in a line, and the fix is the primary button.
  const needsSetup = publishNeedsWorkerSetup(state);
  const fix = needsSetup ? setUpWorker : undefined;
  return (
    <Popup className="modal publish-status" label={title} onClose={close} dismissible={!busy && !settingUp}>
      {({ close: dismiss }) => (
        <>
          <div className="modal-body publish-status-body" data-state={state.kind}>
            <div className="publish-status-symbol" aria-hidden="true">
              <PublishStatusSymbol state={state} />
            </div>
            <h2>{title}</h2>
            {label !== undefined && <span className="publish-status-destination">{label}</span>}
            {busy ? (
              <PublishRunning state={state} />
            ) : (
              <>
                {needsSetup ? (
                  <p>{translate('publish.worker.setup.needed')}</p>
                ) : (
                  <ErrorToast message={state.kind === 'failed' ? translateDescribed(state) : undefined} />
                )}
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
            <NoticeToast message={note} kind="info" />
          </div>
          <div className="modal-footer">
            {busy ? (
              <span>{footerNote}</span>
            ) : fix !== undefined ? (
              <>
                <button type="button" onClick={dismiss} disabled={settingUp}>
                  {translate('ui.close')}
                </button>
                <WorkerSetupButton
                  label={translate('publish.worker.setup.action')}
                  busyLabel={translate('publish.worker.setup.running')}
                  busy={settingUp}
                  disabled={false}
                  run={() => {
                    setSettingUp(true);
                    void fix().finally(() => setSettingUp(false));
                  }}
                />
              </>
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
      return translate('publish.status.title.running');
    case 'running':
      return state.destination === undefined
        ? translate('publish.status.title.running')
        : translate('publish.status.title.destinationRunning', { label: state.destination.label });
    case 'review-open':
      return translate('publish.status.title.review');
    case 'done':
      return translate(doneTitle(state), { label: state.destination?.label ?? '' });
    case 'failed':
      return translate('publish.status.title.failed');
  }
}

/** What finished, in no more words than Stacki can stand behind: a script that ran or a request sent is not a live site. */
function doneTitle(state: Extract<DesktopPublishState, { kind: 'done' }>): MessageKey {
  const added = state.destination !== undefined;
  switch (state.handoff) {
    case 'github':
      return added ? 'publish.status.title.destinationPushed' : 'publish.status.title.pushed';
    case 'script':
      return 'publish.status.title.scriptDone';
    case 'link':
      return 'publish.status.title.requestSent';
    case undefined:
      return added ? 'publish.status.title.destinationDone' : 'publish.status.title.done';
  }
}

/** The destination's label where the title does not already say it: after a script, a request or a failure. */
function unnamedDestination(state: DesktopPublishState): string | undefined {
  if (state.kind === 'failed') {
    return state.destination?.label;
  }
  if (state.kind === 'done') {
    return state.handoff === 'script' || state.handoff === 'link' ? state.destination?.label : undefined;
  }
  return undefined;
}

function hostingResult(state: Extract<DesktopPublishState, { kind: 'done' | 'failed' }>): MessageKey {
  switch (state.handoff) {
    case 'script':
      return 'publish.status.title.scriptDone';
    case 'link':
      return 'publish.status.requestAccepted';
    case 'github':
    case undefined:
      return state.destination === undefined ? 'publish.status.hostingDone' : 'publish.status.destinationDone';
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
            <span>{translate(state.destination === undefined ? 'publish.status.githubDone' : 'publish.status.destinationPushed')}</span>
            <CheckIcon size={14} />
          </div>
        )}
        {state.hosting && (
          <div>
            <UploadCloudIcon />
            <span>{translate(hostingResult(state), { label: state.destination?.label ?? '' })}</span>
            <CheckIcon size={14} />
          </div>
        )}
      </div>
    );
  }
  return undefined;
}
