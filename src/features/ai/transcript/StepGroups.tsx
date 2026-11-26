// A subagent's work as steps a designer reads (agentSteps.ts): one row per step, "Read 5 files", "Edited 3 files
// (Button.astro, Hero.astro, …)", "Ran the tests", in fixed columns (chevron, status mark, words, time) so the
// times line up whatever the words. A long run folds its older steps into "N earlier steps". Opening a step
// lists its calls in the same words, and under them a "Show commands" control, closed by default, behind which
// sit the technical rows: the exact command (highlighted), the full path (shortened in the middle, whole in its
// tooltip), each call's time, and a failed call's error (a log, or a raw payload behind its own "Show details").
// A step's own row shows a time only while it runs: a finished step's seconds ("0.0s" for an edit) add nothing a
// designer acts on, and the subagent's total stays in its head.
// Nothing technical is in the DOM until the person asks for it; "Expand all" in the chat menu opens the steps,
// never the commands.
//
// The same list is drawn in the inline subagent unit (SubagentCard.tsx) and in the Running panel
// (RunningPanel.tsx), so both say the same thing about the same work.
import { memo, useId, useState } from 'react';
import { useFormat, useTranslate } from '../../../lib/i18n/useTranslate';
import { CodeInline } from '../../../ui/CodeBlock';
import { ChevronDownIcon, ChevronRightIcon } from '../../../ui/Icons';
import { LogBlock } from '../../../ui/LogBlock';
import { SkeletonRows } from '../../../ui/Skeleton';
import { formatDuration } from '../chatStatus';
import type { MessageKey } from '../../../../shared/properties/i18n/messageRef';
import {
  callDurationMs,
  callLabel,
  splitEarlier,
  STEP_LIMITS,
  stepLabel,
  type StepCall,
  type StepGroup,
  type StepStatus,
  type StepTimeline,
} from './agentSteps';
import { PayloadDetails } from './PayloadDetails';
import { middleEllipsis, relativePath } from './paths';
import { useNow } from './ticker';
import { looksLikeJson } from './toolWords';
import { useOpenState } from './transcriptUi';
import './steps.css';

export interface StepListProps {
  readonly timeline: StepTimeline;
  readonly chatId: string;
  /** Names this list's open steps apart from another list of the same work (`card:<call>`, `panel:<call>`). */
  readonly scope: string;
  readonly projectPath: string;
  /** The subagent is still at work: an empty list is a placeholder, not nothing. */
  readonly working: boolean;
}

export const StepList = memo(function StepList({ timeline, chatId, scope, projectPath, working }: StepListProps) {
  const translate = useTranslate();
  const { earlier, latest } = splitEarlier(timeline.groups);
  if (timeline.groups.length === 0) {
    return working ? <SkeletonRows count={2} /> : undefined;
  }
  return (
    <ul className="ai-steps" aria-label={translate('ai.steps.label')}>
      {(earlier.length > 0 || timeline.omittedGroups > 0) && (
        <li>
          <EarlierSteps groups={earlier} omitted={timeline.omittedGroups} chatId={chatId} scope={scope} projectPath={projectPath} />
        </li>
      )}
      {latest.map((group) => (
        <li key={group.key}>
          <StepRow group={group} chatId={chatId} scope={scope} projectPath={projectPath} />
        </li>
      ))}
    </ul>
  );
});

/** The older steps of a long run, folded to "N earlier steps"; opened, they show a page at a time. */
function EarlierSteps({
  groups,
  omitted,
  chatId,
  scope,
  projectPath,
}: {
  readonly groups: readonly StepGroup[];
  readonly omitted: number;
  readonly chatId: string;
  readonly scope: string;
  readonly projectPath: string;
}) {
  const translate = useTranslate();
  const bodyId = useId();
  const [open, change] = useOpenState(chatId, `${scope}:earlier`, { open: false });
  const [shown, setShown] = useState<number>(STEP_LIMITS.earlierPageSize);
  // The newest of the earlier steps are the ones a page shows: nearest to what is on screen below.
  const visible = groups.slice(Math.max(0, groups.length - shown));
  const hidden = groups.length - visible.length;
  return (
    <>
      <button className="ai-step ai-step-fold" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={() => change({ open: !open })}>
        <span className="ai-step-chevron">{open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}</span>
        <span className="ai-step-mark ai-step-mark-done" aria-hidden="true" />
        <span className="ai-step-label">{translate('ai.steps.earlier', { count: groups.length + omitted })}</span>
      </button>
      {open && (
        <ul className="ai-steps ai-steps-earlier" id={bodyId}>
          {hidden > 0 && (
            <li>
              <button className="ai-steps-more" onClick={() => setShown((count) => count + STEP_LIMITS.earlierPageSize)}>
                {translate('ai.running.showMore')}
              </button>
            </li>
          )}
          {visible.map((group) => (
            <li key={group.key}>
              <StepRow group={group} chatId={chatId} scope={scope} projectPath={projectPath} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** One step: its row, and opened, its calls in words and the "Show commands" disclosure. */
const StepRow = memo(function StepRow({
  group,
  chatId,
  scope,
  projectPath,
}: {
  readonly group: StepGroup;
  readonly chatId: string;
  readonly scope: string;
  readonly projectPath: string;
}) {
  const translate = useTranslate();
  const bodyId = useId();
  const [open, change] = useOpenState(chatId, `${scope}:step:${group.key}`, { open: false });
  const label = stepLabel(group, translate);
  const rows = group.calls.slice(Math.max(0, group.calls.length - STEP_LIMITS.callRowsShown));
  const unlisted = group.count - rows.length;
  return (
    <div className={`ai-step-unit ai-step-${group.status}`}>
      <button className="ai-step" title={label} aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={() => change({ open: !open })}>
        <span className="ai-step-chevron">{open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}</span>
        <StepMark status={group.status} />
        <span className="ai-step-label">{label}</span>
        <span className="ai-step-time-cell">
          {group.status === 'running' && <StepTime status={group.status} startedAt={group.startedAt} durationMs={undefined} />}
        </span>
      </button>
      {open && (
        <div className="ai-step-body" id={bodyId}>
          {group.count > 1 && (
            <ul className="ai-step-calls">
              {rows.map((call) => (
                <li key={call.item.id} className={`ai-step-call ai-step-${call.status}`}>
                  <StepMark status={call.status} />
                  <span className="ai-step-label">{callLabel(call, translate)}</span>
                  <span className="ai-step-time-cell">
                    {call.status === 'running' && <StepTime status={call.status} startedAt={call.item.at} durationMs={undefined} />}
                  </span>
                </li>
              ))}
              {unlisted > 0 && <li className="ai-step-unlisted">{translate('ai.steps.more', { count: unlisted })}</li>}
            </ul>
          )}
          <StepCommands calls={group.calls} omitted={group.omittedCalls} projectPath={projectPath} />
        </div>
      )}
    </div>
  );
});

/**
 * The technical rows behind "Show commands": closed by default and kept in the component, not in the chat's open
 * states, so "Expand all" never reveals them and nothing technical is drawn until the person asks.
 */
function StepCommands({ calls, omitted, projectPath }: { readonly calls: readonly StepCall[]; readonly omitted: number; readonly projectPath: string }) {
  const translate = useTranslate();
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className="ai-step-commands">
      <button className="ai-step-reveal" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={() => setOpen(!open)}>
        {open ? translate('ai.steps.hideCommands') : translate('ai.steps.showCommands')}
      </button>
      {open && (
        <ul className="ai-step-technical" id={bodyId}>
          {omitted > 0 && <li className="ai-step-unlisted">{translate('ai.steps.more', { count: omitted })}</li>}
          {calls.map((call) => (
            <li key={call.item.id}>
              <TechnicalRow call={call} projectPath={projectPath} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Characters of a path shown; a longer one keeps its start and its file name, with an ellipsis between. */
const PATH_CHARS_SHOWN = 56;

/** One call as it really was: its command or its title, the files it touched, its time and, when it failed, its error. */
function TechnicalRow({ call, projectPath }: { readonly call: StepCall; readonly projectPath: string }) {
  const translate = useTranslate();
  const { item } = call;
  const command = item.toolKind === 'execute' ? (item.command ?? item.title) : undefined;
  const paths = [...new Set([...item.diffs.map((diff) => diff.path), ...item.paths])].slice(0, 3);
  const error = call.status === 'failed' ? item.output.trim() : '';
  return (
    <div className={`ai-step-tech ai-step-${call.status}`}>
      <div className="ai-step-tech-line">
        {command !== undefined ? (
          <CodeInline className="ai-step-command" text={command.slice(0, STEP_LIMITS.commandCharsShown)} language="shell" />
        ) : (
          <span className="ai-step-tech-title">{(item.title.split('\n')[0] ?? '').slice(0, STEP_LIMITS.commandCharsShown)}</span>
        )}
        <span className="ai-step-time-cell">
          <StepTime status={call.status} startedAt={item.at} durationMs={callDurationMs(item)} />
        </span>
      </div>
      {paths.map((path) => {
        const shown = relativePath(path, projectPath);
        return (
          <span key={path} className="ai-step-path" title={path}>
            {middleEllipsis(shown, PATH_CHARS_SHOWN)}
          </span>
        );
      })}
      {error !== '' &&
        (looksLikeJson(error) ? (
          <PayloadDetails text={error} />
        ) : (
          <LogBlock text={error} charsMax={STEP_LIMITS.errorCharsShown} label={translate('ai.tool.output')} />
        ))}
    </div>
  );
}

const STATUS_WORDS = {
  running: 'ai.subagents.status.running',
  done: 'ai.subagents.status.done',
  failed: 'ai.subagents.status.failed',
  stopped: 'ai.subagents.status.stopped',
} as const satisfies Readonly<Record<StepStatus, MessageKey>>;

/** A step's status as a small mark, announced in words so it is not colour alone. */
function StepMark({ status }: { readonly status: StepStatus }) {
  const translate = useTranslate();
  return <span className={`ai-step-mark ai-step-mark-${status}`} role="img" aria-label={translate(STATUS_WORDS[status])} />;
}

/** Elapsed while it runs (the shared ticker), its duration once done, nothing without stamps. */
function StepTime({
  status,
  startedAt,
  durationMs,
}: {
  readonly status: StepStatus;
  readonly startedAt: number | undefined;
  readonly durationMs: number | undefined;
}) {
  if (status === 'running') {
    return startedAt === undefined ? undefined : <Elapsed startedAt={startedAt} />;
  }
  return durationMs === undefined ? undefined : <Duration milliseconds={durationMs} />;
}

function Elapsed({ startedAt }: { readonly startedAt: number }) {
  const now = useNow();
  return <Duration milliseconds={Math.max(0, now - startedAt)} />;
}

function Duration({ milliseconds }: { readonly milliseconds: number }) {
  const { formatNumber } = useFormat();
  return <span className="ai-agent-time">{formatDuration(milliseconds, formatNumber)}</span>;
}
