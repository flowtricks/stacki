// What a chat has going, for the "Running" panel by the composer: the subagents of the current run and the
// commands the agent left running in the background, each with its status and time, split into what still runs
// and what has finished (newest first); and the chip that opens the panel, which shows only while something
// runs or the current run's work has just finished.
//
// Pure: derived from the reducer's view and the subagent units (subagents.ts), never from the clock or the DOM.
// A background command is only what the transcript can prove (BackgroundTask in chatReducer.ts): Claude reports a
// command sent to the background as finished the moment it detaches, so such a command is listed as finished.
//
// Stopping: the adapters Stacki drives stop a whole turn (`session/cancel`), not one subagent or one command.
// claude-agent-acp can stop one subagent only for a client that declares `clientCapabilities.subagents` (every
// subagent then streams as its own child session) and one background command only for JetBrains AIR clients
// (`_session/async_task/stop`); Stacki declares neither, so no row offers a Stop of its own: the panel's one Stop
// is "Stop agent", which stops the turn, and it says so.
import { assert } from '../../../shared/core/assert';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';
import type { TurnId } from '../../../shared/properties/ai/chatModel';
import type { Translator } from '../../lib/i18n/localeContext';
import type { ChatView, ToolItem, TranscriptItem } from './chatReducer';
import { isWorking, type SubagentStatus, type SubagentUnit, type SubagentWork } from './subagents';
import { classifyStep, type StepFacts } from './transcript/toolWords';

export const RUNNING_LIMITS = {
  /** Rows of the Running section; past it the oldest are counted. */
  runningMax: 32,
  /** Finished rows kept, newest first; past it the oldest are counted. */
  finishedMax: 50,
  /** Finished rows shown at first, and how many each "Show more" adds. */
  finishedPageSize: 5,
  /** Transcript items searched back, from the newest, for the current run's finished background commands. */
  itemsScanned: 2_000,
} as const satisfies Record<string, number>;

/** A command the agent started in the background (or one that outlived its turn), as the panel shows it. */
export interface BackgroundCommand {
  readonly call: string;
  /** The exact command line, for "Show commands"; never in the default view. */
  readonly text: string;
  readonly step: StepFacts;
}

export type RunningItem =
  | { readonly kind: 'agent'; readonly key: string; readonly unit: SubagentUnit; readonly status: SubagentStatus }
  | { readonly kind: 'command'; readonly key: string; readonly command: BackgroundCommand; readonly status: SubagentStatus };

export interface RunningWork {
  /** What still runs, in the order it started. */
  readonly running: readonly RunningItem[];
  readonly runningOmitted: number;
  /** What finished (done, failed or stopped), newest first. */
  readonly finished: readonly RunningItem[];
  readonly finishedOmitted: number;
  readonly agentsRunning: number;
  readonly commandsRunning: number;
}

/** The chip by the composer: hidden when nothing runs or just finished. */
export type ChipState =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'working'; readonly agents: number; readonly commands: number }
  | { readonly kind: 'finished'; readonly agents: number; readonly commands: number; readonly failed: number };

export const EMPTY_RUNNING: RunningWork = { running: [], runningOmitted: 0, finished: [], finishedOmitted: 0, agentsRunning: 0, commandsRunning: 0 };

/**
 * The work of the current run: its subagents (those of the running turn, or of the last turn the person started, and any
 * still at work from earlier, the strip's rule) and its background commands (those still open, and those of the current
 * run that finished).
 */
export function deriveRunningWork(view: ChatView, work: SubagentWork): RunningWork {
  const current = view.running ?? lastUserTurn(view.items);
  const tools = toolsByCall(view.items);
  const running: RunningItem[] = [];
  const finished: { readonly item: RunningItem; readonly at: number | undefined; readonly order: number }[] = [];
  let agentsRunning = 0;
  for (const unit of work.units.values()) {
    const status = unit.agent.status;
    if (isWorking(status)) {
      agentsRunning += 1;
      running.push({ kind: 'agent', key: unit.agent.call, unit, status });
    } else if (unit.agent.turn === current) {
      finished.push({ item: { kind: 'agent', key: unit.agent.call, unit, status }, at: tools.get(unit.agent.call)?.at, order: finished.length });
    }
  }
  const open = new Set<string>();
  let commandsRunning = 0;
  for (const task of view.activeTasks) {
    const item = tools.get(task.call);
    if (task.kind === 'command' && item !== undefined) {
      open.add(task.call);
      commandsRunning += 1;
      running.push({ kind: 'command', key: task.call, command: commandOf(item), status: { kind: 'running', startedAt: item.at } });
    }
  }
  for (const item of finishedCommands(view.items, current, open)) {
    finished.push({ item: { kind: 'command', key: item.call, command: commandOf(item), status: commandEnd(item) }, at: item.at, order: finished.length });
  }
  // Newest first by start; work without stamps keeps the order it was found in, newest last found first.
  const ordered = [...finished].sort((left, right) => (right.at ?? -1) - (left.at ?? -1) || right.order - left.order).map((entry) => entry.item);
  const runningOmitted = Math.max(0, running.length - RUNNING_LIMITS.runningMax);
  const finishedOmitted = Math.max(0, ordered.length - RUNNING_LIMITS.finishedMax);
  const result: RunningWork = {
    running: running.slice(runningOmitted),
    runningOmitted,
    finished: ordered.slice(0, RUNNING_LIMITS.finishedMax),
    finishedOmitted,
    agentsRunning,
    commandsRunning,
  };
  assert(result.running.length <= RUNNING_LIMITS.runningMax, 'deriveRunningWork: the running rows are bounded');
  assert(result.finished.length <= RUNNING_LIMITS.finishedMax, 'deriveRunningWork: the finished rows are bounded');
  return result;
}

/** The chip for the work: what runs, else what just finished, else nothing. */
export function chipState(work: RunningWork): ChipState {
  if (work.agentsRunning + work.commandsRunning > 0) {
    return { kind: 'working', agents: work.agentsRunning, commands: work.commandsRunning };
  }
  if (work.finished.length === 0) {
    return { kind: 'hidden' };
  }
  const agents = work.finished.filter((item) => item.kind === 'agent').length;
  const failed = work.finished.filter((item) => item.status.kind === 'failed').length;
  assert(failed <= work.finished.length, 'chipState: failures are a subset');
  return { kind: 'finished', agents, commands: work.finished.length - agents, failed };
}

/** The chip's words: "3 agents working", "2 agents working, 1 background command", "3 agents finished". Hidden: empty. */
export function chipLabel(state: ChipState, translate: Translator): string {
  switch (state.kind) {
    case 'hidden':
      return '';
    case 'working': {
      const agents = translate('ai.subagents.running', { count: state.agents });
      const commands = translate('ai.running.commands', { count: state.commands });
      if (state.agents > 0 && state.commands > 0) {
        return translate('ai.running.both', { agents, commands });
      }
      return state.agents > 0 ? agents : commands;
    }
    case 'finished':
      return state.agents > 0 ? translate('ai.subagents.finished', { count: state.agents }) : translate('ai.tasks.finished', { count: state.commands });
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

/** A background command's name in the panel: "Dev server", "Tests", the script it runs, else "<program> command". Never the command line. */
export function commandName(step: StepFacts, translate: Translator): string {
  switch (step.kind) {
    case 'devServer':
      return translate('ai.running.name.devServer');
    case 'test':
      return translate('ai.running.name.tests');
    case 'check':
      return translate('ai.running.name.checks');
    case 'build':
      return translate('ai.running.name.build');
    case 'install':
      return translate('ai.running.name.install');
    case 'web':
      return translate('ai.running.name.web');
    case 'script':
      return step.subject ?? translate('ai.running.name.script');
    case 'command':
      return step.name === undefined ? translate('ai.running.name.commandPlain') : translate('ai.running.name.command', { program: step.name });
    case 'read':
    case 'edit':
    case 'files':
    case 'search':
    case 'commit':
    case 'push':
    case 'history':
    case 'git':
    case 'ask':
    case 'plan':
    case 'todo':
    case 'helper':
    case 'message':
    case 'tool':
      return translate('ai.running.name.commandPlain');
    default: {
      const exhaustive: never = step.kind;
      return exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function lastUserTurn(items: readonly TranscriptItem[]): TurnId | undefined {
  const stop = Math.max(0, items.length - AI_LIMITS.chatEventsMax);
  for (let index = items.length - 1; index >= stop; index -= 1) {
    const item = items[index];
    if (item?.kind === 'user') {
      return item.turn;
    }
  }
  return undefined;
}

function toolsByCall(items: readonly TranscriptItem[]): ReadonlyMap<string, ToolItem> {
  const tools = new Map<string, ToolItem>();
  for (const item of items) {
    if (item.kind === 'tool' && item.parent === undefined) {
      tools.set(item.call, item);
    }
  }
  return tools;
}

/** The current run's top-level background commands that finished, newest first, from the newest `itemsScanned` items. */
function finishedCommands(items: readonly TranscriptItem[], current: TurnId | undefined, open: ReadonlySet<string>): readonly ToolItem[] {
  if (current === undefined) {
    return [];
  }
  const found: ToolItem[] = [];
  const stop = Math.max(0, items.length - RUNNING_LIMITS.itemsScanned);
  for (let index = items.length - 1; index >= stop && found.length < RUNNING_LIMITS.finishedMax; index -= 1) {
    const item = items[index];
    if (item?.kind === 'tool' && item.parent === undefined && item.turn === current && item.background && item.toolKind === 'execute') {
      if ((item.status === 'completed' || item.status === 'failed') && !open.has(item.call)) {
        found.push(item);
      }
    }
  }
  assert(found.length <= RUNNING_LIMITS.finishedMax, 'finishedCommands: bounded');
  return found;
}

function commandOf(item: ToolItem): BackgroundCommand {
  const text = item.command ?? item.title;
  return { call: item.call, text, step: classifyStep({ ...item, command: text }) };
}

function commandEnd(item: ToolItem): SubagentStatus {
  const durationMs = item.at === undefined || item.endedAt === undefined || item.endedAt < item.at ? undefined : item.endedAt - item.at;
  const failed = item.status === 'failed' || (item.exitCode !== undefined && item.exitCode !== 0);
  return failed ? { kind: 'failed', durationMs } : { kind: 'done', durationMs };
}
