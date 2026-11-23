// The subagents of a chat, as pure functions of the transcript: who they are (the task the coordinator
// gave each, its role, its model), how each stands (queued, running, waiting for the person, done,
// failed, stopped) and for how long, what each is doing now, the work each did (its own calls, grouped
// under it instead of interleaved in the coordinator's list), its result, what the strip above the
// transcript shows, and the transcript of one subagent, built as an ordinary `ChatView` so the panel
// draws it with the same renderer as the chat itself.
//
// Everything is derived from tool calls and text the host already stores (chatReducer.ts): a subagent is
// a top-level Agent or Task call (Codex: a call titled "Start subagent …"), a follow-up is a top-level
// SendMessage call that wakes one again, and their own work is every call and message that names them as
// `parent` (Claude's `_meta.claudeCode.parentToolUseId`), directly or through a nested call. A call that
// names a parent the transcript does not hold belongs to no unit and stays in the coordinator's list.
// Nothing here reads the clock or the DOM; durations come from the host's stamps.
import { assert } from '../../../shared/core/assert';
import type { ChatOption, ToolKindName, TurnId } from '../../../shared/properties/ai/chatModel';
import type { ChatView, PermissionItem, ToolItem, TranscriptItem } from './chatReducer';

/**
 * Subagents the strip lists at once; older ones of the run are counted as "more". Why: an agent can start
 * dozens, and a strip taller than a handful of rows stops being a glance.
 */
export const SUBAGENTS_SHOWN_MAX = 12;

/**
 * Items one subagent's transcript holds, newest kept. Why: a long subagent can make thousands of calls;
 * its transcript, like the chat's, draws a bounded window and says nothing it cannot show. The same bound
 * holds the calls grouped under one unit in the chat's transcript.
 */
export const SUBAGENT_ITEMS_MAX = 2_000;

/** Characters of a result kept for the one-line summary under a finished unit. */
export const RESULT_SUMMARY_CHARS_MAX = 240;

/** Characters of a command kept for the one-line "currently doing". */
const ACTIVITY_COMMAND_CHARS_MAX = 120;

/** How deep a call may sit under a subagent and still count as its own. Why: a cycle in bad data must not loop forever. */
const PARENT_DEPTH_MAX = 8;

/** How Codex titles the call that starts a subagent. */
const CODEX_SUBAGENT_PREFIX = 'Start subagent '; // i18n-ignore: the adapter's own wording, matched, never shown.

/** Claude's tool that sends a running or finished subagent a further message. */
const FOLLOW_UP_TOOL = 'SendMessage'; // i18n-ignore: the agent's tool name, matched, never shown.

export type SubagentStatus =
  /** Started but has reported nothing of its own yet. */
  | { readonly kind: 'queued'; readonly startedAt: number | undefined }
  | { readonly kind: 'running'; readonly startedAt: number | undefined }
  /** A permission request of the subagent waits for the person. */
  | { readonly kind: 'waiting'; readonly startedAt: number | undefined }
  | { readonly kind: 'done'; readonly durationMs: number | undefined }
  /** It failed, or the run it belonged to ended in an error. */
  | { readonly kind: 'failed'; readonly durationMs: number | undefined }
  /** The person stopped the run before it finished. */
  | { readonly kind: 'stopped'; readonly durationMs: number | undefined };

/** What the subagent did last: a call (a file it reads or edits, a command, another tool), a thought, or its words. */
export type SubagentActivity =
  | { readonly kind: 'file'; readonly verb: 'reading' | 'editing'; readonly file: string }
  | { readonly kind: 'command'; readonly command: string }
  | { readonly kind: 'tool'; readonly title: string }
  | { readonly kind: 'thinking' }
  | { readonly kind: 'writing' }
  | { readonly kind: 'starting' };

/** The model a subagent runs on: the one its call named, or the session's (Claude's Agent call without `model`). */
export type SubagentModel = { readonly kind: 'chosen'; readonly id: string } | { readonly kind: 'inherited' };

export interface Subagent {
  /** The Agent, Task or SendMessage call that started it: its identity in the chat. */
  readonly call: string;
  readonly turn: TurnId;
  /** A subagent's start, or a message that woke one again. */
  readonly kind: 'agent' | 'follow-up';
  /** Its role (Claude's `subagent_type`), when the agent said. */
  readonly role: string | undefined;
  /** What it was asked to do, in the agent's words (the call's title). */
  readonly title: string;
  readonly model: SubagentModel;
  readonly status: SubagentStatus;
  readonly activity: SubagentActivity;
  /** The report it handed back, once it finished; undefined while it works or when it said nothing. */
  readonly result: string | undefined;
}

/** A subagent with the calls it made (nested calls included), in the order they were made, newest `SUBAGENT_ITEMS_MAX`. */
export interface SubagentUnit {
  readonly agent: Subagent;
  readonly children: readonly ToolItem[];
  /** How many older calls were left out of `children`. */
  readonly omitted: number;
}

/** Every subagent of the chat, by call, and which unit each grouped call belongs to. */
export interface SubagentWork {
  readonly units: ReadonlyMap<string, SubagentUnit>;
  /** The unit call of every call grouped under one; a call missing here belongs to the coordinator. */
  readonly unitOf: ReadonlyMap<string, string>;
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
  /** At least one subagent is still going: every row is shown. */
  | { readonly kind: 'live'; readonly list: SubagentList; readonly active: number }
  /** All have finished and the strip is folded to one quiet line. */
  | { readonly kind: 'summary'; readonly finished: number; readonly failed: number }
  /** All have finished and the person opened the line again. */
  | { readonly kind: 'review'; readonly list: SubagentList; readonly finished: number; readonly failed: number };

/** Claude nests its subagent calls under `Task` (or `Agent`); Codex titles them "Start subagent …" (the reducer's rule). */
export function isSubagentCall(item: ToolItem): boolean {
  return item.toolName === 'Task' || item.toolName === 'Agent' || item.title.startsWith(CODEX_SUBAGENT_PREFIX);
}

/** A top-level call drawn as a subagent unit: a subagent's start, or a follow-up message to one. */
export function isUnitCall(item: ToolItem): boolean {
  return item.parent === undefined && (isSubagentCall(item) || item.toolName === FOLLOW_UP_TOOL);
}

/** Whether the subagent is still at work (queued, running or waiting for the person). */
export function isWorking(status: SubagentStatus): boolean {
  return status.kind === 'queued' || status.kind === 'running' || status.kind === 'waiting';
}

/**
 * The name a row shows: the agent's description of the task, or Codex's subagent name without its prefix.
 * Empty for a follow-up the agent titled with the bare tool name; the row then says "Follow-up" itself.
 */
export function subagentName(agent: Pick<Subagent, 'title'>): string {
  const title = agent.title.startsWith(CODEX_SUBAGENT_PREFIX) ? agent.title.slice(CODEX_SUBAGENT_PREFIX.length) : agent.title;
  const line = (title.split('\n')[0] ?? title).trim();
  return line === FOLLOW_UP_TOOL ? '' : line;
}

/** The name of the session's current model, from the agent's model option (`id` `model`); undefined when it reported none. */
export function sessionModelName(options: readonly ChatOption[]): string | undefined {
  const option = options.find((candidate) => candidate.id === 'model' || candidate.category === 'model');
  const choice = option?.choices.find((candidate) => candidate.value === option.currentValue);
  if (choice === undefined) {
    return undefined;
  }
  // Claude's "Default" entry names the model it resolves to in its description.
  return choice.value === 'default' && choice.description !== undefined && choice.description !== '' ? choice.description : choice.name;
}

/**
 * The display name of a model a subagent's call chose (`sonnet`): the session's own name for that model when its
 * model option lists one (`Sonnet 4.6`), else the id with a capital (`Sonnet`).
 */
export function chosenModelName(id: string, options: readonly ChatOption[]): string {
  assert(id !== '', 'chosenModelName: a model id');
  const wanted = id.toLowerCase();
  const choices = options.find((candidate) => candidate.id === 'model' || candidate.category === 'model')?.choices ?? [];
  const exact = choices.find((choice) => choice.value.toLowerCase() === wanted);
  const named = exact ?? choices.find((choice) => choice.value.toLowerCase().startsWith(wanted) || choice.name.toLowerCase().includes(wanted));
  const name = named?.name ?? `${id.charAt(0).toUpperCase()}${id.slice(1)}`;
  assert(name !== '', 'chosenModelName: a name');
  return name;
}

/**
 * Every subagent unit of the chat with its own calls. `previous` is the last call's answer: a unit whose
 * subagent and calls are unchanged is returned as the same object, so its row is not drawn again while
 * another subagent streams.
 */
export function deriveSubagentWork(view: ChatView, previous?: SubagentWork): SubagentWork {
  const facts = readFacts(view.items);
  const units = new Map<string, SubagentUnit>();
  for (const call of facts.units) {
    const all = facts.children.get(call.call) ?? [];
    const omitted = Math.max(0, all.length - SUBAGENT_ITEMS_MAX);
    const children = omitted === 0 ? all : all.slice(omitted);
    const agent: Subagent = {
      call: call.call,
      turn: call.turn,
      kind: isSubagentCall(call) ? 'agent' : 'follow-up',
      role: call.agentType,
      title: call.title,
      model: call.agentModel === undefined ? { kind: 'inherited' } : { kind: 'chosen', id: call.agentModel },
      status: statusOf(call, view, facts),
      activity: activityOf(facts.lastChild.get(call.call)),
      result: resultOf(call),
    };
    const before = previous?.units.get(call.call);
    const unit = before !== undefined && sameUnit(before, agent, children, omitted) ? before : { agent, children, omitted };
    assert(unit.children.length <= SUBAGENT_ITEMS_MAX, 'deriveSubagentWork: a unit’s calls are bounded');
    units.set(call.call, unit);
  }
  assert(units.size === facts.units.length, 'deriveSubagentWork: one unit per unit call');
  return { units, unitOf: facts.unitOf };
}

/**
 * The subagents of the current run: those of the running turn (or, while idle, of the last turn the person
 * started), plus any still at work from an earlier turn. Bounded to the newest `SUBAGENTS_SHOWN_MAX`.
 */
export function deriveSubagents(view: ChatView, work?: SubagentWork): SubagentList {
  const all = work ?? deriveSubagentWork(view);
  const current = view.running ?? lastUserTurn(view.items);
  const chosen: Subagent[] = [];
  for (const unit of all.units.values()) {
    if (unit.agent.turn === current || isWorking(unit.agent.status)) {
      chosen.push(unit.agent);
    }
  }
  const omitted = Math.max(0, chosen.length - SUBAGENTS_SHOWN_MAX);
  const agents = omitted === 0 ? chosen : chosen.slice(omitted);
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
  const active = list.agents.filter((agent) => isWorking(agent.status)).length;
  if (active > 0) {
    return { kind: 'live', list, active };
  }
  const failed = list.agents.filter((agent) => agent.status.kind === 'failed').length;
  assert(failed <= total, 'stripState: failures are a subset');
  return options.open ? { kind: 'review', list, finished: total, failed } : { kind: 'summary', finished: total, failed };
}

/** The first paragraph of a result, on one line, cut to `RESULT_SUMMARY_CHARS_MAX`; undefined for an empty one. */
export function resultSummary(result: string | undefined): string | undefined {
  if (result === undefined) {
    return undefined;
  }
  const paragraph = result
    .split(/\n\s*\n/u)
    .map((part) => part.replace(/\s+/gu, ' ').trim())
    .find((part) => part !== '');
  if (paragraph === undefined) {
    return undefined;
  }
  const summary = paragraph.length <= RESULT_SUMMARY_CHARS_MAX ? paragraph : `${paragraph.slice(0, RESULT_SUMMARY_CHARS_MAX - 1)}…`;
  assert(summary.length <= RESULT_SUMMARY_CHARS_MAX, 'resultSummary: bounded');
  return summary;
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
    options: view.options,
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

type TextItem = Extract<TranscriptItem, { readonly kind: 'text' }>;

interface Facts {
  /** Every top-level unit call, in the order they started. */
  readonly units: readonly ToolItem[];
  /** The calls grouped under each unit, in order. */
  readonly children: ReadonlyMap<string, readonly ToolItem[]>;
  readonly unitOf: ReadonlyMap<string, string>;
  /** The newest call or message naming each call as its direct parent. */
  readonly lastChild: ReadonlyMap<string, ToolItem | TextItem>;
  /** The latest stamp of anything grouped under each unit. */
  readonly lastStamp: ReadonlyMap<string, number>;
  /** Whether any call grouped under each unit is still open. */
  readonly openChild: ReadonlySet<string>;
  readonly parentOf: ReadonlyMap<string, string>;
  readonly waiting: readonly PermissionItem[];
  readonly stops: ReadonlyMap<TurnId, Extract<TranscriptItem, { readonly kind: 'turn-end' }>['stop']>;
}

function lastUserTurn(items: readonly TranscriptItem[]): TurnId | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === 'user') {
      return item.turn;
    }
  }
  return undefined;
}

/** Two passes over the transcript: the first learns every call's parent, the second groups each call under its unit. */
function readFacts(items: readonly TranscriptItem[]): Facts {
  const units: ToolItem[] = [];
  const unitCalls = new Set<string>();
  const parentOf = new Map<string, string>();
  const waiting: PermissionItem[] = [];
  const stops = new Map<TurnId, Extract<TranscriptItem, { readonly kind: 'turn-end' }>['stop']>();
  for (const item of items) {
    if (item.kind === 'tool') {
      if (item.parent === undefined) {
        if (isUnitCall(item)) {
          units.push(item);
          unitCalls.add(item.call);
        }
      } else {
        parentOf.set(item.call, item.parent);
      }
    } else if (item.kind === 'permission' && item.answer === undefined) {
      waiting.push(item);
    } else if (item.kind === 'turn-end') {
      stops.set(item.turn, item.stop);
    }
  }
  const children = new Map<string, ToolItem[]>();
  const unitOf = new Map<string, string>();
  const lastChild = new Map<string, ToolItem | TextItem>();
  const lastStamp = new Map<string, number>();
  const openChild = new Set<string>();
  for (const item of items) {
    if ((item.kind !== 'tool' && item.kind !== 'text') || item.parent === undefined) {
      continue;
    }
    lastChild.set(item.parent, item);
    const unit = unitAbove(item.parent, unitCalls, parentOf);
    if (unit === undefined) {
      continue; // A parent the transcript does not hold: the call stays the coordinator's.
    }
    const stamp = item.kind === 'tool' ? (item.endedAt ?? item.at) : (item.until ?? item.at);
    if (stamp !== undefined) {
      lastStamp.set(unit, Math.max(stamp, lastStamp.get(unit) ?? stamp));
    }
    if (item.kind === 'tool') {
      unitOf.set(item.call, unit);
      const list = children.get(unit) ?? [];
      list.push(item);
      children.set(unit, list);
      if (isOpen(item)) {
        openChild.add(unit);
      }
    }
  }
  assert(units.length <= items.length, 'readFacts: units are items');
  assert(unitOf.size <= items.length, 'readFacts: grouped calls are items');
  return { units, children, unitOf, lastChild, lastStamp, openChild, parentOf, waiting, stops };
}

/** The unit call at the top of `call`'s chain of parents (at most `PARENT_DEPTH_MAX` deep), or undefined. */
function unitAbove(call: string, unitCalls: ReadonlySet<string>, parentOf: ReadonlyMap<string, string>): string | undefined {
  let current: string | undefined = call;
  for (let depth = 0; depth < PARENT_DEPTH_MAX && current !== undefined; depth += 1) {
    if (unitCalls.has(current)) {
      return current;
    }
    current = parentOf.get(current);
  }
  return undefined;
}

function isOpen(item: ToolItem): boolean {
  return item.status === 'pending' || item.status === 'in_progress';
}

/**
 * From the call's start to the last thing it or its own work reported. Why not the call's own end: a
 * subagent started in the background returns its call within seconds and works on for minutes.
 */
function durationOf(call: ToolItem, facts: Facts): number | undefined {
  if (call.at === undefined) {
    return undefined;
  }
  const ends = [call.endedAt, facts.lastStamp.get(call.call)].filter((stamp): stamp is number => stamp !== undefined);
  if (ends.length === 0) {
    return undefined;
  }
  const end = Math.max(...ends);
  return end < call.at ? undefined : end - call.at;
}

function statusOf(call: ToolItem, view: ChatView, facts: Facts): SubagentStatus {
  const stop = facts.stops.get(call.turn);
  const stopped = stop === 'cancelled';
  switch (call.status) {
    case 'completed':
      // A subagent started in the background returns its call at once and works on under it.
      if (call.background && (facts.openChild.has(call.call) || view.running !== undefined)) {
        return liveStatus(call, view, facts);
      }
      return { kind: 'done', durationMs: durationOf(call, facts) };
    case 'failed':
      return stopped ? { kind: 'stopped', durationMs: durationOf(call, facts) } : { kind: 'failed', durationMs: durationOf(call, facts) };
    case 'pending':
    case 'in_progress': {
      // A run stopped by the person or by an error takes its subagents with it, whatever their last update said.
      if (stopped) {
        return { kind: 'stopped', durationMs: durationOf(call, facts) };
      }
      if (stop !== undefined && stop !== 'end_turn') {
        return { kind: 'failed', durationMs: durationOf(call, facts) };
      }
      return liveStatus(call, view, facts);
    }
    default: {
      const exhaustive: never = call.status;
      return exhaustive;
    }
  }
}

function liveStatus(call: ToolItem, view: ChatView, facts: Facts): SubagentStatus {
  if (view.running !== undefined && facts.waiting.some((request) => belongsTo(request.call, call.call, facts.parentOf))) {
    return { kind: 'waiting', startedAt: call.at };
  }
  if (call.status === 'pending' && !facts.lastChild.has(call.call)) {
    return { kind: 'queued', startedAt: call.at };
  }
  return { kind: 'running', startedAt: call.at };
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

/** The report the subagent's finishing update carried (what its call showed while it ran, its prompt, is left out). */
function resultOf(call: ToolItem): string | undefined {
  if (call.resultFrom === undefined) {
    return undefined;
  }
  const result = call.output.slice(call.resultFrom).trim();
  return result === '' ? undefined : result;
}

function activityOf(item: ToolItem | TextItem | undefined): SubagentActivity {
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

/** The unit as it was, when nothing it shows has changed. */
function sameUnit(before: SubagentUnit, agent: Subagent, children: readonly ToolItem[], omitted: number): boolean {
  if (before.omitted !== omitted || before.children.length !== children.length) {
    return false;
  }
  if (!before.children.every((child, index) => child === children[index])) {
    return false;
  }
  const was = before.agent;
  return (
    was.title === agent.title &&
    was.role === agent.role &&
    was.kind === agent.kind &&
    was.result === agent.result &&
    JSON.stringify([was.model, was.status, was.activity]) === JSON.stringify([agent.model, agent.status, agent.activity])
  );
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
