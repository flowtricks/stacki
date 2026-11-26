// How a pin stands, as a small filled pill: Draft, Queued, Working, Done, Needs you, Didn't finish, Stopped, Not
// started, On hold, Started, Sent. The app's tooltip says more (why a pin needs the person or was not done), never
// a line of text under it. "Needs you" always has something to answer (pinAnswer.ts).
import { createPortal } from 'react-dom';
import type { MessageKey, Translator } from '../../../lib/i18n/localeContext';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { PIN_LIMITS } from '../../../../shared/properties/ai/commentPinBrief';
import FittedTooltip from '../../../ui/FittedTooltip';
import { CheckIcon, CloseIcon, WarningTriangleIcon } from '../../../ui/Icons';
import { tooltipHost, useDelayedTooltip } from '../../../ui/delayedTooltip';
import type { PinProgress, UnfinishedReason } from './pinModel';

const LABELS = {
  draft: 'ai.pins.progress.draft',
  queued: 'ai.pins.progress.queued',
  working: 'ai.pins.progress.working',
  done: 'ai.pins.progress.done',
  attention: 'ai.pins.progress.attention',
  sent: 'ai.pins.progress.sent',
  held: 'ai.pins.progress.held',
  unreported: 'ai.pins.progress.started',
} as const satisfies Record<Exclude<PinProgress['kind'], 'unfinished'>, MessageKey>;

const ATTENTION_TIPS = {
  permission: 'ai.pins.attention.permission',
  question: 'ai.pins.attention.question',
} as const satisfies Record<Extract<PinProgress, { readonly kind: 'attention' }>['reason'], MessageKey>;

const UNFINISHED = {
  failed: { label: 'ai.pins.progress.failed', tip: 'ai.pins.attention.failed' },
  stopped: { label: 'ai.pins.progress.stopped', tip: 'ai.pins.attention.stopped' },
  'not-started': { label: 'ai.pins.progress.notStarted', tip: 'ai.pins.progress.notStartedTip' },
} as const satisfies Record<UnfinishedReason, { readonly label: MessageKey; readonly tip: MessageKey }>;

const TIPS = {
  draft: 'ai.pins.progress.draftTip',
  queued: 'ai.pins.progress.queuedTip',
  working: 'ai.pins.progress.workingTip',
  done: 'ai.pins.progress.doneTip',
  sent: 'ai.pins.progress.sentTip',
  held: 'ai.pins.attention.paused',
  unreported: 'ai.subagents.status.unreportedTip',
} as const satisfies Record<Exclude<PinProgress['kind'], 'attention' | 'unfinished'>, MessageKey>;

/** The pill's words. */
export function progressLabel(progress: PinProgress, translate: Translator): string {
  return translate(progress.kind === 'unfinished' ? UNFINISHED[progress.reason].label : LABELS[progress.kind]);
}

/** The pill's tooltip: what the state means; for "Needs you", what waits; for a pin not done, why. */
export function progressTip(progress: PinProgress, translate: Translator): string {
  if (progress.kind === 'attention') {
    return translate(ATTENTION_TIPS[progress.reason]);
  }
  if (progress.kind === 'unfinished') {
    return translate(UNFINISHED[progress.reason].tip);
  }
  if (progress.kind === 'queued') {
    return translate(TIPS.queued, { count: PIN_LIMITS.concurrencyMax });
  }
  return progress.kind === 'working' && progress.end === 'reply' ? translate('ai.subagents.status.backgroundTip') : translate(TIPS[progress.kind]);
}

export function PinProgressPill({ progress }: { readonly progress: PinProgress }) {
  const translate = useTranslate();
  return <PinPill tone={progress.kind} label={progressLabel(progress, translate)} tip={progressTip(progress, translate)} />;
}

/** A pin's element is gone from the page shown: it keeps its words and waits to be moved. */
export function DetachedPill() {
  const translate = useTranslate();
  return <PinPill tone="detached" label={translate('ai.pins.detached')} tip={translate('ai.pins.detachedTip')} />;
}

/** A pin never saved: its box holds words that "Send all" will not take until they are saved. */
export function UnsavedPill() {
  const translate = useTranslate();
  return <PinPill tone="unsaved" label={translate('ai.pins.unsaved')} tip={translate('ai.pins.unsavedTip')} />;
}

/** A small filled pill with the app's tooltip. */
function PinPill({ tone, label, tip }: { readonly tone: PinProgress['kind'] | 'detached' | 'unsaved'; readonly label: string; readonly tip: string }) {
  const tooltip = useDelayedTooltip();
  return (
    <>
      <span className={`ai-pin-progress is-${tone}`} onMouseEnter={tooltip.show} onMouseLeave={tooltip.hide} aria-label={`${label}: ${tip}`}>
        {tone === 'working' && <span className="ai-pin-progress-dot" aria-hidden="true" />}
        {tone === 'done' && <CheckIcon size={10} />}
        {tone === 'attention' && <WarningTriangleIcon size={10} />}
        {tone === 'unfinished' && <CloseIcon size={10} />}
        {label}
      </span>
      {tooltip.value !== undefined &&
        createPortal(
          <FittedTooltip role="tooltip" anchor={tooltip.value}>
            {tip}
          </FittedTooltip>,
          tooltipHost(undefined),
        )}
    </>
  );
}
