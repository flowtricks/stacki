// The in-app update popup: download progress that moves live, "ready to restart", and the answers to the File menu's check.
// Main sends states (electron/app/autoUpdate.ts); this only draws them, so tests and the harness can hand it any state.
// The progress bar is the loading state: it renders at once, at 0%, and only ever grows. Backgrounds, never borders.
// Every state wears the same shape (a tinted circle with an icon, a headline, secondary text, the buttons), so the popup
// does not change character as an update moves from available to downloading to ready.
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { ErrorToast } from '../../ui/ErrorToast';
import Popup from '../../ui/Popup';
import { ArrowDownIcon, CheckIcon, ClockIcon, CloseIcon, CodeIcon } from '../../ui/Icons';
import { useFormat, useTranslate } from '../../lib/i18n/useTranslate';
import { assert } from '../../../shared/core/assert';
import { megabytesOf, type DownloadProgress, type UpdateAction, type UpdateNotice, type UpdateState } from '../../../shared/ipc/updateState';
import type { MessageKey } from '../../lib/i18n/localeContext';
import { mainUpdateBridge, type UpdateBridge } from './updateBridge';
import { useUpdatePopup } from './useUpdatePopup';
import './updatePopup.css';

const NOTICE_MESSAGES: Readonly<Record<UpdateNotice, MessageKey>> = {
  latest: 'dialog.update.check.latest',
  development: 'dialog.update.development.message',
  alreadyChecking: 'dialog.update.check.alreadyChecking',
};

/** The popup as the app mounts it, wired to the main process. */
export function UpdatePopupHost({ bridge = mainUpdateBridge }: { readonly bridge?: UpdateBridge }) {
  const model = useUpdatePopup(bridge);
  return <UpdatePopup state={model.state} hidden={model.hidden} onHide={model.hide} onAct={model.act} />;
}

export interface UpdatePopupProps {
  readonly state: UpdateState;
  readonly hidden: boolean;
  readonly onHide: () => void;
  readonly onAct: (action: UpdateAction) => void;
}

/** The popup for one state. Pure of the bridge, so a test or the harness can show any state deterministically. */
export function UpdatePopup({ state, hidden, onHide, onAct }: UpdatePopupProps) {
  // The headline names the dialog for assistive technology: one id, read by the dialog and set on the headline.
  const headingId = useId();
  if (state.kind === 'idle') {
    return undefined;
  }
  return (
    <Popup className="modal confirm-dialog update-popup" role="dialog" labelledBy={headingId} open={!hidden} onClose={onHide}>
      {({ close, finish }) => (
        <>
          <PopupHeader state={state} headingId={headingId} />
          <PopupBody state={state} />
          <PopupFooter state={state} close={close} finish={finish} onHide={onHide} onAct={onAct} />
        </>
      )}
    </Popup>
  );
}

type ActiveState = Exclude<UpdateState, { readonly kind: 'idle' }>;
type Tone = 'accent' | 'danger';

/** The icon each state shows, and whether it is good news (the accent) or bad (red). One place, so no state is left without one. */
function heroOf(state: ActiveState): { readonly icon: ReactNode; readonly tone: Tone } {
  switch (state.kind) {
    case 'downloading':
      return { icon: <ArrowDownIcon size={32} />, tone: 'accent' };
    case 'ready':
      return { icon: <CheckIcon size={32} />, tone: 'accent' };
    case 'error':
      return { icon: <CloseIcon size={32} />, tone: 'danger' };
    case 'notice':
      switch (state.notice) {
        case 'latest':
          return { icon: <CheckIcon size={32} />, tone: 'accent' };
        case 'development':
          return { icon: <CodeIcon size={32} />, tone: 'accent' };
        case 'alreadyChecking':
          return { icon: <ClockIcon size={32} />, tone: 'accent' };
        default: {
          const exhaustive: never = state.notice;
          return exhaustive;
        }
      }
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

function PopupHeader({ state, headingId }: { readonly state: ActiveState; readonly headingId: string }) {
  const translate = useTranslate();
  const hero = heroOf(state);
  return (
    <div className="modal-header update-header">
      <div className={`update-icon update-icon-${hero.tone}`} data-update-icon={state.kind}>
        {hero.icon}
      </div>
      <div className="update-title" id={headingId}>
        {headlineOf(state, translate)}
      </div>
    </div>
  );
}

function headlineOf(state: ActiveState, translate: ReturnType<typeof useTranslate>): string {
  switch (state.kind) {
    case 'downloading':
      return state.version === undefined
        ? translate('dialog.update.downloading.titleUnnamed')
        : translate('dialog.update.downloading.title', { version: state.version });
    case 'ready':
      return translate('dialog.update.ready.heading', { version: state.version });
    case 'notice':
      // The answer "you have the latest" is the headline; the version is the secondary line under it.
      return state.notice === 'latest' ? translate('dialog.update.upToDate.title') : translate('dialog.update.check.title');
    case 'error':
      return translate('dialog.update.check.title');
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

function PopupBody({ state }: { readonly state: ActiveState }) {
  const translate = useTranslate();
  switch (state.kind) {
    case 'downloading':
      return (
        <div className="modal-body confirm-body update-body">
          <DownloadMeter progress={state.progress} />
          <div>{translate('dialog.update.available.detail')}</div>
        </div>
      );
    case 'ready':
      return <div className="modal-body confirm-body">{translate('dialog.update.ready.detail')}</div>;
    case 'notice':
      return (
        <div className="modal-body confirm-body">
          <div>{translate(NOTICE_MESSAGES[state.notice], { version: state.version })}</div>
          {state.notice === 'development' && <div>{translate('dialog.update.development.detail', { version: state.version })}</div>}
        </div>
      );
    case 'error':
      return (
        <div className="modal-body confirm-body">
          <div>{state.stage === 'check' ? translate('dialog.update.check.failed') : translate('dialog.update.download.failed')}</div>
          <ErrorToast message={state.detail.length > 0 ? state.detail : undefined} />
        </div>
      );
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

interface FooterProps {
  readonly state: ActiveState;
  readonly close: () => void;
  readonly finish: (action: () => void) => void;
  readonly onHide: () => void;
  readonly onAct: (action: UpdateAction) => void;
}
function PopupFooter({ state, close, finish, onHide, onAct }: FooterProps) {
  // A button that acts also hides: the popup has left the screen, and the next news must open it again.
  const act = (action: UpdateAction) =>
    finish(() => {
      onHide();
      onAct(action);
    });
  const translate = useTranslate();
  switch (state.kind) {
    case 'downloading':
      return (
        <div className="modal-footer">
          <DefaultButton onClick={close}>{translate('dialog.update.downloading.hide')}</DefaultButton>
        </div>
      );
    case 'ready':
      return (
        <div className="modal-footer">
          <button onClick={close}>{translate('dialog.update.ready.later')}</button>
          <DefaultButton primary onClick={() => act('install')}>
            {translate('dialog.update.ready.restartNow')}
          </DefaultButton>
        </div>
      );
    case 'notice':
      return (
        <div className="modal-footer">
          <DefaultButton primary onClick={close}>
            {translate('ui.close')}
          </DefaultButton>
        </div>
      );
    case 'error':
      return (
        <div className="modal-footer">
          <button onClick={close}>{translate('ui.close')}</button>
          <DefaultButton primary onClick={() => act('retry')}>
            {translate('ui.retry')}
          </DefaultButton>
        </div>
      );
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

/**
 * The button Enter presses: it takes focus once the dialog is open. The `autoFocus` prop is not enough, because React focuses at
 * mount and the dialog's own showModal() then moves focus to its first button, so "Restart Now" and "Retry" lost it to "Later"
 * and "Close". An effect runs after the dialog opened, so the focus stays.
 */
function DefaultButton({ primary = false, onClick, children }: { readonly primary?: boolean; readonly onClick: () => void; readonly children: ReactNode }) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    button.current?.focus();
  }, []);
  return (
    <button ref={button} className={primary ? 'primary' : undefined} onClick={onClick}>
      {children}
    </button>
  );
}

/** The bar and its two counters: the percent, and "48.2 of 52.4 MB" (just what is in, while the size is unknown). */
function DownloadMeter({ progress }: { readonly progress: DownloadProgress }) {
  const translate = useTranslate();
  const { formatNumber } = useFormat();
  assert(progress.percent >= 0, 'the meter percent is not negative');
  assert(progress.percent <= 100, 'the meter percent is at most 100');
  const megabytes = (bytes: number) => formatNumber(megabytesOf(bytes), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const counter =
    progress.totalBytes === undefined
      ? translate('dialog.update.downloading.counterUnknown', { transferred: megabytes(progress.transferredBytes) })
      : translate('dialog.update.downloading.counter', { transferred: megabytes(progress.transferredBytes), total: megabytes(progress.totalBytes) });
  return (
    <div className="update-meter">
      <div
        className="update-bar"
        role="progressbar"
        aria-label={translate('dialog.update.downloading.progressLabel')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.totalBytes === undefined ? undefined : progress.percent}
      >
        <div className="update-bar-fill" style={{ width: `${progress.percent}%` }} />
      </div>
      <div className="update-counters">
        <span className="update-percent">{translate('dialog.update.downloading.percent', { percent: progress.percent })}</span>
        <span className="update-bytes">{counter}</span>
      </div>
    </div>
  );
}
