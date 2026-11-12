// The AI chat panel's IPC contract (docs/contracts.md, "AI panel"). Payload
// parsers run in main before any side effect; the renderer parses each reply
// and each pushed event with the parsers below before a component sees it.
// Pushes: `ai:events` (batched transcript events, acknowledged with the
// one-way `ai:ack`) and `ai:agentStatus` (an agent's availability changed).
import { assert } from '../core/assert';
import { boolean, count, list, object, optional, pathText, record, text } from '../core/boundary';
import type { Parsed } from '../core/boundary';
import { err, ok, type Result } from '../core/result';
import { toArray } from '../core/record';
import { parseAgentId, type AgentId } from '../properties/ai/agentIds';
import { AI_LIMITS } from '../properties/ai/aiLimits';
import {
  parseChatEvent,
  parseChatList,
  parseChatOption,
  parseChatSummary,
  parseSectionName,
  toChatId,
  toPermissionRequestId,
  toSectionId,
  toTurnId,
  type ChatEvent,
  type ChatList,
  type ChatOption,
  type ChatSummary,
  type SectionId,
  type TurnId,
} from '../properties/ai/chatModel';
import { parseMentionCandidates, parseMentionKinds, parseMentionQuery, parsePromptParts, type MentionCandidate } from '../properties/ai/mentions';
import { parseMergeResolution, type MergeResolution } from './mergeResolution';
import type { WireConflictPart, WireMergeClash } from './ipcWire';

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

const projectPath = pathText;
const chat = (input: unknown) => toChatId(text(input));

function bounded(max: number, name: string) {
  return (input: unknown): string => {
    const value = text(input);
    if (value.length > max) {
      throw new Error(`${name}: exceeds limit`);
    }
    return value;
  };
}

function title(input: unknown): string {
  const value = bounded(AI_LIMITS.titleCharsMax, 'title')(input).trim();
  if (value.length === 0) {
    throw new Error('title: expected non-empty text');
  }
  return value;
}

export type PromptAttachment =
  | { readonly kind: 'image'; readonly name: string; readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; readonly data: string }
  | { readonly kind: 'file'; readonly path: string };

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export function parsePromptAttachment(input: unknown): PromptAttachment {
  const value = record(input);
  if (value['kind'] === 'image') {
    const mimeType = IMAGE_TYPES.find((type) => type === value['mimeType']);
    if (mimeType === undefined) {
      throw new Error('attachment.mimeType: unsupported image type');
    }
    const data = bounded(AI_LIMITS.imageBase64CharsMax, 'attachment.data')(value['data']);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      throw new Error('attachment.data: expected base64');
    }
    return { kind: 'image', name: bounded(AI_LIMITS.labelCharsMax, 'attachment.name')(value['name']), mimeType, data };
  }
  if (value['kind'] === 'file') {
    const path = pathText(value['path']);
    assert(!path.includes('\0'), 'attachment.path: pathText refuses NUL');
    return { kind: 'file', path };
  }
  throw new Error('attachment.kind: unknown kind');
}

function attachments(input: unknown): readonly PromptAttachment[] {
  const values = toArray(input);
  if (values === undefined) {
    throw new Error('attachments: expected array');
  }
  if (values.length > AI_LIMITS.attachmentsMax) {
    throw new Error('attachments: exceeds limit');
  }
  return values.map(parsePromptAttachment);
}

export type PermissionAnswer = { readonly kind: 'option'; readonly optionId: string } | { readonly kind: 'cancel' };

function permissionAnswer(input: unknown): PermissionAnswer {
  const value = record(input);
  if (value['kind'] === 'cancel') {
    return { kind: 'cancel' };
  }
  if (value['kind'] === 'option') {
    return { kind: 'option', optionId: bounded(AI_LIMITS.idCharsMax, 'optionId')(value['optionId']) };
  }
  throw new Error('permission answer: unknown kind');
}

export type ReviewAction = { readonly kind: 'keep' } | { readonly kind: 'undo' } | { readonly kind: 'resolve'; readonly resolution: MergeResolution };

function reviewAction(input: unknown): ReviewAction {
  const value = record(input);
  switch (value['kind']) {
    case 'keep':
      return { kind: 'keep' };
    case 'undo':
      return { kind: 'undo' };
    case 'resolve':
      return { kind: 'resolve', resolution: parseMergeResolution(value['resolution']) };
    default:
      throw new Error('review action: unknown kind');
  }
}

export interface ChatSetting {
  readonly option: string;
  readonly value: string;
}

/** Settings a new chat starts with (a model, an effort), applied once its session exists. */
export function parseChatSettings(input: unknown): readonly ChatSetting[] {
  const values = toArray(input);
  if (values === undefined) {
    throw new Error('settings: expected array');
  }
  if (values.length > AI_LIMITS.configOptionsMax) {
    throw new Error('settings: exceeds limit');
  }
  const settings = values.map((entry) => {
    const value = record(entry);
    return { option: bounded(AI_LIMITS.idCharsMax, 'setting.option')(value['option']), value: bounded(AI_LIMITS.idCharsMax, 'setting.value')(value['value']) };
  });
  assert(settings.length === values.length, 'settings: one per entry');
  return settings;
}

function prompt(input: unknown): string {
  return bounded(AI_LIMITS.promptCharsMax, 'prompt')(input);
}

const section = (input: unknown): SectionId => toSectionId(text(input));

/** How a prompt reaches a chat: `send` starts a turn (refused while one runs), `steer` injects into the running turn. */
export type PromptMode = 'send' | 'steer';

function promptMode(input: unknown): PromptMode {
  if (input === 'send' || input === 'steer') {
    return input;
  }
  throw new Error('prompt mode: expected send or steer');
}

/** A change to a project's sections. Names are trimmed; a repeated name is refused where the list is known (chatStore.ts). */
export type SectionAction =
  | { readonly kind: 'create'; readonly name: string }
  | { readonly kind: 'rename'; readonly section: SectionId; readonly name: string }
  | { readonly kind: 'delete'; readonly section: SectionId }
  | { readonly kind: 'collapse'; readonly section: SectionId; readonly collapsed: boolean }
  /** `before` undefined: after the last section. */
  | { readonly kind: 'move'; readonly section: SectionId; readonly before: SectionId | undefined };

export function parseSectionAction(input: unknown): SectionAction {
  const value = record(input);
  switch (value['kind']) {
    case 'create':
      return { kind: 'create', name: parseSectionName(value['name']) };
    case 'rename':
      return { kind: 'rename', section: section(value['section']), name: parseSectionName(value['name']) };
    case 'delete':
      return { kind: 'delete', section: section(value['section']) };
    case 'collapse':
      return { kind: 'collapse', section: section(value['section']), collapsed: boolean(value['collapsed']) };
    case 'move':
      return { kind: 'move', section: section(value['section']), before: optional(section)(value['before']) };
    default:
      throw new Error('section action: unknown kind');
  }
}

/** The payload parsers ipcPayloads.ts lists, one per channel. */
export const AI_PAYLOADS = {
  'ai:agents': object({ projectPath }),
  'ai:installAgent': object({ projectPath, agent: parseAgentId }),
  'ai:trust': object({ projectPath }),
  'ai:chats': object({ projectPath }),
  'ai:chatCreate': object({ projectPath, agent: parseAgentId, title: optional(title), settings: optional(parseChatSettings) }),
  'ai:chatUpdate': object({
    projectPath,
    chat,
    title: optional(title),
    pinned: optional(boolean),
    settings: optional(parseChatSettings),
    /** Archive (true) or restore (false). Archiving also stops the chat's running adapter session. */
    archived: optional(boolean),
    unread: optional(boolean),
  }),
  'ai:chatDelete': object({ projectPath, chat }),
  'ai:chatRead': object({ projectPath, chat }),
  'ai:prompt': object({ projectPath, chat, text: prompt, attachments, parts: optional(parsePromptParts), mode: optional(promptMode) }),
  'ai:steer': object({ projectPath, chat, text: prompt, attachments, parts: optional(parsePromptParts) }),
  'ai:compact': object({ projectPath, chat }),
  'ai:chatFork': object({ projectPath, chat }),
  /** `section` undefined: the implicit first section. `before` undefined: after the section's last chat. */
  'ai:chatMove': object({ projectPath, chat, section: optional(section), before: optional(chat) }),
  'ai:sections': object({ projectPath, action: parseSectionAction }),
  'ai:diff': object({ projectPath, chat, turn: (input: unknown) => toTurnId(text(input)), path: pathText }),
  'ai:mentions': object({ projectPath, query: parseMentionQuery, kinds: parseMentionKinds }),
  'ai:cancel': object({ projectPath, chat }),
  'ai:permission': object({ projectPath, chat, request: (input: unknown) => toPermissionRequestId(text(input)), answer: permissionAnswer }),
  'ai:setOption': object({ projectPath, chat, option: bounded(AI_LIMITS.idCharsMax, 'option'), value: bounded(AI_LIMITS.idCharsMax, 'value') }),
  'ai:review': object({ projectPath, chat, turn: (input: unknown) => toTurnId(text(input)), path: pathText, action: reviewAction }),
  'ai:setup': object({ projectPath, agent: parseAgentId, action: (input: unknown) => parseSetupAction(input) }),
} as const;

/** The one-way acknowledgement: event characters the renderer has applied. Never negative or NaN. */
export const parseAiAck = object({ chars: count });
export type AiAck = Parsed<typeof parseAiAck>;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Where one agent stands on this computer, in the order a person meets the states. */
export type AgentAvailability =
  | { readonly agent: AgentId; readonly state: 'missing-cli' }
  | { readonly agent: AgentId; readonly state: 'needs-install'; readonly adapterVersion: string; readonly downloadMegabytes: number }
  | { readonly agent: AgentId; readonly state: 'installing' }
  | { readonly agent: AgentId; readonly state: 'ready'; readonly adapterVersion: string; readonly running: boolean }
  | { readonly agent: AgentId; readonly state: 'sign-in' }
  | { readonly agent: AgentId; readonly state: 'failed'; readonly message: string };

export interface AiAgentsReply {
  /** Whether the person has let agents work in this project. */
  readonly trusted: boolean;
  readonly agents: readonly AgentAvailability[];
  /**
   * Each agent's session settings (models, efforts, modes) as it last reported them, so a new
   * chat can be set up before its session exists; a small fallback until the agent has said.
   */
  readonly options: readonly { readonly agent: AgentId; readonly options: readonly ChatOption[] }[];
}

export interface AiFailure {
  readonly code:
    | 'not-trusted'
    | 'missing-cli'
    | 'not-installed'
    | 'sign-in'
    | 'busy'
    | 'agent-failed'
    | 'chat-missing'
    | 'read-only'
    /** The agent does not offer this (steering, fork, compaction); the control should not have been shown. */
    | 'unsupported'
    | 'section-missing'
    /** The request is well formed but cannot be applied: a repeated section name, too many sections. */
    | 'invalid';
  readonly message: string;
}

/** `steered`: injected into the running turn. `startedNewTurn`: no turn was running, so the message began one. */
export interface SteerReply {
  readonly turn: TurnId;
  readonly outcome: 'steered' | 'startedNewTurn';
}

/** One pending file's text before and after a turn (undefined: absent on that side). Settled files keep none. */
export interface DiffReply {
  readonly oldText: string | undefined;
  readonly newText: string | undefined;
}

export interface ChatTranscript {
  readonly summary: ChatSummary;
  readonly events: readonly ChatEvent[];
  /** The chat reached its stored-event bound and takes no more prompts. */
  readonly full: boolean;
}

export type ReviewOutcome =
  | { readonly tag: 'done'; readonly review: 'kept' | 'undone' }
  /** The file changed after the agent's edit: the three versions, to settle in the merge editor. */
  | { readonly tag: 'drifted'; readonly clash: WireMergeClash }
  | { readonly tag: 'failed'; readonly message: string };

export interface AiEventsPush {
  readonly projectPath: string;
  readonly chat: ChatSummary['id'];
  readonly events: readonly ChatEvent[];
  /** The characters this push counts against the flow-control watermark. */
  readonly chars: number;
}

export interface AiStatusPush {
  readonly projectPath: string;
  readonly availability: AgentAvailability;
  /** The agent's settings, when this push carries what it just reported (a probe, a new session). */
  readonly options: readonly ChatOption[] | undefined;
}

/** The result types ipcResults.ts lists, one per channel. */
export interface AiResults {
  readonly 'ai:agents': AiAgentsReply;
  readonly 'ai:installAgent': Result<AgentAvailability, AiFailure>;
  readonly 'ai:trust': { readonly ok: true };
  readonly 'ai:chats': ChatList;
  readonly 'ai:chatCreate': Result<ChatSummary, AiFailure>;
  readonly 'ai:chatUpdate': Result<ChatSummary, AiFailure>;
  readonly 'ai:chatDelete': { readonly ok: true };
  readonly 'ai:chatRead': Result<ChatTranscript, AiFailure>;
  readonly 'ai:prompt': Result<{ readonly turn: TurnId }, AiFailure>;
  readonly 'ai:steer': Result<SteerReply, AiFailure>;
  readonly 'ai:compact': Result<{ readonly started: true }, AiFailure>;
  readonly 'ai:chatFork': Result<ChatSummary, AiFailure>;
  readonly 'ai:chatMove': Result<ChatList, AiFailure>;
  readonly 'ai:sections': Result<ChatList, AiFailure>;
  readonly 'ai:diff': Result<DiffReply, AiFailure>;
  readonly 'ai:mentions': Result<readonly MentionCandidate[], AiFailure>;
  readonly 'ai:cancel': { readonly ok: true };
  readonly 'ai:permission': Result<{ readonly answered: true }, AiFailure>;
  readonly 'ai:setOption': Result<{ readonly set: true }, AiFailure>;
  readonly 'ai:review': ReviewOutcome;
  readonly 'ai:setup': SetupState;
}

// ---------------------------------------------------------------------------
// Renderer-side parsers for replies and pushes
// ---------------------------------------------------------------------------

const AVAILABILITY_STATES = ['missing-cli', 'needs-install', 'installing', 'ready', 'sign-in', 'failed'] as const;
const FAILURE_CODES: readonly AiFailure['code'][] = [
  'not-trusted',
  'missing-cli',
  'not-installed',
  'sign-in',
  'busy',
  'agent-failed',
  'chat-missing',
  'read-only',
  'unsupported',
  'section-missing',
  'invalid',
];

export function parseAgentAvailability(input: unknown): AgentAvailability {
  const value = record(input);
  const agent = parseAgentId(value['agent']);
  const state = AVAILABILITY_STATES.find((candidate) => candidate === value['state']);
  switch (state) {
    case 'missing-cli':
    case 'installing':
    case 'sign-in':
      return { agent, state };
    case 'needs-install':
      return {
        agent,
        state,
        adapterVersion: bounded(AI_LIMITS.idCharsMax, 'adapterVersion')(value['adapterVersion']),
        downloadMegabytes: count(value['downloadMegabytes']),
      };
    case 'ready':
      return { agent, state, adapterVersion: bounded(AI_LIMITS.idCharsMax, 'adapterVersion')(value['adapterVersion']), running: boolean(value['running']) };
    case 'failed':
      return { agent, state, message: bounded(AI_LIMITS.labelCharsMax, 'message')(value['message']) };
    case undefined:
      throw new Error('AgentAvailability.state: unknown state');
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

export function parseAiAgentsReply(input: unknown): AiAgentsReply {
  const value = record(input);
  const agents = list(parseAgentAvailability)(value['agents']);
  assert(agents.length <= 16, 'ai:agents: a handful of agents');
  const options = list((entry: unknown) => {
    const item = record(entry);
    const choices = toArray(item['options']);
    if (choices === undefined || choices.length > AI_LIMITS.configOptionsMax) {
      throw new Error('ai:agents.options: expected a bounded array');
    }
    return { agent: parseAgentId(item['agent']), options: choices.map(parseChatOption) };
  })(value['options']);
  return { trusted: boolean(value['trusted']), agents, options };
}

export function parseAiFailure(input: unknown): AiFailure {
  const value = record(input);
  const code = FAILURE_CODES.find((candidate) => candidate === value['code']);
  if (code === undefined) {
    throw new Error('AiFailure.code: unknown code');
  }
  return { code, message: bounded(AI_LIMITS.labelCharsMax, 'message')(value['message']) };
}

/** A `Result` reply whose success value `parse` reads. */
export function parseAiResult<T>(input: unknown, parse: (value: unknown) => T): Result<T, AiFailure> {
  const value = record(input);
  if (value['ok'] === true) {
    return ok(parse(value['value']));
  }
  if (value['ok'] === false) {
    return err(parseAiFailure(value['error']));
  }
  throw new Error('ai result: expected ok flag');
}

/** The reply of `ai:chats`, `ai:chatMove` and `ai:sections`: the whole list, so the renderer replaces its copy in one update. */
export { parseChatList };

export function parseChatTranscript(input: unknown): ChatTranscript {
  const value = record(input);
  const events = toArray(value['events']);
  if (events === undefined) {
    throw new Error('transcript.events: expected array');
  }
  if (events.length > AI_LIMITS.chatEventsMax) {
    throw new Error('transcript.events: exceeds limit');
  }
  return { summary: parseChatSummary(value['summary']), events: events.map(parseChatEvent), full: boolean(value['full']) };
}

export function parseReviewOutcome(input: unknown): ReviewOutcome {
  const value = record(input);
  switch (value['tag']) {
    case 'done': {
      const review = value['review'] === 'kept' || value['review'] === 'undone' ? value['review'] : undefined;
      if (review === undefined) {
        throw new Error('review.review: unknown value');
      }
      return { tag: 'done', review };
    }
    case 'drifted':
      return { tag: 'drifted', clash: parseClash(value['clash']) };
    case 'failed':
      return { tag: 'failed', message: bounded(AI_LIMITS.labelCharsMax, 'message')(value['message']) };
    default:
      throw new Error('review outcome: unknown tag');
  }
}

function parseClash(input: unknown): WireMergeClash {
  const value = record(input);
  const parts = list(parseConflictPart)(value['parts']);
  assert(parts.length <= AI_LIMITS.chatEventsMax, 'clash: parts are bounded by the list parser');
  return { path: pathText(value['path']), ours: optional(text)(value['ours']), theirs: optional(text)(value['theirs']), parts };
}

const CLASH_SIDES = ['ours', 'theirs', 'both'] as const;

function parseConflictPart(input: unknown): WireConflictPart {
  const entry = record(input);
  if (entry['kind'] === 'same') {
    return { kind: 'same', text: text(entry['text']) };
  }
  if (entry['kind'] !== 'clash') {
    throw new Error('clash part: unknown kind');
  }
  const changedBy = CLASH_SIDES.find((side) => side === entry['changedBy']);
  if (changedBy === undefined) {
    throw new Error('clash part: unknown side');
  }
  const part: WireConflictPart = {
    kind: 'clash',
    ours: text(entry['ours']),
    theirs: text(entry['theirs']),
    changedBy,
    merged: optional(text)(entry['merged']),
  };
  assert(part.kind === 'clash', 'clash part: built as a clash');
  return part;
}

export function parseAiEventsPush(input: unknown): AiEventsPush {
  const value = record(input);
  const events = toArray(value['events']);
  if (events === undefined) {
    throw new Error('ai:events.events: expected array');
  }
  if (events.length > AI_LIMITS.eventsQueuedMax) {
    throw new Error('ai:events.events: exceeds limit');
  }
  return { projectPath: pathText(value['projectPath']), chat: toChatId(text(value['chat'])), events: events.map(parseChatEvent), chars: count(value['chars']) };
}

export function parseAiStatusPush(input: unknown): AiStatusPush {
  const value = record(input);
  const options = value['options'] === undefined ? undefined : toArray(value['options']);
  if (options !== undefined && options.length > AI_LIMITS.configOptionsMax) {
    throw new Error('ai:agentStatus.options: exceeds limit');
  }
  return { projectPath: pathText(value['projectPath']), availability: parseAgentAvailability(value['availability']), options: options?.map(parseChatOption) };
}

/** The success value of `ai:steer`. */
export function parseSteerReply(input: unknown): SteerReply {
  const value = record(input);
  const outcome = value['outcome'] === 'steered' || value['outcome'] === 'startedNewTurn' ? value['outcome'] : undefined;
  if (outcome === undefined) {
    throw new Error('ai:steer.outcome: unknown outcome');
  }
  return { turn: toTurnId(text(value['turn'])), outcome };
}

/** The success value of `ai:compact`. */
export function parseCompactStarted(input: unknown): { readonly started: true } {
  if (record(input)['started'] !== true) {
    throw new Error('ai:compact.started: expected true');
  }
  return { started: true };
}

/** The success value of `ai:diff`: each side bounded by the file bound. */
export function parseDiffReply(input: unknown): DiffReply {
  const value = record(input);
  const side = optional(bounded(AI_LIMITS.fileCharsMax, 'diff'));
  return { oldText: side(value['oldText']), newText: side(value['newText']) };
}

/** The success value of `ai:mentions`. */
export function parseMentionReply(input: unknown): readonly MentionCandidate[] {
  return parseMentionCandidates(input);
}

/** The success value of `ai:prompt`: the turn the prompt started. */
export function parsePromptTurn(input: unknown): { readonly turn: TurnId } {
  const turn = toTurnId(text(record(input)['turn']));
  assert(turn.startsWith('t'), 'ai:prompt: a turn id');
  return { turn };
}

// ---------------------------------------------------------------------------
// Guided setup: install an agent's CLI and sign in to it, by buttons
// (electron/handlers/ai/agentSetup.ts). The CLI does the work; Stacki drives it.
// ---------------------------------------------------------------------------

export type SetupAction =
  | { readonly kind: 'detect' }
  | { readonly kind: 'install' }
  | { readonly kind: 'signIn' }
  | { readonly kind: 'code'; readonly code: string }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'signOut' };

/** The longest code a CLI's paste-back prompt takes. */
export const SETUP_CODE_CHARS_MAX = 4_096;

export function parseSetupAction(input: unknown): SetupAction {
  const value = record(input);
  switch (value['kind']) {
    case 'detect':
    case 'install':
    case 'signIn':
    case 'cancel':
    case 'signOut':
      return { kind: value['kind'] };
    case 'code': {
      const code = bounded(SETUP_CODE_CHARS_MAX, 'code')(value['code']).trim();
      if (code === '' || /[\r\n]/.test(code)) {
        throw new Error('code: expected one line');
      }
      return { kind: 'code', code };
    }
    default:
      throw new Error('setup action: unknown kind');
  }
}

/** Where an agent's own CLI stands, in the order a person goes through it. */
export type SetupState =
  | { readonly agent: AgentId; readonly step: 'missing' }
  | { readonly agent: AgentId; readonly step: 'installing' }
  | { readonly agent: AgentId; readonly step: 'signed-out' }
  /**
   * `url`: the page the CLI asked for, opened in the browser; `needsCode`: the CLI waits for a pasted code;
   * `output`: what the CLI has printed so far, with links and tokens left out, for the card's Details.
   */
  | {
      readonly agent: AgentId;
      readonly step: 'signing-in';
      readonly url: string | undefined;
      readonly needsCode: boolean;
      readonly output: string;
    }
  | { readonly agent: AgentId; readonly step: 'ready'; readonly account: SetupAccount }
  /** A step that did not work: what to say, and the CLI's own output for "Copy details". */
  | {
      readonly agent: AgentId;
      readonly step: 'failed';
      readonly during: 'install' | 'sign-in' | 'sign-out';
      readonly message: string;
      readonly details: string;
    };

/**
 * Who the CLI says is signed in. `name` is a display name (never an email), `plan` the plan as the
 * CLI names it; `email` is shown only inside the account menu, held in memory, never stored or logged.
 */
export interface SetupAccount {
  readonly name: string | undefined;
  readonly plan: string | undefined;
  readonly email: string | undefined;
}

export const SETUP_DETAILS_CHARS_MAX = 16_000;

const SETUP_STEPS = ['missing', 'installing', 'signed-out', 'signing-in', 'ready', 'failed'] as const;

export function parseSetupState(input: unknown): SetupState {
  const value = record(input);
  const agent = parseAgentId(value['agent']);
  const step = SETUP_STEPS.find((candidate) => candidate === value['step']);
  switch (step) {
    case 'missing':
    case 'installing':
    case 'signed-out':
      return { agent, step };
    case 'signing-in':
      return {
        agent,
        step,
        url: optional(bounded(AI_LIMITS.labelCharsMax, 'url'))(value['url']),
        needsCode: boolean(value['needsCode']),
        output: optional(bounded(SETUP_DETAILS_CHARS_MAX, 'output'))(value['output']) ?? '',
      };
    case 'ready': {
      const account = record(value['account']);
      const field = optional(bounded(AI_LIMITS.labelCharsMax, 'account'));
      const name = field(account['name']);
      if (name !== undefined && name.includes('@')) {
        throw new Error('account.name: a display name, never an email');
      }
      return { agent, step, account: { name, plan: field(account['plan']), email: field(account['email']) } };
    }
    case 'failed': {
      const during = value['during'] === 'install' || value['during'] === 'sign-in' || value['during'] === 'sign-out' ? value['during'] : undefined;
      if (during === undefined) {
        throw new Error('setup.during: unknown step');
      }
      return {
        agent,
        step,
        during,
        message: bounded(AI_LIMITS.labelCharsMax, 'message')(value['message']),
        details: bounded(SETUP_DETAILS_CHARS_MAX, 'details')(value['details']),
      };
    }
    case undefined:
      throw new Error('setup.step: unknown step');
    default: {
      const exhaustive: never = step;
      return exhaustive;
    }
  }
}
