// The tray of background work: subagents and commands the agent started and left running, and the
// last few that finished. It is derived from the agent's tool calls (the protocol only reports real
// background tasks to JetBrains' AIR clients, which Stacki does not pretend to be), so it lists what
// the transcript can prove. Each task shows its elapsed time and the last line it printed; the only
// control is "Stop agent", which cancels the chat's turn (ai:cancel) and not a single task.
import { memo, useId } from 'react';
import { CodeInline } from '../../../ui/CodeBlock';
import { ChevronDownIcon, ChevronRightIcon, SparkleIcon, TerminalIcon } from '../../../ui/Icons';
import { LoaderDots } from '../../../ui/LoaderDots';
import type { BackgroundTask } from '../chatReducer';
import { formatDuration } from '../chatStatus';
import { useNow } from './ticker';
import type { FinishedTask } from './transcriptModel';
import { useOpenState } from './transcriptUi';

export interface BackgroundTasksProps {
  readonly tasks: readonly BackgroundTask[];
  readonly finished: readonly FinishedTask[];
  readonly chatId: string;
  readonly onStop: () => void;
}

export const BackgroundTasks = memo(function BackgroundTasks({ tasks, finished, chatId, onStop }: BackgroundTasksProps) {
  const [open, change] = useOpenState(chatId, 'background-tasks', { open: false });
  const bodyId = useId();
  if (tasks.length === 0 && finished.length === 0) {
    return undefined;
  }
  const label =
    tasks.length > 0
      ? `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'} running`
      : `${finished.length} ${finished.length === 1 ? 'task' : 'tasks'} finished`;
  return (
    <div className="ai-tasks" role="region" aria-label="Background tasks">
      <div className="ai-tasks-bar">
        <button className="ai-tasks-head" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={() => change({ open: !open })}>
          {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
          {tasks.length > 0 && <LoaderDots dotPx={3} />}
          <span>{label}</span>
        </button>
        {tasks.length > 0 && (
          <button className="ai-tasks-stop" onClick={onStop}>
            Stop agent
          </button>
        )}
      </div>
      {open && (
        <ul className="ai-tasks-list" id={bodyId}>
          {tasks.map((task) => (
            <li key={task.call} className="ai-task">
              <TaskTitle kind={task.kind} title={task.title} />
              {task.startedAt !== undefined && <RunningFor startedAt={task.startedAt} />}
              {task.lastOutputLine !== undefined && <span className="ai-task-peek">{task.lastOutputLine}</span>}
            </li>
          ))}
          {finished.map((task) => (
            <li key={task.call} className={`ai-task ai-task-finished${task.status === 'failed' ? ' ai-task-failed' : ''}`}>
              <TaskTitle kind={task.kind} title={task.title} />
              <span className="ai-task-time">
                {task.status === 'failed' ? 'Failed' : task.durationMs === undefined ? 'Done' : formatDuration(task.durationMs)}
              </span>
              {task.lastOutputLine !== undefined && <span className="ai-task-peek">{task.lastOutputLine}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

function TaskTitle({ kind, title }: { readonly kind: BackgroundTask['kind']; readonly title: string }) {
  const Icon = kind === 'command' ? TerminalIcon : SparkleIcon;
  const line = (title.split('\n')[0] ?? title).slice(0, 300);
  return (
    <span className="ai-task-title">
      <Icon size={13} />
      {kind === 'command' ? <CodeInline text={line} language="shell" /> : <span className="ai-task-name">{line}</span>}
    </span>
  );
}

/** Mounted per running task and only while the tray is open, so a closed tray ticks nothing. */
function RunningFor({ startedAt }: { readonly startedAt: number }) {
  const elapsed = useNow() - startedAt;
  return <span className="ai-task-time">{formatDuration(elapsed)}</span>;
}
