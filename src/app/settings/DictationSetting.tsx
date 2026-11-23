// Settings → Dictation, a tab of its own: whether dictation is ready (and the one button that gets it there),
// which quality to use, which language to listen for, the microphone's permission, the person's vocabulary and
// snippets, and, folded away, where the model came from and lives. Shown only where Stacki's Whisper engine
// runs (Desktop). The language names come from Intl in the person's language, so the list needs no strings of
// its own. Failures are toasts, never a paragraph; a number or path that is not known yet is a skeleton.
import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import { downloadPercent } from '../../../shared/properties/voice/dictationEngine';
import { MICROPHONE_STATUSES, type MicrophoneReport } from '../../../shared/properties/microphone';
import {
  modelTotalBytes,
  WHISPER_LANGUAGES,
  WHISPER_MODELS,
  type DictationLanguage,
  type WhisperModelId,
} from '../../../shared/properties/voice/whisperModels';
import { downloadFailureText } from '../../features/ai/composer/dictationToasts';
import type { DictationStore } from '../../features/ai/voice/dictationStore';
import { useVoiceEnvironment } from '../../features/ai/voice/voiceEnvironment';
import { openMicrophoneSettings, readMicrophone } from '../../ipc/microphoneBridge';
import { revealDictationModel } from '../../ipc/dictationBridge';
import { cleanError } from '../../lib/cleanError';
import { useFormat, useLocale, useTranslate } from '../../lib/i18n/useTranslate';
import { CodeInline } from '../../ui/CodeBlock';
import { confirmDialog } from '../../ui/ConfirmDialog';
import Dropdown, { type DropdownOption } from '../../ui/Dropdown';
import { ErrorToast } from '../../ui/ErrorToast';
import { reportErrorToast } from '../../ui/errorNotices';
import { CheckIcon, ChevronDownIcon, FolderOpenIcon, MicrophoneIcon } from '../../ui/Icons';
import InfoHint from '../../ui/InfoHint';
import { Skeleton } from '../../ui/Skeleton';
import { dictationPageStatus, modelDisplayName, modelFolder, PATH_CHARS_SHOWN, shortenMiddle, type DictationPageStatus } from './dictationDisplay';
import { DictationQuality } from './DictationQuality';
import { DictationWordsRows } from './DictationWords';
import { SettingsRow, SettingsSection } from './SettingsLayout';
import './dictationSetting.css';

/** `projectPath`: the project open in this window, whose component names the word list suggests; none on the welcome screen. */
export function DictationSetting({ projectPath }: { readonly projectPath: string | undefined }) {
  const store = useVoiceEnvironment().whisper?.store;
  return store === undefined ? undefined : <DictationPage store={store} projectPath={projectPath} />;
}

function DictationPage({ store, projectPath }: { readonly store: DictationStore; readonly projectPath: string | undefined }) {
  const translate = useTranslate();
  const snapshot = useSyncExternalStore(store.subscribe, store.snapshot);
  useEffect(() => {
    void store.refresh().catch(() => undefined);
  }, [store]);
  const status = dictationPageStatus(snapshot);
  const engine = snapshot.engine;
  const progress = status.kind === 'downloading' ? { receivedBytes: status.receivedBytes, totalBytes: status.totalBytes } : undefined;
  const failure = engine.kind === 'error' && typeof engine.failure === 'object' ? engine.failure.download : undefined;
  const languageOptions = useLanguageOptions();
  return (
    <section className="dictation-page" aria-label={translate('settings.tab.dictation')}>
      <StatusCard store={store} status={status} model={snapshot.model} />
      <ErrorToast message={failure !== undefined && failure !== 'cancelled' ? downloadFailureText(failure, translate) : undefined} />
      <SettingsSection title={translate('dictation.settings.model')} info={translate('dictation.quality.info')}>
        <DictationQuality store={store} snapshot={snapshot} progress={progress} />
      </SettingsSection>
      <div className="dictation-group">
        <SettingsRow label={translate('dictation.settings.language')} info={translate('dictation.settings.languageInfo')}>
          <Dropdown<DictationLanguage>
            ariaLabel={translate('dictation.settings.language')}
            value={snapshot.language}
            options={languageOptions}
            searchable
            onChange={store.setLanguage}
          />
        </SettingsRow>
        <MicrophoneRow />
      </div>
      <DictationWordsRows words={snapshot.words} projectPath={projectPath} onChange={store.setWords} />
      <ModelDetails status={status} model={snapshot.model} directory={snapshot.status?.directory} />
    </section>
  );
}

// The header: one state at a time, its words, and the one thing to do about it. Not set up → Download (blue);
// downloading → a bar with the bytes so far, and Cancel; ready → a check, and Remove. A paused download resumes
// where it stopped, so it offers Download again.
function StatusCard({ store, status, model }: { readonly store: DictationStore; readonly status: DictationPageStatus; readonly model: WhisperModelId }) {
  const translate = useTranslate();
  const { formatBytes } = useFormat();
  const downloadSize = formatBytes(modelTotalBytes(WHISPER_MODELS[model]));
  const remove = async (): Promise<void> => {
    const size = status.kind === 'ready' ? formatBytes(status.sizeBytes) : '';
    const answer = await confirmDialog({
      title: translate('dictation.settings.removeTitle'),
      body: translate('dictation.settings.removeBody', { size }),
      confirmLabel: translate('dictation.settings.removeConfirm'),
      danger: true,
    });
    if (answer === true) {
      await store.remove();
    }
  };
  let title: string | undefined;
  let detail: string | undefined;
  switch (status.kind) {
    case 'loading':
      break;
    case 'notInstalled':
      title = translate('dictation.page.notInstalled');
      detail = translate('dictation.page.notInstalledDetail');
      break;
    case 'partial':
      title = translate('dictation.page.partial');
      detail = translate('dictation.settings.status.partial', { received: formatBytes(status.receivedBytes), total: formatBytes(status.totalBytes) });
      break;
    case 'downloading':
      title = translate('dictation.settings.status.downloading', { percent: downloadPercent(status.receivedBytes, status.totalBytes) });
      detail = translate('dictation.page.progress', { received: formatBytes(status.receivedBytes), total: formatBytes(status.totalBytes) });
      break;
    case 'ready':
      title = translate('dictation.page.ready');
      detail = translate('dictation.settings.status.installed', { size: formatBytes(status.sizeBytes) });
      break;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
  return (
    <div className="dictation-status" data-state={status.kind}>
      <span className="dictation-status-mark" aria-hidden="true">
        {status.kind === 'ready' ? <CheckIcon size={20} /> : <MicrophoneIcon size={20} />}
      </span>
      <div className="dictation-status-text" role="status">
        {title === undefined ? (
          <>
            <Skeleton width="160px" />
            <Skeleton width="220px" />
          </>
        ) : (
          <>
            <span className="dictation-status-title">
              {title}
              <InfoHint text={translate('dictation.settings.info')} />
            </span>
            <span className="dictation-status-detail">{detail}</span>
          </>
        )}
      </div>
      <div className="dictation-status-action">
        {status.kind === 'loading' && <Skeleton width="120px" height="28px" radius="6px" />}
        {(status.kind === 'notInstalled' || status.kind === 'partial') && (
          <button type="button" className="primary" onClick={() => void store.download()}>
            {translate('dictation.settings.download', { size: downloadSize })}
          </button>
        )}
        {status.kind === 'downloading' && (
          <button type="button" onClick={() => void store.cancel()}>
            {translate('dictation.settings.cancel')}
          </button>
        )}
        {status.kind === 'ready' && (
          <button type="button" className="danger" onClick={() => void remove()}>
            {translate('dictation.settings.remove')}
          </button>
        )}
      </div>
      {status.kind === 'downloading' && (
        <div
          className="dictation-status-bar"
          role="progressbar"
          aria-label={title}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={downloadPercent(status.receivedBytes, status.totalBytes)}
        >
          <div className="dictation-status-bar-fill" style={{ width: `${downloadPercent(status.receivedBytes, status.totalBytes)}%` }} />
        </div>
      )}
    </div>
  );
}

// The system owns the microphone permission; this row only says what it answered, and opens the pane that changes it.
// Where the system cannot say (or the bridge is absent) there is nothing true to show, so the row is not drawn.
function MicrophoneRow() {
  const translate = useTranslate();
  const report = useMicrophoneReport();
  if (report === undefined || report.status === 'unknown') {
    return undefined;
  }
  const labels = {
    granted: 'dictation.settings.mic.granted',
    'not-determined': 'dictation.settings.mic.notDetermined',
    denied: 'dictation.settings.mic.denied',
    restricted: 'dictation.settings.mic.restricted',
  } as const;
  const key = labels[report.status];
  return (
    <SettingsRow label={translate('dictation.settings.mic')}>
      <span className="dictation-mic-state" data-status={report.status}>
        {report.status === 'granted' && <CheckIcon size={12} />}
        {translate(key)}
      </span>
      {report.status === 'denied' && report.settingsAvailable && (
        <button type="button" onClick={() => void openMicrophoneSettings().catch((error: unknown) => reportErrorToast(cleanError(error)))}>
          {translate('ai.dictation.openSettings')}
        </button>
      )}
    </SettingsRow>
  );
}

function useMicrophoneReport(): MicrophoneReport | undefined {
  const [report, setReport] = useState<MicrophoneReport | undefined>(undefined);
  useEffect(() => {
    if (typeof window.avb?.microphoneStatus !== 'function') {
      return undefined;
    }
    let live = true;
    readMicrophone()
      .then((next) => {
        if (live && MICROPHONE_STATUSES.includes(next.status)) {
          setReport(next);
        }
      })
      .catch(() => undefined); // The row is a convenience: when the system will not say, it is not drawn.
    return () => {
      live = false;
    };
  }, []);
  return report;
}

// Model details, folded: where the model comes from and where it lives, for the few who ask. Collapsed, none of it
// is in the page, so the pinned commit and the long path never crowd the cards above.
function ModelDetails({
  status,
  model,
  directory,
}: {
  readonly status: DictationPageStatus;
  readonly model: WhisperModelId;
  readonly directory: string | undefined;
}) {
  const translate = useTranslate();
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const details = WHISPER_MODELS[model];
  const folder = directory === undefined ? undefined : modelFolder(directory, model);
  const reveal = (): void => {
    void revealDictationModel(model).catch((error: unknown) => reportErrorToast(cleanError(error)));
  };
  return (
    <div className="dictation-details" data-open={open}>
      <button type="button" className="dictation-details-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((value) => !value)}>
        <ChevronDownIcon size={12} />
        {translate('dictation.details.title')}
      </button>
      {open && (
        <dl id={bodyId} className="dictation-details-list">
          <dt>{translate('dictation.details.model')}</dt>
          <dd>{modelDisplayName(details)}</dd>
          <dt>{translate('dictation.settings.source')}</dt>
          <dd title={`${details.repository} @ ${details.revision}`}>{details.repository}</dd>
          <dt>{translate('dictation.settings.license')}</dt>
          <dd>{translate('dictation.details.licenseValue', { license: details.license })}</dd>
          <dt>{translate('dictation.settings.storage')}</dt>
          <dd className="dictation-details-storage">
            {folder === undefined ? (
              <Skeleton width="70%" />
            ) : (
              <>
                <span className="dictation-details-path" title={`${folder}/${details.revision}`}>
                  <CodeInline text={shortenMiddle(folder, PATH_CHARS_SHOWN)} language="shell" />
                </span>
                {status.kind === 'ready' && (
                  <button type="button" className="ghost" onClick={reveal}>
                    <FolderOpenIcon size={12} /> {translate('apps.folder.showInFinder')}
                  </button>
                )}
              </>
            )}
          </dd>
        </dl>
      )}
    </div>
  );
}

// Auto-detect first, then every language by its name in the interface language, sorted by that name.
function useLanguageOptions(): readonly DropdownOption<DictationLanguage>[] {
  const translate = useTranslate();
  const { locale } = useLocale();
  return useMemo(() => {
    const names = new Intl.DisplayNames([locale], { type: 'language' });
    const languages = WHISPER_LANGUAGES.map((code) => ({ value: code, label: names.of(code) ?? code }));
    const sorted = [...languages].sort((first, second) => first.label.localeCompare(second.label, locale));
    return [{ value: 'auto' as const, label: translate('dictation.settings.auto'), pinned: true }, ...sorted];
  }, [locale, translate]);
}
