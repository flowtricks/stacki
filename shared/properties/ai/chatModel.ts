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

export type ChatId = Brand<string, 'ChatId'>;
export type TurnId = Brand<string, 'TurnId'>;
export type PermissionRequestId = Brand<string, 'PermissionRequestId'>;

const CHAT_ID = /^c[0-9a-f]{24}$/;
const TURN_ID = /^t[0-9a-f]{16}$/;
const REQUEST_ID = /^p[0-9]{1,15}$/;

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

export interface ChatSummary {
  readonly id: ChatId;
  readonly agent: AgentId;
  readonly title: string;
  readonly pinned: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type ToolKindName = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
export type ToolStatusName = 'pending' | 'in_progress' | 'completed' | 'failed';
export type TurnStop = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | 'error';
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
  | { readonly kind: 'user'; readonly turn: TurnId; readonly text: string; readonly attachments: readonly ChatAttachmentName[]; readonly at: number }
  | { readonly kind: 'text'; readonly turn: TurnId; readonly role: 'agent' | 'thought'; readonly text: string }
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
const STOPS: readonly TurnStop[] = ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled', 'error'];
const REVIEWS: readonly ReviewState[] = ['pending', 'kept', 'undone'];
const CHANGES: readonly FileChangeKind[] = ['modified', 'created', 'deleted'];
const SEVERITIES = ['info', 'warning', 'error', 'sign-in'] as const;
const PERMISSION_KINDS = ['allow_once', 'allow_always', 'reject_once', 'reject_always'] as const;
const PLAN_STATUSES = ['pending', 'in_progress', 'completed'] as const;

export function parseChatSummary(input: unknown): ChatSummary {
  const value = object(input, 'ChatSummary');
  const summary: ChatSummary = {
    id: toChatId(text(value['id'], 32, 'ChatSummary.id')),
    agent: parseAgentId(value['agent']),
    title: text(value['title'], AI_LIMITS.titleCharsMax, 'ChatSummary.title'),
    pinned: flag(value['pinned'], 'ChatSummary.pinned'),
    createdAt: count(value['createdAt'], 'ChatSummary.createdAt'),
    updatedAt: count(value['updatedAt'], 'ChatSummary.updatedAt'),
  };
  assert(summary.updatedAt >= summary.createdAt, 'ChatSummary: updated no earlier than created');
  return summary;
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
      };
    case 'text':
      return {
        kind,
        turn: turnOf(value),
        role: oneOf(value['role'], ['agent', 'thought'] as const, 'text.role'),
        text: text(value['text'], AI_LIMITS.textCharsMax, 'text.text'),
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
    case 'usage':
      return { kind, used: count(value['used'], 'usage.used'), size: count(value['size'], 'usage.size') };
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
