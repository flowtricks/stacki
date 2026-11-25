// A message of comment pins in the transcript: each pin numbered, with the crop it was sent with, the person's own
// words, and the page and element in their names, never a path, a locator or the instructions the agent was given.
// Each pin shows how it stands, read from the transcript (its subagent, or its own turn), so the message is where
// the pins' progress is followed; a pin still on the board opens on the canvas, and one with a subagent opens that
// subagent's transcript.
import type { ChatAttachmentName, ChatId, TurnId } from '../../../../shared/properties/ai/chatModel';
import type { PinSendMode, SentPin } from '../../../../shared/properties/ai/commentPinBrief';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import type { ChatView } from '../chatReducer';
import { pinProgress, pinSubagentCall } from './pinModel';
import { PinProgressPill } from './PinProgressPill';
import { jumpToPin, sentPinOf, usePinState } from './pinStore';
import './pins.css';

export interface PinsMessageProps {
  readonly chat: ChatId;
  readonly turn: TurnId;
  readonly mode: PinSendMode;
  readonly pins: readonly SentPin[];
  readonly attachments: readonly ChatAttachmentName[];
  readonly view: ChatView;
  /** Opens a subagent's own transcript (the transcript's `onOpenSubagent`); absent where there is none to open. */
  readonly onOpenSubagent: ((call: string) => void) | undefined;
}

export function PinsMessage({ chat, turn, mode, pins, attachments, view, onOpenSubagent }: PinsMessageProps) {
  const translate = useTranslate();
  // The board, so a pin still on it can be opened on the canvas; its progress is the transcript's.
  usePinState();
  return (
    <div className="ai-message ai-message-user ai-msg ai-msg-user">
      <div className="ai-msg-bubble ai-pins-message" role="group" aria-label={translate('ai.pins.messageLabel', { count: pins.length })}>
        <div className="ai-pins-message-title">{translate('ai.pins.summaryTitle', { count: pins.length })}</div>
        <ol className="ai-pins-message-list">
          {pins.map((pin) => {
            const thumbnail = pin.image === undefined ? undefined : attachments[pin.image]?.thumbnail;
            const progress = pinProgress({ number: pin.number, delivery: { kind: 'sent', chat, turn, mode, at: 0 } }, view, 'running');
            const onBoard = sentPinOf(chat, turn, pin.number);
            const call = mode === 'subagents' ? pinSubagentCall(view, turn, pin.number) : undefined;
            return (
              <li key={pin.number} className="ai-pins-message-pin">
                <button
                  type="button"
                  className="ai-pins-message-open"
                  disabled={onBoard === undefined}
                  aria-label={translate('ai.pins.jump', { number: pin.number })}
                  onClick={() => {
                    if (onBoard !== undefined) {
                      jumpToPin(onBoard.id);
                    }
                  }}
                >
                  <span className="ai-pin-number">{pin.number}</span>
                  {thumbnail !== undefined && <img className="ai-pin-thumb" src={thumbnail} alt="" />}
                </button>
                <span className="ai-pins-message-text">
                  <span className={pin.comment.trim() === '' ? 'ai-pins-message-comment is-empty' : 'ai-pins-message-comment'}>
                    {pin.comment.trim() === '' ? translate('ai.pins.noComment') : pin.comment}
                  </span>
                  <span className="ai-pins-message-place">{translate('ai.pins.messagePlace', { page: pin.pageLabel, element: pin.elementLabel })}</span>
                  <span className="ai-pins-message-foot">
                    {call !== undefined && onOpenSubagent !== undefined ? (
                      <button
                        type="button"
                        className="ai-pins-message-status"
                        onClick={() => onOpenSubagent(call)}
                        aria-label={translate('ai.pins.openWork', { number: pin.number })}
                      >
                        <PinProgressPill progress={progress} />
                      </button>
                    ) : (
                      <PinProgressPill progress={progress} />
                    )}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
