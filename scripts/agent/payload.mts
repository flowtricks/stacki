// Boundary parser for Claude Code and Codex hook payloads (AGENTS.md §2: a
// value from outside is unknown until parsed). Both harnesses send one JSON
// object on stdin; the fields used here are common to both:
//
//   hook_event_name   PreToolUse | PostToolUse | Stop
//   session_id        stable for one agent session
//   cwd               where the agent was working
//   tool_name         Bash, Edit, Write, MultiEdit, NotebookEdit, apply_patch, …
//   tool_input        { command } for shells; { file_path } or a patch for edits
//
// The event name is checked against the event the hook was configured for:
// the configuration and the payload must agree (a paired assertion, §9).

import { POLICY_LIMITS } from '../policy/limits.mts';

export interface HookPayload {
  readonly sessionId: string;
  readonly cwd: string | undefined;
  readonly toolName: string | undefined;
  readonly toolInput: unknown;
  // The shell command the tool runs, when it runs one.
  readonly command: string | undefined;
  // Files named directly by the tool input (patch paths are read separately).
  readonly paths: readonly string[];
}

export type ParseResult = { readonly ok: true; readonly value: HookPayload } | { readonly ok: false; readonly error: string };

const EVENT_NAMES = {
  'pre-tool': 'PreToolUse',
  'post-tool': 'PostToolUse',
  stop: 'Stop',
} as const;
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
const PATH_FIELDS = ['file_path', 'notebook_path', 'path'] as const;
const FIELD_CHARS_MAX = 4_096;

export function parseHookPayload(raw: string, event: keyof typeof EVENT_NAMES): ParseResult {
  if (raw.length > POLICY_LIMITS.hookPayloadBytesMax) {
    return { ok: false, error: 'hook payload exceeds the size limit' };
  }
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch (error: unknown) {
    return { ok: false, error: `hook payload is not JSON: ${String(error)}` };
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'hook payload is not a JSON object' };
  }
  const eventName = field(input, 'hook_event_name');
  if (eventName !== undefined && eventName !== EVENT_NAMES[event]) {
    return { ok: false, error: `configured for ${EVENT_NAMES[event]}, received ${eventName}` };
  }
  const sessionId = field(input, 'session_id') ?? 'unknown-session';
  if (!SESSION_ID.test(sessionId)) {
    return { ok: false, error: 'hook payload session_id has an unexpected shape' };
  }
  const toolInput: unknown = Reflect.get(input, 'tool_input');
  const command = field(toolInput, 'command');
  const paths = PATH_FIELDS.map((name) => field(toolInput, name)).filter((value): value is string => value !== undefined);
  return {
    ok: true,
    value: {
      sessionId,
      cwd: field(input, 'cwd'),
      toolName: field(input, 'tool_name'),
      toolInput,
      command,
      paths,
    },
  };
}

// A string field of an object, bounded; absent when missing or not a string.
// Shared with the Pi adapter, whose events are parsed the same way.
export function field(container: unknown, name: string): string | undefined {
  if (typeof container !== 'object' || container === null) {
    return undefined;
  }
  const value: unknown = Reflect.get(container, name);
  if (typeof value !== 'string') {
    return undefined;
  }
  // A shell command can be long; every other field is a name or a path.
  const limit = name === 'command' ? POLICY_LIMITS.hookPayloadBytesMax : FIELD_CHARS_MAX;
  return value.length <= limit ? value : undefined;
}
