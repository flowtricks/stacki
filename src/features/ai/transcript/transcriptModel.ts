// The transcript's shape and wording as pure functions, so the components only draw what these
// decide and the tests pin it without a DOM: how items fold into rows (a run of tool calls and
// thoughts is one activity group), how long a group or a thought took, what the running line says,
// how a compaction reads, which background work has finished, and where a long message is cut.
//
// Nothing here reads the clock or the DOM. Durations come from the stamps the host put on events;
// an item without stamps (a chat stored before timings) has no duration, never a wrong one.
import { assert } from '../../../../shared/core/assert';
import type { TurnId } from '../../../../shared/properties/ai/chatModel';
import type { MessageKey } from '../../../../shared/properties/i18n/messageRef';
import type { Translator } from '../../../lib/i18n/localeContext';
import { activityHeadline, buildTurnStatus, formatDuration, formatTokens, type ChatWords, type TurnPhase } from '../chatStatus';
import type { BackgroundTask, ChatView, CompactionItem, ToolItem, TranscriptItem } from '../chatReducer';

/** An item of the kinds an activity group folds: the agent's thoughts and its tool calls. */
export type TextItem = Extract<TranscriptItem, { readonly kind: 'text' }>;
/** A text item with `role === 'thought'` is the agent thinking; the type cannot say so, `isActivityItem` checks it. */
export type ActivityItem = ToolItem | TextItem;

export function isActivityItem(item: TranscriptItem): item is ActivityItem {
  return item.kind === 'tool' || (item.kind === 'text' && item.role === 'thought');
}

export interface ActivityRun {
  readonly kind: 'group';
  /** The first item's id: stable while the group grows, so its open state and React key hold. */
  readonly key: number;
  readonly turn: TurnId;
  readonly items: readonly ActivityItem[];
  /** The last group of its turn: the one that is still going while that turn runs. */
  readonly last: boolean;
}

export interface SingleRow {
  readonly kind: 'item';
  readonly key: number;
  readonly item: TranscriptItem;
  /** The item's position in the chat's items (the sign-in reader hides by position). */
  readonly index: number;
}

export type TranscriptRow = ActivityRun | SingleRow;

/** The items the transcript draws, each with its position in the chat. */
export interface PositionedItem {
  readonly item: TranscriptItem;
  readonly index: number;
}

/**
 * Folds items into rows: every maximal run of consecutive activity items of one turn becomes a group,
 * anything else (a message, a permission request, a compaction, a notice) stays its own row and ends
 * the run. `previous` is the rows of the last call: a group whose items are all the same objects is
 * returned as the same object, so React can skip it while text streams in below.
 */
export function buildRows(items: readonly PositionedItem[], previous: readonly TranscriptRow[]): readonly TranscriptRow[] {
  const known = new Map<number, ActivityRun>();
  for (const row of previous) {
    if (row.kind === 'group') {
      known.set(row.key, row);
    }
  }
  const rows: TranscriptRow[] = [];
  let run: ActivityItem[] = [];
  const flush = (): void => {
    const first = run[0];
    if (first === undefined) {
      return;
    }
    rows.push({ kind: 'group', key: first.id, turn: first.turn, items: run, last: false });
    run = [];
  };
  for (const positioned of items) {
    const { item } = positioned;
    if (isActivityItem(item)) {
      const first = run[0];
      if (first !== undefined && first.turn !== item.turn) {
        flush();
      }
      run.push(item);
    } else {
      flush();
      rows.push({ kind: 'item', key: item.id, item, index: positioned.index });
    }
  }
  flush();
  // Which group is the last of its turn: walked from the end, so each turn's first hit wins.
  const seenTurns = new Set<TurnId>();
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind === 'group' && !seenTurns.has(row.turn)) {
      seenTurns.add(row.turn);
      rows[index] = { ...row, last: true };
    }
  }
  const reused = rows.map((row) => {
    if (row.kind !== 'group') {
      return row;
    }
    const before = known.get(row.key);
    const same =
      before !== undefined && before.last === row.last && before.items.length === row.items.length && before.items.every((item, at) => item === row.items[at]);
    return same ? before : row;
  });
  assert(reused.length <= items.length, 'buildRows: rows never outnumber items');
  return reused;
}

/** The last `limit` rows, and how many were left out; a long chat draws a window, never every row. */
export function windowRows(rows: readonly TranscriptRow[], limit: number): { readonly shown: readonly TranscriptRow[]; readonly hidden: number } {
  assert(limit > 0, 'windowRows: a positive limit');
  const hidden = Math.max(0, rows.length - limit);
  return { shown: hidden === 0 ? rows : rows.slice(hidden), hidden };
}

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

/** When an activity item began and (when known) ended; undefined when the item carries no stamp. */
function itemSpan(item: ActivityItem): { readonly start: number; readonly end: number | undefined } | undefined {
  if (item.at === undefined) {
    return undefined;
  }
  if (item.kind === 'tool') {
    return { start: item.at, end: item.endedAt };
  }
  return { start: item.at, end: item.until };
}

/** The milliseconds a thought took, or undefined when its stamps are missing (old chats) or run backwards. */
export function thoughtDurationMs(item: TextItem): number | undefined {
  if (item.at === undefined || item.until === undefined || item.until < item.at) {
    return undefined;
  }
  return item.until - item.at;
}

/** The milliseconds a finished tool call took, or undefined without both stamps. */
export function toolDurationMs(item: ToolItem): number | undefined {
  if (item.at === undefined || item.endedAt === undefined || item.endedAt < item.at) {
    return undefined;
  }
  return item.endedAt - item.at;
}

/** From the group's first stamp to its last: undefined while any item is unfinished or a stamp is missing. */
export function groupDurationMs(items: readonly ActivityItem[]): number | undefined {
  let start: number | undefined;
  let end: number | undefined;
  for (const item of items) {
    const span = itemSpan(item);
    if (span === undefined || span.end === undefined) {
      return undefined;
    }
    start = start === undefined ? span.start : Math.min(start, span.start);
    end = end === undefined ? span.end : Math.max(end, span.end);
  }
  if (start === undefined || end === undefined) {
    return undefined;
  }
  return Math.max(0, end - start);
}

function isOpen(item: ToolItem): boolean {
  return item.status === 'pending' || item.status === 'in_progress';
}

// ---------------------------------------------------------------------------
// Group headline
// ---------------------------------------------------------------------------

export interface GroupSummary {
  readonly text: string;
  /** How many calls failed, for the warning mark beside the line. */
  readonly failed: number;
  /** Calls still open. */
  readonly open: number;
}

/** "Ran 4 commands, edited 2 files" for the calls; "Thought for 12s" or "Thinking" when the group has only thoughts. */
export function summarizeGroup(items: readonly ActivityItem[], words: ChatWords): GroupSummary {
  const tools = items.filter((item): item is ToolItem => item.kind === 'tool');
  const failed = tools.filter((tool) => tool.status === 'failed').length;
  const open = tools.filter(isOpen).length;
  const headline = tools.length === 0 ? '' : activityHeadline(tools, words.translate);
  if (headline !== '') {
    return { text: headline, failed, open };
  }
  const thought = items.find((item): item is TextItem => item.kind === 'text');
  if (thought === undefined) {
    return { text: words.translate('ai.activity.usedTools', { count: tools.length }), failed, open };
  }
  const duration = thoughtDurationMs(thought);
  return { text: thoughtText(duration, words), failed, open };
}

/** The label of a thought's row: "Thought for 12s", "Thinking…" while it streams, plain "Thought" without stamps. */
export function thoughtLabel(item: TextItem, options: { readonly live: boolean }, words: ChatWords): string {
  if (options.live) {
    return words.translate('ai.thought.thinking');
  }
  return thoughtText(thoughtDurationMs(item), words);
}

function thoughtText(duration: number | undefined, words: ChatWords): string {
  return duration === undefined
    ? words.translate('ai.thought.plain')
    : words.translate('ai.thought.for', { duration: formatDuration(duration, words.formatNumber) });
}

// ---------------------------------------------------------------------------
// The running line
// ---------------------------------------------------------------------------

/** Which phases name a count when several calls of that kind are open at once. */
const COUNTED: Readonly<Partial<Record<TurnPhase, { readonly kinds: readonly ToolItem['toolKind'][]; readonly message: MessageKey }>>> = {
  reading: { kinds: ['read'], message: 'ai.status.counted.reading' },
  command: { kinds: ['execute'], message: 'ai.status.counted.command' },
  editing: { kinds: ['edit', 'delete', 'move'], message: 'ai.status.counted.editing' },
  searching: { kinds: ['search'], message: 'ai.status.counted.searching' },
};

/**
 * The words under a running turn, from live state only: the phase of the newest event, made specific
 * ("Reading 3 files") when several calls of that kind are open. Nothing here is invented progress.
 */
export function runningLabel(
  view: ChatView,
  now: number,
  translate: Translator,
): { readonly label: string; readonly elapsedMs: number | undefined } | undefined {
  const status = buildTurnStatus(view, now, translate);
  if (status.kind !== 'running') {
    return undefined;
  }
  const counted = COUNTED[status.phase];
  if (counted === undefined || view.running === undefined) {
    return { label: status.label, elapsedMs: status.elapsedMs };
  }
  const turn = view.running;
  let open = 0;
  for (const item of view.items) {
    if (item.kind === 'tool' && item.turn === turn && isOpen(item) && counted.kinds.includes(item.toolKind)) {
      open += 1;
    }
  }
  return { label: open >= 2 ? translate(counted.message, { count: open }) : status.label, elapsedMs: status.elapsedMs };
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

export { formatTokens };

export type CompactionTone = 'running' | 'done' | 'failed' | 'stopped';

export interface CompactionLine {
  readonly tone: CompactionTone;
  readonly text: string;
  /** Why it failed, when the agent said. */
  readonly detail?: string | undefined;
}

/** What the compaction row says. The saving is derived from the usage before and after, and only claimed when both are known and it is positive. */
export function compactionLine(item: CompactionItem, words: ChatWords): CompactionLine {
  switch (item.status) {
    case 'in_progress':
      return { tone: 'running', text: words.translate('ai.compaction.running') };
    case 'completed': {
      if (item.before === undefined || item.after === undefined) {
        return { tone: 'done', text: words.translate('ai.compaction.done') };
      }
      const saved = item.before.used - item.after.used;
      return saved > 0
        ? { tone: 'done', text: words.translate('ai.compaction.saved', { tokens: formatTokens(saved, words.formatNumber) }) }
        : { tone: 'done', text: words.translate('ai.compaction.done') };
    }
    case 'failed':
      return { tone: 'failed', text: words.translate('ai.compaction.failed'), detail: item.error };
    case 'cancelled':
      return { tone: 'stopped', text: words.translate('ai.compaction.stopped') };
    default: {
      const exhaustive: never = item.status;
      return exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Background work that has finished
// ---------------------------------------------------------------------------

/** A background task that has ended, for the tray's "finished" list. */
export interface FinishedTask {
  readonly call: string;
  readonly title: string;
  readonly kind: BackgroundTask['kind'];
  readonly status: 'completed' | 'failed';
  readonly durationMs: number | undefined;
  readonly lastOutputLine: string | undefined;
}

/** Claude nests its subagent calls under `Task` (or `Agent`); Codex titles them "Start subagent …" (the reducer's rule). */
function isSubagentCall(item: ToolItem): boolean {
  return item.toolName === 'Task' || item.toolName === 'Agent' || item.title.startsWith('Start subagent');
}

function lastLineOf(output: string): string | undefined {
  const lines = output.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (line !== undefined && line !== '') {
      return line;
    }
  }
  return undefined;
}

/** The newest `limit` subagents and background commands that ended, newest first, looking back at most `scanMax` items. Bounded: a long session lists a handful. */
export function finishedTasks(items: readonly TranscriptItem[], options: { readonly limit: number; readonly scanMax: number }): readonly FinishedTask[] {
  assert(options.limit >= 0, 'finishedTasks: a non-negative limit');
  assert(options.scanMax >= 0, 'finishedTasks: a non-negative scan bound');
  const finished: FinishedTask[] = [];
  const stop = Math.max(0, items.length - options.scanMax);
  for (let index = items.length - 1; index >= stop && finished.length < options.limit; index -= 1) {
    const item = items[index];
    if (item?.kind !== 'tool' || item.parent !== undefined) {
      continue;
    }
    if (item.status !== 'completed' && item.status !== 'failed') {
      continue;
    }
    const subagent = isSubagentCall(item);
    if (!subagent && !item.background) {
      continue;
    }
    finished.push({
      call: item.call,
      title: item.command ?? item.title,
      kind: subagent ? 'subagent' : item.toolKind === 'execute' ? 'command' : 'tool',
      status: item.status,
      durationMs: toolDurationMs(item),
      lastOutputLine: lastLineOf(item.output),
    });
  }
  return finished;
}

// ---------------------------------------------------------------------------
// Long text
// ---------------------------------------------------------------------------

/** Past either bound a message is cut to a preview with "Show more". */
export const LONG_MESSAGE_LINES = 40;
export const LONG_MESSAGE_CHARS = 4000;

export function isLongMessage(text: string): boolean {
  if (text.length > LONG_MESSAGE_CHARS) {
    return true;
  }
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      lines += 1;
      if (lines > LONG_MESSAGE_LINES) {
        return true;
      }
    }
  }
  return false;
}

/** Tool output is drawn in full only on request: a preview of this many characters first. */
export const OUTPUT_PREVIEW_CHARS = 6000;

export interface ClampedOutput {
  readonly text: string;
  /** Characters left out; zero when the whole output fits. */
  readonly hidden: number;
}

/** A command's log is read from its end (what it just printed); a file or a search result from its start. */
export function clampOutput(output: string, options: { readonly from: 'start' | 'end'; readonly limit: number }): ClampedOutput {
  assert(options.limit > 0, 'clampOutput: a positive limit');
  if (output.length <= options.limit) {
    return { text: output, hidden: 0 };
  }
  const hidden = output.length - options.limit;
  return { text: options.from === 'end' ? output.slice(hidden) : output.slice(0, options.limit), hidden };
}
