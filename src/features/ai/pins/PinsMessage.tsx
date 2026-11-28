// A message of comment pins in the transcript: each pin's own words, the page and element in their names (never a path,
// a locator or the instructions the agent was given), how it stands, and the crop it was sent with at the row's end.
// No pin numbers: nothing in the chat refers to them (subagent titles drop theirs, subagents.ts subagentName). Every
// row's words start at the card's text edge, under its title, with or without an image. How a pin stands is read from
// the transcript (pinModel.ts pinProgress); a pin still on the board opens on the canvas, and one with a subagent
// opens that subagent's transcript from its status. A pin that needs the person is answered right there: its badge
// goes to what waits (pinAnswer.ts), and a question shows its words, its choices as buttons and Reply. A pin sent
// with its own model names it quietly beside the badge.
import type { ChatAttachmentName, ChatId, TurnId } from '../../../../shared/properties/ai/chatModel';
import type { PinSendMode, SentPin } from '../../../../shared/properties/ai/commentPinBrief';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import type { ChatView } from '../chatReducer';
import { useState } from 'react';
import { readSentImage } from '../aiStore';
import { SentImageViewer } from '../transcript/SentImageViewer';
import { isSubagentModel, type PinQuestion } from '../../../../shared/properties/ai/commentPinBrief';
import { chosenModelName, deriveSubagentWork } from '../subagents';
import { answerPinQuestion, goToPinAnswer } from './pinAnswer';
import { ChipWords } from '../mentions/ChipWords';
import { pinProgress, pinSubagentCall, segmentsOfWords } from './pinModel';
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

// A pin's question: its words, each choice as a button that sends it, and Reply for an answer in the person's own words.
function PinAsk({ chat, pin, asked, onReply }: { readonly chat: ChatId; readonly pin: SentPin; readonly asked: PinQuestion; readonly onReply: () => void }) {
  const translate = useTranslate();
  // The question a choice is on its way for, so one press is one answer; a later question has its buttons again.
  const [sending, setSending] = useState<string | undefined>(undefined);
  const busy = sending === asked.question;
  const choose = (choice: string): void => {
    setSending(asked.question);
    void answerPinQuestion(chat, pin, choice).then((sent) => {
      if (!sent) {
        setSending(undefined);
      }
    });
  };
  return (
    <span className="ai-pin-ask" role="group" aria-label={asked.question}>
      <span className="ai-pin-ask-words">{asked.question}</span>
      <span className="ai-pin-ask-choices">
        {asked.choices.map((choice) => (
          <button key={choice} type="button" className="ai-pin-ask-choice" disabled={busy} onClick={() => choose(choice)}>
            {choice}
          </button>
        ))}
        <button type="button" className={asked.choices.length === 0 ? 'primary ai-pin-ask-reply' : 'ai-pin-ask-choice is-reply'} onClick={onReply}>
          {translate('ai.pins.reply')}
        </button>
      </span>
    </span>
  );
}

// The model the person chose for a pin, as a quiet name; when its subagent ran on another one, the name it ran on,
// with the tooltip saying what was asked for.
function PinModelTag({ pin, view, call }: { readonly pin: SentPin; readonly view: ChatView; readonly call: string | undefined }) {
  const translate = useTranslate();
  if (pin.model === undefined || pin.modelName === undefined) {
    return undefined;
  }
  const ran = call === undefined || !isSubagentModel(pin.model) ? undefined : deriveSubagentWork(view).units.get(call)?.agent.model;
  if (ran === undefined || (ran.kind === 'chosen' && ran.id === pin.model)) {
    return <span className="ai-pins-message-model">{pin.modelName}</span>;
  }
  const actual = ran.kind === 'chosen' ? chosenModelName(ran.id, view.options) : translate('ai.pins.model.chatPlain');
  return (
    <span className="ai-pins-message-model is-different" title={translate('ai.pins.model.differed', { asked: pin.modelName, actual })}>
      {actual}
    </span>
  );
}

// The crop a pin was sent with, at the row's end: it opens large.
function PinPicture({
  chat,
  name,
  thumbnail,
  original,
}: {
  readonly chat: ChatId;
  readonly name: string;
  readonly thumbnail: string;
  readonly original: ChatAttachmentName['original'];
}) {
  const translate = useTranslate();
  const [viewing, setViewing] = useState(false);
  const label = translate('ai.screenshot.enlarge', { name });
  return (
    <>
      <button
        type="button"
        className="ai-image-open ai-pins-message-picture"
        aria-label={label}
        aria-haspopup="dialog"
        title={original === undefined ? translate('ai.images.smallOnly') : label}
        onClick={() => setViewing(true)}
      >
        <img className="ai-pin-thumb ai-pins-message-thumb" src={thumbnail} alt="" />
      </button>
      {viewing && (
        <SentImageViewer name={name} thumbnail={thumbnail} original={original} load={(image) => readSentImage(chat, image)} onClose={() => setViewing(false)} />
      )}
    </>
  );
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
            const picture = pin.image === undefined ? undefined : attachments[pin.image];
            const onBoard = sentPinOf(chat, turn, pin.number);
            const progress = pinProgress({ number: pin.number, delivery: { kind: 'sent', chat, turn, mode, at: 0 } }, view);
            const call = mode === 'subagents' ? pinSubagentCall(view, turn, pin.number) : undefined;
            const open =
              progress.kind === 'attention'
                ? { label: translate('ai.pins.answer', { number: pin.number }), run: () => void goToPinAnswer(chat, pin, progress) }
                : call !== undefined && onOpenSubagent !== undefined
                  ? { label: translate('ai.pins.openWork', { number: pin.number }), run: () => onOpenSubagent(call) }
                  : undefined;
            const words = (
              <>
                <span className={pin.comment.trim() === '' ? 'ai-pins-message-comment is-empty' : 'ai-pins-message-comment'}>
                  {pin.comment.trim() === '' ? translate('ai.pins.noComment') : <ChipWords segments={segmentsOfWords(pin)} />}
                </span>
                <span className="ai-pins-message-place">{translate('ai.pins.messagePlace', { page: pin.pageLabel, element: pin.elementLabel })}</span>
              </>
            );
            return (
              <li key={pin.number} className="ai-pins-message-pin">
                <span className="ai-pins-message-text">
                  {onBoard === undefined ? (
                    <span className="ai-pins-message-words">{words}</span>
                  ) : (
                    <button
                      type="button"
                      className="ai-pins-message-words ai-pins-message-open"
                      aria-label={translate('ai.pins.jump', { number: pin.number })}
                      onClick={() => jumpToPin(onBoard.id)}
                    >
                      {words}
                    </button>
                  )}
                  <span className="ai-pins-message-foot">
                    {open !== undefined ? (
                      <button type="button" className="ai-pins-message-status" onClick={open.run} aria-label={open.label}>
                        <PinProgressPill progress={progress} />
                      </button>
                    ) : (
                      <PinProgressPill progress={progress} />
                    )}
                    <PinModelTag pin={pin} view={view} call={call} />
                  </span>
                  {progress.kind === 'attention' && progress.reason === 'question' && (
                    <PinAsk chat={chat} pin={pin} asked={progress.question} onReply={() => void goToPinAnswer(chat, pin, progress)} />
                  )}
                </span>
                {picture?.thumbnail !== undefined && (
                  <PinPicture chat={chat} name={pin.elementLabel} thumbnail={picture.thumbnail} original={picture.original} />
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
