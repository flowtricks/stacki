// Settings → Dictation → Quality: the three speech models as cards to pick from, quickest first. Each card
// names the tier, says in a line what it is good for, shows its download size and whether it is already on this
// computer. Picking one that is downloaded switches to it at once; picking one that is not asks first (the
// download is hundreds of megabytes), then switches and downloads. While a download runs the cards are
// locked, because one model downloads at a time and the choice must not move under it.
import { downloadPercent } from '../../../shared/properties/voice/dictationEngine';
import { installOf } from '../../../shared/properties/voice/dictationModel';
import { modelTotalBytes, WHISPER_MODELS, type WhisperModelId } from '../../../shared/properties/voice/whisperModels';
import type { DictationSnapshot, DictationStore } from '../../features/ai/voice/dictationStore';
import { useFormat, useTranslate } from '../../lib/i18n/useTranslate';
import { confirmDialog } from '../../ui/ConfirmDialog';
import { CheckIcon } from '../../ui/Icons';
import { QUALITY_ORDER } from './dictationDisplay';

/** Each quality tier's name and its one-line hint (whisperModels.ts: Best is large-v3 turbo, Balanced small, Fast base). */
export const TIER_LABELS = {
  turbo: { label: 'dictation.model.turbo', hint: 'dictation.model.turboHint' },
  small: { label: 'dictation.model.small', hint: 'dictation.model.smallHint' },
  base: { label: 'dictation.model.base', hint: 'dictation.model.baseHint' },
} as const satisfies { readonly [Id in WhisperModelId]: { readonly label: string; readonly hint: string } };

export function DictationQuality({
  store,
  snapshot,
  progress,
}: {
  readonly store: DictationStore;
  readonly snapshot: DictationSnapshot;
  /** The running download's bytes, when one runs; the chosen card says how far it is. */
  readonly progress: { readonly receivedBytes: number; readonly totalBytes: number } | undefined;
}) {
  const downloading = progress !== undefined;
  const translate = useTranslate();
  const { formatBytes } = useFormat();
  const choose = async (id: WhisperModelId): Promise<void> => {
    if (id === snapshot.model || downloading) {
      return;
    }
    if (installOf(snapshot.status, id).kind === 'installed') {
      store.setModel(id);
      return;
    }
    const answer = await confirmDialog({
      title: translate('dictation.quality.downloadTitle', { quality: translate(TIER_LABELS[id].label) }),
      body: translate('dictation.quality.downloadBody', { size: formatBytes(modelTotalBytes(WHISPER_MODELS[id])) }),
      confirmLabel: translate('dictation.quality.downloadConfirm'),
    });
    if (answer === true) {
      store.setModel(id);
      await store.download();
    }
  };
  return (
    <div className="dictation-quality" role="radiogroup" aria-label={translate('dictation.settings.model')}>
      {QUALITY_ORDER.map((id) => {
        const selected = id === snapshot.model;
        const install = installOf(snapshot.status, id);
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={downloading && !selected}
            className="dictation-quality-card"
            data-selected={selected}
            onClick={() => void choose(id)}
          >
            <span className="dictation-quality-name">{translate(TIER_LABELS[id].label)}</span>
            <span className="dictation-quality-detail">{translate(TIER_LABELS[id].hint)}</span>
            <span className="dictation-quality-foot">
              <span className="dictation-quality-size">{formatBytes(modelTotalBytes(WHISPER_MODELS[id]))}</span>
              {selected && progress !== undefined && (
                <span className="dictation-quality-state">
                  {translate('dictation.settings.status.downloading', { percent: downloadPercent(progress.receivedBytes, progress.totalBytes) })}
                </span>
              )}
              {install.kind === 'installed' && (
                <span className="dictation-quality-state" data-downloaded="true">
                  <CheckIcon size={12} />
                  {translate('dictation.quality.downloaded')}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
