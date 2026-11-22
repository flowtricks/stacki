// The context ring at the far right of the status line: how much of the agent's context window this chat
// has used (neutral below 70%, amber from 70%, red from 90%). Hovering the ring shows a short tip ("Context 42%
// used"); a click opens a small panel with the numbers, Compact and the auto-compact picker.
//
// A custom Popup, not the ring's tooltip slot: the panel holds buttons, which a tooltip cannot. It opens on click only
// (Enter and Space click the button too), toggles on the next click of the ring, and closes on Escape or a press
// outside. Focus moves to its first control when it opens and returns to the ring when it closes. Compact exists only for agents that can compact (a table in
// agentPresentation.ts: Codex has no compact command) and waits while a turn runs, because the agent
// compacts by taking a turn of its own.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { assert } from '../../../../shared/core/assert';
import type { AgentId } from '../../../../shared/properties/ai/agentIds';
import { canCompact } from '../../../../shared/properties/ai/agentPresentation';
import type { ChatId } from '../../../../shared/properties/ai/chatModel';
import type { Translator } from '../../../lib/i18n/localeContext';
import { useFormat, useTranslate } from '../../../lib/i18n/useTranslate';
import { tooltipHost, useDelayedTooltip } from '../../../ui/delayedTooltip';
import FittedTooltip from '../../../ui/FittedTooltip';
import { LayersIcon } from '../../../ui/Icons';
import Popup from '../../../ui/Popup';
import { ProgressRing, type RingTone } from '../../../ui/ProgressRing';
import { autoCompactSupported, contextBarTone } from '../../../../shared/properties/ai/autoCompact';
import { compactChat } from '../aiStore';
import { AutoCompactPicker, useAutoCompactPercent } from '../autoCompactPreference';
import { contextPercent, contextTone } from '../chatStatus';

export interface ContextUsage {
  readonly used: number;
  readonly size: number;
}

const PANEL_GAP_PX = 8;

interface PanelPlace {
  readonly right: number;
  readonly bottom: number;
}

/** The sentence in the panel: "41,250 tokens of 1,000,000 · 4%", or what is missing. */
export function contextSentence(usage: ContextUsage | undefined, translate: Translator, formatNumber: (value: number) => string): string {
  if (usage === undefined || usage.size <= 0) {
    return translate('ai.context.unknown');
  }
  const percent = contextPercent(usage.used, usage.size);
  assert(percent !== undefined, 'contextSentence: a window of positive size has a percentage');
  return translate('ai.context.sentence', { used: formatNumber(usage.used), size: formatNumber(usage.size), percent });
}

export function ContextRing({
  chat,
  agent,
  usage,
  running,
  compacting,
}: {
  readonly chat: ChatId;
  readonly agent: AgentId;
  readonly usage: ContextUsage | undefined;
  readonly running: boolean;
  /** A compaction is in progress. */
  readonly compacting: boolean;
}) {
  const translate = useTranslate();
  const { formatNumber } = useFormat();
  const [anchor, setAnchor] = useState<HTMLButtonElement | undefined>(undefined);
  const [place, setPlace] = useState<PanelPlace | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement | undefined>(undefined);
  const tip = useDelayedTooltip();
  const show = (): void => {
    if (anchor !== undefined) {
      const rectangle = anchor.getBoundingClientRect();
      setPlace({ right: Math.max(8, window.innerWidth - rectangle.right), bottom: window.innerHeight - rectangle.top + PANEL_GAP_PX });
    }
    tip.hide();
    setOpen(true);
  };
  const close = (): void => {
    setOpen(false);
    // The ring gets the keyboard back, so Tab continues from where the person was.
    anchor?.focus();
  };
  // The first control takes focus once the panel is on screen.
  useEffect(() => {
    if (open) {
      panel.current?.querySelector<HTMLElement>('button, input')?.focus();
    }
  }, [open]);
  const known = usage !== undefined && usage.size > 0;
  const tone = known ? contextTone(usage.used, usage.size) : 'unknown';
  const ringTone: RingTone = tone === 'unknown' ? 'neutral' : tone;
  const percent = known ? contextPercent(usage.used, usage.size) : undefined;
  const compactable = canCompact(agent);
  const threshold = useAutoCompactPercent();
  const blocked = running ? translate('ai.context.wait') : compacting ? translate('ai.context.already') : undefined;
  return (
    <>
      <button
        ref={(element) => setAnchor(element ?? undefined)}
        type="button"
        className="ghost ai-ring"
        aria-label={percent === undefined ? translate('ai.context.label') : translate('ai.context.labelPercent', { percent })}
        aria-haspopup="dialog"
        aria-expanded={open}
        onMouseEnter={open ? undefined : tip.show}
        onMouseLeave={tip.hide}
        onBlur={tip.hide}
        onClick={() => (open ? close() : show())}
      >
        <ProgressRing
          value={known ? Math.min(1, usage.used / usage.size) : undefined}
          tone={ringTone}
          sizePx={14}
          label={percent === undefined ? translate('ai.context.ring') : translate('ai.context.ringPercent', { percent })}
        />
      </button>
      {tip.value !== undefined &&
        createPortal(
          <FittedTooltip role="tooltip" anchor={tip.value} preferred="above">
            {percent === undefined ? translate('ai.context.ring') : translate('ai.context.ringPercent', { percent })}
          </FittedTooltip>,
          tooltipHost(undefined),
        )}
      {place !== undefined && (
        <Popup
          mode="popover"
          role="dialog"
          label={translate('ai.context.label')}
          open={open}
          anchor={anchor}
          // A press on the ring is its own toggle, not an outside press that would close the panel and reopen it.
          within={anchor}
          onClose={close}
          ref={(element) => {
            panel.current = element ?? undefined;
          }}
          className="ai-ring-panel"
          style={{ position: 'fixed', right: place.right, bottom: place.bottom, zIndex: 400 }}
        >
          <div className="ai-ring-head">
            <span className="ai-ring-title">{translate('ai.context.ring')}</span>
            {percent !== undefined && (
              <span className="ai-ring-percent" data-tone={contextBarTone(percent)}>
                {percent}%
              </span>
            )}
          </div>
          <div className="ai-ring-bar" data-tone={contextBarTone(percent)} role="presentation">
            {percent !== undefined && <span className="ai-ring-fill" style={{ inlineSize: `${Math.min(100, percent)}%` }} />}
            {threshold !== undefined && <span className="ai-ring-tick" style={{ insetInlineStart: `${threshold}%` }} />}
          </div>
          <div className="ai-ring-tokens">
            {known
              ? translate('ai.context.usedTokens', {
                  used: formatNumber(usage.used, { notation: 'compact', maximumFractionDigits: 1 }),
                  size: formatNumber(usage.size, { notation: 'compact', maximumFractionDigits: 1 }),
                })
              : translate('ai.context.empty')}
          </div>
          {(compactable || autoCompactSupported(agent)) && (
            <div className="ai-ring-actions">
              {compactable && (
                <button
                  type="button"
                  className="ai-ring-compact"
                  disabled={blocked !== undefined}
                  title={blocked ?? translate('ai.context.compact.title')}
                  onClick={() => {
                    close();
                    void compactChat(chat);
                  }}
                >
                  <LayersIcon size={14} />
                  {compacting ? translate('ai.context.compacting') : translate('ai.context.compact')}
                </button>
              )}
              {autoCompactSupported(agent) && <AutoCompactPicker ariaLabel={translate('ai.autoCompact.label')} variant="short" />}
            </div>
          )}
        </Popup>
      )}
    </>
  );
}
