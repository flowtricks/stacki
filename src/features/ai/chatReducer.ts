// A chat's transcript as the panel draws it, folded from the same events the
// main process stores (shared/properties/ai/chatModel.ts). Pure, so a chat
// replayed from disk and one streaming live reach the same view, and so the
// fold can be property-tested (test/renderer/ai/chatReducer.test.js): applying
// events one at a time equals applying them as one batch; a tool call is one
// item however many updates it gets; streamed text is never lost or reordered.
import { assert } from '../../../shared/core/assert';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';
import type {
  ChatAttachmentName,
  ChatCommand,
  ChatDiff,
  ChatEvent,
  ChatFileChange,
  ChatOption,
  PermissionRequestId,
  ToolKindName,
  ToolStatusName,
  TurnId,
  TurnStop,
} from '../../../shared/properties/ai/chatModel';

export interface ToolItem {
  readonly kind: 'tool';
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
}

export interface PermissionItem {
  readonly kind: 'permission';
  readonly turn: TurnId;
  readonly request: PermissionRequestId;
  readonly call: string;
  readonly title: string;
  readonly options: Extract<ChatEvent, { readonly kind: 'permission' }>['options'];
  readonly answer: { readonly outcome: 'selected' | 'cancelled'; readonly optionId: string | undefined } | undefined;
}

export type TranscriptItem =
  | { readonly kind: 'user'; readonly turn: TurnId; readonly text: string; readonly attachments: readonly ChatAttachmentName[]; readonly at: number }
  | { readonly kind: 'text'; readonly turn: TurnId; readonly role: 'agent' | 'thought'; readonly text: string }
  | ToolItem
  | PermissionItem
  | { readonly kind: 'changes'; readonly turn: TurnId; readonly files: readonly ChatFileChange[] }
  | { readonly kind: 'notice'; readonly severity: 'info' | 'warning' | 'error' | 'sign-in'; readonly text: string }
  | { readonly kind: 'turn-end'; readonly turn: TurnId; readonly stop: TurnStop; readonly message: string | undefined }
  | { readonly kind: 'unsupported'; readonly label: string };

export interface ChatView {
  readonly items: readonly TranscriptItem[];
  /** The running turn; undefined while the chat waits for the person. */
  readonly running: TurnId | undefined;
  readonly plan: { readonly turn: TurnId; readonly entries: Extract<ChatEvent, { readonly kind: 'plan' }>['entries'] } | undefined;
  readonly commands: readonly ChatCommand[];
  readonly options: readonly ChatOption[];
  readonly usage: { readonly used: number; readonly size: number } | undefined;
  readonly title: string | undefined;
  /** The last prompt the person sent, for Retry. */
  readonly lastPrompt: { readonly turn: TurnId; readonly text: string } | undefined;
}

export const EMPTY_CHAT: ChatView = {
  items: [],
  running: undefined,
  plan: undefined,
  commands: [],
  options: [],
  usage: undefined,
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
  return next;
}

export function applyEvent(view: ChatView, event: ChatEvent): ChatView {
  switch (event.kind) {
    case 'user':
      return {
        ...push(view, { kind: 'user', turn: event.turn, text: event.text, attachments: event.attachments, at: event.at }),
        lastPrompt: { turn: event.turn, text: event.text },
      };
    case 'text':
      return appendText(view, event.turn, event.role, event.text);
    case 'tool':
      return applyTool(view, event);
    case 'plan':
      return { ...view, plan: { turn: event.turn, entries: event.entries } };
    case 'commands':
      return { ...view, commands: event.commands };
    case 'options':
      return { ...view, options: event.options };
    case 'usage':
      return { ...view, usage: { used: event.used, size: event.size } };
    case 'title':
      return { ...view, title: event.title };
    case 'permission':
      return push(view, {
        kind: 'permission',
        turn: event.turn,
        request: event.request,
        call: event.call,
        title: event.title,
        options: event.options,
        answer: undefined,
      });
    case 'permission-answered':
      return mapItems(view, (item) =>
        item.kind === 'permission' && item.request === event.request ? { ...item, answer: { outcome: event.outcome, optionId: event.optionId } } : item,
      );
    case 'turn-start':
      return { ...view, running: event.turn };
    case 'turn-end':
      return {
        ...push(view, { kind: 'turn-end', turn: event.turn, stop: event.stop, message: event.message }),
        running: view.running === event.turn ? undefined : view.running,
      };
    case 'changes':
      return push(view, { kind: 'changes', turn: event.turn, files: event.files });
    case 'review':
      return mapItems(view, (item) =>
        item.kind === 'changes' && item.turn === event.turn
          ? { ...item, files: item.files.map((file) => (file.path === event.path ? { ...file, review: event.review } : file)) }
          : item,
      );
    case 'notice':
      return push(view, { kind: 'notice', severity: event.severity, text: event.text });
    case 'unsupported': {
      const last = view.items[view.items.length - 1];
      return last?.kind === 'unsupported' && last.label === event.label ? view : push(view, { kind: 'unsupported', label: event.label });
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

function push(view: ChatView, item: TranscriptItem): ChatView {
  if (view.items.length >= AI_LIMITS.chatEventsMax) {
    return view; // The store refuses events past this bound too; the view never outgrows it.
  }
  return { ...view, items: [...view.items, item] };
}

function mapItems(view: ChatView, change: (item: TranscriptItem) => TranscriptItem): ChatView {
  return { ...view, items: view.items.map(change) };
}

function appendText(view: ChatView, turn: TurnId, role: 'agent' | 'thought', text: string): ChatView {
  const last = view.items[view.items.length - 1];
  if (last?.kind === 'text' && last.turn === turn && last.role === role) {
    const items = [...view.items];
    items[items.length - 1] = { ...last, text: last.text + text };
    return { ...view, items };
  }
  return push(view, { kind: 'text', turn, role, text });
}

function applyTool(view: ChatView, event: Extract<ChatEvent, { readonly kind: 'tool' }>): ChatView {
  const index = view.items.findIndex((item) => item.kind === 'tool' && item.call === event.call);
  const existing = index === -1 ? undefined : view.items[index];
  if (existing === undefined || existing.kind !== 'tool') {
    return push(view, {
      kind: 'tool',
      turn: event.turn,
      call: event.call,
      title: event.title ?? 'Tool',
      toolKind: event.toolKind ?? 'other',
      status: event.status ?? 'pending',
      paths: event.paths ?? [],
      diffs: event.diffs ?? [],
      output: event.output ?? '',
      exitCode: event.exitCode,
      parent: event.parent,
    });
  }
  const merged: ToolItem = {
    ...existing,
    title: event.title ?? existing.title,
    toolKind: event.toolKind ?? existing.toolKind,
    status: event.status ?? existing.status,
    paths: event.paths ?? existing.paths,
    diffs: event.diffs ?? existing.diffs,
    output: event.output === undefined ? existing.output : (existing.output + event.output).slice(-AI_LIMITS.toolOutputCharsMax),
    exitCode: event.exitCode ?? existing.exitCode,
    parent: event.parent ?? existing.parent,
  };
  const items = [...view.items];
  items[index] = merged;
  return { ...view, items };
}
