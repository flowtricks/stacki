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
import { withoutPinNumber } from '../../../shared/properties/ai/commentPinBrief';
import { plainWords, withoutInternalMarkup } from './internalText';
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
  /**
   * At work as far as the transcript can tell. `end`: `own` when the call returns with its result, so its end is seen;
   * `reply` for an agent sent to the background, whose end no event reports: only the end of the reply proves it.
   */
  | { readonly kind: 'running'; readonly startedAt: number | undefined; readonly end: 'own' | 'reply' }
  /** Codex says it started a subagent and nothing after that: whether it still works or has finished is not known. */
  | { readonly kind: 'unreported' }
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
  /** The report it handed back, once it finished; undefined while it works or when it said nothing, and always for a follow-up. */
  readonly result: string | undefined;
  /** A follow-up: what the coordinator told the agent, in its words; undefined for an agent's start or an old chat. */
  readonly message: string | undefined;
  /** A follow-up: the title of the agent it went to, when the transcript holds that agent. */
  readonly target: string | undefined;
  /** A follow-up: whether it reached the agent; undefined for an agent's start. */
  readonly delivery: FollowUpDelivery | undefined;
}

/** `pending` until the call returns, then `sent`, or `failed` when the call failed or its reply says it did not succeed or cannot be read. */
export type FollowUpDelivery = 'pending' | 'sent' | 'failed';

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
  /** The turn each unit last reported or was woken in. */
  readonly activeIn: ReadonlyMap<string, TurnId>;
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
  | { readonly kind: 'live'; readonly list: SubagentList; readonly active: number; readonly tally: SubagentTally }
  /** None is still going: the strip is folded to one quiet line. */
  | { readonly kind: 'summary'; readonly tally: SubagentTally }
  /** None is still going and the person opened the line again. */
  | { readonly kind: 'review'; readonly list: SubagentList; readonly tally: SubagentTally };

/** How many of the listed agents stand each way; `active` of `StripState` is working, waiting to start and needing the person. */
export interface SubagentTally {
  readonly working: number;
  readonly queued: number;
  readonly waiting: number;
  readonly done: number;
  readonly failed: number;
  readonly stopped: number;
  /** Started, with no word since (Codex). */
  readonly unreported: number;
}

export function tallyOf(list: SubagentList): SubagentTally {
  const count = (kind: SubagentStatus['kind']): number => list.agents.filter((agent) => agent.status.kind === kind).length;
  const tally = {
    working: count('running'),
    queued: count('queued'),
    waiting: count('waiting'),
    // Agents left out of the list are older ones of the run; only finished ones are ever left out in a bounded run.
    done: count('done') + list.omitted,
    failed: count('failed'),
    stopped: count('stopped'),
    unreported: count('unreported'),
  };
  assert(Object.values(tally).reduce((sum, value) => sum + value, 0) === list.agents.length + list.omitted, 'tallyOf: every agent is counted once');
  return tally;
}

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
  return line === FOLLOW_UP_TOOL ? '' : withoutPinNumber(cleanTitle(line));
}

/** Characters of a subagent's title kept; a longer one is cut with an ellipsis (the row cuts it again to its width). */
export const TITLE_CHARS_MAX = 160;

/** Ids the agent may write into a title: a tool call's (`toolu_…`, `call_…`), a UUID, or a run of hex with a digit and a letter (a hash, an agent id). */
const TITLE_IDS =
  /\b(?:toolu_|call_)[A-Za-z0-9_-]+|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/giu;

/**
 * A title as a row shows it: ids taken out (a designer has no use for `a7a4cd5`), spaces collapsed, a title shouted
 * in capitals lowered, and its first letter capitalised ("Release Stacki 1.4.14" keeps its own capitals). Bounded to
 * `TITLE_CHARS_MAX`. Empty when nothing but ids was there.
 */
export function cleanTitle(title: string): string {
  const words = title
    .slice(0, TITLE_CHARS_MAX * 2)
    .replace(TITLE_IDS, '')
    .replace(/[([{]\s*[)\]}]/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/\s+([,.:;!?])/gu, '$1')
    .trim()
    .replace(/^[,.:;\-–—]+\s*|\s*[,:;\-–—]+$/gu, '');
  const shouted = /\p{Lu}/u.test(words) && !/\p{Ll}/u.test(words) && words.length > 3;
  const cased = shouted ? words.toLowerCase() : words;
  // A name written as an identifier (Codex's `count_lines`, `fixBuild`) stays as it was written.
  const identifier = /^[a-z0-9]+(?:[_-][a-z0-9]+)+(?:\s|$)|^[a-z]+[A-Z]/u.test(cased);
  const capital = cased === '' || identifier ? cased : `${cased.charAt(0).toUpperCase()}${cased.slice(1)}`;
  const cut = capital.length <= TITLE_CHARS_MAX ? capital : `${capital.slice(0, TITLE_CHARS_MAX - 1)}…`;
  assert(cut.length <= TITLE_CHARS_MAX, 'cleanTitle: bounded');
  return cut;
}

/** The name of the session's current model, from the agent's model option (`id` `model`); undefined when it reported none. */
export function sessionModelName(options: readonly ChatOption[]): string | undefined {
  const option = options.find((candidate) => candidate.id === 'model' || candidate.category === 'model');
  const choice = option?.choices.find((candidate) => candidate.value === option.currentValue);
  if (choice === undefined) {
    return undefined;
  }
  // Claude's "Default" entry names the model it resolves to in its description, before a tagline
  // ("Opus 5.5 · Best for everyday, complex tasks", Claude Code 2.1.332).
  const described = choice.value === 'default' ? choice.description?.split('·')[0]?.trim() : undefined;
  return described === undefined || described === '' ? choice.name : described;
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
    const follow = !isSubagentCall(call);
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
      // A follow-up's reply is the tool's own acknowledgement (JSON with ids): read for success, never shown.
      result: follow ? undefined : reportOf(resultOf(call)),
      message: follow ? call.sentMessage : undefined,
      target: follow ? targetOf(call, facts.units) : undefined,
      delivery: follow ? deliveryOf(call, resultOf(call)) : undefined,
    };
    const before = previous?.units.get(call.call);
    const unit = before !== undefined && sameUnit(before, agent, children, omitted) ? before : { agent, children, omitted };
    assert(unit.children.length <= SUBAGENT_ITEMS_MAX, 'deriveSubagentWork: a unit’s calls are bounded');
    units.set(call.call, unit);
  }
  assert(units.size === facts.units.length, 'deriveSubagentWork: one unit per unit call');
  return { units, unitOf: facts.unitOf, activeIn: facts.reportedIn };
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
    // A follow-up to an agent the chat holds is a message, not another agent: the agent it woke is listed instead.
    if (unit.agent.kind === 'follow-up' && unit.agent.target !== undefined) {
      continue;
    }
    const woken = current !== undefined && all.activeIn.get(unit.agent.call) === current;
    if (unit.agent.turn === current || woken || isWorking(unit.agent.status)) {
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
  const tally = tallyOf(list);
  if (active > 0) {
    return { kind: 'live', list, active, tally };
  }
  return options.open ? { kind: 'review', list, tally } : { kind: 'summary', tally };
}

/**
 * The first paragraph of a result as plain words on one line (no Markdown marks, no bookkeeping tags), cut to
 * `RESULT_SUMMARY_CHARS_MAX`; undefined for an empty one, or one that held only bookkeeping.
 */
export function resultSummary(result: string | undefined): string | undefined {
  const words = result === undefined ? undefined : withoutInternalMarkup(result);
  if (words === undefined) {
    return undefined;
  }
  const paragraph = words
    .split(/\n\s*\n/u)
    .map(plainWords)
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
  /** For each agent a follow-up reached: the turn of the newest one. It woke the agent, so its work goes on there. */
  readonly resumed: ReadonlyMap<string, TurnId>;
  /** The turn of the newest thing each unit reported: its own call, or its newest call or words. */
  readonly reportedIn: ReadonlyMap<string, TurnId>;
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
  const reportedIn = new Map<string, TurnId>();
  const resumed = new Map<string, TurnId>();
  for (const item of items) {
    // A follow-up that did not fail wakes the agent it names, in the follow-up's turn.
    if (item.kind === 'tool' && item.parent === undefined && item.toolName === FOLLOW_UP_TOOL && item.status !== 'failed') {
      const target = recipientOf(item, units);
      if (target !== undefined) {
        resumed.set(target.call, item.turn);
        reportedIn.set(target.call, item.turn);
      }
    }
    if ((item.kind !== 'tool' && item.kind !== 'text') || item.parent === undefined) {
      continue;
    }
    lastChild.set(item.parent, item);
    const unit = unitAbove(item.parent, unitCalls, parentOf);
    if (unit === undefined) {
      continue; // A parent the transcript does not hold: the call stays the coordinator's.
    }
    reportedIn.set(unit, item.turn);
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
  return { units, children, unitOf, lastChild, lastStamp, openChild, parentOf, waiting, stops, reportedIn, resumed };
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
  // A background launch's own end is when it was sent off, not when its work ended: only its work says that.
  const returned = sentToBackground(call) ? undefined : call.endedAt;
  const ends = [returned, facts.lastStamp.get(call.call)].filter((stamp): stamp is number => stamp !== undefined);
  if (ends.length === 0) {
    return undefined;
  }
  const end = Math.max(...ends);
  return end < call.at ? undefined : end - call.at;
}

/** The note Claude's Agent call returns when it sends the agent to the background: the agent is only starting then. */
const BACKGROUND_LAUNCH = /^Async agent launched successfully/u; // i18n-ignore: the agent's own words, matched, never shown.

/** Whether the call returned because the agent went to the background (it asked for that, or the call says so). */
function sentToBackground(call: ToolItem): boolean {
  if (!isSubagentCall(call)) {
    return false;
  }
  // The finishing update's own text: the output before it holds the prompt, which the note follows with no line break.
  return call.background || BACKGROUND_LAUNCH.test(resultOf(call) ?? '');
}

/**
 * How an agent sent to the background stands. Nothing reports its end by itself: Claude's adapter tells that only to
 * JetBrains clients. What it does do for Stacki is hold a turn open until every agent that turn started or woke has
 * finished, so the turn it last worked in is the proof: still running, the agent may be working or finished; ended
 * well, it finished; ended any other way, it did not.
 */
function backgroundStatus(call: ToolItem, view: ChatView, facts: Facts): SubagentStatus {
  const turn = facts.reportedIn.get(call.call) ?? call.turn;
  const stop = facts.stops.get(turn);
  // Work it buffered can arrive in a later turn still stamped with the earlier one: reporting since that turn began is working.
  const since = view.running === undefined ? undefined : view.turnStartedAt;
  const heard = facts.lastStamp.get(call.call);
  if (stop === undefined || (since !== undefined && heard !== undefined && heard >= since)) {
    return liveStatus(call, view, facts, 'reply');
  }
  if (stop === 'end_turn') {
    return { kind: 'done', durationMs: durationOf(call, facts) };
  }
  return stop === 'cancelled' ? { kind: 'stopped', durationMs: durationOf(call, facts) } : { kind: 'failed', durationMs: durationOf(call, facts) };
}

function statusOf(call: ToolItem, view: ChatView, facts: Facts): SubagentStatus {
  const stop = facts.stops.get(call.turn);
  const stopped = stop === 'cancelled';
  switch (call.status) {
    case 'completed':
      if (sentToBackground(call)) {
        return backgroundStatus(call, view, facts);
      }
      // A follow-up that woke an agent again does so after the call returned: the agent's work goes on there.
      if (isSubagentCall(call) && facts.resumed.has(call.call)) {
        return backgroundStatus(call, view, facts);
      }
      // Codex's call is the start of its subagent; none of that agent's work, and no end, is ever sent.
      if (call.title.startsWith(CODEX_SUBAGENT_PREFIX) && !facts.lastChild.has(call.call)) {
        return { kind: 'unreported' };
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
      if (!stillReporting(call, view, facts)) {
        return { kind: 'done', durationMs: durationOf(call, facts) };
      }
      return liveStatus(call, view, facts, 'own');
    }
    default: {
      const exhaustive: never = call.status;
      return exhaustive;
    }
  }
}

/**
 * Whether a subagent left open can still be at work as far as the transcript shows. Its own running turn, or a turn
 * the view never saw end: yes. Otherwise its turn ended well and it outlived it, which is real for an agent sent to the
 * background, but the adapters deliver its reports only while a turn runs, and `session/cancel` stops only a running
 * turn. So while the chat waits for the person it is not shown at work: a step whose close never came (an app restart,
 * a lost update) would otherwise tick for a day ("22h 55m" for an agent that worked 16 minutes) with nothing to stop.
 * While a later turn runs it is at work only once it has reported in that turn; with no stamps there is no evidence
 * either way and it keeps its open state.
 */
function stillReporting(call: ToolItem, view: ChatView, facts: Facts): boolean {
  if (view.running === call.turn) {
    return true;
  }
  if (!facts.stops.has(call.turn)) {
    return true;
  }
  if (view.running === undefined) {
    return false;
  }
  const since = view.turnStartedAt;
  const stamps = [call.at, call.endedAt, facts.lastStamp.get(call.call)].filter((stamp): stamp is number => stamp !== undefined);
  if (since === undefined || stamps.length === 0) {
    return true;
  }
  assert(view.running !== call.turn, 'stillReporting: an earlier turn’s subagent');
  return Math.max(...stamps) >= since;
}

function liveStatus(call: ToolItem, view: ChatView, facts: Facts, end: 'own' | 'reply'): SubagentStatus {
  if (view.running !== undefined && facts.waiting.some((request) => belongsTo(request.call, call.call, facts.parentOf))) {
    return { kind: 'waiting', startedAt: call.at };
  }
  if (call.status === 'pending' && !facts.lastChild.has(call.call)) {
    return { kind: 'queued', startedAt: call.at };
  }
  return { kind: 'running', startedAt: call.at, end };
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

/** Characters of a SendMessage reply read for its verdict; a longer one is not an acknowledgement. */
const FOLLOW_UP_REPLY_CHARS_MAX = 20_000;

/**
 * Whether a follow-up reached its agent, from the call and the reply it returned. Parsed at the boundary: the reply is
 * `unknown` until it is a JSON object with a boolean `success`; only that boolean is used (never its other fields, which
 * hold ids). A reply that opens as JSON but is not an object with `success`, or is too long to be one, counts as failed;
 * plain words or nothing say nothing against it.
 */
export function deliveryOf(call: Pick<ToolItem, 'status'>, reply: string | undefined): FollowUpDelivery {
  switch (call.status) {
    case 'pending':
    case 'in_progress':
      return 'pending';
    case 'failed':
      return 'failed';
    case 'completed':
      break;
    default: {
      const exhaustive: never = call.status;
      return exhaustive;
    }
  }
  const text = reply?.trim() ?? '';
  if (text.charAt(0) !== '{' && text.charAt(0) !== '[') {
    return 'sent';
  }
  if (text.length > FOLLOW_UP_REPLY_CHARS_MAX) {
    return 'failed';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'failed';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'failed';
  }
  return 'success' in parsed && parsed.success === true ? 'sent' : 'failed';
}

/**
 * The title of the agent a follow-up went to: the unit whose call id is the recipient, or whose own reply names it (Claude
 * ends an agent's report with the id a follow-up can address it by). Undefined when none matches; the row then says
 * "Follow-up message". Bounded by the number of units.
 */
function recipientOf(call: ToolItem, units: readonly ToolItem[]): ToolItem | undefined {
  const recipient = call.sentTo;
  if (recipient === undefined || recipient === '') {
    return undefined;
  }
  return units.find((unit) => isSubagentCall(unit) && (unit.call === recipient || (recipient.length >= 6 && unit.output.includes(recipient))));
}

function targetOf(call: ToolItem, units: readonly ToolItem[]): string | undefined {
  const match = recipientOf(call, units);
  if (match === undefined) {
    return undefined;
  }
  const name = subagentName({ title: match.title });
  return name === '' ? undefined : name;
}

/**
 * An agent's report without the bookkeeping the agents append to it (internalText.ts): the lines that name the
 * agent's id, the `<usage>` block with its token counts, the tools it used, a background launch's note. What is left
 * is what the agent said; undefined when nothing is.
 */
export function reportOf(result: string | undefined): string | undefined {
  return result === undefined ? undefined : withoutInternalMarkup(result);
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
    was.message === agent.message &&
    was.target === agent.target &&
    was.delivery === agent.delivery &&
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
