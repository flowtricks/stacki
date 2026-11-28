// Messages set aside with ⌘⏎ while the agent works, drawn above the box: the words, a small picture for each
// image (which opens large), "Send now" (into the running turn) and remove. Chips read as chips there too. They send one by one when the turn ends. A turn that stopped for any reason
// but finishing holds them ("Paused") until the person resumes, so nothing sends itself after a failure.
// They live in this window's memory only, which the tooltip says.
import { useState } from 'react';
import { ImageViewer } from '../../../ui/ImageViewer';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { CloseIcon } from '../../../ui/Icons';
import type { ChatId } from '../../../../shared/properties/ai/chatModel';
import { ChipWords } from '../mentions/ChipWords';
import { removeQueued, resumeQueue, sendQueuedNow, type DraftAttachment, type QueuedPrompt } from '../aiStore';

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
          <span className="ai-queued-text">
            <ChipWords segments={entry.draft.segments} focus="stop" />
          </span>
          <QueuedImages attachments={entry.draft.attachments} />
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

// A queued message's images, from the data URLs its draft still holds.
function QueuedImages({ attachments }: { readonly attachments: readonly DraftAttachment[] }) {
  const translate = useTranslate();
  const [viewing, setViewing] = useState<DraftAttachment | undefined>(undefined);
  const images = attachments.filter((entry) => entry.preview !== undefined);
  if (images.length === 0) {
    return undefined;
  }
  return (
    <span className="ai-queued-images">
      {images.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className="ai-image-open ai-queued-image"
          aria-label={translate('ai.screenshot.enlarge', { name: imageName(entry) })}
          aria-haspopup="dialog"
          title={imageName(entry)}
          onClick={() => setViewing(entry)}
        >
          <img src={entry.preview} alt="" />
        </button>
      ))}
      {viewing !== undefined && <ImageViewer name={imageName(viewing)} source={viewing.preview} onClose={() => setViewing(undefined)} />}
    </span>
  );
}

function imageName(entry: DraftAttachment): string {
  return entry.attachment.kind === 'image' ? entry.attachment.name : entry.attachment.path;
}
