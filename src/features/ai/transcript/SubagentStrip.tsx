// The strip above the transcript that lists the subagents of the current run: one row each, with a
// status dot (running, waiting for the person, done, failed), its time, and while it works a single line
// of what it is doing now. It shows only while the run has subagents; once all have finished it folds to
// one quiet line ("3 agents finished") that opens again on a click. A row opens that subagent's
// transcript (SubagentPane.tsx). It has no other controls: it observes, it does not orchestrate.
import { memo, useId } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from '../../../ui/Icons';
import { LoaderDots } from '../../../ui/LoaderDots';
import { useFormat, useTranslate } from '../../../lib/i18n/useTranslate';
import type { Translator } from '../../../lib/i18n/localeContext';
import type { MessageKey } from '../../../../shared/properties/i18n/messageRef';
import { formatDuration } from '../chatStatus';
import { stripState, subagentName, type Subagent, type SubagentActivity, type SubagentList, type SubagentStatus } from '../subagents';
import { relativeTitle } from './paths';
import { useNow } from './ticker';
import { useOpenState } from './transcriptUi';

export interface SubagentStripProps {
  readonly list: SubagentList;
  readonly chatId: string;
  readonly projectPath: string;
  readonly onOpen: (call: string) => void;
}

export const SubagentStrip = memo(function SubagentStrip({ list, chatId, projectPath, onOpen }: SubagentStripProps) {
  const translate = useTranslate();
  const bodyId = useId();
  // Remembered per run (the first subagent's call), so a new run's summary starts folded again.
  const [open, change] = useOpenState(chatId, `subagents:${list.agents[0]?.call ?? ''}`, { open: false });
  const state = stripState(list, { open });
  switch (state.kind) {
    case 'hidden':
      return undefined;
    case 'live':
      return (
        <div className="ai-agents ai-agents-live" role="region" aria-label={translate('ai.subagents.label')}>
          <div className="ai-agents-head">
            <LoaderDots dotPx={3} />
            <span>{translate('ai.subagents.running', { count: state.active })}</span>
          </div>
          <Rows list={state.list} projectPath={projectPath} onOpen={onOpen} />
        </div>
      );
    case 'summary':
    case 'review': {
      const expanded = state.kind === 'review';
      return (
        <div className="ai-agents" role="region" aria-label={translate('ai.subagents.label')}>
          <button className="ai-agents-head" aria-expanded={expanded} aria-controls={expanded ? bodyId : undefined} onClick={() => change({ open: !expanded })}>
            {expanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
            <span>{translate('ai.subagents.finished', { count: state.finished })}</span>
            {state.failed > 0 && <span className="ai-agents-failed">{translate('ai.subagents.failed', { count: state.failed })}</span>}
          </button>
          {state.kind === 'review' && (
            <div id={bodyId}>
              <Rows list={state.list} projectPath={projectPath} onOpen={onOpen} />
            </div>
          )}
        </div>
      );
    }
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
});

function Rows({ list, projectPath, onOpen }: { readonly list: SubagentList; readonly projectPath: string; readonly onOpen: (call: string) => void }) {
  const translate = useTranslate();
  return (
    <ul className="ai-agents-list">
      {list.omitted > 0 && <li className="ai-agents-more">{translate('ai.subagents.more', { count: list.omitted })}</li>}
      {list.agents.map((agent) => (
        <li key={agent.call}>
          <SubagentRow agent={agent} projectPath={projectPath} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}

/** One subagent: its dot, name and role, its time, and (while it works) what it is doing now. */
export function SubagentRow({
  agent,
  projectPath,
  onOpen,
}: {
  readonly agent: Subagent;
  readonly projectPath: string;
  readonly onOpen: (call: string) => void;
}) {
  const translate = useTranslate();
  const working = agent.status.kind === 'running' || agent.status.kind === 'waiting';
  return (
    <button className={`ai-agent ai-agent-${agent.status.kind}`} onClick={() => onOpen(agent.call)}>
      <SubagentDot status={agent.status} />
      <span className="ai-agent-name">{relativeTitle(subagentName(agent), projectPath)}</span>
      {agent.role !== undefined && <span className="ai-agent-role">{agent.role}</span>}
      <SubagentTime status={agent.status} />
      {working && <span className="ai-agent-doing">{activityText(agent.activity, translate)}</span>}
    </button>
  );
}

const STATUS_LABELS = {
  running: 'ai.subagents.status.running',
  waiting: 'ai.subagents.status.waiting',
  done: 'ai.subagents.status.done',
  failed: 'ai.subagents.status.failed',
} as const satisfies Readonly<Record<SubagentStatus['kind'], MessageKey>>;

/** The status dot, announced in words so it is not colour alone. */
export function SubagentDot({ status }: { readonly status: SubagentStatus }) {
  const translate = useTranslate();
  return <span className={`ai-agent-dot ai-agent-dot-${status.kind}`} role="img" aria-label={translate(STATUS_LABELS[status.kind])} />;
}

/** Elapsed time while it works (one shared ticker), its duration once done, nothing when the stamps are missing. */
export function SubagentTime({ status }: { readonly status: SubagentStatus }) {
  switch (status.kind) {
    case 'running':
    case 'waiting':
      return status.startedAt === undefined ? undefined : <Elapsed startedAt={status.startedAt} />;
    case 'done':
    case 'failed':
      return status.durationMs === undefined ? undefined : <Duration milliseconds={status.durationMs} />;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function Elapsed({ startedAt }: { readonly startedAt: number }) {
  const now = useNow();
  return <Duration milliseconds={Math.max(0, now - startedAt)} />;
}

function Duration({ milliseconds }: { readonly milliseconds: number }) {
  const { formatNumber } = useFormat();
  return <span className="ai-agent-time">{formatDuration(milliseconds, formatNumber)}</span>;
}

/** "Editing Hero.astro", "Running npm test", a tool's own title, or a plain phase. */
export function activityText(activity: SubagentActivity, translate: Translator): string {
  switch (activity.kind) {
    case 'file':
      return activity.verb === 'reading'
        ? translate('ai.subagents.doing.reading', { file: activity.file })
        : translate('ai.subagents.doing.editing', { file: activity.file });
    case 'command':
      return translate('ai.subagents.doing.command', { command: activity.command });
    case 'tool':
      return activity.title;
    case 'thinking':
      return translate('ai.subagents.doing.thinking');
    case 'writing':
      return translate('ai.subagents.doing.writing');
    case 'starting':
      return translate('ai.subagents.doing.starting');
    default: {
      const exhaustive: never = activity;
      return exhaustive;
    }
  }
}
