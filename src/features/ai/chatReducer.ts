// A chat's transcript as the panel draws it, folded from the same events the
// main process stores (shared/properties/ai/chatModel.ts). Pure, so a chat
// replayed from disk and one streaming live reach the same view, and so the
// fold can be property-tested (test/renderer/ai/chatReducer.test.js): applying
// events one at a time equals applying them as one batch; a tool call is one
// item however many updates it gets; streamed text is never lost or reordered;
// item ids only ever grow; a compaction is one item however often it is reported.
//
// Time is never read here: every duration comes from the `at` stamps the main
// process puts on events, so the fold stays a function of its input and a chat
// stored before timings simply shows no durations.
import { assert } from '../../../shared/core/assert';
import type { MessageRef } from '../../../shared/core/i18n/messageReference';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';
import type {
  ChatAttachmentName,
  ChatCommand,
  ChatContext,
  ChatDiff,
  ChatEvent,
  ChatFileChange,
  ChatOption,
  CompactionStatus,
  PermissionRequestId,
  SentPart,
  ToolKindName,
  ToolStatusName,
  TurnId,
  TurnStop,
  UserSendMode,
  UntrackedReason,
} from '../../../shared/properties/ai/chatModel';

export interface ToolItem {
  readonly kind: 'tool';
  /** Position in the order items were added; strictly increasing, never reused. */
  readonly id: number;
  readonly turn: TurnId;
  readonly call: string;
  readonly title: string;
  readonly toolKind: ToolKindName;
  readonly status: ToolStatusName;
  readonly paths: readonly string[];
  readonly diffs: readonly ChatDiff[];
  readonly output: string;
  readonly exitCode: number | undefined;
  readonly parent: string | undefined;
  /** When the host first heard of the call; undefined in chats stored before timings. */
  readonly at: number | undefined;
  /** When the call completed or failed; undefined while it runs and in chats stored before timings. */
  readonly endedAt: number | undefined;
  /** The agent's own name for the tool (Claude's `Bash`, `Task`), when it said. */
  readonly toolName: string | undefined;
  readonly command: string | undefined;
  /** The call was started in the background (Claude's `run_in_background`). */
  readonly background: boolean;
}

export interface PermissionItem {
  readonly kind: 'permission';
  readonly id: number;
  readonly turn: TurnId;
  readonly request: PermissionRequestId;
  readonly call: string;
  readonly title: string;
  readonly options: Extract<ChatEvent, { readonly kind: 'permission' }>['options'];
  readonly answer: { readonly outcome: 'selected' | 'cancelled'; readonly optionId: string | undefined } | undefined;
}

/** A compaction of the agent's context, reported by the agent or derived from its "Compact conversation" call. */
export interface CompactionItem {
  readonly kind: 'compaction';
  readonly id: number;
  readonly turn: TurnId | undefined;
  /** The agent's compaction id (or the tool call's id); one item per id, however often it is reported. */
  readonly compactionId: string;
  readonly status: CompactionStatus;
  readonly at: number;
  /** Context usage when the compaction began, and the first usage report after it completed: derived, so absent when the agent reported none. */
  readonly before: ChatContext | undefined;
  readonly after: ChatContext | undefined;
  /** Why it failed, when the agent said. */
  readonly error: string | undefined;
}

export type TranscriptItem =
  | {
      readonly kind: 'user';
      readonly id: number;
      readonly turn: TurnId;
      readonly text: string;
      readonly attachments: readonly ChatAttachmentName[];
      readonly at: number;
      /** The mentions the message was made of; `text` stays the plain fallback. */
      readonly parts: readonly SentPart[] | undefined;
      readonly mode: UserSendMode | undefined;
    }
  | {
      readonly kind: 'text';
      readonly id: number;
      readonly turn: TurnId;
      readonly role: 'agent' | 'thought';
      readonly text: string;
      /** First and last chunk's arrival; undefined in chats stored before timings, which show no duration. */
      readonly at: number | undefined;
      readonly until: number | undefined;
    }
  | ToolItem
  | PermissionItem
  | CompactionItem
  | { readonly kind: 'changes'; readonly id: number; readonly turn: TurnId; readonly files: readonly ChatFileChange[] }
  | { readonly kind: 'changes-untracked'; readonly id: number; readonly turn: TurnId; readonly reason: UntrackedReason }
  | {
      readonly kind: 'notice';
      readonly id: number;
      readonly severity: 'info' | 'warning' | 'error' | 'sign-in';
      readonly text: string;
      readonly textRef: MessageRef | undefined;
    }
  | {
      readonly kind: 'turn-end';
      readonly id: number;
      readonly turn: TurnId;
      readonly stop: TurnStop;
      readonly message: string | undefined;
      readonly at: number;
      /** When the turn began, when this view saw it begin. */
      readonly startedAt: number | undefined;
    }
  | { readonly kind: 'unsupported'; readonly id: number; readonly label: string; readonly labelRef: MessageRef | undefined };

/**
 * Work the agent still has going, derived from tool calls (the protocol's background-task data is sent only
 * to JetBrains AIR clients, which Stacki does not impersonate): a subagent that has not finished, a command
 * started in the background, or any call still open after its turn ended.
 */
export interface BackgroundTask {
  readonly call: string;
  readonly turn: TurnId;
  readonly title: string;
  readonly kind: 'command' | 'subagent' | 'tool';
  readonly startedAt: number | undefined;
  /** The last non-empty line the call has printed, for the tray's peek. */
  readonly lastOutputLine: string | undefined;
}

export interface ChatView {
  readonly items: readonly TranscriptItem[];
  /** The id the next item gets. */
  readonly nextItemId: number;
  /** The running turn; undefined while the chat waits for the person. */
  readonly running: TurnId | undefined;
  /** When the running turn began; undefined while idle and for a turn this view did not see begin. */
  readonly turnStartedAt: number | undefined;
  readonly plan: { readonly turn: TurnId; readonly entries: Extract<ChatEvent, { readonly kind: 'plan' }>['entries'] } | undefined;
  readonly commands: readonly ChatCommand[];
  readonly options: readonly ChatOption[];
  readonly usage: { readonly used: number; readonly size: number } | undefined;
  /** The latest compaction's state; undefined when the chat has none. */
  readonly compaction: { readonly id: string; readonly status: CompactionStatus; readonly at: number } | undefined;
  readonly activeTasks: readonly BackgroundTask[];
  readonly title: string | undefined;
  /** The last prompt the person sent, for Retry. */
  readonly lastPrompt: { readonly turn: TurnId; readonly text: string } | undefined;
}

export const EMPTY_CHAT: ChatView = {
  items: [],
  nextItemId: 0,
  running: undefined,
  turnStartedAt: undefined,
  plan: undefined,
  commands: [],
  options: [],
  usage: undefined,
  compaction: undefined,
  activeTasks: [],
  title: undefined,
  lastPrompt: undefined,
};

export function reduceChat(view: ChatView, events: readonly ChatEvent[]): ChatView {
  let next = view;
  for (const event of events) {
    next = applyEvent(next, event);
  }
  assert(next.items.length <= AI_LIMITS.chatEventsMax, 'reduceChat: the transcript is bounded');
  assert(next.items.length >= view.items.length, 'reduceChat: items are only ever added');
  assert(next.nextItemId >= view.nextItemId, 'reduceChat: item ids only grow');
  return next;
}

export function applyEvent(view: ChatView, event: ChatEvent): ChatView {
  switch (event.kind) {
    case 'user':
      return {
        ...push(view, (id) => ({
          kind: 'user',
          id,
          turn: event.turn,
          text: event.text,
          attachments: event.attachments,
          at: event.at,
          parts: event.parts,
          mode: event.mode,
        })),
        lastPrompt: { turn: event.turn, text: event.text },
      };
    case 'text':
      return appendText(view, event);
    case 'tool':
      return withTasks(applyTool(view, event));
    case 'plan':
      return { ...view, plan: { turn: event.turn, entries: event.entries } };
    case 'commands':
      return { ...view, commands: event.commands };
    case 'options':
      return { ...view, options: event.options };
    case 'usage':
      return applyUsage(view, { used: event.used, size: event.size });
    case 'title':
      return { ...view, title: event.title };
    case 'permission':
      return push(view, (id) => ({
        kind: 'permission',
        id,
        turn: event.turn,
        request: event.request,
        call: event.call,
        title: event.title,
        options: event.options,
        answer: undefined,
      }));
    case 'permission-answered':
      return mapItems(view, (item) =>
        item.kind === 'permission' && item.request === event.request ? { ...item, answer: { outcome: event.outcome, optionId: event.optionId } } : item,
      );
    case 'turn-start':
      return { ...view, running: event.turn, turnStartedAt: event.at };
    case 'turn-end': {
      const ending = view.running === event.turn;
      const ended = push(view, (id) => ({
        kind: 'turn-end',
        id,
        turn: event.turn,
        stop: event.stop,
        message: event.message,
        at: event.at,
        startedAt: ending ? view.turnStartedAt : undefined,
      }));
      return withTasks({
        ...ended,
        running: ending ? undefined : view.running,
        turnStartedAt: ending ? undefined : view.turnStartedAt,
      });
    }
    case 'changes':
      return push(view, (id) => ({ kind: 'changes', id, turn: event.turn, files: event.files }));
    case 'changes-untracked':
      return push(view, (id) => ({ kind: 'changes-untracked', id, turn: event.turn, reason: event.reason }));
    case 'review':
      return mapItems(view, (item) =>
        item.kind === 'changes' && item.turn === event.turn
          ? { ...item, files: item.files.map((file) => (file.path === event.path ? { ...file, review: event.review } : file)) }
          : item,
      );
    case 'notice':
      return push(view, (id) => ({ kind: 'notice', id, severity: event.severity, text: event.text, textRef: event.textRef }));
    case 'compaction':
      return applyCompaction(view, event);
    case 'unsupported': {
      const last = view.items[view.items.length - 1];
      return last?.kind === 'unsupported' && last.label === event.label
        ? view
        : push(view, (id) => ({ kind: 'unsupported', id, label: event.label, labelRef: event.labelRef }));
    }
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/** Requests in the transcript still waiting on the person. */
export function waitingPermissions(view: ChatView): readonly PermissionItem[] {
  const waiting = view.items.filter((item): item is PermissionItem => item.kind === 'permission' && item.answer === undefined);
  assert(waiting.length <= view.items.length, 'waitingPermissions: a subset of the items');
  return view.running === undefined ? [] : waiting;
}

/** The changes of every turn still waiting for Keep or Undo. */
export function pendingChanges(view: ChatView): number {
  let pending = 0;
  for (const item of view.items) {
    if (item.kind === 'changes') {
      pending += item.files.filter((file) => file.review === 'pending').length;
    }
  }
  assert(pending >= 0, 'pendingChanges: a count');
  return pending;
}

function push(view: ChatView, build: (id: number) => TranscriptItem): ChatView {
  if (view.items.length >= AI_LIMITS.chatEventsMax) {
    return view; // The store refuses events past this bound too; the view never outgrows it.
  }
  const item = build(view.nextItemId);
  assert(item.id === view.nextItemId, 'push: an item takes the id it was offered');
  return { ...view, items: [...view.items, item], nextItemId: view.nextItemId + 1 };
}

function mapItems(view: ChatView, change: (item: TranscriptItem) => TranscriptItem): ChatView {
  return { ...view, items: view.items.map(change) };
}

function appendText(view: ChatView, event: Extract<ChatEvent, { readonly kind: 'text' }>): ChatView {
  const last = view.items[view.items.length - 1];
  // The last chunk's stamp, else the first's: a chat stored before timings has neither and stays without.
  const stamp = event.until ?? event.at;
  if (last?.kind === 'text' && last.turn === event.turn && last.role === event.role) {
    const items = [...view.items];
    items[items.length - 1] = { ...last, text: last.text + event.text, at: last.at ?? event.at, until: stamp ?? last.until };
    return { ...view, items };
  }
  return push(view, (id) => ({ kind: 'text', id, turn: event.turn, role: event.role, text: event.text, at: event.at, until: stamp }));
}

function isFinished(status: ToolStatusName): boolean {
  return status === 'completed' || status === 'failed';
}

/** The stored title of a call the agent did not name; the transcript shows a translated stand-in for it. */
export const UNNAMED_TOOL_TITLE = 'Tool'; // i18n-ignore: stored data, shown translated by ToolCard.

function applyTool(view: ChatView, event: Extract<ChatEvent, { readonly kind: 'tool' }>): ChatView {
  const index = view.items.findIndex((item) => item.kind === 'tool' && item.call === event.call);
  const existing = index === -1 ? undefined : view.items[index];
  if (existing === undefined || existing.kind !== 'tool') {
    const status = event.status ?? 'pending';
    return push(view, (id) => ({
      kind: 'tool',
      id,
      turn: event.turn,
      call: event.call,
      title: event.title ?? UNNAMED_TOOL_TITLE,
      toolKind: event.toolKind ?? 'other',
      status,
      paths: event.paths ?? [],
      diffs: event.diffs ?? [],
      output: event.output ?? '',
      exitCode: event.exitCode,
      parent: event.parent,
      at: event.at,
      endedAt: isFinished(status) ? event.at : undefined,
      toolName: event.toolName,
      command: event.command,
      background: event.background ?? false,
    }));
  }
  const status = event.status ?? existing.status;
  const merged: ToolItem = {
    ...existing,
    title: event.title ?? existing.title,
    toolKind: event.toolKind ?? existing.toolKind,
    status,
    paths: event.paths ?? existing.paths,
    diffs: event.diffs ?? existing.diffs,
    output: event.output === undefined ? existing.output : (existing.output + event.output).slice(-AI_LIMITS.toolOutputCharsMax),
    exitCode: event.exitCode ?? existing.exitCode,
    parent: event.parent ?? existing.parent,
    at: existing.at ?? event.at,
    // The first time the call is seen finished: a later duplicate update does not move the end.
    endedAt: existing.endedAt ?? (isFinished(status) ? event.at : undefined),
    toolName: event.toolName ?? existing.toolName,
    command: event.command ?? existing.command,
    background: event.background ?? existing.background,
  };
  const items = [...view.items];
  items[index] = merged;
  return { ...view, items };
}

function applyUsage(view: ChatView, usage: ChatContext): ChatView {
  const next: ChatView = { ...view, usage };
  // The first report after a completed compaction is how much context is left: derived, never invented.
  const index = lastCompactionIndex(view.items);
  const compaction = index === -1 ? undefined : view.items[index];
  if (compaction?.kind === 'compaction' && compaction.status === 'completed' && compaction.after === undefined) {
    const items = [...view.items];
    items[index] = { ...compaction, after: usage };
    return { ...next, items };
  }
  return next;
}

function lastCompactionIndex(items: readonly TranscriptItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.kind === 'compaction') {
      return index;
    }
  }
  return -1;
}

function applyCompaction(view: ChatView, event: Extract<ChatEvent, { readonly kind: 'compaction' }>): ChatView {
  const index = view.items.findIndex((item) => item.kind === 'compaction' && item.compactionId === event.id);
  const existing = index === -1 ? undefined : view.items[index];
  if (existing === undefined || existing.kind !== 'compaction') {
    const known = view.items.filter((item) => item.kind === 'compaction').length;
    if (known >= AI_LIMITS.compactionsMax) {
      return view; // Bounded like every collection; a runaway agent cannot grow the transcript with rows.
    }
    return withCompaction(
      push(view, (id) => ({
        kind: 'compaction',
        id,
        turn: event.turn,
        compactionId: event.id,
        status: event.status,
        at: event.at,
        before: view.usage,
        after: undefined,
        error: event.error,
      })),
    );
  }
  // Only in_progress moves on: a repeated or late report must not undo a finished compaction.
  if (existing.status !== 'in_progress' || existing.status === event.status) {
    return view;
  }
  const items = [...view.items];
  items[index] = { ...existing, status: event.status, error: event.error };
  return withCompaction({ ...view, items });
}

function withCompaction(view: ChatView): ChatView {
  const index = lastCompactionIndex(view.items);
  const latest = index === -1 ? undefined : view.items[index];
  if (latest?.kind !== 'compaction') {
    return view;
  }
  const same = view.compaction?.id === latest.compactionId && view.compaction.status === latest.status && view.compaction.at === latest.at;
  return same ? view : { ...view, compaction: { id: latest.compactionId, status: latest.status, at: latest.at } };
}

// ---------------------------------------------------------------------------
// Background tasks
// ---------------------------------------------------------------------------

/** Claude nests its subagent calls under `Task` (or `Agent`); Codex titles them "Start subagent …". */
function isSubagent(item: ToolItem): boolean {
  return item.toolName === 'Task' || item.toolName === 'Agent' || item.title.startsWith('Start subagent');
}

function lastLine(output: string): string | undefined {
  const lines = output.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (line !== undefined && line !== '') {
      return line.slice(0, AI_LIMITS.labelCharsMax);
    }
  }
  return undefined;
}

/**
 * The tasks the items imply. A call counts while it is open (pending or in progress), is not a child of
 * another call, and is a subagent, was started in the background, or outlived its turn.
 */
export function deriveTasks(items: readonly TranscriptItem[]): readonly BackgroundTask[] {
  const endedTurns = new Set<TurnId>();
  for (const item of items) {
    if (item.kind === 'turn-end') {
      endedTurns.add(item.turn);
    }
  }
  const tasks: BackgroundTask[] = [];
  for (const item of items) {
    if (item.kind !== 'tool' || item.parent !== undefined || isFinished(item.status)) {
      continue;
    }
    const subagent = isSubagent(item);
    if (!subagent && !item.background && !endedTurns.has(item.turn)) {
      continue;
    }
    if (tasks.length >= AI_LIMITS.backgroundTasksMax) {
      break;
    }
    const kind = subagent ? 'subagent' : item.toolKind === 'execute' ? 'command' : 'tool';
    tasks.push({ call: item.call, turn: item.turn, title: item.title, kind, startedAt: item.at, lastOutputLine: lastLine(item.output) });
  }
  assert(tasks.length <= AI_LIMITS.backgroundTasksMax, 'deriveTasks: bounded');
  return tasks;
}

function sameTask(left: BackgroundTask, right: BackgroundTask): boolean {
  return (
    left.call === right.call &&
    left.turn === right.turn &&
    left.title === right.title &&
    left.kind === right.kind &&
    left.startedAt === right.startedAt &&
    left.lastOutputLine === right.lastOutputLine
  );
}

/** Recomputes `activeTasks`, keeping the previous array (and its task objects) when nothing changed so memoized rows hold. */
function withTasks(view: ChatView): ChatView {
  const derived = deriveTasks(view.items);
  const previous = view.activeTasks;
  if (derived.length === previous.length && derived.every((task, index) => sameTask(task, previous[index] ?? task) && previous[index] !== undefined)) {
    return view;
  }
  const reused = derived.map((task) => previous.find((old) => sameTask(old, task)) ?? task);
  return { ...view, activeTasks: reused };
}
