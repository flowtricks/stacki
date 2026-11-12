// What the panel says about the agent's progress, as pure functions of a chat's view and a clock
// reading: the context ring's tone, the line under a running turn ("Running a command  1m 17s"),
// the one-line summary of a group of tool calls, and how a duration is written. Pure so the
// panels that draw them (composer, transcript) share one wording and the tests pin it.
//
// `now` is always passed in: nothing here reads the clock, so a test can fix time and a component
// can tick it once per second without recomputing anything else.
import { assert } from '../../../shared/core/assert';
import type { ToolKindName } from '../../../shared/properties/ai/chatModel';
import { waitingPermissions, type ChatView, type ToolItem, type TranscriptItem } from './chatReducer';

export type ContextTone = 'unknown' | 'neutral' | 'amber' | 'red';

/** The ring's colour: neutral below 70% of the window, amber from 70%, red from 90%; unknown before the agent reports a window. */
export function contextTone(used: number, size: number): ContextTone {
  assert(Number.isFinite(used), 'contextTone: used is finite');
  assert(Number.isFinite(size), 'contextTone: size is finite');
  if (size <= 0 || used < 0) {
    return 'unknown';
  }
  // Integer comparisons: no rounding decides which side of a threshold a chat falls on.
  if (used * 100 >= size * 90) {
    return 'red';
  }
  if (used * 100 >= size * 70) {
    return 'amber';
  }
  return 'neutral';
}

/** The share of the window used, rounded down, or undefined while the window is unknown. */
export function contextPercent(used: number, size: number): number | undefined {
  if (size <= 0 || used < 0) {
    return undefined;
  }
  return Math.floor((used * 100) / size);
}

/** A duration as people read it: `1.4s`, `12s`, `1m 17s`, `1h 2m`. Never negative. */
export function formatDuration(milliseconds: number): string {
  assert(Number.isFinite(milliseconds), 'formatDuration: a finite number');
  const clamped = Math.max(0, milliseconds);
  if (clamped < 10_000) {
    return `${(Math.floor(clamped / 100) / 10).toFixed(1)}s`;
  }
  const seconds = Math.floor(clamped / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export type TurnPhase = 'command' | 'reading' | 'searching' | 'editing' | 'fetching' | 'thinking' | 'waiting' | 'compacting' | 'working';

export type TurnStatus =
  | { readonly kind: 'idle' }
  /** `elapsedMs` is undefined for a turn this view did not see begin. */
  | { readonly kind: 'running'; readonly phase: TurnPhase; readonly label: string; readonly elapsedMs: number | undefined }
  | { readonly kind: 'worked'; readonly elapsedMs: number };

/** Neutral words for the moments between tool calls, rotated slowly so the line shows life without claiming a step. */
const IDLE_VERBS = ['Working', 'Thinking it through', 'Looking around'] as const;
const IDLE_VERB_MS = 4000;

const PHASE_LABELS: Readonly<Record<Exclude<TurnPhase, 'working'>, string>> = {
  command: 'Running a command',
  reading: 'Reading files',
  searching: 'Searching',
  editing: 'Editing files',
  fetching: 'Fetching',
  thinking: 'Thinking',
  waiting: 'Waiting for you',
  compacting: 'Compacting conversation',
};

function phaseOfTool(kind: ToolKindName): TurnPhase {
  switch (kind) {
    case 'execute':
      return 'command';
    case 'read':
      return 'reading';
    case 'search':
      return 'searching';
    case 'edit':
    case 'delete':
    case 'move':
      return 'editing';
    case 'fetch':
      return 'fetching';
    case 'think':
      return 'thinking';
    case 'switch_mode':
    case 'other':
      return 'working';
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function phaseOf(view: ChatView): TurnPhase {
  if (waitingPermissions(view).length > 0) {
    return 'waiting';
  }
  if (view.compaction?.status === 'in_progress') {
    return 'compacting';
  }
  const last = view.items[view.items.length - 1];
  if (last?.kind === 'tool' && (last.status === 'pending' || last.status === 'in_progress')) {
    return phaseOfTool(last.toolKind);
  }
  if (last?.kind === 'text' && last.role === 'thought') {
    return 'thinking';
  }
  return 'working';
}

/** The line under the transcript: what a running turn is doing and for how long, or how long the last turn took. */
export function buildTurnStatus(view: ChatView, now: number): TurnStatus {
  assert(Number.isFinite(now), 'buildTurnStatus: a finite clock reading');
  if (view.running !== undefined) {
    const phase = phaseOf(view);
    const verb = IDLE_VERBS[Math.floor(Math.max(0, now) / IDLE_VERB_MS) % IDLE_VERBS.length] ?? IDLE_VERBS[0];
    return {
      kind: 'running',
      phase,
      label: phase === 'working' ? verb : PHASE_LABELS[phase],
      elapsedMs: view.turnStartedAt === undefined ? undefined : Math.max(0, now - view.turnStartedAt),
    };
  }
  for (let index = view.items.length - 1; index >= 0; index -= 1) {
    const item = view.items[index];
    if (item?.kind === 'turn-end') {
      return item.startedAt === undefined ? { kind: 'idle' } : { kind: 'worked', elapsedMs: Math.max(0, item.at - item.startedAt) };
    }
  }
  return { kind: 'idle' };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Distinct files a call touched, else one per call (a call that names no file still counts once). */
function fileCount(calls: readonly ToolItem[]): number {
  const paths = new Set<string>();
  let unnamed = 0;
  for (const call of calls) {
    const named = [...call.paths, ...call.diffs.map((diff) => diff.path)];
    if (named.length === 0) {
      unnamed += 1;
    }
    for (const path of named) {
      paths.add(path);
    }
  }
  return paths.size + unnamed;
}

/** "Ran 4 commands, edited 2 files, read 6 files": a group of tool calls in one line. Empty when there is nothing to say. */
export function activityHeadline(items: readonly TranscriptItem[]): string {
  const byKind = (...kinds: readonly ToolKindName[]): readonly ToolItem[] =>
    items.filter((item): item is ToolItem => item.kind === 'tool' && kinds.includes(item.toolKind));
  const commands = byKind('execute');
  const edits = byKind('edit', 'delete', 'move');
  const reads = byKind('read');
  const searches = byKind('search');
  const fetches = byKind('fetch');
  const others = byKind('other');
  const phrases = [
    commands.length === 0 ? '' : `ran ${plural(commands.length, 'command', 'commands')}`,
    edits.length === 0 ? '' : `edited ${plural(fileCount(edits), 'file', 'files')}`,
    reads.length === 0 ? '' : `read ${plural(fileCount(reads), 'file', 'files')}`,
    searches.length === 0 ? '' : `searched ${plural(searches.length, 'time', 'times')}`,
    fetches.length === 0 ? '' : `fetched ${plural(fetches.length, 'page', 'pages')}`,
    others.length === 0 ? '' : `used ${plural(others.length, 'tool', 'tools')}`,
  ].filter((phrase) => phrase !== '');
  const line = phrases.join(', ');
  return line === '' ? '' : `${line.charAt(0).toUpperCase()}${line.slice(1)}`;
}
