// A chat as Stacki keeps it: the summary the chat list shows, and the events a
// transcript is made of. The main process turns each ACP update into a
// `ChatEvent` (electron/handlers/ai/agentHost.ts), appends it to the chat's file
// and pushes it to the renderer, whose reducer folds the same events into the
// view (src/features/ai/chatReducer.ts) — live, or replayed from disk. One
// representation for both, so a reopened chat reads exactly as it streamed.
//
// Chats are private to this computer: they live under userData, never in the
// project, so nothing here is ever committed.
import { assert } from '../../core/assert';
import type { Brand } from '../../core/brand';
import { toArray, toRecord } from '../../core/record';
import { parseAgentId, type AgentId } from './agentIds';
import { AI_LIMITS } from './aiLimits';
import { BUILTIN_CHIP_IDS, SKILL_SOURCES, isProjectRelativePath, isSkillDisplayPath, type BuiltinChipId, type SkillSource } from './mentions';

export type ChatId = Brand<string, 'ChatId'>;
export type TurnId = Brand<string, 'TurnId'>;
export type PermissionRequestId = Brand<string, 'PermissionRequestId'>;
/** A named section of a project's chat list. */
export type SectionId = Brand<string, 'SectionId'>;

const CHAT_ID = /^c[0-9a-f]{24}$/;
const TURN_ID = /^t[0-9a-f]{16}$/;
const REQUEST_ID = /^p[0-9]{1,15}$/;
const SECTION_ID = /^s[0-9a-f]{16}$/;

export function toChatId(value: string): ChatId {
  if (!CHAT_ID.test(value)) {
    throw new Error('ChatId: expected c<24 hex>');
  }
  assert(value.length === 25, 'ChatId: fixed length');
  return value as ChatId;
}

export function toTurnId(value: string): TurnId {
  if (!TURN_ID.test(value)) {
    throw new Error('TurnId: expected t<16 hex>');
  }
  assert(value.length === 17, 'TurnId: fixed length');
  return value as TurnId;
}

export function toPermissionRequestId(value: string): PermissionRequestId {
  if (!REQUEST_ID.test(value)) {
    throw new Error('PermissionRequestId: expected p<digits>');
  }
  assert(value.startsWith('p'), 'PermissionRequestId: prefixed');
  return value as PermissionRequestId;
}

export function toSectionId(value: string): SectionId {
  if (!SECTION_ID.test(value)) {
    throw new Error('SectionId: expected s<16 hex>');
  }
  assert(value.length === 17, 'SectionId: fixed length');
  return value as SectionId;
}

/** The last context usage an agent reported for a chat: tokens in the window, and the window's size. */
export interface ChatContext {
  readonly used: number;
  readonly size: number;
}

/** A chat as the list shows it. `section` undefined: the implicit first section. `rank`: position within its section. */
export interface ChatSummary {
  readonly id: ChatId;
  readonly agent: AgentId;
  readonly title: string;
  readonly pinned: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly section: SectionId | undefined;
  readonly rank: number;
  /** When the person archived the chat; undefined while it is in the list. */
  readonly archivedAt: number | undefined;
  /** A turn ended in the chat while the person was elsewhere. */
  readonly unread: boolean;
  readonly context: ChatContext | undefined;
  /** The chat this one was forked from. */
  readonly forkOf: ChatId | undefined;
}

export interface ChatSection {
  readonly id: SectionId;
  readonly name: string;
  readonly collapsed: boolean;
  /** Position among the sections, 0-based. */
  readonly rank: number;
}

/** Everything the list needs, in one value: replies to list changes replace the renderer's copy whole. */
export interface ChatList {
  readonly chats: readonly ChatSummary[];
  readonly sections: readonly ChatSection[];
}

export type UserSendMode = 'send' | 'steer' | 'queued';

/** A part of a sent message as the transcript keeps it: enough to draw the chip and show what the agent was given. */
export type SentPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'file'; readonly path: string; readonly truncated: boolean; readonly excerpt: string | undefined }
  | { readonly kind: 'skill'; readonly name: string; readonly source: SkillSource; readonly path: string }
  | { readonly kind: 'builtin'; readonly id: BuiltinChipId; readonly textHash: string };

export type CompactionStatus = 'in_progress' | 'completed' | 'failed' | 'cancelled';

export type ToolKindName = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
export type ToolStatusName = 'pending' | 'in_progress' | 'completed' | 'failed';
/** `sign-in`: the turn ended because the agent needs the person to sign in again; the panel shows one sign-in card, never an error. */
export type TurnStop = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | 'error' | 'sign-in';
export type ReviewState = 'pending' | 'kept' | 'undone';
export type FileChangeKind = 'modified' | 'created' | 'deleted';

export interface ChatDiff {
  readonly path: string;
  readonly oldText: string | undefined;
  readonly newText: string;
}

export interface ChatAttachmentName {
  readonly kind: 'image' | 'file';
  readonly name: string;
}

export interface ChatOption {
  readonly id: string;
  readonly name: string;
  readonly category: string | undefined;
  readonly currentValue: string;
  readonly choices: readonly { readonly value: string; readonly name: string; readonly description: string | undefined }[];
}

export interface ChatCommand {
  readonly name: string;
  readonly description: string;
  readonly hint: string | undefined;
}

export interface ChatFileChange {
  readonly path: string;
  readonly change: FileChangeKind;
  readonly review: ReviewState;
}

/** Everything a transcript is made of. `turn` ties an event to the prompt that caused it. */
export type ChatEvent =
  | {
      readonly kind: 'user';
      readonly turn: TurnId;
      readonly text: string;
      readonly attachments: readonly ChatAttachmentName[];
      readonly at: number;
      /** The mentions and text the message was made of; `text` stays the plain fallback old readers show. */
      readonly parts?: readonly SentPart[] | undefined;
      readonly mode?: UserSendMode | undefined;
    }
  | {
      readonly kind: 'text';
      readonly turn: TurnId;
      readonly role: 'agent' | 'thought';
      readonly text: string;
      /** When the first chunk arrived and the last one did; absent in chats stored before timings, which show no duration. */
      readonly at?: number | undefined;
      readonly until?: number | undefined;
    }
  | {
      readonly kind: 'tool';
      readonly turn: TurnId;
      readonly call: string;
      readonly title: string | undefined;
      readonly toolKind: ToolKindName | undefined;
      readonly status: ToolStatusName | undefined;
      readonly paths: readonly string[] | undefined;
      readonly diffs: readonly ChatDiff[] | undefined;
      /** Output to append to what the call has shown so far. */
      readonly output: string | undefined;
      readonly exitCode: number | undefined;
      readonly parent: string | undefined;
      /** When the host last heard of the call; absent in chats stored before timings. */
      readonly at?: number | undefined;
      /** The agent's own name for the tool (Claude's `Bash`, `compact`), when it said. */
      readonly toolName?: string | undefined;
      /** The command a call runs, when the agent sent one. */
      readonly command?: string | undefined;
      /** The call was started in the background (Claude's `run_in_background`). */
      readonly background?: boolean | undefined;
    }
  | {
      readonly kind: 'compaction';
      readonly turn: TurnId | undefined;
      /** The agent's compaction id, or the tool call's id when the agent reports compaction as a call. */
      readonly id: string;
      readonly status: CompactionStatus;
      readonly at: number;
      /** Why a compaction failed, when the agent said; at most `compactionErrorCharsMax` characters. */
      readonly error?: string | undefined;
    }
  | {
      readonly kind: 'plan';
      readonly turn: TurnId;
      readonly entries: readonly { readonly content: string; readonly status: 'pending' | 'in_progress' | 'completed' }[];
    }
  | { readonly kind: 'commands'; readonly commands: readonly ChatCommand[] }
  | { readonly kind: 'options'; readonly options: readonly ChatOption[] }
  | {
      readonly kind: 'permission';
      readonly turn: TurnId;
      readonly request: PermissionRequestId;
      readonly call: string;
      readonly title: string;
      readonly options: readonly {
        readonly id: string;
        readonly name: string;
        readonly kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
      }[];
    }
  | {
      readonly kind: 'permission-answered';
      readonly request: PermissionRequestId;
      readonly outcome: 'selected' | 'cancelled';
      readonly optionId: string | undefined;
    }
  | { readonly kind: 'usage'; readonly used: number; readonly size: number }
  | { readonly kind: 'turn-start'; readonly turn: TurnId; readonly at: number }
  | { readonly kind: 'turn-end'; readonly turn: TurnId; readonly stop: TurnStop; readonly message: string | undefined; readonly at: number }
  | { readonly kind: 'changes'; readonly turn: TurnId; readonly files: readonly ChatFileChange[] }
  | { readonly kind: 'review'; readonly turn: TurnId; readonly path: string; readonly review: ReviewState }
  | { readonly kind: 'notice'; readonly severity: 'info' | 'warning' | 'error' | 'sign-in'; readonly text: string }
  | { readonly kind: 'title'; readonly title: string }
  | { readonly kind: 'unsupported'; readonly label: string };

export type ChatEventKind = ChatEvent['kind'];

const TOOL_KINDS: readonly ToolKindName[] = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'];
const TOOL_STATUSES: readonly ToolStatusName[] = ['pending', 'in_progress', 'completed', 'failed'];
const STOPS: readonly TurnStop[] = ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled', 'error', 'sign-in'];
const REVIEWS: readonly ReviewState[] = ['pending', 'kept', 'undone'];
const CHANGES: readonly FileChangeKind[] = ['modified', 'created', 'deleted'];
const SEVERITIES = ['info', 'warning', 'error', 'sign-in'] as const;
const PERMISSION_KINDS = ['allow_once', 'allow_always', 'reject_once', 'reject_always'] as const;
const PLAN_STATUSES = ['pending', 'in_progress', 'completed'] as const;
const COMPACTION_STATUSES = ['in_progress', 'completed', 'failed', 'cancelled'] as const;
const SEND_MODES = ['send', 'steer', 'queued'] as const;

/** A chat summary as version 2 of the index and the IPC replies carry it: every list field present (absent = undefined where the type says so). */
export function parseChatSummary(input: unknown): ChatSummary {
  const value = object(input, 'ChatSummary');
  const summary: ChatSummary = {
    ...parseChatSummaryBase(value),
    section: value['section'] === undefined ? undefined : toSectionId(text(value['section'], 32, 'ChatSummary.section')),
    rank: count(value['rank'], 'ChatSummary.rank'),
    archivedAt: value['archivedAt'] === undefined ? undefined : count(value['archivedAt'], 'ChatSummary.archivedAt'),
    unread: flag(value['unread'], 'ChatSummary.unread'),
    context: value['context'] === undefined ? undefined : parseChatContext(value['context']),
    forkOf: value['forkOf'] === undefined ? undefined : toChatId(text(value['forkOf'], 32, 'ChatSummary.forkOf')),
  };
  assert(summary.updatedAt >= summary.createdAt, 'ChatSummary: updated no earlier than created');
  assert(summary.forkOf !== summary.id, 'ChatSummary: a chat is not its own fork');
  return summary;
}

/**
 * A summary from a version 1 index, which had no sections, order, archive, unread, usage or forks.
 * Only the migration reads it; `rank` is the record's position in the old list (newest first).
 */
export function parseChatSummaryLegacy(input: unknown, rank: number): ChatSummary {
  const value = object(input, 'ChatSummary');
  const summary: ChatSummary = {
    ...parseChatSummaryBase(value),
    section: undefined,
    rank: count(rank, 'ChatSummary.rank'),
    archivedAt: undefined,
    unread: false,
    context: undefined,
    forkOf: undefined,
  };
  assert(summary.updatedAt >= summary.createdAt, 'ChatSummary: updated no earlier than created');
  return summary;
}

function parseChatSummaryBase(value: Record<string, unknown>) {
  return {
    id: toChatId(text(value['id'], 32, 'ChatSummary.id')),
    agent: parseAgentId(value['agent']),
    title: text(value['title'], AI_LIMITS.titleCharsMax, 'ChatSummary.title'),
    pinned: flag(value['pinned'], 'ChatSummary.pinned'),
    createdAt: count(value['createdAt'], 'ChatSummary.createdAt'),
    updatedAt: count(value['updatedAt'], 'ChatSummary.updatedAt'),
  };
}

export function parseChatContext(input: unknown): ChatContext {
  const value = object(input, 'ChatContext');
  const context: ChatContext = { used: count(value['used'], 'context.used'), size: count(value['size'], 'context.size') };
  if (context.used > AI_LIMITS.contextTokensMax || context.size > AI_LIMITS.contextTokensMax) {
    throw new Error('context: exceeds limit');
  }
  return context;
}

/** A section name as a person types it: trimmed, 1 to `sectionNameCharsMax` characters. */
export function parseSectionName(input: unknown): string {
  const value = text(input, AI_LIMITS.sectionNameCharsMax * 4, 'section.name').trim();
  if (value.length === 0) {
    throw new Error('section.name: expected non-empty text');
  }
  if (value.length > AI_LIMITS.sectionNameCharsMax) {
    throw new Error('section.name: exceeds limit');
  }
  return value;
}

export function parseChatSection(input: unknown): ChatSection {
  const value = object(input, 'ChatSection');
  return {
    id: toSectionId(text(value['id'], 32, 'section.id')),
    name: parseSectionName(value['name']),
    collapsed: flag(value['collapsed'], 'section.collapsed'),
    rank: count(value['rank'], 'section.rank'),
  };
}

/** The list a reply carries: chats and sections, both bounded, section ids unique, every chat's section one that exists. */
export function parseChatList(input: unknown): ChatList {
  const value = object(input, 'ChatList');
  const sections = list(value['sections'], AI_LIMITS.sectionsMax, 'ChatList.sections').map(parseChatSection);
  const chats = list(value['chats'], AI_LIMITS.chatsMax, 'ChatList.chats').map(parseChatSummary);
  const known = new Set(sections.map((section) => section.id));
  if (known.size !== sections.length) {
    throw new Error('ChatList: repeated section id');
  }
  if (chats.some((chat) => chat.section !== undefined && !known.has(chat.section))) {
    throw new Error('ChatList: a chat names a section that is not listed');
  }
  assert(chats.length <= AI_LIMITS.chatsMax, 'parseChatList: chats are bounded');
  return { chats, sections };
}

/** The parts of a stored message. A file's excerpt is bounded; a built-in keeps a hash, never its text. */
export function parseSentPart(input: unknown): SentPart {
  const value = object(input, 'part');
  switch (value['kind']) {
    case 'text':
      return { kind: 'text', text: text(value['text'], AI_LIMITS.promptCharsMax, 'part.text') };
    case 'file': {
      const path = text(value['path'], AI_LIMITS.labelCharsMax, 'part.path');
      if (!isProjectRelativePath(path)) {
        throw new Error('part.path: expected a project-relative path');
      }
      return {
        kind: 'file',
        path,
        truncated: flag(value['truncated'], 'part.truncated'),
        excerpt: value['excerpt'] === undefined ? undefined : text(value['excerpt'], AI_LIMITS.mentionPreviewCharsMax, 'part.excerpt'),
      };
    }
    case 'skill': {
      const path = text(value['path'], AI_LIMITS.labelCharsMax, 'part.path');
      if (!isSkillDisplayPath(path)) {
        throw new Error('part.path: expected a project-relative or ~/ path');
      }
      return { kind: 'skill', name: identifier(value['name']), source: oneOf(value['source'], SKILL_SOURCES, 'part.source'), path };
    }
    case 'builtin': {
      const textHash = text(value['textHash'], 64, 'part.textHash');
      if (!/^[0-9a-f]{8,64}$/.test(textHash)) {
        throw new Error('part.textHash: expected 8 to 64 hex digits');
      }
      return { kind: 'builtin', id: oneOf(value['id'], BUILTIN_CHIP_IDS, 'part.id'), textHash };
    }
    default:
      throw new Error('part.kind: unknown kind');
  }
}

function optionalCount(input: unknown, name: string): number | undefined {
  return input === undefined ? undefined : count(input, name);
}

/** One event, from the chat's file or from IPC. Throws on any shape the union does not allow. */
export function parseChatEvent(input: unknown): ChatEvent {
  const value = object(input, 'ChatEvent');
  const kind = value['kind'];
  const event = parseChatEventOfKind(kind, value);
  assert(event.kind === kind, 'ChatEvent: the parsed kind is the one sent');
  return event;
}

function parseChatEventOfKind(kind: unknown, value: Record<string, unknown>): ChatEvent {
  switch (kind) {
    case 'user':
      return {
        kind,
        turn: turnOf(value),
        text: text(value['text'], AI_LIMITS.promptCharsMax, 'user.text'),
        attachments: list(value['attachments'], AI_LIMITS.attachmentsMax, 'user.attachments').map((entry) => {
          const attachment = object(entry, 'attachment');
          return { kind: oneOf(attachment['kind'], ['image', 'file'] as const, 'attachment.kind'), name: label(attachment['name']) };
        }),
        at: count(value['at'], 'user.at'),
        parts: value['parts'] === undefined ? undefined : list(value['parts'], AI_LIMITS.promptPartsMax, 'user.parts').map(parseSentPart),
        mode: value['mode'] === undefined ? undefined : oneOf(value['mode'], SEND_MODES, 'user.mode'),
      };
    case 'text':
      return {
        kind,
        turn: turnOf(value),
        role: oneOf(value['role'], ['agent', 'thought'] as const, 'text.role'),
        text: text(value['text'], AI_LIMITS.textCharsMax, 'text.text'),
        at: optionalCount(value['at'], 'text.at'),
        until: optionalCount(value['until'], 'text.until'),
      };
    case 'compaction':
      return {
        kind,
        turn: value['turn'] === undefined ? undefined : turnOf(value),
        id: identifier(value['id']),
        status: oneOf(value['status'], COMPACTION_STATUSES, 'compaction.status'),
        at: count(value['at'], 'compaction.at'),
        error: value['error'] === undefined ? undefined : text(value['error'], AI_LIMITS.compactionErrorCharsMax, 'compaction.error'),
      };
    case 'tool':
      return parseToolEvent(value);
    case 'plan':
      return {
        kind,
        turn: turnOf(value),
        entries: list(value['entries'], AI_LIMITS.planEntriesMax, 'plan.entries').map((entry) => {
          const item = object(entry, 'plan entry');
          return { content: label(item['content']), status: oneOf(item['status'], PLAN_STATUSES, 'plan.status') };
        }),
      };
    case 'commands':
      return {
        kind,
        commands: list(value['commands'], AI_LIMITS.commandsMax, 'commands').map((entry) => {
          const command = object(entry, 'command');
          return {
            name: identifier(command['name']),
            description: text(command['description'], AI_LIMITS.labelCharsMax, 'command.description'),
            hint: optionalLabel(command['hint']),
          };
        }),
      };
    case 'options':
      return { kind, options: list(value['options'], AI_LIMITS.configOptionsMax, 'options').map(parseChatOption) };
    case 'permission':
      return {
        kind,
        turn: turnOf(value),
        request: toPermissionRequestId(identifier(value['request'])),
        call: identifier(value['call']),
        title: label(value['title']),
        options: list(value['options'], AI_LIMITS.permissionOptionsMax, 'permission.options').map((entry) => {
          const option = object(entry, 'permission option');
          return { id: identifier(option['id']), name: label(option['name']), kind: oneOf(option['kind'], PERMISSION_KINDS, 'permission.kind') };
        }),
      };
    case 'permission-answered':
      return {
        kind,
        request: toPermissionRequestId(identifier(value['request'])),
        outcome: oneOf(value['outcome'], ['selected', 'cancelled'] as const, 'permission-answered.outcome'),
        optionId: value['optionId'] === undefined ? undefined : identifier(value['optionId']),
      };
    case 'usage': {
      const usage = parseChatContext(value);
      return { kind, used: usage.used, size: usage.size };
    }
    case 'turn-start':
      return { kind, turn: turnOf(value), at: count(value['at'], 'turn-start.at') };
    case 'turn-end':
      return {
        kind,
        turn: turnOf(value),
        stop: oneOf(value['stop'], STOPS, 'turn-end.stop'),
        message: optionalLabel(value['message']),
        at: count(value['at'], 'turn-end.at'),
      };
    case 'changes':
      return {
        kind,
        turn: turnOf(value),
        files: list(value['files'], AI_LIMITS.ledgerFilesMax, 'changes.files').map((entry) => {
          const file = object(entry, 'change');
          return {
            path: label(file['path']),
            change: oneOf(file['change'], CHANGES, 'change.change'),
            review: oneOf(file['review'], REVIEWS, 'change.review'),
          };
        }),
      };
    case 'review':
      return { kind, turn: turnOf(value), path: label(value['path']), review: oneOf(value['review'], REVIEWS, 'review.review') };
    case 'notice':
      return { kind, severity: oneOf(value['severity'], SEVERITIES, 'notice.severity'), text: label(value['text']) };
    case 'title':
      return { kind, title: text(value['title'], AI_LIMITS.titleCharsMax, 'title.title') };
    case 'unsupported':
      return { kind, label: label(value['label']) };
    default:
      throw new Error('ChatEvent: unknown kind');
  }
}

function parseToolEvent(value: Record<string, unknown>): ChatEvent {
  const diffs = value['diffs'];
  const paths = value['paths'];
  return {
    kind: 'tool',
    turn: turnOf(value),
    call: identifier(value['call']),
    title: optionalLabel(value['title']),
    toolKind: value['toolKind'] === undefined ? undefined : oneOf(value['toolKind'], TOOL_KINDS, 'tool.toolKind'),
    status: value['status'] === undefined ? undefined : oneOf(value['status'], TOOL_STATUSES, 'tool.status'),
    paths: paths === undefined ? undefined : list(paths, AI_LIMITS.locationsMax, 'tool.paths').map(label),
    diffs:
      diffs === undefined
        ? undefined
        : list(diffs, AI_LIMITS.toolContentMax, 'tool.diffs').map((entry) => {
            const diff = object(entry, 'diff');
            return {
              path: label(diff['path']),
              oldText: diff['oldText'] === undefined ? undefined : text(diff['oldText'], AI_LIMITS.fileCharsMax, 'diff.oldText'),
              newText: text(diff['newText'], AI_LIMITS.fileCharsMax, 'diff.newText'),
            };
          }),
    output: value['output'] === undefined ? undefined : text(value['output'], AI_LIMITS.toolOutputCharsMax, 'tool.output'),
    exitCode: value['exitCode'] === undefined ? undefined : integer(value['exitCode'], 'tool.exitCode'),
    parent: value['parent'] === undefined ? undefined : identifier(value['parent']),
    at: optionalCount(value['at'], 'tool.at'),
    toolName: value['toolName'] === undefined ? undefined : identifier(value['toolName']),
    command: value['command'] === undefined ? undefined : text(value['command'], AI_LIMITS.labelCharsMax, 'tool.command'),
    background: value['background'] === undefined ? undefined : flag(value['background'], 'tool.background'),
  };
}

export function parseChatOption(input: unknown): ChatOption {
  const option = object(input, 'option');
  const parsed: ChatOption = {
    id: identifier(option['id']),
    name: label(option['name']),
    category: option['category'] === undefined ? undefined : identifier(option['category']),
    currentValue: identifier(option['currentValue']),
    choices: list(option['choices'], AI_LIMITS.configChoicesMax, 'option.choices').map((entry) => {
      const choice = object(entry, 'choice');
      return { value: identifier(choice['value']), name: label(choice['name']), description: optionalLabel(choice['description']) };
    }),
  };
  assert(parsed.choices.length <= AI_LIMITS.configChoicesMax, 'option: choices are bounded');
  return parsed;
}

/** The size of an event on the wire, for flow control and the transcript's bound. */
export function chatEventChars(event: ChatEvent): number {
  const size = JSON.stringify(event).length;
  assert(size > 0, 'chatEventChars: an event serializes to something');
  return size;
}

// ---------------------------------------------------------------------------
// Bounded field readers (null is never a value here: these are our own files).
// ---------------------------------------------------------------------------

function object(input: unknown, name: string): Record<string, unknown> {
  const value = toRecord(input);
  if (value === undefined) {
    throw new Error(`${name}: expected object`);
  }
  return value;
}

function list(input: unknown, max: number, name: string): readonly unknown[] {
  const values = toArray(input);
  if (values === undefined) {
    throw new Error(`${name}: expected array`);
  }
  if (values.length > max) {
    throw new Error(`${name}: exceeds limit`);
  }
  return values;
}

function text(input: unknown, max: number, name: string): string {
  if (typeof input !== 'string') {
    throw new Error(`${name}: expected string`);
  }
  if (input.length > max) {
    throw new Error(`${name}: exceeds limit`);
  }
  return input;
}

function label(input: unknown): string {
  return text(input, AI_LIMITS.labelCharsMax, 'label');
}

function optionalLabel(input: unknown): string | undefined {
  return input === undefined ? undefined : label(input);
}

function identifier(input: unknown): string {
  const value = text(input, AI_LIMITS.idCharsMax, 'identifier');
  if (value.length === 0) {
    throw new Error('identifier: expected non-empty string');
  }
  return value;
}

function flag(input: unknown, name: string): boolean {
  if (typeof input !== 'boolean') {
    throw new Error(`${name}: expected boolean`);
  }
  return input;
}

function count(input: unknown, name: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) {
    throw new Error(`${name}: expected nonnegative integer`);
  }
  return input;
}

function integer(input: unknown, name: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input)) {
    throw new Error(`${name}: expected integer`);
  }
  return input;
}

function oneOf<T extends string>(input: unknown, allowed: readonly T[], name: string): T {
  const found = allowed.find((candidate) => candidate === input);
  if (found === undefined) {
    throw new Error(`${name}: unknown value`);
  }
  return found;
}

function turnOf(value: Record<string, unknown>): TurnId {
  return toTurnId(text(value['turn'], 32, 'turn'));
}
