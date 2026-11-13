// One run of the agent's work between two messages: its thoughts and tool calls, folded into a
// single line ("Ran 4 commands, edited 2 files · 1m 12s") with a status mark. It is open while its
// turn is still working and closes by itself when the turn ends; the person's own click wins over
// both, and is remembered. A very long run draws its newest calls and offers the earlier ones.
import { memo, useId, useState } from 'react';
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, WarningTriangleIcon } from '../../../ui/Icons';
import { useFormat, useTranslate } from '../../../lib/i18n/useTranslate';
import { formatDuration } from '../chatStatus';
import { useChatWords } from '../useChatWords';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCard } from './ToolCard';
import { groupDurationMs, summarizeGroup, type ActivityRun } from './transcriptModel';
import { useOpenState } from './transcriptUi';

/** Calls drawn in one open group; the rest are behind "Show earlier". */
export const GROUP_ITEMS_SHOWN_MAX = 200;

export const ActivityGroup = memo(function ActivityGroup({
  run,
  chatId,
  projectPath,
  working,
}: {
  readonly run: ActivityRun;
  readonly chatId: string;
  readonly projectPath: string;
  /** The turn this run belongs to is still going. */
  readonly working: boolean;
}) {
  const translate = useTranslate();
  const words = useChatWords();
  const { formatNumber } = useFormat();
  const live = working && run.last;
  const [open, change] = useOpenState(chatId, `group:${run.key}`, { open: live });
  const [shown, setShown] = useState(GROUP_ITEMS_SHOWN_MAX);
  const bodyId = useId();
  const summary = summarizeGroup(run.items, words);
  const duration = live ? undefined : groupDurationMs(run.items);
  const hidden = Math.max(0, run.items.length - shown);
  const visible = hidden === 0 ? run.items : run.items.slice(hidden);
  const childCounts = countChildren(run);
  const lastItem = run.items[run.items.length - 1];
  return (
    <div className={`ai-group${live ? ' ai-group-live' : ''}`}>
      <button className="ai-group-head" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={() => change({ open: !open })}>
        {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        <span className="ai-group-mark">{live ? undefined : summary.failed > 0 ? <WarningTriangleIcon size={12} /> : <CheckIcon size={12} />}</span>
        <span className="ai-group-title">{summary.text}</span>
        {summary.failed > 0 && <span className="ai-group-failed">{translate('ai.group.failed', { count: summary.failed })}</span>}
        {duration !== undefined && duration >= 1000 && <span className="ai-group-time">{formatDuration(duration, formatNumber)}</span>}
      </button>
      {open && (
        <div className="ai-group-body" id={bodyId}>
          {hidden > 0 && (
            <button className="ai-group-earlier" onClick={() => setShown((count) => count + GROUP_ITEMS_SHOWN_MAX)}>
              {translate('ai.group.showEarlier', { count: Math.min(hidden, GROUP_ITEMS_SHOWN_MAX) })}
            </button>
          )}
          {visible.map((item) =>
            item.kind === 'tool' ? (
              <ToolCard key={item.id} item={item} chatId={chatId} projectPath={projectPath} live={working} childCount={childCounts.get(item.call) ?? 0} />
            ) : (
              <ThinkingBlock key={item.id} item={item} chatId={chatId} live={live && item === lastItem} />
            ),
          )}
        </div>
      )}
    </div>
  );
});

/** How many calls of the run name each call as their parent (a subagent's own work). */
function countChildren(run: ActivityRun): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const item of run.items) {
    if (item.kind === 'tool' && item.parent !== undefined) {
      counts.set(item.parent, (counts.get(item.parent) ?? 0) + 1);
    }
  }
  return counts;
}
