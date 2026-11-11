// ACP session updates turned into Stacki's own transcript events
// (shared/properties/ai/chatModel.ts). Pure: the host decides which turn an
// update belongs to and what else it does (the ledger hears every path a tool
// names before the event is queued). An update that belongs to a turn is
// dropped outside one — after a turn ends, a late chunk has no prompt to sit
// under — while chat-wide ones (commands, options, usage) always apply.
import { assert } from '../../../shared/core/assert';
import type { AcpConfigOption, AcpContent, AcpToolCall, AcpUpdate } from '../../../shared/properties/ai/acpWire';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';
import type { ChatEvent, ChatOption, TurnId } from '../../../shared/properties/ai/chatModel';

export function eventsForUpdate(update: AcpUpdate, turn: TurnId | undefined): readonly ChatEvent[] {
  switch (update.kind) {
    case 'message': {
      if (turn === undefined || update.role === 'user') {
        return []; // The person's own words are recorded when sent; a replay of them is not news.
      }
      const text = contentText(update.content);
      return text === '' ? [] : [{ kind: 'text', turn, role: update.role, text }];
    }
    case 'tool-call':
    case 'tool-call-update':
      return turn === undefined ? [] : [toolEvent(update.call, turn)];
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
    case 'unknown-update':
      return [{ kind: 'unsupported', label: `The agent sent an update Stacki does not show yet (${update.sessionUpdate}).` }];
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

function toolEvent(call: AcpToolCall, turn: TurnId): ChatEvent {
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
      joined[joined.length - 1] = { ...last, text: last.text + event.text };
    } else {
      joined.push(event);
    }
  }
  assert(joined.length <= events.length, 'coalesceEvents: never more events than came in');
  return joined;
}
