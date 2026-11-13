// The context ring at the far right of the status line: how much of the agent's context window this chat
// has used (neutral below 70%, amber from 70%, red from 90%), and, on hover or click, a small panel with the
// numbers and a Compact button.
//
// A custom Popup, not the ring's tooltip slot: the panel holds a button, which a tooltip cannot. Hovering
// opens it and leaving closes it after a beat (so the pointer can cross to the button); clicking pins it
// open until Escape or a press outside. Compact exists only for agents that can compact (a table in
// agentPresentation.ts: Codex has no compact command) and waits while a turn runs, because the agent
// compacts by taking a turn of its own.
import { useEffect, useRef, useState } from 'react';
import { assert } from '../../../../shared/core/assert';
import type { AgentId } from '../../../../shared/properties/ai/agentIds';
import { canCompact } from '../../../../shared/properties/ai/agentPresentation';
import type { ChatId } from '../../../../shared/properties/ai/chatModel';
import type { Translator } from '../../../lib/i18n/localeContext';
import { useFormat, useTranslate } from '../../../lib/i18n/useTranslate';
import Popup from '../../../ui/Popup';
import { ProgressRing, type RingTone } from '../../../ui/ProgressRing';
import { compactChat } from '../aiStore';
import { contextPercent, contextTone } from '../chatStatus';

export interface ContextUsage {
  readonly used: number;
  readonly size: number;
}

/** How long the pointer may be outside both the ring and its panel before the panel closes. */
const LEAVE_DELAY_MS = 180;
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
  const pinned = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearTimer = (): void => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
  };
  // A timer left running would set state on an unmounted chip.
  useEffect(() => clearTimer, []);
  const show = (): void => {
    clearTimer();
    if (anchor !== undefined) {
      const rectangle = anchor.getBoundingClientRect();
      setPlace({ right: Math.max(8, window.innerWidth - rectangle.right), bottom: window.innerHeight - rectangle.top + PANEL_GAP_PX });
    }
    setOpen(true);
  };
  const close = (): void => {
    clearTimer();
    pinned.current = false;
    setOpen(false);
  };
  const leave = (): void => {
    clearTimer();
    if (!pinned.current) {
      timer.current = setTimeout(close, LEAVE_DELAY_MS);
    }
  };
  const known = usage !== undefined && usage.size > 0;
  const tone = known ? contextTone(usage.used, usage.size) : 'unknown';
  const ringTone: RingTone = tone === 'unknown' ? 'neutral' : tone;
  const percent = known ? contextPercent(usage.used, usage.size) : undefined;
  const compactable = canCompact(agent);
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
        onMouseEnter={show}
        onMouseLeave={leave}
        onClick={() => {
          pinned.current = true;
          show();
        }}
      >
        <ProgressRing
          value={known ? Math.min(1, usage.used / usage.size) : undefined}
          tone={ringTone}
          sizePx={14}
          label={percent === undefined ? translate('ai.context.ring') : translate('ai.context.ringPercent', { percent })}
        />
      </button>
      {place !== undefined && (
        <Popup
          mode="popover"
          role="dialog"
          label={translate('ai.context.label')}
          open={open}
          anchor={anchor}
          onClose={close}
          className="ai-ring-panel"
          style={{ position: 'fixed', right: place.right, bottom: place.bottom, zIndex: 400 }}
          onMouseEnter={clearTimer}
          onMouseLeave={leave}
        >
          <div className="ai-ring-sentence" data-tone={tone}>
            {contextSentence(usage, translate, formatNumber)}
          </div>
          {compactable && known && <div className="ai-ring-note">{translate('ai.context.note')}</div>}
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
              {compacting ? translate('ai.context.compacting') : translate('ai.context.compact')}
            </button>
          )}
        </Popup>
      )}
    </>
  );
}
