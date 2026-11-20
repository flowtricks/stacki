// The in-app update popup: download progress that moves live, "ready to restart", and the answers to the File menu's check.
// Main sends states (electron/app/autoUpdate.ts); this only draws them, so tests and the harness can hand it any state.
// The progress bar is the loading state: it renders at once, at 0%, and only ever grows. Backgrounds, never borders.
import Popup from '../../ui/Popup';
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
  if (state.kind === 'idle') {
    return undefined;
  }
  return (
    <Popup className="modal confirm-dialog update-popup" role="alertdialog" open={!hidden} onClose={onHide}>
      {({ close, finish }) => (
        <>
          <PopupHeader state={state} />
          <PopupBody state={state} />
          <PopupFooter state={state} close={close} finish={finish} onHide={onHide} onAct={onAct} />
        </>
      )}
    </Popup>
  );
}

function PopupHeader({ state }: { readonly state: Exclude<UpdateState, { readonly kind: 'idle' }> }) {
  const translate = useTranslate();
  switch (state.kind) {
    case 'downloading':
      return (
        <div className="modal-header">
          {state.version === undefined
            ? translate('dialog.update.downloading.titleUnnamed')
            : translate('dialog.update.downloading.title', { version: state.version })}
        </div>
      );
    case 'ready':
      return <div className="modal-header">{translate('dialog.update.ready.heading', { version: state.version })}</div>;
    case 'notice':
    case 'error':
      return <div className="modal-header">{translate('dialog.update.check.title')}</div>;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

function PopupBody({ state }: { readonly state: Exclude<UpdateState, { readonly kind: 'idle' }> }) {
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
          {state.detail.length > 0 && <div className="update-error-detail">{state.detail}</div>}
        </div>
      );
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

interface FooterProps {
  readonly state: Exclude<UpdateState, { readonly kind: 'idle' }>;
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
          <button autoFocus onClick={close}>
            {translate('dialog.update.downloading.hide')}
          </button>
        </div>
      );
    case 'ready':
      return (
        <div className="modal-footer">
          <button onClick={close}>{translate('dialog.update.ready.later')}</button>
          <button autoFocus className="primary" onClick={() => act('install')}>
            {translate('dialog.update.ready.restartNow')}
          </button>
        </div>
      );
    case 'notice':
      return (
        <div className="modal-footer">
          <button autoFocus className="primary" onClick={close}>
            {translate('ui.close')}
          </button>
        </div>
      );
    case 'error':
      return (
        <div className="modal-footer">
          <button onClick={close}>{translate('ui.close')}</button>
          <button autoFocus className="primary" onClick={() => act('retry')}>
            {translate('ui.retry')}
          </button>
        </div>
      );
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
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
