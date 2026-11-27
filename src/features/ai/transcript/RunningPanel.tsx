// "What is running": a quiet chip above the composer ("3 agents working", "2 agents working, 1 background
// command", "3 agents finished") that shows only while the chat has work going or the current run's work has
// just finished, and opens a panel over the bottom of the chat (the way Claude's desktop app shows its running
// agents). The panel lists what runs (each subagent and background command: a status dot, its task in words, the
// model it runs on, its time ticking) and, folded with a count, what finished, newest first, a page at a time.
// A subagent opens to "31 tasks, 1 running" and its work as steps a designer reads (StepGroups.tsx); a command
// opens to the command itself, the one technical line it has.
//
// The panel lives in the chat column, not a portal: the transcript scrolls under it and it stays open. Escape or a
// press outside closes it (Popup), and the chip toggles it. Its only control that acts is "Stop all", at the top, which
// stops the whole turn; no row has a Stop of its own because the adapters cannot stop one subagent for Stacki
// (runningWork.ts says why), and a button that only pretended would be worse than none. Once pressed it reads
// "Stopping…" and waits, disabled, until what it stopped has ended; a stop that never reached the agent is a toast.
import { memo, useId, useMemo, useRef, useState } from 'react';
import type { ChatId, ChatOption } from '../../../../shared/properties/ai/chatModel';
import { useFormat, useTranslate } from '../../../lib/i18n/useTranslate';
import { CodeInline } from '../../../ui/CodeBlock';
import { ChevronDownIcon, ChevronRightIcon } from '../../../ui/Icons';
import { LoaderDots } from '../../../ui/LoaderDots';
import Popup from '../../../ui/Popup';
import { stopChat } from '../aiStore';
import type { ChatView } from '../chatReducer';
import { chipLabel, chipMark, chipState, commandName, deriveRunningWork, RUNNING_LIMITS, type RunningItem, type RunningWork } from '../runningWork';
import { deriveSubagentWork, isWorking, type SubagentUnit, type SubagentWork } from '../subagents';
import { groupSteps, STEP_LIMITS, timelineSummary } from './agentSteps';
import { StepList } from './StepGroups';
import { agentModelLabel, displayName, statusLabel, statusLine, SubagentDot, SubagentTime } from './SubagentStrip';
import { useOpenState } from './transcriptUi';
import './running.css';

export interface RunningChipProps {
  readonly view: ChatView;
  readonly chatId: ChatId;
  readonly projectPath: string;
}

export const RunningChip = memo(function RunningChip({ view, chatId, projectPath }: RunningChipProps) {
  const translate = useTranslate();
  const previous = useRef<SubagentWork | undefined>(undefined);
  const work = useMemo(() => {
    const derived = deriveSubagentWork(view, previous.current);
    previous.current = derived;
    return derived;
  }, [view]);
  const running = useMemo(() => deriveRunningWork(view, work), [view, work]);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | undefined>(undefined);
  // What a press of Stop asked to end: the running turn, or the commands left running after it. Stopping lasts while
  // that is still what runs, so it ends by itself when the turn ends, with no timer and no effect to reset it.
  const [stopped, setStopped] = useState<string | undefined>(undefined);
  const chip = chipState(running);
  if (chip.kind === 'hidden') {
    return undefined;
  }
  const close = (): void => {
    setOpen(false);
    anchor?.focus();
  };
  // The turn can be stopped while it runs, or while a command it left keeps going (the host's cancel reaches both).
  const stoppable = view.running !== undefined || running.commandsRunning > 0;
  const stopTarget = view.running ?? (running.commandsRunning > 0 ? 'commands' : undefined);
  const stop: StopControl | undefined = stoppable
    ? {
        stopping: stopped !== undefined && stopped === stopTarget,
        run: () => {
          setStopped(stopTarget);
          void stopChat(chatId).then((sent) => {
            if (!sent) {
              setStopped(undefined);
            }
          });
        },
      }
    : undefined;
  return (
    <div className="ai-running">
      <button
        ref={(element) => setAnchor(element ?? undefined)}
        type="button"
        className={`ai-running-chip${open ? ' is-open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {chip.kind === 'working' ? <LoaderDots dotPx={3} /> : <SubagentDot status={chipMark(chip)} />}
        <span className="ai-running-chip-text">{chipLabel(chip, translate)}</span>
        {chip.kind === 'finished' && chip.failed > 0 && chip.agents + chip.commands > 0 && (
          <span className="ai-agents-failed">{translate('ai.subagents.failed', { count: chip.failed })}</span>
        )}
      </button>
      <Popup
        mode="popover"
        portal={false}
        keepOnScroll
        role="dialog"
        label={translate('ai.running.label')}
        open={open}
        anchor={anchor}
        // A press on the chip is its own toggle, not an outside press that would close the panel and open it again.
        within={anchor}
        onClose={close}
        className="ai-running-panel"
      >
        <PanelBody running={running} chatId={chatId} projectPath={projectPath} options={view.options} stop={stop} />
      </Popup>
    </div>
  );
});

/** The panel's one Stop: what it does, and whether it was pressed and waits for the turn to end. */
interface StopControl {
  readonly stopping: boolean;
  readonly run: () => void;
}

function PanelBody({
  running,
  chatId,
  projectPath,
  options,
  stop,
}: {
  readonly running: RunningWork;
  readonly chatId: ChatId;
  readonly projectPath: string;
  readonly options: readonly ChatOption[];
  readonly stop: StopControl | undefined;
}) {
  const translate = useTranslate();
  const { formatNumber } = useFormat();
  const runningCount = running.running.length + running.runningOmitted;
  const rowProps = { chatId, projectPath, options };
  return (
    <div className="ai-running-body">
      {runningCount > 0 && (
        <section className="ai-running-section" aria-label={translate('ai.running.section.running')}>
          <div className="ai-running-section-head">
            <span className="ai-running-section-title">{translate('ai.running.section.running')}</span>
            <span className="ai-running-count">{formatNumber(runningCount)}</span>
            {stop !== undefined && <StopButton stop={stop} />}
          </div>
          <ul className="ai-running-list">
            {running.runningOmitted > 0 && <li className="ai-running-more">{translate('ai.steps.more', { count: running.runningOmitted })}</li>}
            {running.running.map((item) => (
              <li key={item.key}>
                <Row item={item} {...rowProps} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {running.finished.length > 0 && (
        <FinishedSection running={running} startOpen={runningCount === 0} rowProps={rowProps} stop={runningCount === 0 ? stop : undefined} />
      )}
    </div>
  );
}

/** "Stop all", or while the stop it sent takes effect, "Stopping…" with its dots, disabled so it is sent once. */
function StopButton({ stop }: { readonly stop: StopControl }) {
  const translate = useTranslate();
  return (
    <button
      type="button"
      className="ai-running-stop"
      title={translate('ai.running.stopTitle')}
      disabled={stop.stopping}
      aria-busy={stop.stopping}
      onClick={stop.stopping ? undefined : stop.run}
    >
      {stop.stopping && <LoaderDots dotPx={3} />}
      {translate(stop.stopping ? 'ai.running.stopping' : 'ai.running.stopAll')}
    </button>
  );
}

/** What finished, folded with its count; it starts open only when nothing runs, since then it is all there is. */
function FinishedSection({
  running,
  startOpen,
  rowProps,
  stop,
}: {
  readonly running: RunningWork;
  readonly startOpen: boolean;
  readonly rowProps: { readonly chatId: ChatId; readonly projectPath: string; readonly options: readonly ChatOption[] };
  readonly stop: StopControl | undefined;
}) {
  const translate = useTranslate();
  const { formatNumber } = useFormat();
  const bodyId = useId();
  const [open, setOpen] = useState(startOpen);
  const [shown, setShown] = useState<number>(RUNNING_LIMITS.finishedPageSize);
  const visible = running.finished.slice(0, shown);
  const hidden = running.finished.length - visible.length;
  const total = running.finished.length + running.finishedOmitted;
  return (
    <section className="ai-running-section" aria-label={translate('ai.running.section.finished')}>
      <div className="ai-running-section-head">
        <button type="button" className="ai-running-fold" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={() => setOpen(!open)}>
          {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
          <span className="ai-running-section-title">{translate('ai.running.section.finished')}</span>
          <span className="ai-running-count">{formatNumber(total)}</span>
        </button>
        {stop !== undefined && <StopButton stop={stop} />}
      </div>
      {open && (
        <ul className="ai-running-list" id={bodyId}>
          {visible.map((item) => (
            <li key={item.key}>
              <Row item={item} {...rowProps} />
            </li>
          ))}
          {hidden > 0 && (
            <li>
              <button type="button" className="ai-steps-more" onClick={() => setShown((count) => count + RUNNING_LIMITS.finishedPageSize)}>
                {translate('ai.running.showMore')}
              </button>
            </li>
          )}
          {hidden === 0 && running.finishedOmitted > 0 && <li className="ai-running-more">{translate('ai.steps.more', { count: running.finishedOmitted })}</li>}
        </ul>
      )}
    </section>
  );
}

function Row({
  item,
  chatId,
  projectPath,
  options,
}: {
  readonly item: RunningItem;
  readonly chatId: ChatId;
  readonly projectPath: string;
  readonly options: readonly ChatOption[];
}) {
  switch (item.kind) {
    case 'agent':
      return <AgentRow unit={item.unit} chatId={chatId} projectPath={projectPath} options={options} />;
    case 'command':
      return <CommandRow item={item} />;
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}

/** One subagent: dot, task, model and time in the strip's columns, a summary line, and opened, its steps. */
const AgentRow = memo(function AgentRow({
  unit,
  chatId,
  projectPath,
  options,
}: {
  readonly unit: SubagentUnit;
  readonly chatId: ChatId;
  readonly projectPath: string;
  readonly options: readonly ChatOption[];
}) {
  const translate = useTranslate();
  const bodyId = useId();
  const { agent } = unit;
  const [open, change] = useOpenState(chatId, `panel:agent:${agent.call}`, { open: false });
  const working = isWorking(agent.status);
  const timeline = groupSteps(unit.children, { working });
  const name = displayName(agent, projectPath, translate);
  const model = agentModelLabel(agent, options);
  const summary =
    timeline.tasks === 0
      ? working
        ? statusLine(agent, translate)
        : statusLabel(agent.status, translate)
      : timelineSummary({ ...timeline, tasks: timeline.tasks + unit.omitted }, translate);
  return (
    <div className={`ai-running-row ai-running-${agent.status.kind}`}>
      <button
        type="button"
        className="ai-running-head"
        title={[name, agent.role, model].filter((part) => part !== undefined && part !== '').join(' · ')}
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => change({ open: !open })}
      >
        <span className="ai-step-chevron">{open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}</span>
        <SubagentDot status={agent.status} />
        <span className="ai-running-name">{name}</span>
        <span className="ai-agent-model">{model}</span>
        <span className="ai-agent-time-cell">
          <SubagentTime status={agent.status} />
        </span>
        <span className="ai-running-summary">
          {model !== '' && <span className="ai-running-model-inline">{model} · </span>}
          {summary}
        </span>
      </button>
      {open && (
        <div className="ai-running-steps" id={bodyId}>
          <StepList timeline={timeline} chatId={chatId} scope={`panel:${agent.call}`} projectPath={projectPath} working={working} />
        </div>
      )}
    </div>
  );
});

/** One background command: its name in words ("Dev server", "Tests"), never its command line until opened. */
function CommandRow({ item }: { readonly item: Extract<RunningItem, { readonly kind: 'command' }> }) {
  const translate = useTranslate();
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  const name = commandName(item.command.step, translate);
  return (
    <div className={`ai-running-row ai-running-${item.status.kind}`}>
      <button
        type="button"
        className="ai-running-head"
        title={name}
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => setOpen(!open)}
      >
        <span className="ai-step-chevron">{open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}</span>
        <SubagentDot status={item.status} />
        <span className="ai-running-name">{name}</span>
        <span className="ai-agent-model" />
        <span className="ai-agent-time-cell">
          <SubagentTime status={item.status} />
        </span>
        <span className="ai-running-summary">{statusLabel(item.status, translate)}</span>
      </button>
      {open && (
        <div className="ai-running-steps ai-step-technical" id={bodyId}>
          <CodeInline className="ai-step-command" text={item.command.text.slice(0, STEP_LIMITS.commandCharsShown)} language="shell" />
        </div>
      )}
    </div>
  );
}
