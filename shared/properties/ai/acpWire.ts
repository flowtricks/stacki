// The Agent Client Protocol as Stacki reads it: JSON-RPC 2.0, one message per
// line on an adapter's stdio (https://agentclientprotocol.com, protocol v1).
// Hand-written rather than taken from @agentclientprotocol/sdk: about a dozen
// methods matter to the panel, each parsed into a discriminated union with its
// bounds checked here (AGENTS.md §2, §10). The adapter is another program, so
// a line it gets wrong is an expected failure (`Result`), never a crash; an
// update kind this file does not know is kept as `unknown-update`, so a newer
// adapter degrades to a visible "unsupported" row instead of an error.
//
// Fixtures: test/shared/properties/ai/acpWire.test.ts replays lines recorded from
// the real adapters (test/fixtures/ai/) plus each bad shape.
import { assert } from '../../core/assert';
import { err, ok, type Result } from '../../core/result';
import { toArray, toRecord } from '../../core/record';
import { AI_LIMITS } from './aiLimits';

/** The protocol version Stacki speaks. */
export const ACP_PROTOCOL_VERSION = 1;
/** ACP's error code for "sign in first" (`AUTH_REQUIRED`). */
export const ACP_AUTH_REQUIRED = -32000;
/** JSON-RPC's "method not found". */
export const JSON_RPC_METHOD_NOT_FOUND = -32601;

export type JsonRpcId = number | string;

export type AcpMessage =
  | { readonly kind: 'request'; readonly id: JsonRpcId; readonly method: string; readonly params: unknown }
  | { readonly kind: 'notification'; readonly method: string; readonly params: unknown }
  | { readonly kind: 'result'; readonly id: JsonRpcId; readonly result: unknown }
  | { readonly kind: 'error'; readonly id: JsonRpcId; readonly code: number; readonly message: string };

export interface AcpWireError {
  readonly code: 'not-json' | 'not-json-rpc' | 'bad-shape';
  readonly message: string;
}

export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';
export type PermissionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
export type PlanStatus = 'pending' | 'in_progress' | 'completed';
export type PlanPriority = 'high' | 'medium' | 'low';
/** The lifecycle of a context compaction, as `compaction_update` names it. */
export type CompactionState = 'in_progress' | 'completed' | 'failed' | 'cancelled';
/** What `_session/steering` did with a message (acp-agent.js, `steerSession`). */
export type SteerOutcome = 'steered' | 'startedNewTurn' | 'promptRequired';

const TOOL_KINDS: readonly ToolKind[] = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'];
const TOOL_STATUSES: readonly ToolStatus[] = ['pending', 'in_progress', 'completed', 'failed'];
const STOP_REASONS: readonly StopReason[] = ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'];
const PERMISSION_KINDS: readonly PermissionKind[] = ['allow_once', 'allow_always', 'reject_once', 'reject_always'];
const PLAN_STATUSES: readonly PlanStatus[] = ['pending', 'in_progress', 'completed'];
const PLAN_PRIORITIES: readonly PlanPriority[] = ['high', 'medium', 'low'];
const COMPACTION_STATES: readonly CompactionState[] = ['in_progress', 'completed', 'failed', 'cancelled'];
const STEER_OUTCOMES: readonly SteerOutcome[] = ['steered', 'startedNewTurn', 'promptRequired'];

/** A content block, reduced to what the panel shows. Audio and blobs are named, not carried. */
export type AcpContent =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'image'; readonly mimeType: string }
  | { readonly kind: 'link'; readonly name: string; readonly uri: string }
  | { readonly kind: 'resource'; readonly uri: string; readonly text: string | undefined }
  | { readonly kind: 'other'; readonly type: string };

export type AcpToolContent =
  | { readonly kind: 'content'; readonly content: AcpContent }
  | { readonly kind: 'diff'; readonly path: string; readonly oldText: string | undefined; readonly newText: string }
  | { readonly kind: 'terminal'; readonly terminalId: string };

export interface AcpLocation {
  readonly path: string;
  readonly line: number | undefined;
}

/** A tool call as first announced, and each later update (fields absent mean "unchanged"). */
export interface AcpToolCall {
  readonly id: string;
  readonly title: string | undefined;
  readonly toolKind: ToolKind | undefined;
  readonly status: ToolStatus | undefined;
  readonly content: readonly AcpToolContent[] | undefined;
  readonly locations: readonly AcpLocation[] | undefined;
  /** Output streamed into the call (Codex sends it in `_meta.terminal_output_delta`). */
  readonly outputDelta: string | undefined;
  /** The exit code of a command the call ran, when it reported one. */
  readonly exitCode: number | undefined;
  /** The tool call a subagent's call runs under (Claude's `_meta.claudeCode.parentToolUseId`). */
  readonly parent: string | undefined;
  /** The agent's own name for the tool (Claude's `_meta.claudeCode.toolName`: `Bash`, `compact`). */
  readonly toolName: string | undefined;
  /** The three fields of `rawInput` the panel uses; the rest of the input is dropped. */
  readonly rawInput: AcpRawInput | undefined;
  /** What a Codex subagent call reports in `rawInput.activityKind` (`started`, ...). */
  readonly activityKind: string | undefined;
}

export interface AcpRawInput {
  readonly command: string | undefined;
  readonly description: string | undefined;
  /** Claude's `run_in_background` on a Bash call. */
  readonly runInBackground: boolean | undefined;
}

export interface AcpPlanEntry {
  readonly content: string;
  readonly status: PlanStatus;
  readonly priority: PlanPriority;
}

export interface AcpCommand {
  readonly name: string;
  readonly description: string;
  readonly hint: string | undefined;
}

export interface AcpConfigChoice {
  readonly value: string;
  readonly name: string;
  readonly description: string | undefined;
}

/** A session setting the agent offers: model, mode, effort and others. Only selects are offered to the person. */
export interface AcpConfigOption {
  readonly id: string;
  readonly name: string;
  readonly category: string | undefined;
  readonly currentValue: string;
  readonly choices: readonly AcpConfigChoice[];
}

export type AcpUpdate =
  | { readonly kind: 'message'; readonly role: 'agent' | 'thought' | 'user'; readonly content: AcpContent }
  | { readonly kind: 'tool-call'; readonly call: AcpToolCall }
  | { readonly kind: 'tool-call-update'; readonly call: AcpToolCall }
  | { readonly kind: 'plan'; readonly entries: readonly AcpPlanEntry[] }
  | { readonly kind: 'commands'; readonly commands: readonly AcpCommand[] }
  | { readonly kind: 'mode'; readonly modeId: string }
  | { readonly kind: 'config'; readonly options: readonly AcpConfigOption[] }
  | { readonly kind: 'info'; readonly title: string | undefined }
  | { readonly kind: 'usage'; readonly used: number; readonly size: number }
  | {
      readonly kind: 'compaction';
      readonly id: string;
      readonly status: CompactionState;
      readonly summary: string | undefined;
      readonly error: string | undefined;
    }
  /** A chunk of a compaction's summary: acknowledged and dropped, since the panel shows status only. */
  | { readonly kind: 'compaction-summary'; readonly id: string }
  | { readonly kind: 'notice'; readonly severity: string; readonly title: string; readonly message: string | undefined }
  | { readonly kind: 'unknown-update'; readonly sessionUpdate: string };

export interface AcpSessionNotification {
  readonly sessionId: string;
  readonly update: AcpUpdate;
}

export interface AcpInitialize {
  readonly protocolVersion: number;
  readonly agentName: string;
  readonly agentVersion: string;
  readonly loadSession: boolean;
  readonly resumeSession: boolean;
  readonly images: boolean;
  readonly embeddedContext: boolean;
  /** Top-level `_meta.steering.supported`: `_session/steering` injects a message into a running turn. */
  readonly steering: boolean;
  /** Claude's `agentCapabilities._meta.claudeCode.promptQueueing`: a second plain prompt queues. */
  readonly promptQueueing: boolean;
  /** `sessionCapabilities`: each is present as an object when the agent supports the method. */
  readonly fork: boolean;
  readonly close: boolean;
  readonly delete: boolean;
  readonly title: boolean;
}

export interface AcpMode {
  readonly id: string;
  readonly name: string;
  readonly description: string | undefined;
}

export interface AcpSession {
  readonly sessionId: string;
  readonly currentModeId: string | undefined;
  readonly modes: readonly AcpMode[];
  readonly options: readonly AcpConfigOption[];
}

export interface AcpPromptEnd {
  readonly stopReason: StopReason;
}

export interface AcpPermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: PermissionKind;
}

export interface AcpPermissionRequest {
  readonly sessionId: string;
  readonly call: AcpToolCall;
  readonly options: readonly AcpPermissionOption[];
}

export interface AcpReadFile {
  readonly sessionId: string;
  readonly path: string;
  /** 1-based first line, when the agent asked for part of the file. */
  readonly line: number | undefined;
  readonly limit: number | undefined;
}

export interface AcpWriteFile {
  readonly sessionId: string;
  readonly path: string;
  readonly content: string;
}

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

/** One line from an adapter, as a JSON-RPC message. The caller bounds the line's length. */
export function parseAcpLine(line: string): Result<AcpMessage, AcpWireError> {
  assert(line.length <= AI_LIMITS.lineBytesMax, 'parseAcpLine: the connection bounds a line before parsing it');
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (error: unknown) {
    return err({ code: 'not-json', message: String(error).slice(0, 200) });
  }
  const message = toRecord(value);
  if (message === undefined || message['jsonrpc'] !== '2.0') {
    // i18n-ignore: a protocol diagnostic for logs.
    return err({ code: 'not-json-rpc', message: 'Expected a JSON-RPC 2.0 object' });
  }
  const parsed = envelope(message);
  assert(!parsed.ok || parsed.value.kind.length > 0, 'parseAcpLine: a message has a kind');
  return parsed;
}

function envelope(message: Record<string, unknown>): Result<AcpMessage, AcpWireError> {
  const method = message['method'];
  const id = message['id'];
  const hasId = typeof id === 'number' || typeof id === 'string';
  if (typeof method === 'string') {
    if (method.length > AI_LIMITS.idCharsMax) {
      return bad('method name exceeds limit');
    }
    if (hasId) {
      return ok({ kind: 'request', id, method, params: message['params'] });
    }
    return ok({ kind: 'notification', method, params: message['params'] });
  }
  if (!hasId) {
    return bad('a response names its request id');
  }
  if ('error' in message) {
    const error = toRecord(message['error']);
    const code = error?.['code'];
    const text = error?.['message'];
    if (typeof code !== 'number' || typeof text !== 'string') {
      return bad('an error carries a code and a message');
    }
    return ok({ kind: 'error', id, code, message: text.slice(0, AI_LIMITS.labelCharsMax) });
  }
  return ok({ kind: 'result', id, result: message['result'] });
}

function bad(message: string): Result<never, AcpWireError> {
  assert(message.length > 0, 'bad: a refusal says why');
  return err({ code: 'bad-shape', message });
}

// ---------------------------------------------------------------------------
// Results Stacki asks for
// ---------------------------------------------------------------------------

export function parseInitializeResult(input: unknown): Result<AcpInitialize, AcpWireError> {
  return guarded(() => {
    const value = required(input, 'initialize');
    const version = value['protocolVersion'];
    if (typeof version !== 'number' || !Number.isSafeInteger(version)) {
      throw new Error('initialize.protocolVersion: expected integer');
    }
    const capabilities = toRecord(value['agentCapabilities']) ?? {};
    const prompt = toRecord(capabilities['promptCapabilities']) ?? {};
    const session = toRecord(capabilities['sessionCapabilities']) ?? {};
    const info = toRecord(value['agentInfo']) ?? {};
    const parsed: AcpInitialize = {
      protocolVersion: version,
      agentName: optionalText(info['name'], AI_LIMITS.labelCharsMax) ?? 'agent',
      agentVersion: optionalText(info['version'], AI_LIMITS.idCharsMax) ?? '',
      loadSession: capabilities['loadSession'] === true,
      resumeSession: toRecord(session['resume']) !== undefined,
      images: prompt['image'] === true,
      embeddedContext: prompt['embeddedContext'] === true,
      // Declared as `_meta` extensions, so both are optional objects a plain agent omits.
      steering: toRecord(toRecord(value['_meta'])?.['steering'])?.['supported'] === true,
      promptQueueing: toRecord(toRecord(toRecord(capabilities['_meta'])?.['claudeCode']))?.['promptQueueing'] === true,
      fork: toRecord(session['fork']) !== undefined,
      close: toRecord(session['close']) !== undefined,
      delete: toRecord(session['delete']) !== undefined,
      title: toRecord(session['title']) !== undefined,
    };
    assert(parsed.agentName.length > 0, 'initialize: the agent has a name');
    return parsed;
  });
}

export function parseSessionResult(input: unknown, sessionId: string | undefined): Result<AcpSession, AcpWireError> {
  return guarded(() => {
    const value = required(input, 'session');
    // `session/new` names the session; `session/load` and `session/resume` answer for the one asked about.
    const id = sessionId ?? requiredText(value['sessionId'], AI_LIMITS.idCharsMax, 'session.sessionId');
    const modes = toRecord(value['modes']);
    const available = modes === undefined ? [] : bounded(modes['availableModes'], AI_LIMITS.configChoicesMax, 'session.modes');
    const session: AcpSession = {
      sessionId: id,
      currentModeId: modes === undefined ? undefined : optionalText(modes['currentModeId'], AI_LIMITS.idCharsMax),
      modes: available.map(parseMode),
      options: parseConfigOptions(value['configOptions']),
    };
    assert(session.sessionId.length > 0, 'session: a session has an id');
    return session;
  });
}

/** The answer to `_session/steering`: what the adapter did with the message. An outcome it does not name is a failure. */
export function parseSteerResult(input: unknown): Result<{ readonly outcome: SteerOutcome }, AcpWireError> {
  return guarded(() => {
    const value = required(input, 'steering');
    const outcome = oneOf(value['outcome'], STEER_OUTCOMES, 'steering.outcome');
    assert(STEER_OUTCOMES.includes(outcome), 'steering: a known outcome');
    return { outcome };
  });
}

/** The answer to `session/fork`: the new session, shaped like `session/new`'s. */
export function parseForkResult(input: unknown): Result<AcpSession, AcpWireError> {
  return parseSessionResult(input, undefined);
}

export function parsePromptResult(input: unknown): Result<AcpPromptEnd, AcpWireError> {
  return guarded(() => {
    const value = required(input, 'prompt');
    const stopReason = oneOf(value['stopReason'], STOP_REASONS, 'prompt.stopReason');
    assert(STOP_REASONS.includes(stopReason), 'prompt: a known stop reason');
    return { stopReason };
  });
}

// ---------------------------------------------------------------------------
// What the adapter sends Stacki
// ---------------------------------------------------------------------------

export function parseSessionNotification(input: unknown): Result<AcpSessionNotification, AcpWireError> {
  return guarded(() => {
    const value = required(input, 'session/update');
    const sessionId = requiredText(value['sessionId'], AI_LIMITS.idCharsMax, 'session/update.sessionId');
    const update = required(value['update'], 'session/update.update');
    const parsed = { sessionId, update: parseUpdate(update) };
    assert(parsed.update.kind.length > 0, 'session/update: an update has a kind');
    return parsed;
  });
}

export function parsePermissionRequest(input: unknown): Result<AcpPermissionRequest, AcpWireError> {
  return guarded(() => {
    const value = required(input, 'request_permission');
    const sessionId = requiredText(value['sessionId'], AI_LIMITS.idCharsMax, 'request_permission.sessionId');
    const options = bounded(value['options'], AI_LIMITS.permissionOptionsMax, 'request_permission.options').map((option) => {
      const entry = required(option, 'permission option');
      return {
        optionId: requiredText(entry['optionId'], AI_LIMITS.idCharsMax, 'permission.optionId'),
        name: requiredText(entry['name'], AI_LIMITS.labelCharsMax, 'permission.name'),
        kind: oneOf(entry['kind'], PERMISSION_KINDS, 'permission.kind'),
      };
    });
    if (options.length === 0) {
      throw new Error('request_permission: no options to choose from');
    }
    const request = { sessionId, call: parseToolCall(required(value['toolCall'], 'request_permission.toolCall')), options };
    assert(request.options.length <= AI_LIMITS.permissionOptionsMax, 'request_permission: options are bounded');
    return request;
  });
}

export function parseReadFileRequest(input: unknown): Result<AcpReadFile, AcpWireError> {
  return guarded(() => {
    const value = required(input, 'fs/read_text_file');
    const request = {
      sessionId: requiredText(value['sessionId'], AI_LIMITS.idCharsMax, 'read.sessionId'),
      path: requiredText(value['path'], AI_LIMITS.labelCharsMax, 'read.path'),
      line: optionalCount(value['line'], 'read.line'),
      limit: optionalCount(value['limit'], 'read.limit'),
    };
    assert(request.path.length > 0, 'fs/read_text_file: a path is named');
    return request;
  });
}

export function parseWriteFileRequest(input: unknown): Result<AcpWriteFile, AcpWireError> {
  return guarded(() => {
    const value = required(input, 'fs/write_text_file');
    const request = {
      sessionId: requiredText(value['sessionId'], AI_LIMITS.idCharsMax, 'write.sessionId'),
      path: requiredText(value['path'], AI_LIMITS.labelCharsMax, 'write.path'),
      content: requiredText(value['content'], AI_LIMITS.fileCharsMax, 'write.content'),
    };
    assert(request.path.length > 0, 'fs/write_text_file: a path is named');
    return request;
  });
}

// ---------------------------------------------------------------------------
// Session updates
// ---------------------------------------------------------------------------

function parseUpdate(update: Record<string, unknown>): AcpUpdate {
  const kind = requiredText(update['sessionUpdate'], AI_LIMITS.idCharsMax, 'update.sessionUpdate');
  switch (kind) {
    case 'agent_message_chunk':
      return { kind: 'message', role: 'agent', content: parseContent(update['content']) };
    case 'agent_thought_chunk':
      return { kind: 'message', role: 'thought', content: parseContent(update['content']) };
    case 'user_message_chunk':
      return { kind: 'message', role: 'user', content: parseContent(update['content']) };
    case 'tool_call':
      return { kind: 'tool-call', call: parseToolCall(update) };
    case 'tool_call_update':
      return { kind: 'tool-call-update', call: parseToolCall(update) };
    case 'plan':
      return { kind: 'plan', entries: bounded(update['entries'], AI_LIMITS.planEntriesMax, 'plan.entries').map(parsePlanEntry) };
    case 'available_commands_update':
      return { kind: 'commands', commands: bounded(update['availableCommands'], AI_LIMITS.commandsMax, 'commands').map(parseCommand) };
    case 'current_mode_update':
      return { kind: 'mode', modeId: requiredText(update['currentModeId'], AI_LIMITS.idCharsMax, 'mode.currentModeId') };
    case 'config_option_update':
      return { kind: 'config', options: parseConfigOptions(update['configOptions']) };
    case 'session_info_update':
      return { kind: 'info', title: optionalText(update['title'], AI_LIMITS.titleCharsMax * 4) };
    case 'usage_update':
      return { kind: 'usage', used: tokenCount(update['used'], 'usage.used'), size: tokenCount(update['size'], 'usage.size') };
    case 'compaction_update': {
      const status = optionalOneOf(update['status'], COMPACTION_STATES);
      // A status the protocol reserves for later (or an `_`-prefixed extension) is shown as an unsupported update, not guessed at.
      if (status === undefined) {
        return { kind: 'unknown-update', sessionUpdate: kind };
      }
      return {
        kind: 'compaction',
        id: requiredText(update['compactionId'], AI_LIMITS.idCharsMax, 'compaction.compactionId'),
        status,
        summary: optionalText(update['summary'], AI_LIMITS.labelCharsMax),
        error: optionalText(update['error'], AI_LIMITS.labelCharsMax),
      };
    }
    case 'compaction_summary_chunk':
      return { kind: 'compaction-summary', id: requiredText(update['compactionId'], AI_LIMITS.idCharsMax, 'compaction.compactionId') };
    case 'notice':
      return {
        kind: 'notice',
        severity: optionalText(update['severity'], AI_LIMITS.idCharsMax) ?? 'info',
        title: requiredText(update['title'], AI_LIMITS.labelCharsMax, 'notice.title'),
        message: optionalText(update['message'], AI_LIMITS.labelCharsMax),
      };
    default:
      return { kind: 'unknown-update', sessionUpdate: kind };
  }
}

function parseToolCall(value: Record<string, unknown>): AcpToolCall {
  const meta = toRecord(value['_meta']);
  const delta = toRecord(meta?.['terminal_output_delta']);
  const exit = toRecord(meta?.['terminal_exit']);
  const claude = toRecord(meta?.['claudeCode']);
  const raw = toRecord(value['rawInput']);
  const content = value['content'];
  const locations = value['locations'];
  const call: AcpToolCall = {
    id: requiredText(value['toolCallId'], AI_LIMITS.idCharsMax, 'toolCall.toolCallId'),
    title: optionalText(value['title'], AI_LIMITS.labelCharsMax),
    toolKind: optionalOneOf(value['kind'], TOOL_KINDS),
    status: optionalOneOf(value['status'], TOOL_STATUSES),
    content: content === undefined || content === null ? undefined : skipInvalid(content, AI_LIMITS.toolContentMax, parseToolContent),
    locations: locations === undefined || locations === null ? undefined : skipInvalid(locations, AI_LIMITS.locationsMax, parseLocation),
    outputDelta: optionalText(delta?.['data'], AI_LIMITS.toolOutputCharsMax),
    exitCode: typeof exit?.['exit_code'] === 'number' && Number.isSafeInteger(exit['exit_code']) ? exit['exit_code'] : undefined,
    parent: optionalText(claude?.['parentToolUseId'], AI_LIMITS.idCharsMax),
    toolName: optionalText(claude?.['toolName'], AI_LIMITS.idCharsMax),
    rawInput: parseRawInput(raw),
    activityKind: optionalText(raw?.['activityKind'], AI_LIMITS.idCharsMax),
  };
  assert(call.id.length > 0, 'toolCall: a call has an id');
  return call;
}

// Only three fields of a tool's input matter to the panel; the input itself can be a whole file.
function parseRawInput(raw: Record<string, unknown> | undefined): AcpRawInput | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const command = typeof raw['command'] === 'string' ? optionalText(raw['command'], AI_LIMITS.labelCharsMax) : undefined;
  const description = optionalText(raw['description'], AI_LIMITS.labelCharsMax);
  const runInBackground = typeof raw['run_in_background'] === 'boolean' ? raw['run_in_background'] : undefined;
  if (command === undefined && description === undefined && runInBackground === undefined) {
    return undefined;
  }
  return { command, description, runInBackground };
}

function parseToolContent(input: unknown): AcpToolContent {
  const value = required(input, 'tool content');
  const type = value['type'];
  if (type === 'diff') {
    return {
      kind: 'diff',
      path: requiredText(value['path'], AI_LIMITS.labelCharsMax, 'diff.path'),
      oldText: optionalText(value['oldText'], AI_LIMITS.fileCharsMax),
      newText: requiredText(value['newText'], AI_LIMITS.fileCharsMax, 'diff.newText'),
    };
  }
  if (type === 'terminal') {
    return { kind: 'terminal', terminalId: requiredText(value['terminalId'], AI_LIMITS.idCharsMax, 'terminal.terminalId') };
  }
  if (type === 'content') {
    return { kind: 'content', content: parseContent(value['content']) };
  }
  throw new Error('tool content: unknown type');
}

function parseLocation(input: unknown): AcpLocation {
  const value = required(input, 'location');
  return { path: requiredText(value['path'], AI_LIMITS.labelCharsMax, 'location.path'), line: optionalCount(value['line'], 'location.line') };
}

/** A content block. An unknown type is kept by name, so a new kind of block shows as unsupported, not as an error. */
export function parseContent(input: unknown): AcpContent {
  const value = required(input, 'content');
  const type = requiredText(value['type'], AI_LIMITS.idCharsMax, 'content.type');
  switch (type) {
    case 'text':
      return { kind: 'text', text: requiredText(value['text'], AI_LIMITS.textCharsMax, 'content.text') };
    case 'image':
      return { kind: 'image', mimeType: optionalText(value['mimeType'], AI_LIMITS.idCharsMax) ?? 'image' };
    case 'resource_link':
      return {
        kind: 'link',
        name: requiredText(value['name'], AI_LIMITS.labelCharsMax, 'link.name'),
        uri: requiredText(value['uri'], AI_LIMITS.labelCharsMax, 'link.uri'),
      };
    case 'resource': {
      const resource = required(value['resource'], 'resource.resource');
      return {
        kind: 'resource',
        uri: requiredText(resource['uri'], AI_LIMITS.labelCharsMax, 'resource.uri'),
        text: optionalText(resource['text'], AI_LIMITS.fileCharsMax),
      };
    }
    default:
      return { kind: 'other', type };
  }
}

function parsePlanEntry(input: unknown): AcpPlanEntry {
  const value = required(input, 'plan entry');
  return {
    content: requiredText(value['content'], AI_LIMITS.labelCharsMax, 'plan.content'),
    status: oneOf(value['status'], PLAN_STATUSES, 'plan.status'),
    priority: optionalOneOf(value['priority'], PLAN_PRIORITIES) ?? 'medium',
  };
}

function parseCommand(input: unknown): AcpCommand {
  const value = required(input, 'command');
  const commandInput = toRecord(value['input']);
  return {
    name: requiredText(value['name'], AI_LIMITS.idCharsMax, 'command.name'),
    description: optionalText(value['description'], AI_LIMITS.labelCharsMax) ?? '',
    hint: optionalText(commandInput?.['hint'], AI_LIMITS.labelCharsMax),
  };
}

function parseMode(input: unknown): AcpMode {
  const value = required(input, 'mode');
  return {
    id: requiredText(value['id'], AI_LIMITS.idCharsMax, 'mode.id'),
    name: requiredText(value['name'], AI_LIMITS.labelCharsMax, 'mode.name'),
    description: optionalText(value['description'], AI_LIMITS.labelCharsMax),
  };
}

/** Select options only, flattened out of their groups; a boolean or unknown option is skipped, as the spec allows. */
export function parseConfigOptions(input: unknown): readonly AcpConfigOption[] {
  if (input === undefined || input === null) {
    return [];
  }
  const options = skipInvalid(input, AI_LIMITS.configOptionsMax, (entry) => {
    const value = required(entry, 'config option');
    if (value['type'] !== 'select') {
      throw new Error('config option: only selects are offered');
    }
    return {
      id: requiredText(value['id'], AI_LIMITS.idCharsMax, 'config.id'),
      name: requiredText(value['name'], AI_LIMITS.labelCharsMax, 'config.name'),
      category: optionalText(value['category'], AI_LIMITS.idCharsMax),
      currentValue: requiredText(value['currentValue'], AI_LIMITS.idCharsMax, 'config.currentValue'),
      choices: configChoices(value['options']),
    };
  });
  assert(options.length <= AI_LIMITS.configOptionsMax, 'config options are bounded');
  return options;
}

function configChoices(input: unknown): readonly AcpConfigChoice[] {
  const entries = bounded(input, AI_LIMITS.configChoicesMax, 'config.options');
  const choices: AcpConfigChoice[] = [];
  for (const entry of entries) {
    const value = required(entry, 'config choice');
    const grouped = toArray(value['options']);
    const members = grouped === undefined ? [value] : grouped.map((member) => required(member, 'config choice'));
    for (const member of members) {
      if (choices.length >= AI_LIMITS.configChoicesMax) {
        throw new Error('config.options: exceeds limit');
      }
      choices.push({
        value: requiredText(member['value'], AI_LIMITS.idCharsMax, 'choice.value'),
        name: requiredText(member['name'], AI_LIMITS.labelCharsMax, 'choice.name'),
        description: optionalText(member['description'], AI_LIMITS.labelCharsMax),
      });
    }
  }
  return choices;
}

// ---------------------------------------------------------------------------
// Bounded field readers. JSON says "absent" with null, so null reads as undefined.
// ---------------------------------------------------------------------------

function guarded<T>(parse: () => T): Result<T, AcpWireError> {
  try {
    return ok(parse());
  } catch (error: unknown) {
    // A thrown parse error is a malformed message from another program: an expected failure here.
    return err({ code: 'bad-shape', message: error instanceof Error ? error.message : String(error) });
  }
}

function required(input: unknown, label: string): Record<string, unknown> {
  const value = toRecord(input);
  if (value === undefined) {
    throw new Error(`${label}: expected object`);
  }
  return value;
}

function requiredText(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string') {
    throw new Error(`${label}: expected string`);
  }
  if (input.length > max) {
    throw new Error(`${label}: exceeds limit`);
  }
  return input;
}

function optionalText(input: unknown, max: number): string | undefined {
  if (typeof input !== 'string') {
    return undefined;
  }
  // An over-long optional label is cut, not refused: it is display text.
  return input.length > max ? input.slice(0, max) : input;
}

function requiredCount(input: unknown, label: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) {
    throw new Error(`${label}: expected nonnegative integer`);
  }
  return input;
}

/** A token count: a nonnegative integer within the sanity ceiling, so a bad number cannot reach a percentage. */
function tokenCount(input: unknown, label: string): number {
  const value = requiredCount(input, label);
  if (value > AI_LIMITS.contextTokensMax) {
    throw new Error(`${label}: exceeds limit`);
  }
  return value;
}

function optionalCount(input: unknown, label: string): number | undefined {
  return input === undefined || input === null ? undefined : requiredCount(input, label);
}

function oneOf<T extends string>(input: unknown, allowed: readonly T[], label: string): T {
  const found = allowed.find((candidate) => candidate === input);
  if (found === undefined) {
    throw new Error(`${label}: unknown value`);
  }
  return found;
}

function optionalOneOf<T extends string>(input: unknown, allowed: readonly T[]): T | undefined {
  return allowed.find((candidate) => candidate === input);
}

function bounded(input: unknown, max: number, label: string): readonly unknown[] {
  const values = toArray(input);
  if (values === undefined) {
    throw new Error(`${label}: expected array`);
  }
  if (values.length > max) {
    throw new Error(`${label}: exceeds limit`);
  }
  return values;
}

// The spec marks content and locations `x-deserialize-skip-invalid-items`: one bad item is dropped, not the message.
function skipInvalid<T>(input: unknown, max: number, parse: (item: unknown) => T): readonly T[] {
  const values = bounded(input, max, 'list');
  const parsed: T[] = [];
  for (const value of values) {
    try {
      parsed.push(parse(value));
    } catch {
      continue;
    }
  }
  assert(parsed.length <= values.length, 'skipInvalid: never more items than were sent');
  return parsed;
}
