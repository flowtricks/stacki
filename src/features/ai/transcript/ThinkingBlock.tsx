// The agent's thinking as one line: "Thought for 12s" (from the stamps on its first and last
// chunk), or "Thinking…" with the loader while it streams. It opens to the thought itself.
// A thought from a chat stored before timings reads plain "Thought": no duration is invented.
import { memo, useId } from 'react';
import { LoaderDots } from '../../../ui/LoaderDots';
import { ChevronDownIcon, ChevronRightIcon } from '../../../ui/Icons';
import { ChatText } from '../ChatText';
import { useChatWords } from '../useChatWords';
import { thoughtLabel, type TextItem } from './transcriptModel';
import { useOpenState } from './transcriptUi';

export const ThinkingBlock = memo(function ThinkingBlock({ item, chatId, live }: { readonly item: TextItem; readonly chatId: string; readonly live: boolean }) {
  const words = useChatWords();
  const [open, change] = useOpenState(chatId, `thought:${item.id}`, { open: false });
  const bodyId = useId();
  return (
    <div className="ai-thought">
      <button className="ai-thought-head" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={() => change({ open: !open })}>
        {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        {live && <LoaderDots dotPx={3} />}
        <span>{thoughtLabel(item, { live }, words)}</span>
      </button>
      {open && (
        <div className="ai-thought-body" id={bodyId}>
          <ChatText text={item.text} />
        </div>
      )}
    </div>
  );
});
