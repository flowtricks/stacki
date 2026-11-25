// Comment mode's bar over the canvas: says the mode is on (and, while a pin is being moved, where the next click
// puts it), opens the list of every pin, sends them all, and ends the mode. "Send all" names how many pins it
// takes and is the only way pins are ever sent; when it cannot send, its tooltip says why (and, for an agent whose
// subagents the panel cannot follow, that the pins go one message at a time), never a line of text.
//
// The list (PinList.tsx) reviews every pin on every page: jump to one, include or leave it out of the next send,
// delete it, and clear the sent ones.
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MessageKey } from '../../../lib/i18n/localeContext';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { centralIcon } from '../../../ui/central/CentralIcon';
import { bubbleText as centralBubbleText, listMenu as centralList } from '../../../ui/central/centralGeometry';
import FittedTooltip from '../../../ui/FittedTooltip';
import { tooltipHost, useDelayedTooltip } from '../../../ui/delayedTooltip';
import { useAiState } from '../aiStore';
import { setPanelMode } from '../panelModes';
import { COMMENT_MODE_ID } from './commentMode';
import { PinList } from './PinList';
import { sendAllPins, sendReadiness, setPinListOpen, startMovingPin, usePinState, type SendBlock } from './pinStore';
import './pins.css';

const CommentGlyph = centralIcon(centralBubbleText);
const ListGlyph = centralIcon(centralList);

const BLOCKS = {
  none: 'ai.pins.send.none',
  'too-many-pins': 'ai.pins.send.tooManyPins',
  'too-many-images': 'ai.pins.send.tooManyImages',
  busy: 'ai.pins.send.busy',
  running: 'ai.pins.send.running',
  'not-ready': 'ai.pins.send.notReady',
} as const satisfies Record<SendBlock, MessageKey>;

export function PinBar() {
  const translate = useTranslate();
  const pins = usePinState();
  const ai = useAiState();
  const listButton = useRef<HTMLButtonElement>(null);
  const sendTip = useDelayedTooltip();
  // What the mode does, told on the mode's own name in the bar (the Modes menu's rows carry no tooltip).
  const modeTip = useDelayedTooltip();
  const [sending, setSending] = useState(false);
  if (pins.mode !== 'on') {
    return undefined;
  }
  const readiness = sendReadiness(pins, ai);
  const moving = pins.moving === undefined ? undefined : pins.board.pins.find((pin) => pin.id === pins.moving);
  const tip =
    readiness.kind === 'blocked'
      ? translate(BLOCKS[readiness.reason], { count: readiness.count })
      : readiness.mode === 'single'
        ? translate('ai.pins.send.oneByOne')
        : translate('ai.pins.send.subagents');
  return (
    <div className="ai-pin-bar" role="toolbar" aria-label={translate('ai.pins.mode')}>
      <span className="ai-pin-bar-mode" onMouseEnter={modeTip.show} onMouseLeave={modeTip.hide}>
        <CommentGlyph size={16} />
        <span className="ai-pin-bar-mode-name">
          {moving === undefined ? translate('ai.pins.mode') : translate('ai.pins.moving', { number: moving.number })}
        </span>
      </span>
      {moving !== undefined ? (
        <button type="button" className="ai-pin-bar-button" onClick={() => startMovingPin(undefined)}>
          {translate('ai.pins.cancelMove')}
        </button>
      ) : (
        <>
          <button
            ref={listButton}
            type="button"
            className={`ai-pin-bar-button${pins.listOpen ? ' is-on' : ''}`}
            aria-expanded={pins.listOpen}
            onClick={() => setPinListOpen(pins.listOpen ? 'closed' : 'open')}
          >
            <ListGlyph size={16} />
            {translate('ai.pins.list', { count: pins.board.pins.length })}
          </button>
          <button
            type="button"
            className="primary ai-pin-send"
            aria-disabled={readiness.kind !== 'ready' || sending}
            aria-label={`${translate('ai.pins.sendAll', { count: readiness.count })}. ${tip}`}
            onMouseEnter={sendTip.show}
            onMouseLeave={sendTip.hide}
            onBlur={sendTip.hide}
            onClick={() => {
              if (readiness.kind !== 'ready' || sending) {
                return;
              }
              setSending(true);
              void sendAllPins(translate).finally(() => setSending(false));
            }}
          >
            {translate('ai.pins.sendAll', { count: readiness.count })}
          </button>
        </>
      )}
      <button type="button" className="ai-pin-bar-button" onClick={() => setPanelMode(COMMENT_MODE_ID, 'off')}>
        {translate('ai.pins.done')}
      </button>
      {sendTip.value !== undefined &&
        createPortal(
          <FittedTooltip role="tooltip" anchor={sendTip.value}>
            {tip}
          </FittedTooltip>,
          tooltipHost(undefined),
        )}
      {modeTip.value !== undefined &&
        moving === undefined &&
        createPortal(
          <FittedTooltip role="tooltip" anchor={modeTip.value}>
            {translate('ai.pins.modeTip')}
          </FittedTooltip>,
          tooltipHost(undefined),
        )}
      {pins.listOpen && <PinList anchor={listButton.current ?? undefined} />}
    </div>
  );
}
