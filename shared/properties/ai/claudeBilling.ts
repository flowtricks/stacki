// What a running Claude session says about who pays for it. The adapter passes two of Claude's own messages on as
// `_claude/sdkMessage` extension notifications, because the session asks for them (claudeSubscriptionOnly.ts):
//
// - `system`/`init`, at the start of every turn: `apiKeySource`, "none" when no API key is part of the sign-in.
// - `rate_limit_event`: `rate_limit_info.isUsingOverage`, true while the plan's included usage is spent and the
//   turn is charged as extra usage, with `resetsAt` (seconds since 1970) when the included usage returns.
//
// Field names are as Claude Code 2.1.332 prints them. Both come from another process, so nothing is trusted: a
// message of any other shape says nothing about billing.
import { toRecord } from '../../core/record';

/** The longest session id or key source read; a longer one is not one. */
const TEXT_CHARS_MAX = 512;

export type ClaudeBillingSignal =
  { readonly kind: 'key-source'; readonly source: string } | { readonly kind: 'usage'; readonly extra: boolean; readonly resetsAtSeconds: number | undefined };

export interface ClaudeSessionSignal {
  readonly sessionId: string;
  readonly signal: ClaudeBillingSignal;
}

/** The key source of a session no API key is part of. */
export const NO_KEY_SOURCE = 'none';

/**
 * The key source a Console sign-in saves. Claude Code 2.1.332 reports it beside a subscription sign-in too, while
 * sending only the subscription (checked against a local fake API), so alone it does not say who pays.
 */
export const SAVED_KEY_SOURCE = '/login managed key';

export const CLAUDE_RAW_MESSAGE_METHOD = '_claude/sdkMessage';

export function parseClaudeSessionSignal(params: unknown): ClaudeSessionSignal | undefined {
  const value = toRecord(params);
  const sessionId = boundedText(value?.['sessionId']);
  const message = toRecord(value?.['message']);
  if (sessionId === undefined || message === undefined) {
    return undefined;
  }
  const signal = billingSignal(message);
  return signal === undefined ? undefined : { sessionId, signal };
}

function billingSignal(message: Readonly<Record<string, unknown>>): ClaudeBillingSignal | undefined {
  if (message['type'] === 'system' && message['subtype'] === 'init') {
    const source = boundedText(message['apiKeySource']);
    return source === undefined ? undefined : { kind: 'key-source', source };
  }
  if (message['type'] !== 'rate_limit_event') {
    return undefined;
  }
  const limits = toRecord(message['rate_limit_info']);
  const extra = limits?.['isUsingOverage'];
  if (typeof extra !== 'boolean') {
    return undefined;
  }
  const resetsAt = limits?.['resetsAt'];
  return { kind: 'usage', extra, resetsAtSeconds: typeof resetsAt === 'number' && Number.isSafeInteger(resetsAt) && resetsAt > 0 ? resetsAt : undefined };
}

function boundedText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && value.length <= TEXT_CHARS_MAX ? value : undefined;
}
