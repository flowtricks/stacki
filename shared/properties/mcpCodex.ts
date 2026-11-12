// The MCP tab's Codex mapping: how a server in the panel's model (mcpConfig.ts) is spelled in Codex's
// `[mcp_servers.<name>]` tables, and back. Pure; the TOML text itself is mcpToml.ts.
//
// Why a mapping and not a copy: `.mcp.json` lets a value say `${NAME}` and Claude Code expands it, but
// Codex does not expand anything in its config. Codex instead names the environment variables it
// forwards (`env_vars`, `bearer_token_env_var`, `env_http_headers`). So a reference that stands for a
// whole value maps to one of those; a reference buried inside longer text has no Codex spelling, and
// the mapping refuses it rather than writing a string Codex would send literally.
//
// Keys the mapping manages are listed in CODEX_MANAGED_KEYS. Any other key a person keeps in a table
// (`enabled`, `startup_timeout_sec`, `cwd`) is not the mapping's to touch.
//
// The stdio keys (`command`, `args`, `env`, `env_vars`) are checked against a real Codex file. The
// remote keys (`url`, `bearer_token_env_var`, `http_headers`, `env_http_headers`) come from the Codex
// documentation and are not checked against an installed Codex, so verify them.
import { assert } from '../core/assert';
import { err, ok, type Result } from '../core/result';
import { MCP_LIMITS, isMcpEnvName, isMcpHeaderName, mcpPlaceholders, parseMcpServerConfig, type McpPair, type McpServerConfig } from './mcpConfig';

export const CODEX_MANAGED_KEYS = ['command', 'args', 'env_vars', 'env', 'url', 'bearer_token_env_var', 'http_headers', 'env_http_headers'] as const;
export type CodexManagedKey = (typeof CODEX_MANAGED_KEYS)[number];

/** The managed keys that are tables of strings: a sub-table `[mcp_servers.x.env]` or an inline table. */
export const CODEX_TABLE_KEYS = ['env', 'http_headers', 'env_http_headers'] as const;
export type CodexTableKey = (typeof CODEX_TABLE_KEYS)[number];

/** The top-level table every Codex MCP server lives under. */
export const CODEX_SERVERS_TABLE = 'mcp_servers';

/** A server as Codex's keys hold it. Pairs keep their order; an absent scalar is `undefined`. */
export interface CodexFields {
  readonly command: string | undefined;
  readonly args: readonly string[];
  /** Names Codex forwards from its own environment. */
  readonly envVars: readonly string[];
  /** Literal environment values. */
  readonly env: readonly McpPair[];
  readonly url: string | undefined;
  /** The variable whose value is sent as `Authorization: Bearer <value>`. */
  readonly bearerTokenEnvVar: string | undefined;
  /** Literal headers. */
  readonly httpHeaders: readonly McpPair[];
  /** Headers whose value is read from the named variable: header name, then variable name. */
  readonly envHttpHeaders: readonly McpPair[];
}

export interface CodexMapProblem {
  readonly code: 'unmappable';
}

const WHOLE_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const BEARER_REFERENCE = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const BARE_KEY = /^[A-Za-z0-9_-]+$/;

/** A TOML key segment: bare when it can be, otherwise a quoted string (so `my.server` stays one segment). */
export function tomlKey(segment: string): string {
  assert(segment.length > 0, 'A TOML key segment is not empty');
  return BARE_KEY.test(segment) ? segment : tomlString(segment);
}

/** A TOML basic string with every character that needs it escaped. */
export function tomlString(value: string): string {
  assert(value.length <= MCP_LIMITS.pastedCharsMax * 4, 'A TOML string is bounded before it is written');
  let quoted = '"';
  for (const character of value) {
    quoted += escapeCharacter(character);
  }
  quoted += '"';
  assert(quoted.length >= value.length + 2, 'A quoted string holds its text and two quotes');
  return quoted;
}

function escapeCharacter(character: string): string {
  switch (character) {
    case '"':
      return '\\"';
    case '\\':
      return '\\\\';
    case '\b':
      return '\\b';
    case '\t':
      return '\\t';
    case '\n':
      return '\\n';
    case '\f':
      return '\\f';
    case '\r':
      return '\\r';
    default: {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? `\\u${code.toString(16).padStart(4, '0')}` : character;
    }
  }
}

/** The header path of a server's table, such as `mcp_servers."my.server"`. */
export function codexTablePath(name: string): string {
  return `${CODEX_SERVERS_TABLE}.${tomlKey(name)}`;
}

/**
 * Codex's spelling of a server, or `unmappable` when it has none: an SSE server (Codex speaks stdio and
 * streamable HTTP), a reference that is not a whole value, or an environment variable whose name differs
 * from the variable it would forward.
 */
export function toCodexFields(config: McpServerConfig): Result<CodexFields, CodexMapProblem> {
  if (config.transport === 'sse') {
    return err({ code: 'unmappable' });
  }
  if (config.transport === 'stdio') {
    return stdioFields(config);
  }
  return remoteFields(config);
}

function emptyFields(): CodexFields {
  return { command: undefined, args: [], envVars: [], env: [], url: undefined, bearerTokenEnvVar: undefined, httpHeaders: [], envHttpHeaders: [] };
}

function stdioFields(config: Extract<McpServerConfig, { readonly transport: 'stdio' }>): Result<CodexFields, CodexMapProblem> {
  const texts = [config.command, ...config.args];
  if (texts.some((text) => mcpPlaceholders(text).length > 0)) {
    return err({ code: 'unmappable' });
  }
  const env: McpPair[] = [];
  const envVars: string[] = [];
  for (const pair of config.env) {
    const whole = WHOLE_REFERENCE.exec(pair.value)?.[1];
    if (whole !== undefined) {
      // Codex forwards a variable under its own name, so the child must expect that same name.
      if (whole !== pair.name) {
        return err({ code: 'unmappable' });
      }
      envVars.push(whole);
    } else if (mcpPlaceholders(pair.value).length > 0) {
      return err({ code: 'unmappable' });
    } else {
      env.push(pair);
    }
  }
  assert(env.length + envVars.length === config.env.length, 'Every environment pair is written exactly once');
  return ok({ ...emptyFields(), command: config.command, args: config.args, envVars, env });
}

function remoteFields(config: Extract<McpServerConfig, { readonly transport: 'http' | 'sse' }>): Result<CodexFields, CodexMapProblem> {
  if (mcpPlaceholders(config.url).length > 0) {
    return err({ code: 'unmappable' });
  }
  let bearerTokenEnvVar: string | undefined;
  const httpHeaders: McpPair[] = [];
  const envHttpHeaders: McpPair[] = [];
  for (const header of config.headers) {
    const bearer = BEARER_REFERENCE.exec(header.value)?.[1];
    const whole = WHOLE_REFERENCE.exec(header.value)?.[1];
    if (bearer !== undefined && header.name.toLowerCase() === 'authorization' && bearerTokenEnvVar === undefined) {
      bearerTokenEnvVar = bearer;
    } else if (whole !== undefined) {
      envHttpHeaders.push({ name: header.name, value: whole });
    } else if (mcpPlaceholders(header.value).length > 0) {
      return err({ code: 'unmappable' });
    } else {
      httpHeaders.push(header);
    }
  }
  const written = httpHeaders.length + envHttpHeaders.length + (bearerTokenEnvVar === undefined ? 0 : 1);
  assert(written === config.headers.length, 'Every header is written exactly once');
  return ok({ ...emptyFields(), url: config.url, bearerTokenEnvVar, httpHeaders, envHttpHeaders });
}

/**
 * The panel's model of a Codex table, or `undefined` when the keys do not make one server: both a
 * command and a URL, neither, or a value the model's own bounds refuse. Keys outside the managed set
 * never reach here. Order is: literal pairs, then references, with the bearer header first.
 */
export function fromCodexFields(fields: CodexFields): McpServerConfig | undefined {
  const hasCommand = fields.command !== undefined;
  const hasUrl = fields.url !== undefined;
  if (hasCommand === hasUrl) {
    return undefined;
  }
  if (fields.envVars.some((name) => !isMcpEnvName(name)) || fields.envHttpHeaders.some((pair) => !isMcpEnvName(pair.value))) {
    return undefined;
  }
  if (fields.bearerTokenEnvVar !== undefined && !isMcpEnvName(fields.bearerTokenEnvVar)) {
    return undefined;
  }
  if (fields.httpHeaders.some((pair) => !isMcpHeaderName(pair.name)) || fields.envHttpHeaders.some((pair) => !isMcpHeaderName(pair.name))) {
    return undefined;
  }
  const wire = hasCommand
    ? {
        transport: 'stdio',
        command: fields.command,
        args: fields.args,
        env: [...fields.env, ...fields.envVars.map((name) => ({ name, value: `\${${name}}` }))],
      }
    : { transport: 'http', url: fields.url, headers: remoteHeaders(fields) };
  const parsed = parseMcpServerConfig(wire, 'codex');
  return parsed.ok ? parsed.value : undefined;
}

function remoteHeaders(fields: CodexFields): readonly McpPair[] {
  const headers: McpPair[] = [];
  if (fields.bearerTokenEnvVar !== undefined) {
    headers.push({ name: 'Authorization', value: `Bearer \${${fields.bearerTokenEnvVar}}` });
  }
  headers.push(...fields.httpHeaders);
  headers.push(...fields.envHttpHeaders.map((pair) => ({ name: pair.name, value: `\${${pair.value}}` })));
  return headers;
}
