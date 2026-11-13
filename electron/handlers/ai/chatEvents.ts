// ACP session updates turned into Stacki's own transcript events
// (shared/properties/ai/chatModel.ts). Pure: the host decides which turn an
// update belongs to and what else it does (the ledger hears every path a tool
// names before the event is queued). An update that belongs to a turn is
// dropped outside one — after a turn ends, a late chunk has no prompt to sit
// under — while chat-wide ones (commands, options, usage) always apply.
//
// The clock is the caller's: this file never reads the time. `context.at` stamps
// the events that carry timings (text, tools, compaction), so the transcript can
// show "Thought for 12s" and a call's elapsed time; without it they carry none.
import { assert } from '../../../shared/core/assert';
import type { AcpConfigOption, AcpContent, AcpToolCall, AcpUpdate } from '../../../shared/properties/ai/acpWire';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';
import { described } from './aiMessages';
import type { ChatEvent, ChatOption, CompactionStatus, ToolStatusName, TurnId } from '../../../shared/properties/ai/chatModel';

/**
 * The tool calls that are a compaction. Claude reports `/compact` as a call titled "Compact
 * conversation" when the client does not declare `session.compaction`. The recorded updates repeat
 * `_meta.claudeCode.toolName: 'compact'`, but the host still keeps the call ids per chat, so an
 * update that names only the id (another adapter version, a replay) is never shown as a plain tool.
 * Bounded: past `compactionsMax` the oldest id is forgotten.
 */
export class CompactionCalls {
  private readonly ids = new Set<string>();

  note(call: string): void {
    if (this.ids.size >= AI_LIMITS.compactionsMax) {
      const oldest = this.ids.values().next();
      if (oldest.done !== true) {
        this.ids.delete(oldest.value);
      }
    }
    this.ids.add(call);
    assert(this.ids.size <= AI_LIMITS.compactionsMax, 'CompactionCalls: bounded');
  }

  has(call: string): boolean {
    return this.ids.has(call);
  }
}

export interface UpdateContext {
  /** The time the update arrived. Compaction needs one: without it the event says 0 (the epoch), which renders no duration. */
  readonly at?: number | undefined;
  readonly compactions?: CompactionCalls | undefined;
}

export function eventsForUpdate(update: AcpUpdate, turn: TurnId | undefined, context: UpdateContext = {}): readonly ChatEvent[] {
  const at = context.at;
  switch (update.kind) {
    case 'message': {
      if (turn === undefined || update.role === 'user') {
        return []; // The person's own words are recorded when sent; a replay of them is not news.
      }
      const text = contentText(update.content);
      return text === '' ? [] : [{ kind: 'text', turn, role: update.role, text, ...(at === undefined ? {} : { at, until: at }) }];
    }
    case 'tool-call':
    case 'tool-call-update':
      return compactionOrToolEvents(update, turn, context);
    case 'compaction':
      return [{ kind: 'compaction', turn, id: update.id, status: update.status, at: at ?? 0, ...compactionError(update.status, update.error) }];
    case 'compaction-summary':
      return []; // The summary's text is the agent's context, not the transcript's: only the status is shown.
    case 'plan':
      return turn === undefined ? [] : [{ kind: 'plan', turn, entries: update.entries.map((entry) => ({ content: entry.content, status: entry.status })) }];
    case 'commands':
      return [{ kind: 'commands', commands: update.commands }];
    case 'config':
      return [{ kind: 'options', options: update.options.map(chatOption) }];
    case 'usage':
      return [{ kind: 'usage', used: update.used, size: update.size }];
    case 'notice':
      return [
        { kind: 'notice', severity: noticeSeverity(update.severity), text: update.message === undefined ? update.title : `${update.title}: ${update.message}` },
      ];
    case 'mode':
    case 'info':
      return []; // The host folds these into the chat's options and title.
    case 'unknown-update': {
      const unsupported = described('ai.notice.unsupportedUpdate', { update: update.sessionUpdate });
      return [{ kind: 'unsupported', label: unsupported.message, labelRef: unsupported.messageRef }];
    }
    default: {
      const exhaustive: never = update;
      return exhaustive;
    }
  }
}

/** The paths a tool call names: where it reads or edits, and every diff's file. */
export function toolPaths(call: AcpToolCall): readonly string[] {
  const paths = new Set<string>();
  for (const location of call.locations ?? []) {
    paths.add(location.path);
  }
  for (const content of call.content ?? []) {
    if (content.kind === 'diff') {
      paths.add(content.path);
    }
  }
  assert(paths.size <= AI_LIMITS.locationsMax + AI_LIMITS.toolContentMax, 'toolPaths: bounded by the parsed call');
  return [...paths];
}

export function chatOption(option: AcpConfigOption): ChatOption {
  return { id: option.id, name: option.name, category: option.category, currentValue: option.currentValue, choices: option.choices };
}

function compactionOrToolEvents(
  update: Extract<AcpUpdate, { readonly kind: 'tool-call' | 'tool-call-update' }>,
  turn: TurnId | undefined,
  context: UpdateContext,
): readonly ChatEvent[] {
  const call = update.call;
  const at = context.at ?? 0;
  if (call.toolName === 'compact') {
    context.compactions?.note(call.id);
    const status = compactionStatusOf(call.status) ?? 'in_progress';
    return [{ kind: 'compaction', turn, id: call.id, status, at, ...compactionError(status, callText(call)) }];
  }
  if (context.compactions?.has(call.id) === true) {
    const status = compactionStatusOf(call.status);
    return status === undefined ? [] : [{ kind: 'compaction', turn, id: call.id, status, at, ...compactionError(status, callText(call)) }];
  }
  return turn === undefined ? [] : [toolEvent(call, turn, context.at)];
}

/**
 * The failure reason of a compaction, cut to what the panel keeps. Only a failed compaction has one:
 * an adapter's text on a compaction that went well is a summary, not an error. Cut, never refused,
 * so a long message cannot make the whole update vanish. Empty when there is nothing to say.
 */
function compactionError(status: CompactionStatus, reason: string | undefined): { readonly error?: string } {
  const trimmed = reason?.trim() ?? '';
  if (status !== 'failed' || trimmed === '') {
    return {};
  }
  const max = AI_LIMITS.compactionErrorCharsMax;
  const error = trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
  assert(error.length <= max, 'compactionError: within the limit');
  return { error };
}

/** The text a tool call carries (its content blocks), where the agent says why a compaction call failed. */
function callText(call: AcpToolCall): string {
  return (call.content ?? [])
    .flatMap((content) => (content.kind === 'content' ? [contentText(content.content)] : []))
    .filter((text) => text !== '')
    .join('\n');
}

function compactionStatusOf(status: ToolStatusName | undefined): CompactionStatus | undefined {
  switch (status) {
    case undefined:
      return undefined;
    case 'pending':
    case 'in_progress':
      return 'in_progress';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function toolEvent(call: AcpToolCall, turn: TurnId, at: number | undefined): ChatEvent {
  const diffs = (call.content ?? []).flatMap((content) =>
    content.kind === 'diff' ? [{ path: content.path, oldText: content.oldText, newText: content.newText }] : [],
  );
  const textOutput = (call.content ?? [])
    .flatMap((content) => (content.kind === 'content' ? [contentText(content.content)] : []))
    .filter((text) => text !== '')
    .join('\n');
  const output = [call.outputDelta ?? '', textOutput].filter((text) => text !== '').join('');
  const paths = call.locations === undefined && diffs.length === 0 ? undefined : toolPaths(call);
  const event: ChatEvent = {
    kind: 'tool',
    turn,
    call: call.id,
    title: call.title,
    toolKind: call.toolKind,
    status: call.status,
    paths,
    diffs: diffs.length === 0 ? undefined : diffs,
    output: output === '' ? undefined : output.slice(-AI_LIMITS.toolOutputCharsMax),
    exitCode: call.exitCode,
    parent: call.parent,
    // Only what is known is set, so an event without timings or names stores exactly what it did before.
    ...(at === undefined ? {} : { at }),
    ...(call.toolName === undefined ? {} : { toolName: call.toolName }),
    ...(call.rawInput?.command === undefined ? {} : { command: call.rawInput.command }),
    ...(call.rawInput?.runInBackground === undefined ? {} : { background: call.rawInput.runInBackground }),
  };
  assert(event.kind === 'tool', 'toolEvent: a tool event');
  return event;
}

function contentText(content: AcpContent): string {
  switch (content.kind) {
    case 'text':
      return content.text;
    case 'link':
      return `[${content.name}](${content.uri})`;
    case 'resource':
      return content.text === undefined ? content.uri : '';
    case 'image':
      return '';
    case 'other':
      return '';
    default: {
      const exhaustive: never = content;
      return exhaustive;
    }
  }
}

function noticeSeverity(severity: string): 'info' | 'warning' | 'error' {
  if (severity === 'warning' || severity === 'error') {
    return severity;
  }
  return 'info';
}

/**
 * Consecutive text of one turn and role, joined: what a batch stores and sends
 * instead of one event per streamed token.
 */
export function coalesceEvents(events: readonly ChatEvent[]): readonly ChatEvent[] {
  const joined: ChatEvent[] = [];
  for (const event of events) {
    const last = joined[joined.length - 1];
    if (
      event.kind === 'text' &&
      last?.kind === 'text' &&
      last.turn === event.turn &&
      last.role === event.role &&
      last.text.length + event.text.length <= AI_LIMITS.textCharsMax
    ) {
      // The first chunk's `at` stays; `until` becomes the last chunk's.
      joined[joined.length - 1] = { ...last, text: last.text + event.text, ...(event.until === undefined ? {} : { until: event.until }) };
    } else {
      joined.push(event);
    }
  }
  assert(joined.length <= events.length, 'coalesceEvents: never more events than came in');
  return joined;
}
