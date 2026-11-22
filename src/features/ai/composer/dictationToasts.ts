// Dictation's notices, said as the app's toasts (src/ui/errorNotices.ts), never as rows under the
// composer that would push the box around. Each notice keeps its way out as a toast action: a microphone
// the system keeps off opens the right System Settings pane, a stopped model download offers Retry, and a
// computer too slow for the standard model offers the small one.
import type { MicrophoneAdvice } from '../../../../shared/properties/microphone';
import { microphoneAdvice } from '../../../../shared/properties/microphone';
import type { DownloadFailure } from '../../../../shared/properties/voice/dictationModel';
import type { useTranslate, useTranslateRef } from '../../../lib/i18n/useTranslate';
import type { ToastRecovery } from '../../../ui/errorNotices';
import type { ToastKind } from '../../../ui/toastNotice';
import type { DictationNotice } from '../useDictation';

type Translate = ReturnType<typeof useTranslate>;
type TranslateRef = ReturnType<typeof useTranslateRef>;

export interface DictationToast {
  readonly message: string;
  readonly kind: ToastKind;
  readonly recovery: readonly ToastRecovery[];
}

export interface DictationToastActions {
  readonly openSettings: () => void;
  readonly retry: () => void;
  readonly useSmall: () => void;
}

/** The toast for a notice: its sentence, how worried to be, and the action that fixes it. */
export function dictationToast(
  notice: DictationNotice,
  text: { readonly translate: Translate; readonly translateRef: TranslateRef },
  actions: DictationToastActions,
): DictationToast {
  const { translate, translateRef } = text;
  switch (notice.kind) {
    case 'blocked': {
      const advice: MicrophoneAdvice = microphoneAdvice(notice.report);
      const canOpen = notice.report.settingsAvailable && notice.report.status === 'denied';
      return {
        message: `${translateRef(advice.messageRef)} ${translateRef(advice.hintRef)}`,
        kind: 'warning',
        recovery: canOpen ? [{ label: translate('ai.dictation.openSettings'), run: actions.openSettings }] : [],
      };
    }
    case 'message':
      return { message: translateRef(notice.ref), kind: 'warning', recovery: [] };
    case 'modelMissing':
      return {
        message: translate('dictation.notice.modelMissing'),
        kind: 'warning',
        recovery: [{ label: translate('dictation.notice.retry'), run: actions.retry }],
      };
    case 'downloadFailed':
      return {
        message: downloadFailureText(notice.failure, translate),
        kind: 'error',
        recovery: [{ label: translate('dictation.notice.retry'), run: actions.retry }],
      };
    case 'tooSlow':
      return {
        message: translate('dictation.notice.tooSlow'),
        kind: 'warning',
        recovery: [{ label: translate('dictation.notice.useSmall'), run: actions.useSmall }],
      };
    default: {
      const exhaustive: never = notice;
      return exhaustive;
    }
  }
}

/** Why the model download stopped, in the person's terms; a cancel was their own choice and says nothing. */
export function downloadFailureText(failure: DownloadFailure, translate: Translate): string {
  switch (failure) {
    case 'offline':
      return translate('dictation.download.offline');
    case 'timeout':
      return translate('dictation.download.timeout');
    case 'hostRefused':
      return translate('dictation.download.hostRefused');
    case 'httpStatus':
      return translate('dictation.download.httpStatus');
    case 'tooLarge':
      return translate('dictation.download.tooLarge');
    case 'hashMismatch':
      return translate('dictation.download.hashMismatch');
    case 'diskFull':
      return translate('dictation.download.diskFull');
    case 'writeFailed':
      return translate('dictation.download.writeFailed');
    case 'busy':
      return translate('dictation.download.busy');
    case 'cancelled':
      return '';
    default: {
      const exhaustive: never = failure;
      return exhaustive;
    }
  }
}
