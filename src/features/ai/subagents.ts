// The subagents of a chat's current run, as pure functions of the transcript: who they are, how each
// stands (running, waiting for the person, done, failed), what each is doing now, what the strip above
// the transcript shows, and the transcript of one subagent, built as an ordinary `ChatView` so the
// panel draws it with the same renderer as the chat itself.
//
// Everything is derived from tool calls and text the host already stores (chatReducer.ts): a subagent is
// a top-level Agent or Task call (Codex: a call titled "Start subagent …"), and its own work is every
// call and message that names it as `parent` (Claude's `_meta.claudeCode.parentToolUseId`). Nothing
// here reads the clock or the DOM; durations come from the host's stamps.
import { assert } from '../../../shared/core/assert';
import type { ToolKindName, TurnId } from '../../../shared/properties/ai/chatModel';
import type { ChatView, PermissionItem, ToolItem, TranscriptItem } from './chatReducer';

/**
 * Subagents the strip lists at once; older ones of the run are counted as "more". Why: an agent can start
 * dozens, and a strip taller than a handful of rows stops being a glance.
 */
export const SUBAGENTS_SHOWN_MAX = 12;

/**
 * Items one subagent's transcript holds, newest kept. Why: a long subagent can make thousands of calls;
 * its transcript, like the chat's, draws a bounded window and says nothing it cannot show.
 */
export const SUBAGENT_ITEMS_MAX = 2_000;

/** Characters of a command kept for the one-line "currently doing". */
const ACTIVITY_COMMAND_CHARS_MAX = 120;

/** How deep a request's call may sit under a subagent and still count as its own. Why: a cycle in bad data must not loop forever. */
const PARENT_DEPTH_MAX = 8;

/** How Codex titles the call that starts a subagent. */
const CODEX_SUBAGENT_PREFIX = 'Start subagent '; // i18n-ignore: the adapter's own wording, matched, never shown.

export type SubagentStatus =
  | { readonly kind: 'running'; readonly startedAt: number | undefined }
  /** A permission request of the subagent waits for the person. */
  | { readonly kind: 'waiting'; readonly startedAt: number | undefined }
  | { readonly kind: 'done'; readonly durationMs: number | undefined }
  /** It failed, or the run it belonged to was stopped before it finished. */
  | { readonly kind: 'failed'; readonly durationMs: number | undefined };

/** What the subagent did last: a call (a file it reads or edits, a command, another tool), a thought, or its words. */
export type SubagentActivity =
  | { readonly kind: 'file'; readonly verb: 'reading' | 'editing'; readonly file: string }
  | { readonly kind: 'command'; readonly command: string }
  | { readonly kind: 'tool'; readonly title: string }
  | { readonly kind: 'thinking' }
  | { readonly kind: 'writing' }
  | { readonly kind: 'starting' };

export interface Subagent {
  /** The Agent or Task call that started it: its identity in the chat. */
  readonly call: string;
  readonly turn: TurnId;
  /** Its role (Claude's `subagent_type`), when the agent said. */
  readonly role: string | undefined;
  /** What it was asked to do, in the agent's words (the call's title). */
  readonly title: string;
  readonly status: SubagentStatus;
  readonly activity: SubagentActivity;
}

export interface SubagentList {
  /** The newest `SUBAGENTS_SHOWN_MAX`, in the order they started. */
  readonly agents: readonly Subagent[];
  /** How many older subagents of the run were left out. */
  readonly omitted: number;
}

/** What the strip above the transcript shows. */
export type StripState =
  | { readonly kind: 'hidden' }
  /** At least one subagent is still going: every pill is shown. */
  | { readonly kind: 'live'; readonly list: SubagentList; readonly active: number }
  /** All have finished and the strip is folded to one quiet line. */
  | { readonly kind: 'summary'; readonly finished: number; readonly failed: number }
  /** All have finished and the person opened the line again. */
  | { readonly kind: 'review'; readonly list: SubagentList; readonly finished: number; readonly failed: number };

/** Claude nests its subagent calls under `Task` (or `Agent`); Codex titles them "Start subagent …" (the reducer's rule). */
export function isSubagentCall(item: ToolItem): boolean {
  return item.toolName === 'Task' || item.toolName === 'Agent' || item.title.startsWith(CODEX_SUBAGENT_PREFIX);
}

/** The name a pill shows: the agent's description of the task, or Codex's subagent name without its prefix. */
export function subagentName(agent: Pick<Subagent, 'title'>): string {
  const title = agent.title.startsWith(CODEX_SUBAGENT_PREFIX) ? agent.title.slice(CODEX_SUBAGENT_PREFIX.length) : agent.title;
  return (title.split('\n')[0] ?? title).trim();
}

/**
 * The subagents of the current run: those of the running turn (or, while idle, of the last turn the person
 * started), plus any still open from an earlier turn. Bounded to the newest `SUBAGENTS_SHOWN_MAX`.
 */
export function deriveSubagents(view: ChatView): SubagentList {
  const facts = readFacts(view.items);
  const current = view.running ?? facts.lastUserTurn;
  const chosen: ToolItem[] = [];
  for (const call of facts.subagents) {
    if (call.turn === current || isOpen(call)) {
      chosen.push(call);
    }
  }
  const omitted = Math.max(0, chosen.length - SUBAGENTS_SHOWN_MAX);
  const shown = omitted === 0 ? chosen : chosen.slice(omitted);
  const agents = shown.map((call) => ({
    call: call.call,
    turn: call.turn,
    role: call.agentType,
    title: call.title,
    status: statusOf(call, view, facts),
    activity: activityOf(facts.lastChild.get(call.call)),
  }));
  assert(agents.length <= SUBAGENTS_SHOWN_MAX, 'deriveSubagents: bounded');
  assert(agents.length + omitted === chosen.length, 'deriveSubagents: every chosen subagent is shown or counted');
  return { agents, omitted };
}

/** The strip for a list of subagents; `open` is whether the person unfolded the summary of a finished run. */
export function stripState(list: SubagentList, options: { readonly open: boolean }): StripState {
  const total = list.agents.length + list.omitted;
  if (total === 0) {
    return { kind: 'hidden' };
  }
  const active = list.agents.filter((agent) => agent.status.kind === 'running' || agent.status.kind === 'waiting').length;
  if (active > 0) {
    return { kind: 'live', list, active };
  }
  const failed = list.agents.filter((agent) => agent.status.kind === 'failed').length;
  assert(failed <= total, 'stripState: failures are a subset');
  return options.open ? { kind: 'review', list, finished: total, failed } : { kind: 'summary', finished: total, failed };
}

/**
 * One subagent's transcript as a chat of its own: its calls and words re-rooted (they name no parent there,
 * so they draw as top-level rows and its own subagents nest under them as usual), consecutive chunks of
 * one kind joined (other speakers interleaved them), its permission requests, and the run state of the
 * subagent itself. Undefined when the chat has no such call. Bounded to the newest `SUBAGENT_ITEMS_MAX`.
 */
export function subagentView(view: ChatView, call: string): ChatView | undefined {
  const root = view.items.find((item): item is ToolItem => item.kind === 'tool' && item.call === call);
  if (root === undefined) {
    return undefined;
  }
  const children = new Set<string>();
  const own: TranscriptItem[] = [];
  for (const item of view.items) {
    if ((item.kind === 'tool' || item.kind === 'text') && item.parent === call) {
      if (item.kind === 'tool') {
        children.add(item.call);
      }
      const copy = rerooted(item);
      const last = own[own.length - 1];
      const joined = last === undefined ? undefined : joinedText(last, copy);
      if (joined === undefined) {
        own.push(copy);
      } else {
        own[own.length - 1] = joined; // Other speakers interleaved this one's chunks; here they read as one message.
      }
    } else if (item.kind === 'permission' && (item.call === call || children.has(item.call))) {
      own.push(item);
    }
  }
  const items = own.length > SUBAGENT_ITEMS_MAX ? own.slice(own.length - SUBAGENT_ITEMS_MAX) : own;
  const running = isOpen(root) && view.running !== undefined ? view.running : undefined;
  const sub: ChatView = {
    items,
    nextItemId: view.nextItemId,
    running,
    turnStartedAt: running === undefined ? undefined : root.at,
    plan: undefined,
    commands: [],
    options: [],
    usage: undefined,
    compaction: undefined,
    activeTasks: [],
    title: undefined,
    lastPrompt: undefined,
  };
  assert(sub.items.length <= SUBAGENT_ITEMS_MAX, 'subagentView: bounded');
  assert(
    sub.items.every((item) => item.kind === 'permission' || ((item.kind === 'tool' || item.kind === 'text') && item.parent === undefined)),
    'subagentView: only its own re-rooted work and its requests',
  );
  return sub;
}

/** The subagent's status for the strip, read from a list by call; undefined once it is no longer listed. */
export function findSubagent(list: SubagentList, call: string): Subagent | undefined {
  return list.agents.find((agent) => agent.call === call);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface Facts {
  /** Every top-level subagent call, in the order they started. */
  readonly subagents: readonly ToolItem[];
  /** The newest call or message naming each call as its parent. */
  readonly lastChild: ReadonlyMap<string, ToolItem | Extract<TranscriptItem, { readonly kind: 'text' }>>;
  /** The parent of each nested call. */
  readonly parentOf: ReadonlyMap<string, string>;
  readonly waiting: readonly PermissionItem[];
  readonly stops: ReadonlyMap<TurnId, Extract<TranscriptItem, { readonly kind: 'turn-end' }>['stop']>;
  readonly lastUserTurn: TurnId | undefined;
}

/** One pass over the transcript collects everything the statuses need. */
function readFacts(items: readonly TranscriptItem[]): Facts {
  const subagents: ToolItem[] = [];
  const lastChild = new Map<string, ToolItem | Extract<TranscriptItem, { readonly kind: 'text' }>>();
  const parentOf = new Map<string, string>();
  const waiting: PermissionItem[] = [];
  const stops = new Map<TurnId, Extract<TranscriptItem, { readonly kind: 'turn-end' }>['stop']>();
  let lastUserTurn: TurnId | undefined;
  for (const item of items) {
    switch (item.kind) {
      case 'tool':
        if (item.parent === undefined) {
          if (isSubagentCall(item)) {
            subagents.push(item);
          }
        } else {
          parentOf.set(item.call, item.parent);
          lastChild.set(item.parent, item);
        }
        break;
      case 'text':
        if (item.parent !== undefined) {
          lastChild.set(item.parent, item);
        }
        break;
      case 'permission':
        if (item.answer === undefined) {
          waiting.push(item);
        }
        break;
      case 'turn-end':
        stops.set(item.turn, item.stop);
        break;
      case 'user':
        lastUserTurn = item.turn;
        break;
      case 'compaction':
      case 'changes':
      case 'changes-untracked':
      case 'notice':
      case 'unsupported':
        break;
      default: {
        const exhaustive: never = item;
        return exhaustive;
      }
    }
  }
  assert(subagents.length <= items.length, 'readFacts: subagents are items');
  return { subagents, lastChild, parentOf, waiting, stops, lastUserTurn };
}

function isOpen(item: ToolItem): boolean {
  return item.status === 'pending' || item.status === 'in_progress';
}

function durationOf(item: ToolItem): number | undefined {
  if (item.at === undefined || item.endedAt === undefined || item.endedAt < item.at) {
    return undefined;
  }
  return item.endedAt - item.at;
}

function statusOf(call: ToolItem, view: ChatView, facts: Facts): SubagentStatus {
  switch (call.status) {
    case 'completed':
      return { kind: 'done', durationMs: durationOf(call) };
    case 'failed':
      return { kind: 'failed', durationMs: durationOf(call) };
    case 'pending':
    case 'in_progress': {
      const stop = facts.stops.get(call.turn);
      // A run stopped by the person or by an error takes its subagents with it, whatever their last update said.
      if (stop !== undefined && stop !== 'end_turn') {
        return { kind: 'failed', durationMs: undefined };
      }
      if (view.running !== undefined && facts.waiting.some((request) => belongsTo(request.call, call.call, facts.parentOf))) {
        return { kind: 'waiting', startedAt: call.at };
      }
      return { kind: 'running', startedAt: call.at };
    }
    default: {
      const exhaustive: never = call.status;
      return exhaustive;
    }
  }
}

/** Whether `target` is the subagent call itself or one of its own calls (nested at most `PARENT_DEPTH_MAX` deep). */
function belongsTo(target: string, subagent: string, parentOf: ReadonlyMap<string, string>): boolean {
  let current: string | undefined = target;
  for (let depth = 0; depth < PARENT_DEPTH_MAX && current !== undefined; depth += 1) {
    if (current === subagent) {
      return true;
    }
    current = parentOf.get(current);
  }
  return false;
}

function activityOf(item: ToolItem | Extract<TranscriptItem, { readonly kind: 'text' }> | undefined): SubagentActivity {
  if (item === undefined) {
    return { kind: 'starting' };
  }
  if (item.kind === 'text') {
    return item.role === 'thought' ? { kind: 'thinking' } : { kind: 'writing' };
  }
  return toolActivity(item);
}

function toolActivity(item: ToolItem): SubagentActivity {
  const verb = fileVerb(item.toolKind);
  const path = item.diffs[0]?.path ?? item.paths[0];
  if (verb !== undefined && path !== undefined && path !== '') {
    return { kind: 'file', verb, file: baseName(path) };
  }
  if (item.toolKind === 'execute') {
    const command = (item.command ?? item.title).split('\n')[0]?.trim() ?? '';
    if (command !== '') {
      return { kind: 'command', command: command.slice(0, ACTIVITY_COMMAND_CHARS_MAX) };
    }
  }
  return { kind: 'tool', title: (item.title.split('\n')[0] ?? item.title).trim() };
}

function fileVerb(kind: ToolKindName): 'reading' | 'editing' | undefined {
  switch (kind) {
    case 'read':
      return 'reading';
    case 'edit':
    case 'delete':
    case 'move':
      return 'editing';
    case 'execute':
    case 'search':
    case 'fetch':
    case 'think':
    case 'switch_mode':
    case 'other':
      return undefined;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

/**
 * Re-rooted copies, one per source item. Why: the subagent's transcript is rebuilt on every event, and
 * its rows are memoized by item identity; the same source item must give the same copy, or every row of
 * a running subagent would draw again on each streamed word.
 */
const REROOTED = new WeakMap<TranscriptItem, TranscriptItem>();

function rerooted(item: Extract<TranscriptItem, { readonly kind: 'tool' | 'text' }>): TranscriptItem {
  const known = REROOTED.get(item);
  if (known !== undefined) {
    return known;
  }
  const copy: TranscriptItem = { ...item, parent: undefined };
  REROOTED.set(item, copy);
  return copy;
}

/** The two as one message when both are text of one turn and kind; undefined when they stay apart. */
function joinedText(last: TranscriptItem, item: TranscriptItem): TranscriptItem | undefined {
  if (item.kind === 'text' && last.kind === 'text' && last.turn === item.turn && last.role === item.role) {
    return { ...last, text: last.text + item.text, until: item.until ?? last.until };
  }
  return undefined;
}
