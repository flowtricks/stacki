// One subagent in the transcript, as one unit instead of its commands and reads interleaved with the
// coordinator's: a head with its status dot, the task it was given, the model it runs on and its time
// (its role, which seldom fits beside them, is in the head's tooltip);
// a line of progress (what it is doing now, and what it has done so far: "Ran 12 commands, read 3
// files"); once it finishes, the first line of its report. Opened (closed by default, the person's
// choice remembered), it shows its own calls, drawn as the chat draws calls, and its whole report, and
// offers its full transcript (its words and thoughts too, SubagentPane.tsx).
//
// The strip above the transcript asks for a unit by call (`reveal`, a count that grows with each ask):
// the unit opens and scrolls itself into view.
import { memo, useEffect, useId, useRef, useState } from 'react';
import type { ChatOption } from '../../../../shared/properties/ai/chatModel';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { ChevronDownIcon, ChevronRightIcon } from '../../../ui/Icons';
import { SkeletonRows } from '../../../ui/Skeleton';
import { ChatText } from '../ChatText';
import { activityHeadline } from '../chatStatus';
import type { ToolItem } from '../chatReducer';
import { isWorking, resultSummary, type SubagentUnit } from '../subagents';
import { GROUP_ITEMS_SHOWN_MAX } from './ActivityGroup';
import { displayName, modelLabel, statusLabel, statusLine, SubagentDot, SubagentTime } from './SubagentStrip';
import { ToolCard } from './ToolCard';
import { useOpenState } from './transcriptUi';

export interface SubagentCardProps {
  readonly unit: SubagentUnit;
  readonly chatId: string;
  readonly projectPath: string;
  readonly options: readonly ChatOption[];
  /** The turn the unit belongs to is still running: its calls count their seconds and show diffs open. */
  readonly live: boolean;
  /** Grows each time the strip asks for this unit; undefined when it never did. */
  readonly reveal: number | undefined;
  /** Opens the subagent's full transcript; undefined inside a subagent's own transcript. */
  readonly onOpenTranscript: ((call: string) => void) | undefined;
}

export const SubagentCard = memo(function SubagentCard({ unit, chatId, projectPath, options, live, reveal, onOpenTranscript }: SubagentCardProps) {
  const translate = useTranslate();
  const { agent, children } = unit;
  const [open, change] = useOpenState(chatId, `agent:${agent.call}`, { open: false });
  const [shown, setShown] = useState(GROUP_ITEMS_SHOWN_MAX);
  const bodyId = useId();
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (reveal === undefined) {
      return;
    }
    change({ open: true });
    element.current?.scrollIntoView({ block: 'nearest' });
  }, [reveal, change]);
  const working = isWorking(agent.status);
  const name = displayName(agent, projectPath, translate);
  const model = modelLabel(agent.model, options, translate);
  const done = children.length === 0 ? '' : activityHeadline(children, translate);
  const line = working ? statusLine(agent, translate) : agent.status.kind === 'done' ? '' : statusLabel(agent.status, translate);
  const progress = [line, done].filter((part) => part !== '').join(' · ');
  // The opened unit shows the whole report below, so its one-line summary would only repeat it.
  const summary = working || open ? undefined : resultSummary(agent.result);
  const hidden = Math.max(0, children.length - shown);
  const visible = hidden === 0 ? children : children.slice(hidden);
  const counts = nestedCounts(children);
  return (
    <div ref={element} className={`ai-subagent ai-subagent-${agent.status.kind}`} data-subagent={agent.call}>
      <button
        className="ai-subagent-head"
        title={[name, agent.role, model].filter((part) => part !== undefined).join(' · ')}
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => change({ open: !open })}
      >
        <span className="ai-subagent-chevron">{open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}</span>
        <SubagentDot status={agent.status} />
        <span className="ai-subagent-title">{name}</span>
        <span className={`ai-agent-model${agent.model.kind === 'inherited' ? ' ai-agent-model-inherited' : ''}`}>{model}</span>
        <span className="ai-agent-time-cell">
          <SubagentTime status={agent.status} />
        </span>
        {progress !== '' && <span className="ai-subagent-progress">{progress}</span>}
        {summary !== undefined && <span className="ai-subagent-summary">{summary}</span>}
      </button>
      {open && (
        <div className="ai-subagent-body" id={bodyId}>
          {(hidden > 0 || unit.omitted > 0) && (
            <button className="ai-group-earlier" disabled={hidden === 0} onClick={() => setShown((count) => count + GROUP_ITEMS_SHOWN_MAX)}>
              {translate('ai.group.showEarlier', { count: hidden > 0 ? Math.min(hidden, GROUP_ITEMS_SHOWN_MAX) : unit.omitted })}
            </button>
          )}
          {visible.length === 0 && working && <SkeletonRows count={2} />}
          {visible.map((item) => (
            <ToolCard
              key={item.id}
              item={item}
              chatId={chatId}
              projectPath={projectPath}
              live={live}
              childCount={counts.get(item.call) ?? 0}
              nested={item.parent !== agent.call}
            />
          ))}
          {agent.result !== undefined && (
            <div className="ai-subagent-result" role="group" aria-label={translate('ai.subagents.result')}>
              <ChatText text={agent.result} />
            </div>
          )}
          {onOpenTranscript !== undefined && (
            <button className="ai-subagent-open" onClick={() => onOpenTranscript(agent.call)}>
              {translate('ai.subagents.openTranscript')}
            </button>
          )}
        </div>
      )}
    </div>
  );
});

/** How many of the unit's calls sit under each of its calls (a nested subagent's own work). */
function nestedCounts(children: readonly ToolItem[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const item of children) {
    if (item.parent !== undefined) {
      counts.set(item.parent, (counts.get(item.parent) ?? 0) + 1);
    }
  }
  return counts;
}
