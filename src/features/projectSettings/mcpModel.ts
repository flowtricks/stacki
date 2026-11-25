// What the MCP tab decides without a screen: the words for a server and for each failure, the form a
// server takes while it is edited, the Codex chip a card shows, and the text a copy puts on the clipboard.
// Everything here is a pure function of data, so the rules can be tested without a window.
import { assert } from '../../../shared/core/assert';
import type { McpCodexState, McpErrorCode, McpServerItem } from '../../../shared/properties/mcp';
import {
  MCP_LIMITS,
  isMcpEnvName,
  isMcpHeaderName,
  mcpFileFields,
  parseMcpServerConfig,
  redactMcpConfig,
  type McpPair,
  type McpProblemCode,
  type McpServerConfig,
  type McpServerSummary,
  type McpTransport,
} from '../../../shared/properties/mcpConfig';
import type { McpJsonIssueCode } from '../../../shared/properties/mcpJson';
import type { McpPasteProblemCode } from '../../../shared/properties/mcpCommand';
import type { McpProviderProblem } from '../../../shared/properties/mcpProviders';
import type { MessageKey, Translator } from '../../lib/i18n/localeContext';

/** The line under a server's name, in plain words. */
export function serverLine(translate: Translator, summary: McpServerSummary): string {
  if (summary.transport === 'stdio') {
    return translate('settings.mcp.summary.command', { command: summary.command });
  }
  return translate(summary.transport === 'sse' ? 'settings.mcp.summary.remoteSse' : 'settings.mcp.summary.remote', { host: summary.host });
}

/** The secrets a server refers to that `.env` does not have; `undefined` names (the list is unknown) count as none. */
export function missingSecrets(summary: McpServerSummary, envNames: ReadonlySet<string> | undefined): readonly string[] {
  if (envNames === undefined) {
    return [];
  }
  return summary.secretNames.filter((name) => !envNames.has(name));
}

export type ServerStatus = 'configured' | 'needs-secrets' | 'invalid';

/** A status only when it is known: from the file and `.env` alone, since no cheap real connection check exists. */
export function serverStatus(item: McpServerItem, envNames: ReadonlySet<string> | undefined): ServerStatus {
  if (item.status === 'invalid') {
    return 'invalid';
  }
  return missingSecrets(item.summary, envNames).length > 0 ? 'needs-secrets' : 'configured';
}

export const SERVER_STATUS_KEYS: Readonly<Record<ServerStatus, MessageKey>> = {
  configured: 'settings.mcp.status.configured',
  'needs-secrets': 'settings.mcp.status.needsSecrets',
  invalid: 'settings.mcp.status.invalid',
};

/** The Codex chip on a card: what it says, and whether a click does anything. */
export type CodexChip =
  { readonly kind: 'on' } | { readonly kind: 'off' } | { readonly kind: 'missing' } | { readonly kind: 'unreadable' } | { readonly kind: 'unsupported' };

export function codexChipOf(state: McpCodexState | undefined, name: string): CodexChip {
  if (state === undefined || state.state === 'missing') {
    return { kind: 'missing' };
  }
  if (state.state === 'unavailable') {
    return { kind: state.code === 'codex-unsupported' ? 'unsupported' : 'unreadable' };
  }
  return { kind: state.servers.some((server) => server.name === name) ? 'on' : 'off' };
}

export const MCP_ERROR_KEYS: Readonly<Record<McpErrorCode, MessageKey>> = {
  changed: 'settings.mcp.error.changed',
  'name-taken': 'settings.mcp.error.nameTaken',
  'not-found': 'settings.mcp.error.notFound',
  'invalid-name': 'settings.mcp.error.invalidName',
  invalid: 'settings.mcp.error.invalid',
  limit: 'settings.mcp.error.limit',
  unreadable: 'settings.mcp.error.unreadable',
  'too-large': 'settings.mcp.error.tooLarge',
  'not-text': 'settings.mcp.error.notText',
  denied: 'settings.mcp.error.denied',
  filesystem: 'settings.mcp.error.filesystem',
  unmappable: 'settings.mcp.error.unmappable',
  'codex-unavailable': 'settings.mcp.error.codexUnavailable',
  'codex-unsupported': 'settings.mcp.error.codexUnsupported',
};

export const PROVIDER_PROBLEM_KEYS: Readonly<Record<McpProviderProblem, MessageKey>> = {
  'missing-option': 'settings.mcp.problem.missingOption',
  'bad-url': 'settings.mcp.problem.badUrl',
  'bad-option': 'settings.mcp.problem.badOption',
  'bad-secret-name': 'settings.mcp.problem.badSecretName',
};

/** Why a server's fields cannot be saved, in words; the code comes from the shared validator. */
export const PROBLEM_KEYS: Readonly<Record<McpProblemCode, MessageKey>> = {
  'expected-object': 'settings.mcp.problem.expectedObject',
  'expected-string': 'settings.mcp.problem.expectedString',
  'expected-array': 'settings.mcp.problem.expectedArray',
  'unknown-transport': 'settings.mcp.problem.unknownTransport',
  'missing-target': 'settings.mcp.problem.missingTarget',
  'both-targets': 'settings.mcp.problem.bothTargets',
  'bad-url': 'settings.mcp.problem.badUrl',
  'bad-name': 'settings.mcp.problem.badName',
  'bad-pair': 'settings.mcp.problem.badPair',
  'duplicate-pair': 'settings.mcp.problem.duplicatePair',
  'too-long': 'settings.mcp.problem.tooLong',
  'too-many': 'settings.mcp.problem.tooMany',
  'control-characters': 'settings.mcp.problem.controlCharacters',
};

export const ISSUE_KEYS: Readonly<Record<McpJsonIssueCode, MessageKey>> = {
  ...PROBLEM_KEYS,
  'unexpected-token': 'settings.mcp.issue.unexpectedToken',
  'unexpected-end': 'settings.mcp.issue.unexpectedEnd',
  'unterminated-string': 'settings.mcp.issue.unterminatedString',
  'bad-string': 'settings.mcp.issue.badString',
  'bad-number': 'settings.mcp.issue.badNumber',
  'trailing-content': 'settings.mcp.issue.trailingContent',
  'trailing-comma': 'settings.mcp.issue.trailingComma',
  'expected-colon': 'settings.mcp.issue.expectedColon',
  'expected-key': 'settings.mcp.issue.expectedKey',
  'duplicate-key': 'settings.mcp.issue.duplicateKey',
  'too-large': 'settings.mcp.issue.tooLarge',
  'too-deep': 'settings.mcp.issue.tooDeep',
  'not-object': 'settings.mcp.issue.notObject',
  'servers-not-object': 'settings.mcp.issue.serversNotObject',
  'too-many-servers': 'settings.mcp.issue.tooManyServers',
  'bad-server-name': 'settings.mcp.issue.badServerName',
};

export const PASTE_PROBLEM_KEYS: Readonly<Record<McpPasteProblemCode, MessageKey>> = {
  empty: 'settings.mcp.paste.empty',
  'too-long': 'settings.mcp.paste.tooLong',
  'unterminated-quote': 'settings.mcp.paste.unterminatedQuote',
  'unsupported-syntax': 'settings.mcp.paste.unsupportedSyntax',
  'unknown-flag': 'settings.mcp.paste.unknownFlag',
  'unsupported-flag': 'settings.mcp.paste.unsupportedFlag',
  'missing-name': 'settings.mcp.paste.missingName',
  'missing-target': 'settings.mcp.paste.missingTarget',
  'bad-name': 'settings.mcp.paste.badName',
  'bad-url': 'settings.mcp.paste.badUrl',
  'bad-transport': 'settings.mcp.paste.badTransport',
  'bad-scope': 'settings.mcp.paste.badScope',
  'bad-pair': 'settings.mcp.paste.badPair',
  'bad-json': 'settings.mcp.paste.badJson',
  'bad-config': 'settings.mcp.paste.badConfig',
  'too-many': 'settings.mcp.paste.tooMany',
  'not-mcp-command': 'settings.mcp.paste.notMcpCommand',
  conflicting: 'settings.mcp.paste.conflicting',
};

/** A server while it is being edited: every field a text box, in the order the form draws them. */
export interface ServerDraft {
  readonly transport: McpTransport;
  readonly url: string;
  readonly command: string;
  /** One argument per line. */
  readonly args: string;
  readonly pairs: readonly DraftPair[];
}

export interface DraftPair {
  readonly name: string;
  readonly value: string;
}

export function draftOf(config: McpServerConfig): ServerDraft {
  if (config.transport === 'stdio') {
    return { transport: 'stdio', url: '', command: config.command, args: config.args.join('\n'), pairs: config.env };
  }
  return { transport: config.transport, url: config.url, command: '', args: '', pairs: config.headers };
}

/**
 * The server a draft stands for, or the first thing wrong with it. The assembled object goes through the same
 * parser main uses, so the form cannot offer to save what main would refuse.
 */
export function configOfDraft(
  draft: ServerDraft,
): { readonly ok: true; readonly value: McpServerConfig } | { readonly ok: false; readonly code: McpProblemCode; readonly field: DraftField } {
  const pairs = draft.pairs.filter((pair) => pair.name.trim().length > 0 || pair.value.length > 0);
  for (const pair of pairs) {
    const valid = draft.transport === 'stdio' ? isMcpEnvName(pair.name) : isMcpHeaderName(pair.name);
    if (!valid) {
      return { ok: false, code: 'bad-name', field: 'pairs' };
    }
  }
  const lines = draft.args.length === 0 ? [] : draft.args.split('\n');
  const input =
    draft.transport === 'stdio'
      ? { transport: 'stdio', command: draft.command.trim(), args: lines, env: pairs }
      : { transport: draft.transport, url: draft.url.trim(), headers: pairs };
  const parsed = parseMcpServerConfig(input, 'server');
  if (parsed.ok) {
    return parsed;
  }
  return { ok: false, code: parsed.error.code, field: fieldOf(parsed.error.path) };
}

export type DraftField = 'url' | 'command' | 'args' | 'pairs' | 'server';

function fieldOf(path: string): DraftField {
  if (path.startsWith('server.url')) {
    return 'url';
  }
  if (path.startsWith('server.command')) {
    return 'command';
  }
  if (path.startsWith('server.args')) {
    return 'args';
  }
  if (path.startsWith('server.env') || path.startsWith('server.headers')) {
    return 'pairs';
  }
  return 'server';
}

/** Rows a draft can hold, matching the file's own bound. */
export const DRAFT_PAIRS_MAX = MCP_LIMITS.pairsMax;

/** The text a copy puts on the clipboard: the server as `.mcp.json` would hold it, literal values replaced by `***`. */
export function copyText(name: string, config: McpServerConfig): string {
  assert(name.length > 0, 'A copied server has a name');
  return JSON.stringify({ mcpServers: { [name]: mcpFileFields(redactMcpConfig(config)) } }, undefined, 2);
}

/** Whether a pair's value is a plain `${NAME}` style reference, which is shown as written rather than masked. */
export function isShownAlways(pair: McpPair): boolean {
  return pair.value.includes('${');
}
