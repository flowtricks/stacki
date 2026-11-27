// Answering what a pin needs from the person (docs/contracts.md, "Comment pins"). "Needs you" is only ever a
// permission card or a question the pin's agent asked, and both are answered from here: a permission's badge shows
// its card; a question's choices send the answer, and its Reply (and badge) puts the cursor in the chat's message
// box, which already opens with the words that say which pin the reply is about (pinModel.ts pinReplyLead).
import type { SentPin } from '../../../../shared/properties/ai/commentPinBrief';
import type { ChatId } from '../../../../shared/properties/ai/chatModel';
import { aiState, draftText, draftWithText, openChat, requestComposerFocus, sendReply, setDraft } from '../aiStore';
import { revealRequest } from '../transcript/permissionAttention';
import type { PinProgress } from './pinModel';
import { pinReplyLead } from './pinModel';
import { pinState } from './pinStore';

type Needed = Extract<PinProgress, { readonly kind: 'attention' }>;

/** Takes the person to what the pin waits for. */
export async function goToPinAnswer(chat: ChatId, pin: Pick<SentPin, 'comment' | 'elementLabel'>, progress: Needed): Promise<void> {
  if (aiState().open !== chat) {
    await openChat(chat);
  }
  if (progress.reason === 'permission') {
    // After the chat has drawn its cards.
    window.requestAnimationFrame(() => revealRequest(progress.request));
    return;
  }
  const lead = pinReplyLead(pin);
  setDraft(chat, (draft) => (draftText(draft).trim() === '' ? draftWithText(draft, lead) : draft));
  requestComposerFocus();
}

/** Sends a choice picked for a pin's question. While one message per pin is going out, it waits for the reply under way. */
export function answerPinQuestion(chat: ChatId, pin: Pick<SentPin, 'comment' | 'elementLabel'>, choice: string): Promise<boolean> {
  const run = pinState().run;
  const whileRunning = run !== undefined && run.chat === chat ? 'queue' : 'steer';
  return sendReply(chat, `${pinReplyLead(pin)}${choice}`, { whileRunning });
}
