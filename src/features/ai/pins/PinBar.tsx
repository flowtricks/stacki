// Comment mode's bar at the bottom of the canvas, clear of the page's own navigation: one small pill, as quiet as
// it can be for what there is to do. Its list opens upward.
//   No pins yet       the pin icon and the mode's name, and ✕ to leave the mode.
//   Pins              the pin icon alone (its tooltip names the mode and says what it does), one count that opens
//                     the list ("2 pins", or "2 working" / "1 needs you" once every pin is sent), the blue Send for
//                     the pins that can go ("Send", "Send 3"), and ✕. Send is there only with something to send; when
//                     it cannot go yet (the agent not set up) it is a quiet button whose tooltip says why, never a
//                     washed-out blue one. A reply or pins already running never hold it back.
//   Moving a pin      where the next click puts it, and Cancel.
// Only the primary button and hover or open states carry a fill. On a narrow canvas the mode's name drops first
// (a container query on the bar's own slot), so nothing truncates. ✕ and Escape leave the mode; pins stay.
//
// The list (PinList.tsx) reviews every pin on every page: jump to one, include or leave it out of the next send,
// and delete it; a pin whose work finished well is deleted by itself.
import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { centralIcon } from '../../../ui/central/CentralIcon';
import { bubbleText as centralBubbleText, close as centralClose } from '../../../ui/central/centralGeometry';
import FittedTooltip from '../../../ui/FittedTooltip';
import { tooltipHost, useDelayedTooltip } from '../../../ui/delayedTooltip';
import { useAiState } from '../aiStore';
import { BillingWarning, billingWarning } from '../BillingWarning';
import { setPanelMode } from '../panelModes';
import { TipButton } from '../sessions/TipButton';
import { COMMENT_MODE_ID } from './commentMode';
import { PinList } from './PinList';
import { pinRunning } from './pinModel';
import { pinAgent, progressOf, sendAllPins, sendReadiness, setPinListOpen, startMovingPin, usePinState, type PinState, type SendReadiness } from './pinStore';
import './pins.css';

const CommentGlyph = centralIcon(centralBubbleText);
const CloseGlyph = centralIcon(centralClose);

/** What the count says: how many saved pins there are, or, once every one is sent, how many need the person or are at work. */
function countLabel(pins: PinState, translate: ReturnType<typeof useTranslate>): string {
  const saved = pins.board.pins.filter((pin) => pin.savedAt !== undefined);
  if (saved.length === 0 || saved.some((pin) => pin.delivery.kind === 'draft')) {
    return translate('ai.pins.list', { count: saved.length });
  }
  const standing = saved.map(progressOf);
  const needing = standing.filter((progress) => progress.kind === 'attention').length;
  if (needing > 0) {
    return translate('ai.pins.listAttention', { count: needing });
  }
  // Only pins really at work are counted as working: one that stopped or did not finish is just a pin on the board.
  const working = standing.filter(pinRunning).length;
  return working > 0 ? translate('ai.pins.listWorking', { count: working }) : translate('ai.pins.list', { count: saved.length });
}

// Its own component so its tooltip's state ends with the button: once the pins are sent there is no Send.
function SendButton({ readiness }: { readonly readiness: Exclude<SendReadiness, { readonly kind: 'empty' }> }) {
  const translate = useTranslate();
  const sendTip = useDelayedTooltip();
  const tip =
    readiness.kind === 'blocked'
      ? translate('ai.pins.send.notReady')
      : readiness.mode === 'single'
        ? translate('ai.pins.send.oneByOne')
        : translate('ai.pins.send.subagents');
  const sendLabel = translate('ai.pins.sendCount', { count: readiness.count });
  return (
    <>
      <button
        type="button"
        className={readiness.kind === 'ready' ? 'primary ai-pin-send' : 'ai-pin-bar-button ai-pin-send-waiting'}
        aria-disabled={readiness.kind !== 'ready'}
        aria-label={`${sendLabel}. ${tip}`}
        onMouseEnter={sendTip.show}
        onMouseLeave={sendTip.hide}
        onBlur={sendTip.hide}
        onClick={() => {
          if (readiness.kind === 'ready') {
            // The store takes the pins at once, so a second press finds nothing of theirs to send.
            void sendAllPins(translate);
          }
        }}
      >
        {sendLabel}
      </button>
      {sendTip.value !== undefined &&
        createPortal(
          <FittedTooltip role="tooltip" anchor={sendTip.value}>
            {tip}
          </FittedTooltip>,
          tooltipHost(undefined),
        )}
    </>
  );
}

export function PinBar() {
  const translate = useTranslate();
  const pins = usePinState();
  const ai = useAiState();
  const listButton = useRef<HTMLButtonElement>(null);
  const modeTip = useDelayedTooltip();
  if (pins.mode !== 'on') {
    return undefined;
  }
  const readiness = sendReadiness(pins, ai);
  // Asked of Claude whenever it is the agent "Send all" would go to (a warning is only ever Claude's).
  const warning = billingWarning(ai.setups.get(pinAgent(ai)));
  const moving = pins.moving === undefined ? undefined : pins.board.pins.find((pin) => pin.id === pins.moving);
  const saved = pins.board.pins.filter((pin) => pin.savedAt !== undefined).length;
  const empty = saved === 0 && moving === undefined;
  const leave = (
    <TipButton className="ai-pin-bar-icon" label={translate('ai.pins.leave')} onClick={() => setPanelMode(COMMENT_MODE_ID, 'off')}>
      <CloseGlyph size={16} />
    </TipButton>
  );
  return (
    // Out of the picture while a pin's crop is taken, so no crop ever shows the bar.
    <div className={`ai-pin-bar-slot${pins.capturing ? ' is-capturing' : ''}`}>
      <div className={`ai-pin-bar${empty ? ' is-empty' : ''}`} role="toolbar" aria-label={translate('ai.pins.mode')}>
        <span className="ai-pin-bar-mode" onMouseEnter={modeTip.show} onMouseLeave={modeTip.hide}>
          <CommentGlyph size={16} />
          {moving !== undefined ? (
            <span className="ai-pin-bar-mode-name">{translate('ai.pins.moving', { number: moving.number })}</span>
          ) : (
            empty && <span className="ai-pin-bar-mode-name is-droppable">{translate('ai.pins.mode')}</span>
          )}
        </span>
        {moving !== undefined && (
          <button type="button" className="ai-pin-bar-button" onClick={() => startMovingPin(undefined)}>
            {translate('ai.pins.cancelMove')}
          </button>
        )}
        {moving === undefined && !empty && (
          <button
            ref={listButton}
            type="button"
            className={`ai-pin-bar-button${pins.listOpen ? ' is-on' : ''}`}
            aria-expanded={pins.listOpen}
            onClick={() => setPinListOpen(pins.listOpen ? 'closed' : 'open')}
          >
            {countLabel(pins, translate)}
          </button>
        )}
        {moving === undefined && readiness.kind !== 'empty' && <SendButton readiness={readiness} />}
        {moving === undefined && leave}
        {modeTip.value !== undefined &&
          moving === undefined &&
          createPortal(
            <FittedTooltip role="tooltip" anchor={modeTip.value}>
              {empty ? translate('ai.pins.modeTip') : `${translate('ai.pins.mode')}. ${translate('ai.pins.modeTip')}`}
            </FittedTooltip>,
            tooltipHost(undefined),
          )}
        {pins.listOpen && <PinList anchor={listButton.current ?? undefined} />}
      </div>
      {/* Pins start work with the panel out of view, so the warning about its billing stands here too, over the bar. */}
      {warning !== undefined && <BillingWarning kind={warning} />}
    </div>
  );
}
