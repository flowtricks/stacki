// The Settings panel's MCP tab: the contract between the renderer and the main process. The project's
// `.mcp.json` is listed as summaries (a card's words), never as values: a literal environment or header
// value crosses once, in an `mcp:reveal` reply, when a person edits that server, and never in a listing, an
// error or a log line. The raw file text crosses only for the JSON view, in `mcp:readText`. Every change names
// the revision (a digest of the file's exact bytes) it was authored against, so a file edited outside Stacki
// is refused with `changed` rather than overwritten.
//
// Codex keeps its servers in the person's own `~/.codex/config.toml`, outside the project. The renderer
// never names that path: main uses one fixed path under the home folder. A Codex change names a server of
// the project by name only; main reads that server from `.mcp.json` itself, so no value travels through
// the renderer on its way to the Codex file.
//
// The files are read and printed by mcpJson.ts and mcpToml.ts; this module is the wire shape and the
// parsers for both directions.
import { assert } from '../core/assert';
import { digest, optional, record, text } from '../core/boundary';
import type { Digest } from '../core/brand';
import type { Result } from '../core/result';
import {
  MCP_LIMITS,
  MCP_PROBLEM_CODES,
  isMcpServerName,
  parseMcpServerConfig,
  type McpPairSummary,
  type McpProblem,
  type McpServerConfig,
  type McpServerSummary,
} from './mcpConfig';

export const MCP_ERROR_CODES = [
  'changed',
  'name-taken',
  'not-found',
  'invalid-name',
  'invalid',
  'limit',
  'unreadable',
  'too-large',
  'not-text',
  'denied',
  'filesystem',
  'unmappable',
  'codex-unavailable',
  'codex-unsupported',
] as const;
export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];

/** A failure the panel shows. The message is fixed text per code: it never holds a name, a value or file text. */
export interface McpError {
  readonly code: McpErrorCode;
  readonly message: string;
}

export type McpResult<T> = Result<T, McpError>;

/** One server of a file as a card shows it. A malformed entry is listed, never dropped. */
export type McpServerItem =
  | { readonly name: string; readonly status: 'server'; readonly summary: McpServerSummary }
  | { readonly name: string; readonly status: 'invalid'; readonly problem: McpProblem };

export interface McpListing {
  /** The digest of the file's bytes, or of no bytes when the file does not exist. */
  readonly revision: Digest;
  readonly exists: boolean;
  readonly servers: readonly McpServerItem[];
}

/** The file as text, for the JSON view. An absent file is empty text. */
export interface McpText {
  readonly revision: Digest;
  readonly exists: boolean;
  readonly text: string;
}

/** What Codex's file looks like to the panel: absent, unusable (and why, in words that hold no content), or readable. */
export type McpCodexState =
  | { readonly state: 'missing' }
  | { readonly state: 'unavailable'; readonly code: Extract<McpErrorCode, 'unreadable' | 'too-large' | 'not-text' | 'denied' | 'codex-unsupported'> }
  | { readonly state: 'ready'; readonly revision: Digest; readonly servers: readonly McpServerItem[] };

export type McpChange =
  | { readonly kind: 'add'; readonly name: string; readonly config: McpServerConfig }
  | { readonly kind: 'update'; readonly name: string; readonly config: McpServerConfig }
  | { readonly kind: 'remove'; readonly name: string };

export type McpCodexChange = { readonly kind: 'put'; readonly name: string } | { readonly kind: 'remove'; readonly name: string };

const CODEX_UNAVAILABLE_CODES = ['unreadable', 'too-large', 'not-text', 'denied', 'codex-unsupported'] as const;

export function parseMcpServerName(input: unknown): string {
  const name = text(input);
  if (!isMcpServerName(name)) {
    throw new Error('MCP: expected a server name');
  }
  return name;
}

function parseConfigField(input: unknown): McpServerConfig {
  const parsed = parseMcpServerConfig(input, 'config');
  if (!parsed.ok) {
    throw new Error('MCP: expected a server configuration');
  }
  return parsed.value;
}

/** A change a person made in the panel, checked before it leaves the renderer and again in main. */
export function parseMcpChange(input: unknown): McpChange {
  const fields = record(input);
  const kind = fields['kind'];
  if (kind === 'add' || kind === 'update') {
    return { kind, name: parseMcpServerName(fields['name']), config: parseConfigField(fields['config']) };
  }
  if (kind === 'remove') {
    return { kind, name: parseMcpServerName(fields['name']) };
  }
  throw new Error('MCP: unknown change');
}

export function parseMcpCodexChange(input: unknown): McpCodexChange {
  const fields = record(input);
  const kind = fields['kind'];
  if (kind === 'put' || kind === 'remove') {
    return { kind, name: parseMcpServerName(fields['name']) };
  }
  throw new Error('MCP: unknown Codex change');
}

/** The raw file text a person saved from the JSON view, bounded here and checked again in main. */
export function parseMcpTextInput(input: unknown): string {
  if (typeof input !== 'string' || input.length > MCP_LIMITS.fileBytesMax) {
    throw new Error('MCP: expected file text within the limit');
  }
  return input;
}

export const parseMcpRevision = digest;

export function parseMcpListing(input: unknown): McpListing {
  const fields = record(input);
  const servers = fields['servers'];
  if (!Array.isArray(servers) || servers.length > MCP_LIMITS.serversMax) {
    throw new Error('MCP: expected a bounded server list');
  }
  const exists = fields['exists'];
  if (typeof exists !== 'boolean') {
    throw new Error('MCP: expected a presence flag');
  }
  return { revision: digest(fields['revision']), exists, servers: servers.map(parseServerItem) };
}

export function parseMcpText(input: unknown): McpText {
  const fields = record(input);
  const exists = fields['exists'];
  if (typeof exists !== 'boolean') {
    throw new Error('MCP: expected a presence flag');
  }
  return { revision: digest(fields['revision']), exists, text: parseMcpTextInput(fields['text']) };
}

export function parseMcpConfigReply(input: unknown): McpServerConfig {
  return parseConfigField(input);
}

export function parseMcpCodexState(input: unknown): McpCodexState {
  const fields = record(input);
  const state = fields['state'];
  if (state === 'missing') {
    return { state };
  }
  if (state === 'unavailable') {
    const code = CODEX_UNAVAILABLE_CODES.find((known) => known === fields['code']);
    if (code === undefined) {
      throw new Error('MCP: unknown Codex failure');
    }
    return { state, code };
  }
  if (state === 'ready') {
    const servers = fields['servers'];
    if (!Array.isArray(servers) || servers.length > MCP_LIMITS.serversMax) {
      throw new Error('MCP: expected a bounded Codex server list');
    }
    return { state, revision: digest(fields['revision']), servers: servers.map(parseServerItem) };
  }
  throw new Error('MCP: unknown Codex state');
}

/** A reply that is either a value parsed by `parseValue` or a failure with a known code. */
export function parseMcpResult<T>(input: unknown, parseValue: (value: unknown) => T): McpResult<T> {
  const fields = record(input);
  if (fields['ok'] === true) {
    return { ok: true, value: parseValue(fields['value']) };
  }
  if (fields['ok'] !== false) {
    throw new Error('MCP: expected a result');
  }
  const failure = record(fields['error']);
  const code = MCP_ERROR_CODES.find((known) => known === failure['code']);
  if (code === undefined) {
    throw new Error('MCP: unknown failure code');
  }
  const message = text(failure['message']);
  assert(message.length <= 200, 'An MCP failure message is short');
  return { ok: false, error: { code, message } };
}

function parseServerItem(input: unknown): McpServerItem {
  const fields = record(input);
  const name = text(fields['name']);
  if (name.length === 0 || name.length > MCP_LIMITS.nameCharsMax) {
    throw new Error('MCP: expected a server name');
  }
  if (fields['status'] === 'server') {
    return { name, status: 'server', summary: parseSummary(fields['summary']) };
  }
  if (fields['status'] === 'invalid') {
    const problem = record(fields['problem']);
    const code = MCP_PROBLEM_CODES.find((known) => known === problem['code']);
    if (code === undefined) {
      throw new Error('MCP: unknown problem code');
    }
    return { name, status: 'invalid', problem: { code, path: text(problem['path']) } };
  }
  throw new Error('MCP: unknown server status');
}

function parseSummary(input: unknown): McpServerSummary {
  const fields = record(input);
  const transport = fields['transport'];
  if (transport === 'stdio') {
    const argumentCount = fields['argumentCount'];
    if (typeof argumentCount !== 'number' || !Number.isSafeInteger(argumentCount) || argumentCount < 0 || argumentCount > MCP_LIMITS.argsMax) {
      throw new Error('MCP: expected an argument count');
    }
    return {
      transport,
      command: text(fields['command']),
      argumentCount,
      env: parsePairSummaries(fields['env']),
      secretNames: parseNames(fields['secretNames']),
    };
  }
  if (transport === 'http' || transport === 'sse') {
    return { transport, host: text(fields['host']), headers: parsePairSummaries(fields['headers']), secretNames: parseNames(fields['secretNames']) };
  }
  throw new Error('MCP: unknown transport');
}

function parsePairSummaries(input: unknown): readonly McpPairSummary[] {
  if (!Array.isArray(input) || input.length > MCP_LIMITS.pairsMax) {
    throw new Error('MCP: expected bounded pairs');
  }
  return input.map((item): McpPairSummary => {
    const fields = record(item);
    return { name: text(fields['name']), reference: optional(text)(fields['reference']) };
  });
}

function parseNames(input: unknown): readonly string[] {
  if (!Array.isArray(input) || input.length > MCP_LIMITS.pairsMax * 4) {
    throw new Error('MCP: expected bounded names');
  }
  return input.map((item) => text(item));
}
