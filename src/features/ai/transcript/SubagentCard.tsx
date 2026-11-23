// One subagent in the transcript, as one unit instead of its commands and reads interleaved with the
// coordinator's: a head with its status dot, the task it was given, the model it runs on and its time
// (its role, which seldom fits beside them, is in the head's tooltip);
// a line of progress (what it is doing now, and what it has done so far: "Ran 12 commands, read 3
// files"); once it finishes, the first line of its report. Opened (closed by default, the person's
// choice remembered), it shows its work as steps a designer reads ("Read 5 files", "Ran the tests"), the
// commands behind each one revealed only on request (StepGroups.tsx, the same list the Running panel draws),
// its whole report, and its full transcript (its words, thoughts and every call as a card, SubagentPane.tsx).
//
// The strip above the transcript asks for a unit by call (`reveal`, a count that grows with each ask):
// the unit opens and scrolls itself into view.
import { memo, useEffect, useId, useRef } from 'react';
import { reportErrorToast } from '../../../ui/errorNotices';
import type { ChatOption } from '../../../../shared/properties/ai/chatModel';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { ChevronDownIcon, ChevronRightIcon } from '../../../ui/Icons';
import { ChatText } from '../ChatText';
import { activityHeadline } from '../chatStatus';
import { isWorking, resultSummary, type SubagentUnit } from '../subagents';
import { groupSteps } from './agentSteps';
import { PayloadDetails } from './PayloadDetails';
import { agentModelLabel, displayName, followUpWord, statusLabel, statusLine, SubagentDot, SubagentTime } from './SubagentStrip';
import { StepList } from './StepGroups';
import { looksLikeJson } from './toolWords';
import { useOpenState } from './transcriptUi';

export interface SubagentCardProps {
  readonly unit: SubagentUnit;
  readonly chatId: string;
  readonly projectPath: string;
  readonly options: readonly ChatOption[];
  /** Grows each time the strip asks for this unit; undefined when it never did. */
  readonly reveal: number | undefined;
  /** Opens the subagent's full transcript; undefined inside a subagent's own transcript. */
  readonly onOpenTranscript: ((call: string) => void) | undefined;
}

export const SubagentCard = memo(function SubagentCard({ unit, chatId, projectPath, options, reveal, onOpenTranscript }: SubagentCardProps) {
  const translate = useTranslate();
  const { agent, children } = unit;
  const [open, change] = useOpenState(chatId, `agent:${agent.call}`, { open: false });
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
  const model = agentModelLabel(agent, options, translate);
  const followUp = agent.kind === 'follow-up';
  const done = children.length === 0 ? '' : activityHeadline(children, translate);
  const line = followUp
    ? followUpWord(agent.status, { calls: children.length }, translate)
    : working
      ? statusLine(agent, translate)
      : agent.status.kind === 'done'
        ? ''
        : statusLabel(agent.status, translate);
  const progress = [line, done].filter((part) => part !== '').join(' · ');
  // A follow-up's own words are what it shows; an agent's report is a payload (JSON) for the person to ask for, never prose to summarise.
  const report = agent.result !== undefined && looksLikeJson(agent.result) ? undefined : agent.result;
  // The opened unit shows the whole report below, so its one-line summary would only repeat it.
  const summary = working || open ? undefined : resultSummary(followUp ? agent.message : report);
  useEffect(() => {
    if (agent.delivery === 'failed') {
      reportFailedFollowUp(`${chatId}:${agent.call}`, translate('ai.followUp.failed'));
    }
  }, [agent.delivery, agent.call, chatId, translate]);
  const timeline = groupSteps(children, { working });
  return (
    <div ref={element} className={`ai-subagent ai-subagent-${agent.status.kind}`} data-subagent={agent.call}>
      <button
        className="ai-subagent-head"
        title={[name, agent.role, model].filter((part) => part !== undefined && part !== '').join(' · ')}
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
          <StepList timeline={timeline} chatId={chatId} scope={`card:${agent.call}`} projectPath={projectPath} working={working} />
          {followUp && agent.message !== undefined && (
            <div className="ai-subagent-result" role="group" aria-label={translate('ai.followUp.message')}>
              <ChatText text={agent.message} />
            </div>
          )}
          {report !== undefined && (
            <div className="ai-subagent-result" role="group" aria-label={translate('ai.subagents.result')}>
              <ChatText text={report} />
            </div>
          )}
          {agent.result !== undefined && report === undefined && <PayloadDetails text={agent.result} />}
          {onOpenTranscript !== undefined && (!followUp || children.length > 0) && (
            <button className="ai-subagent-open" onClick={() => onOpenTranscript(agent.call)}>
              {translate('ai.subagents.openTranscript')}
            </button>
          )}
        </div>
      )}
    </div>
  );
});

/** Follow-ups already reported as a toast, by chat and call: the card is drawn again as the transcript scrolls, the toast is not. Bounded; the oldest are forgotten. */
const REPORTED_MAX = 200;
const reported = new Set<string>();

function reportFailedFollowUp(key: string, message: string): void {
  if (reported.has(key)) {
    return;
  }
  if (reported.size >= REPORTED_MAX) {
    reported.clear();
  }
  reported.add(key);
  reportErrorToast(message);
}
