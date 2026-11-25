// The moment the agent compacted its context: in progress with the loader, then "Conversation
// compacted · saved ~42k tokens" (derived from the usage before and after, so only said when both
// are known), or a plain failed / stopped line. A background fill, not a rule across the panel.
import { memo } from 'react';
import { LoaderDots } from '../../../ui/LoaderDots';
import { CheckIcon, WarningTriangleIcon } from '../../../ui/Icons';
import type { CompactionItem } from '../chatReducer';
import { useChatWords } from '../useChatWords';
import { compactionLine } from './transcriptModel';

export const CompactionRow = memo(function CompactionRow({ item }: { readonly item: CompactionItem }) {
  const line = compactionLine(item, useChatWords());
  return (
    <div className={`ai-compaction ai-compaction-${line.tone}`} role={line.tone === 'running' ? 'status' : undefined}>
      <span className="ai-compaction-mark">
        {line.tone === 'running' ? <LoaderDots dotPx={3} /> : line.tone === 'done' ? <CheckIcon size={12} /> : <WarningTriangleIcon size={12} />}
      </span>
      <span>
        {line.text}
        {line.detail !== undefined && <span className="ai-compaction-detail"> · {line.detail}</span>}
      </span>
    </div>
  );
});
