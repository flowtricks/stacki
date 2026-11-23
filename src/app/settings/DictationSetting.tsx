// Settings → AI → Dictation: the on-device speech model's status, size, source (repository and pinned
// commit), license and folder; downloading or cancelling it, removing it (after the app's own
// confirmation), which model, and which language dictation listens for. Shown only
// where Stacki's Whisper engine runs (Desktop). The language names come from Intl in the person's
// language, so the list needs no strings of its own.
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { downloadPercent } from '../../../shared/properties/voice/dictationEngine';
import { installOf, type ModelInstall } from '../../../shared/properties/voice/dictationModel';
import {
  modelTotalBytes,
  WHISPER_LANGUAGES,
  WHISPER_MODEL_IDS,
  WHISPER_MODELS,
  type DictationLanguage,
  type WhisperModelId,
} from '../../../shared/properties/voice/whisperModels';
import { downloadFailureText } from '../../features/ai/composer/dictationToasts';
import type { DictationStore } from '../../features/ai/voice/dictationStore';
import { useVoiceEnvironment } from '../../features/ai/voice/voiceEnvironment';
import { useFormat, useLocale, useTranslate } from '../../lib/i18n/useTranslate';
import { confirmDialog } from '../../ui/ConfirmDialog';
import Dropdown, { type DropdownOption } from '../../ui/Dropdown';
import { Skeleton } from '../../ui/Skeleton';
import { DictationWordsRows } from './DictationWords';
import { SettingsRow } from './SettingsLayout';
import './dictationSetting.css';

/** Each quality tier's name and its one-line hint (whisperModels.ts: Best is large-v3 turbo, Balanced small, Fast base). */
const TIER_LABELS = {
  turbo: { label: 'dictation.model.turbo', hint: 'dictation.model.turboHint' },
  small: { label: 'dictation.model.small', hint: 'dictation.model.smallHint' },
  base: { label: 'dictation.model.base', hint: 'dictation.model.baseHint' },
} as const satisfies { readonly [Id in WhisperModelId]: { readonly label: string; readonly hint: string } };

/** Characters of the pinned commit shown; the whole hash is in the tooltip. */
const REVISION_CHARS_SHOWN = 7;

/** `projectPath`: the project open in this window, whose component names the word list suggests; none on the welcome screen. */
export function DictationSetting({ projectPath }: { readonly projectPath: string | undefined }) {
  const store = useVoiceEnvironment().whisper?.store;
  return store === undefined ? undefined : <DictationRows store={store} projectPath={projectPath} />;
}

function DictationRows({ store, projectPath }: { readonly store: DictationStore; readonly projectPath: string | undefined }) {
  const translate = useTranslate();
  const { formatBytes } = useFormat();
  const snapshot = useSyncExternalStore(store.subscribe, store.snapshot);
  useEffect(() => {
    void store.refresh().catch(() => undefined);
  }, [store]);
  const install = installOf(snapshot.status, snapshot.model);
  const model = WHISPER_MODELS[snapshot.model];
  const engine = snapshot.engine;
  const downloading = engine.kind === 'downloading' || install.kind === 'downloading';
  const failure = engine.kind === 'error' && typeof engine.failure === 'object' ? engine.failure.download : undefined;
  const folder = snapshot.status === undefined ? undefined : `${snapshot.status.directory}/${model.id}/${model.revision}`;
  const languageOptions = useLanguageOptions();
  const modelOptions: readonly DropdownOption<WhisperModelId>[] = WHISPER_MODEL_IDS.map((id) => ({
    value: id,
    label: translate(TIER_LABELS[id].label),
    description: `${translate(TIER_LABELS[id].hint)} ${formatBytes(modelTotalBytes(WHISPER_MODELS[id]))}`,
  }));
  const remove = async (): Promise<void> => {
    const size = install.kind === 'installed' ? formatBytes(install.sizeBytes) : '';
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
  return (
    <>
      <SettingsRow label={translate('dictation.settings.label')} info={translate('dictation.settings.info')}>
        <span className="dictation-setting-status">
          {snapshot.status === undefined ? (
            <Skeleton width="120px" />
          ) : engine.kind === 'downloading' ? (
            translate('dictation.settings.status.downloading', { percent: downloadPercent(engine.receivedBytes, engine.totalBytes) })
          ) : (
            statusText(install, { formatBytes, translate })
          )}
        </span>
        {install.kind === 'installed' ? (
          <button type="button" className="danger" onClick={() => void remove()}>
            {translate('dictation.settings.remove')}
          </button>
        ) : downloading ? (
          <button type="button" onClick={() => void store.cancel()}>
            {translate('dictation.settings.cancel')}
          </button>
        ) : (
          <button type="button" onClick={() => void store.download()}>
            {translate('dictation.settings.download', { size: formatBytes(modelTotalBytes(model)) })}
          </button>
        )}
      </SettingsRow>
      {failure !== undefined && failure !== 'cancelled' && (
        <p className="ai-compose-problem dictation-setting-problem">{downloadFailureText(failure, translate)}</p>
      )}
      <dl className="dictation-setting-facts">
        <dt>{translate('dictation.settings.source')}</dt>
        <dd title={model.revision}>
          {translate('dictation.settings.sourceValue', { repository: model.repository, revision: model.revision.slice(0, REVISION_CHARS_SHOWN) })}
        </dd>
        <dt>{translate('dictation.settings.license')}</dt>
        <dd>{translate('dictation.settings.licenseValue', { license: model.license })}</dd>
        <dt>{translate('dictation.settings.storage')}</dt>
        <dd className="dictation-setting-path">{folder ?? <Skeleton width="70%" />}</dd>
      </dl>
      <SettingsRow label={translate('dictation.settings.model')}>
        <Dropdown<WhisperModelId>
          ariaLabel={translate('dictation.settings.model')}
          value={snapshot.model}
          options={modelOptions}
          optionLayout="stacked"
          disabled={downloading}
          onChange={store.setModel}
        />
      </SettingsRow>
      <SettingsRow label={translate('dictation.settings.language')} info={translate('dictation.settings.languageInfo')}>
        <Dropdown<DictationLanguage>
          ariaLabel={translate('dictation.settings.language')}
          value={snapshot.language}
          options={languageOptions}
          searchable
          onChange={store.setLanguage}
        />
      </SettingsRow>
      <DictationWordsRows words={snapshot.words} projectPath={projectPath} onChange={store.setWords} />
    </>
  );
}

function statusText(
  install: ModelInstall,
  text: { readonly formatBytes: (sizeBytes: number) => string; readonly translate: ReturnType<typeof useTranslate> },
): string {
  const { formatBytes, translate } = text;
  switch (install.kind) {
    case 'notInstalled':
      return translate('dictation.settings.status.notInstalled');
    case 'partial':
      return translate('dictation.settings.status.partial', { received: formatBytes(install.receivedBytes), total: formatBytes(install.totalBytes) });
    case 'downloading':
      return translate('dictation.settings.status.downloading', { percent: downloadPercent(install.receivedBytes, install.totalBytes) });
    case 'installed':
      return translate('dictation.settings.status.installed', { size: formatBytes(install.sizeBytes) });
    default: {
      const exhaustive: never = install;
      return exhaustive;
    }
  }
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
