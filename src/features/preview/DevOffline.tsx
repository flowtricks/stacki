import { ErrorToast } from '../../ui/ErrorToast';
import { reportErrorToast } from '../../ui/errorNotices';
import type { IpcResults } from '../../../shared/ipc/ipcResults';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';
import { NO_LIVE_TEXT, useLiveValue, type LiveValue } from '../../ui/liveValue';

const NODE_URL = 'https://nodejs.org/en/download';
export type DevDiagnosis = IpcResults['dev:diagnose'];

export function DevOffline({
  devLog,
  devDiag,
  onRestart,
}: {
  readonly devLog?: LiveValue<string> | undefined;
  readonly devDiag?: DevDiagnosis | undefined;
  readonly onRestart?: () => void;
}) {
  const translate = useTranslate();
  const log = useLiveValue(devLog ?? NO_LIVE_TEXT);
  const message = offlineMessage(devDiag, translate);
  return (
    <>
      <div>{translate('preview.offline.title')}</div>
      <ErrorToast message={message.known ? `${message.title} ${message.detail ?? ''}` : undefined} />
      <div className="offline-actions">
        <button onClick={onRestart}>{translate('preview.offline.start')}</button>
        <OfflineAction action={message.action} />
      </div>
      {devDiag?.nodePath && (
        <div className="offline-meta">{translate('preview.offline.usingNode', { version: devDiag.nodeVersion ?? '?', path: devDiag.nodePath })}</div>
      )}
      {log && (
        <button className="ghost" onClick={() => reportErrorToast(log)}>
          {translate('preview.offline.diagnostics')}
        </button>
      )}
    </>
  );
}

function OfflineAction({ action }: { readonly action: OfflineMessage['action'] }) {
  if (!action) {
    return undefined;
  }
  return (
    <button className="ghost" onClick={() => void window.avb.openExternal(action.url)}>
      {action.label}
    </button>
  );
}

interface OfflineMessage {
  readonly known: boolean;
  readonly title: string;
  readonly detail: string | undefined;
  readonly action: { readonly label: string; readonly url: string } | undefined;
}

function offlineMessage(diagnosis: DevDiagnosis | undefined, translate: Translator): OfflineMessage {
  if (diagnosis?.kind === 'no-node') {
    return {
      known: true,
      title: translate('preview.offline.noNode.title'),
      detail: translate('preview.offline.noNode.detail'),
      action: { label: translate('preview.offline.getNode'), url: NODE_URL },
    };
  }
  if (diagnosis?.kind === 'node-too-old') {
    return {
      known: true,
      title: translate('preview.offline.nodeOld.title', { version: diagnosis.nodeVersion ?? '?' }),
      detail: translate('preview.offline.nodeOld.detail', { astroVersion: diagnosis.astroVersion ?? '?', requires: diagnosis.requires ?? '?' }),
      action: { label: translate('preview.offline.getNode'), url: NODE_URL },
    };
  }
  if (diagnosis?.kind === 'no-deps') {
    return {
      known: true,
      title: translate('preview.offline.noDeps.title'),
      detail: translate('preview.offline.noDeps.detail'),
      action: undefined,
    };
  }
  return { known: false, title: translate('preview.offline.title'), detail: undefined, action: undefined };
}
