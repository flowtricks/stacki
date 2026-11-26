// The strip above the transcript that lists the subagents of the current run at a glance: one row each,
// in fixed columns so every row lines up whatever its numbers (a status dot, the task, the model it runs
// on, its time in a right-aligned column of tabular figures), and while it works a single line of what
// it is doing now. It shows only while the run has subagents; once all have finished it folds to one
// quiet line ("3 agents finished") that opens again on a click. Its head counts each state apart ("2 agents
// working · 1 done") and says finished only when every agent is done. A state is told by its mark's shape and
// words, not colour alone: a turning arc and a ticking time at work, a hollow ring while starting, a warning mark
// when it needs the person, a check when done, a cross when it did not finish, a square when stopped, a dash when
// the agent's end is not reported. A row takes the person to that
// subagent's unit in the transcript (SubagentCard.tsx) and opens it. It has no other controls: it
// observes, it does not orchestrate.
import { memo, useId } from 'react';
import type { ChatOption } from '../../../../shared/properties/ai/chatModel';
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, CloseIcon, WarningTriangleIcon } from '../../../ui/Icons';
import { LoaderDots } from '../../../ui/LoaderDots';
import { useFormat, useTranslate } from '../../../lib/i18n/useTranslate';
import type { Translator } from '../../../lib/i18n/localeContext';
import type { MessageKey } from '../../../../shared/properties/i18n/messageRef';
import { elapsedSince, formatDuration } from '../chatStatus';
import { commandName } from '../runningWork';
import {
  chosenModelName,
  sessionModelName,
  stripState,
  subagentName,
  type Subagent,
  type SubagentActivity,
  type SubagentList,
  type SubagentModel,
  type SubagentStatus,
  type SubagentTally,
} from '../subagents';
import { relativeTitle } from './paths';
import { useNow } from './ticker';
import { classifyStep, toolTitleText, type StepFacts } from './toolWords';
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
            {state.tally.working > 0 && <LoaderDots dotPx={3} />}
            <span>{tallyLabel(state.tally, translate)}</span>
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
            <span>{tallyLabel({ ...state.tally, failed: 0 }, translate)}</span>
            {state.tally.failed > 0 && <span className="ai-agents-failed">{translate('ai.subagents.failed', { count: state.tally.failed })}</span>}
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

/**
 * The head's words: "3 agents finished" when every one is done, else each state that has agents, counted apart
 * ("2 agents working · 1 needs you · 1 done"). Nothing says finished while an agent works.
 */
export function tallyLabel(tally: SubagentTally, translate: Translator): string {
  const others = tally.working + tally.queued + tally.waiting + tally.failed + tally.stopped + tally.unreported;
  if (others === 0) {
    return tally.done === 0 ? '' : translate('ai.subagents.finished', { count: tally.done });
  }
  const parts: readonly (readonly [number, MessageKey])[] = [
    [tally.working, 'ai.subagents.running'],
    [tally.waiting, 'ai.subagents.head.waiting'],
    [tally.queued, 'ai.subagents.head.starting'],
    [tally.unreported, 'ai.subagents.head.started'],
    [tally.done, 'ai.subagents.head.done'],
    [tally.failed, 'ai.subagents.failed'],
    [tally.stopped, 'ai.subagents.head.stopped'],
  ];
  return parts
    .filter(([count]) => count > 0)
    .map(([count, key]) => translate(key, { count }))
    .join(' · ');
}

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
  const model = agentModelLabel(agent, options);
  return (
    <button
      className={`ai-agent ai-agent-${agent.status.kind}`}
      title={agentTooltip([name, agent.role, model, statusTip(agent.status, translate)])}
      onClick={() => onOpen(agent.call)}
    >
      <SubagentDot status={agent.status} />
      <span className="ai-agent-name">{name}</span>
      <span className="ai-agent-model">{model}</span>
      <span className="ai-agent-time-cell">
        <SubagentTime status={agent.status} />
      </span>
      {agent.status.kind !== 'done' && <span className="ai-agent-doing">{statusLine(agent, translate)}</span>}
    </button>
  );
}

/**
 * The task a row names: the agent's description; for a follow-up "Follow-up to <that agent's task>", or "Follow-up message"
 * when the agent it went to is not known; "Subagent" when an agent gave no description.
 */
export function displayName(
  agent: Pick<Subagent, 'title' | 'kind'> & { readonly target?: string | undefined },
  projectPath: string,
  translate: Translator,
): string {
  if (agent.kind === 'follow-up') {
    return agent.target === undefined ? translate('ai.subagents.followUp') : translate('ai.followUp.to', { name: relativeTitle(agent.target, projectPath) });
  }
  const name = subagentName(agent);
  return name === '' ? translate('ai.subagents.untitled') : relativeTitle(name, projectPath);
}

/** The model column: the model a subagent runs on; empty for a follow-up, which is a message and runs on nothing of its own. */
export function agentModelLabel(agent: Pick<Subagent, 'kind' | 'model'>, options: readonly ChatOption[]): string {
  return agent.kind === 'follow-up' ? '' : modelLabel(agent.model, options);
}

/** A follow-up's state in one word: Sent (it went, nothing has come of it yet), Working, Done, or the failure. */
export function followUpWord(status: SubagentStatus, work: { readonly calls: number }, translate: Translator): string {
  switch (status.kind) {
    case 'queued':
      return translate('ai.followUp.sent');
    case 'running':
    case 'waiting':
      return translate('ai.followUp.working');
    case 'done':
      return work.calls > 0 ? translate('ai.subagents.status.done') : translate('ai.followUp.sent');
    case 'failed':
    case 'stopped':
    case 'unreported':
      return statusLabel(status, translate);
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/**
 * "Sonnet" for a model the call chose; the chat's own model otherwise, by its plain name (no "inherited": the person
 * does not need to know where it came from), or nothing when the chat does not say which it is.
 */
export function modelLabel(model: SubagentModel, options: readonly ChatOption[]): string {
  switch (model.kind) {
    case 'chosen':
      return chosenModelName(model.id, options);
    case 'inherited':
      return sessionModelName(options) ?? '';
    default: {
      const exhaustive: never = model;
      return exhaustive;
    }
  }
}

export function agentTooltip(parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part !== '').join(' · ');
}

/** What a state means when its word cannot say it all: an agent whose end no event reports. */
export function statusTip(status: SubagentStatus, translate: Translator): string | undefined {
  if (status.kind === 'running' && status.end === 'reply') {
    return translate('ai.subagents.status.backgroundTip');
  }
  return status.kind === 'unreported' ? translate('ai.subagents.status.unreportedTip') : undefined;
}

const STATUS_LABELS = {
  queued: 'ai.subagents.status.queued',
  running: 'ai.subagents.status.running',
  waiting: 'ai.subagents.status.waiting',
  done: 'ai.subagents.status.done',
  failed: 'ai.subagents.status.failed',
  stopped: 'ai.subagents.status.stopped',
  unreported: 'ai.subagents.status.unreported',
} as const satisfies Readonly<Record<SubagentStatus['kind'], MessageKey>>;

export function statusLabel(status: SubagentStatus, translate: Translator): string {
  if (status.kind === 'running' && status.end === 'reply') {
    return translate('ai.subagents.status.background');
  }
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
      if (agent.status.end === 'own') {
        return doing;
      }
      // Before anything of its work arrived there is nothing to add to where it runs.
      return agent.activity.kind === 'starting' ? statusLabel(agent.status, translate) : `${statusLabel(agent.status, translate)} · ${doing}`;
    case 'done':
    case 'failed':
    case 'stopped':
    case 'unreported':
      return statusLabel(agent.status, translate);
    default: {
      const exhaustive: never = agent.status;
      return exhaustive;
    }
  }
}

/** The status mark: its shape tells the state, so it never rests on colour, and it is announced in words. */
export function SubagentDot({ status }: { readonly status: SubagentStatus }) {
  const translate = useTranslate();
  return (
    <span className={`ai-agent-dot ai-agent-dot-${status.kind}`} role="img" aria-label={statusLabel(status, translate)}>
      {status.kind === 'done' && <CheckIcon size={11} />}
      {status.kind === 'failed' && <CloseIcon size={11} />}
      {status.kind === 'waiting' && <WarningTriangleIcon size={11} />}
    </span>
  );
}

/** Elapsed time while it works (one shared ticker), its duration once done, nothing when the stamps are missing. */
/** The shortest finished time worth showing: below it the time reads "0.0s". */
const DURATION_SHOWN_MS_MIN = 100;

export function SubagentTime({ status }: { readonly status: SubagentStatus }) {
  switch (status.kind) {
    case 'running':
    case 'waiting':
      return status.startedAt === undefined ? undefined : <Elapsed startedAt={status.startedAt} />;
    // Nothing runs yet, or nothing says it still does: no clock ticks.
    case 'queued':
    case 'unreported':
      return undefined;
    case 'done':
    case 'failed':
    case 'stopped':
      // Under a tenth of a second ("0.0s", a helper started in the background) says nothing: no time is shown.
      return status.durationMs === undefined || status.durationMs < DURATION_SHOWN_MS_MIN ? undefined : <Duration milliseconds={status.durationMs} />;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function Elapsed({ startedAt }: { readonly startedAt: number }) {
  const elapsed = elapsedSince(startedAt, useNow());
  return elapsed === undefined ? undefined : <Duration milliseconds={elapsed} />;
}

function Duration({ milliseconds }: { readonly milliseconds: number }) {
  const { formatNumber } = useFormat();
  return <span className="ai-agent-time">{formatDuration(milliseconds, formatNumber)}</span>;
}

/** "Editing Hero.astro", "Running Tests", a tool's own title, or a plain phase. */
export function activityText(activity: SubagentActivity, translate: Translator): string {
  switch (activity.kind) {
    case 'file':
      return activity.verb === 'reading'
        ? translate('ai.subagents.doing.reading', { file: activity.file })
        : translate('ai.subagents.doing.editing', { file: activity.file });
    case 'command':
      // The command's name in words ("Running Tests", "Running Dev server"), never its command line.
      return translate('ai.subagents.doing.command', { command: commandName(commandStep(activity.command), translate) });
    case 'tool':
      return toolTitleText(activity.title, undefined, translate);
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

function commandStep(command: string): StepFacts {
  return classifyStep({ toolKind: 'execute', toolName: undefined, title: command, command, paths: [], diffs: [] });
}
