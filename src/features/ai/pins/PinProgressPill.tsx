// How a pin stands, as a small filled pill: Draft, Queued, Working, Done, Needs you, Sent. "Needs you" says why in
// the app's tooltip (a question waits in the chat, the work did not finish, it was stopped, or the run is held),
// never in a line of text under it.
import { createPortal } from 'react-dom';
import type { MessageKey, Translator } from '../../../lib/i18n/localeContext';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import FittedTooltip from '../../../ui/FittedTooltip';
import { tooltipHost, useDelayedTooltip } from '../../../ui/delayedTooltip';
import type { AttentionReason, PinProgress } from './pinModel';

const LABELS = {
  draft: 'ai.pins.progress.draft',
  queued: 'ai.pins.progress.queued',
  working: 'ai.pins.progress.working',
  done: 'ai.pins.progress.done',
  attention: 'ai.pins.progress.attention',
  sent: 'ai.pins.progress.sent',
} as const satisfies Record<PinProgress['kind'], MessageKey>;

const REASONS = {
  permission: 'ai.pins.attention.permission',
  failed: 'ai.pins.attention.failed',
  stopped: 'ai.pins.attention.stopped',
  paused: 'ai.pins.attention.paused',
} as const satisfies Record<AttentionReason, MessageKey>;

const TIPS = {
  draft: 'ai.pins.progress.draftTip',
  queued: 'ai.pins.progress.queuedTip',
  working: 'ai.pins.progress.workingTip',
  done: 'ai.pins.progress.doneTip',
  sent: 'ai.pins.progress.sentTip',
} as const satisfies Record<Exclude<PinProgress['kind'], 'attention'>, MessageKey>;

/** The pill's words. */
export function progressLabel(progress: PinProgress, translate: Translator): string {
  return translate(LABELS[progress.kind]);
}

/** The pill's tooltip: what the state means, and for "Needs you", why. */
export function progressTip(progress: PinProgress, translate: Translator): string {
  return progress.kind === 'attention' ? translate(REASONS[progress.reason]) : translate(TIPS[progress.kind]);
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
