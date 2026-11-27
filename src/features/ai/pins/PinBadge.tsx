// A sent pin's badge in the pin list and the pin's box: its status pill, which for "Needs you" is a button that
// goes to what waits in the chat (pinAnswer.ts).
import type { CommentPin } from '../../../../shared/properties/ai/commentPins';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { goToPinAnswer } from './pinAnswer';
import type { PinProgress } from './pinModel';
import { PinProgressPill } from './PinProgressPill';

export function PinBadge({ pin, progress }: { readonly pin: CommentPin; readonly progress: PinProgress }) {
  const translate = useTranslate();
  const delivery = pin.delivery;
  if (progress.kind === 'attention' && delivery.kind === 'sent') {
    const about = { comment: pin.comment, elementLabel: pin.place.elementLabel };
    return (
      <button
        type="button"
        className="ai-pins-message-status"
        aria-label={translate('ai.pins.answer', { number: pin.number })}
        onClick={() => void goToPinAnswer(delivery.chat, about, progress)}
      >
        <PinProgressPill progress={progress} />
      </button>
    );
  }
  return <PinProgressPill progress={progress} />;
}
