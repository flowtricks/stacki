// Messages set aside with ⌘⏎ while the agent works, drawn above the box: the words, "Send now" (into the
// running turn) and remove. They send one by one when the turn ends. A turn that stopped for any reason
// but finishing holds them ("Paused") until the person resumes, so nothing sends itself after a failure.
// They live in this window's memory only, which the tooltip says.
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { CloseIcon } from '../../../ui/Icons';
import type { ChatId } from '../../../../shared/properties/ai/chatModel';
import { removeQueued, resumeQueue, sendQueuedNow, type QueuedPrompt } from '../aiStore';

const SNIPPET_CHARS_MAX = 160;

export function QueuedPrompts({ chat, queued, paused }: { readonly chat: ChatId; readonly queued: readonly QueuedPrompt[]; readonly paused: boolean }) {
  const translate = useTranslate();
  if (queued.length === 0) {
    return undefined;
  }
  return (
    <div className="ai-queue" role="list" aria-label={translate('ai.queue.label')} title={translate('ai.queue.hint')}>
      {paused && (
        <div className="ai-queue-paused" role="status">
          <span>{translate('ai.queue.paused')}</span>
          <button type="button" className="ghost" onClick={() => void resumeQueue(chat)}>
            {translate('ai.queue.resume')}
          </button>
        </div>
      )}
      {queued.map((entry) => (
        <div className="ai-queued" role="listitem" key={entry.id}>
          <span className="ai-queued-text" title={entry.text}>
            {entry.text.length > SNIPPET_CHARS_MAX ? `${entry.text.slice(0, SNIPPET_CHARS_MAX)}…` : entry.text}
          </span>
          <button type="button" className="ghost ai-queued-send" onClick={() => void sendQueuedNow(chat, entry.id)}>
            {translate('ai.queue.sendNow')}
          </button>
          <button type="button" className="ghost ai-queued-remove" aria-label={translate('ai.queue.remove')} onClick={() => removeQueued(chat, entry.id)}>
            <CloseIcon size={10} />
          </button>
        </div>
      ))}
    </div>
  );
}
