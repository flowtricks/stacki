// The strip above the transcript that lists the subagents of the current run at a glance: one row each,
// in fixed columns so every row lines up whatever its numbers (a status dot, the task, the model it runs
// on, its time in a right-aligned column of tabular figures), and while it works a single line of what
// it is doing now. It shows only while the run has subagents; once all have finished it folds to one
// quiet line ("3 agents finished") that opens again on a click. A row takes the person to that
// subagent's unit in the transcript (SubagentCard.tsx) and opens it. It has no other controls: it
// observes, it does not orchestrate.
import { memo, useId } from 'react';
import type { ChatOption } from '../../../../shared/properties/ai/chatModel';
import { ChevronDownIcon, ChevronRightIcon } from '../../../ui/Icons';
import { LoaderDots } from '../../../ui/LoaderDots';
import { useFormat, useTranslate } from '../../../lib/i18n/useTranslate';
import type { Translator } from '../../../lib/i18n/localeContext';
import type { MessageKey } from '../../../../shared/properties/i18n/messageRef';
import { formatDuration } from '../chatStatus';
import {
  chosenModelName,
  isWorking,
  sessionModelName,
  stripState,
  subagentName,
  type Subagent,
  type SubagentActivity,
  type SubagentList,
  type SubagentModel,
  type SubagentStatus,
} from '../subagents';
import { relativeTitle } from './paths';
import { useNow } from './ticker';
import { useOpenState } from './transcriptUi';

export interface SubagentStripProps {
  readonly list: SubagentList;
  readonly chatId: string;
  readonly projectPath: string;
  /** The session's settings, for the name of the model each subagent runs on. */
  readonly options: readonly ChatOption[];
  readonly onOpen: (call: string) => void;
}

export const SubagentStrip = memo(function SubagentStrip({ list, chatId, projectPath, options, onOpen }: SubagentStripProps) {
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
          <Rows list={state.list} projectPath={projectPath} options={options} onOpen={onOpen} />
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
              <Rows list={state.list} projectPath={projectPath} options={options} onOpen={onOpen} />
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

function Rows({
  list,
  projectPath,
  options,
  onOpen,
}: {
  readonly list: SubagentList;
  readonly projectPath: string;
  readonly options: readonly ChatOption[];
  readonly onOpen: (call: string) => void;
}) {
  const translate = useTranslate();
  return (
    <ul className="ai-agents-list">
      {list.omitted > 0 && <li className="ai-agents-more">{translate('ai.subagents.more', { count: list.omitted })}</li>}
      {list.agents.map((agent) => (
        <li key={agent.call}>
          <SubagentRow agent={agent} projectPath={projectPath} options={options} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}

/** One subagent: its dot, task, model and time in fixed columns, and (while it works) what it is doing now. */
export function SubagentRow({
  agent,
  projectPath,
  options,
  onOpen,
}: {
  readonly agent: Subagent;
  readonly projectPath: string;
  readonly options: readonly ChatOption[];
  readonly onOpen: (call: string) => void;
}) {
  const translate = useTranslate();
  const name = displayName(agent, projectPath, translate);
  const model = modelLabel(agent.model, options, translate);
  return (
    <button className={`ai-agent ai-agent-${agent.status.kind}`} title={agentTooltip(name, agent.role, model)} onClick={() => onOpen(agent.call)}>
      <SubagentDot status={agent.status} />
      <span className="ai-agent-name">{name}</span>
      <span className={`ai-agent-model${agent.model.kind === 'inherited' ? ' ai-agent-model-inherited' : ''}`}>{model}</span>
      <span className="ai-agent-time-cell">
        <SubagentTime status={agent.status} />
      </span>
      {isWorking(agent.status) && <span className="ai-agent-doing">{statusLine(agent, translate)}</span>}
    </button>
  );
}

/** The task a row names: the agent's description, or "Follow-up message" / "Subagent" when it gave none. */
export function displayName(agent: Pick<Subagent, 'title' | 'kind'>, projectPath: string, translate: Translator): string {
  const name = subagentName(agent);
  if (name !== '') {
    return relativeTitle(name, projectPath);
  }
  return agent.kind === 'follow-up' ? translate('ai.subagents.followUp') : translate('ai.subagents.untitled');
}

/** "Sonnet" for a model the call chose; the session's model, marked inherited, otherwise. */
export function modelLabel(model: SubagentModel, options: readonly ChatOption[], translate: Translator): string {
  switch (model.kind) {
    case 'chosen':
      return chosenModelName(model.id, options);
    case 'inherited': {
      const session = sessionModelName(options);
      return session === undefined ? translate('ai.subagents.model.session') : translate('ai.subagents.model.inherited', { model: session });
    }
    default: {
      const exhaustive: never = model;
      return exhaustive;
    }
  }
}

function agentTooltip(name: string, role: string | undefined, model: string): string {
  return [name, role, model].filter((part): part is string => part !== undefined && part !== '').join(' · ');
}

const STATUS_LABELS = {
  queued: 'ai.subagents.status.queued',
  running: 'ai.subagents.status.running',
  waiting: 'ai.subagents.status.waiting',
  done: 'ai.subagents.status.done',
  failed: 'ai.subagents.status.failed',
  stopped: 'ai.subagents.status.stopped',
} as const satisfies Readonly<Record<SubagentStatus['kind'], MessageKey>>;

export function statusLabel(status: SubagentStatus, translate: Translator): string {
  return translate(STATUS_LABELS[status.kind]);
}

/** The line under a working subagent: its state when it is not simply running, then what it is doing. */
export function statusLine(agent: Subagent, translate: Translator): string {
  const doing = activityText(agent.activity, translate);
  switch (agent.status.kind) {
    case 'queued':
      return statusLabel(agent.status, translate);
    case 'waiting':
      return `${statusLabel(agent.status, translate)} · ${doing}`;
    case 'running':
      return doing;
    case 'done':
    case 'failed':
    case 'stopped':
      return statusLabel(agent.status, translate);
    default: {
      const exhaustive: never = agent.status;
      return exhaustive;
    }
  }
}

/** The status dot, announced in words so it is not colour alone. */
export function SubagentDot({ status }: { readonly status: SubagentStatus }) {
  const translate = useTranslate();
  return <span className={`ai-agent-dot ai-agent-dot-${status.kind}`} role="img" aria-label={statusLabel(status, translate)} />;
}

/** Elapsed time while it works (one shared ticker), its duration once done, nothing when the stamps are missing. */
export function SubagentTime({ status }: { readonly status: SubagentStatus }) {
  switch (status.kind) {
    case 'queued':
    case 'running':
    case 'waiting':
      return status.startedAt === undefined ? undefined : <Elapsed startedAt={status.startedAt} />;
    case 'done':
    case 'failed':
    case 'stopped':
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
