// The Settings panel's MCP tab, the model: one MCP server as the panel understands it, the
// bounds every parser holds, and the pure helpers that turn a server into words (a summary, the
// secrets it needs) without ever showing a value. The files that carry servers are read by other
// modules: `.mcp.json` by mcpJson.ts, Codex's TOML by mcpToml.ts, a pasted terminal line by
// mcpCommand.ts. They all end here, in `McpServerConfig`.
//
// Two transports reach the model as three kinds: `stdio` (Stacki's agent starts a command) and
// `http` / `sse` (it connects to a URL). Claude Code writes the same names in `.mcp.json`'s `type`.
//
// A value may reference a secret as `${NAME}` or `${NAME:-default}` (Claude Code's own expansion in
// `.mcp.json`). The secret itself lives in `.env`; the file holds the reference. Nothing here reads or
// writes a file, and no problem value carries a user's text.
import { assert } from '../core/assert';
import { toRecord } from '../core/record';
import { err, ok, type Result } from '../core/result';

export const MCP_LIMITS = {
  /** Servers in one file. */
  serversMax: 64,
  /** A server's name, in characters. */
  nameCharsMax: 64,
  /** Arguments of one command. */
  argsMax: 64,
  /** One argument, a command, or an environment or header value, in characters (2 KiB). */
  argCharsMax: 2048,
  /** Environment variables, or headers, of one server. */
  pairsMax: 64,
  /** A URL, in characters. */
  urlCharsMax: 2048,
  /** A pasted terminal line, in characters. */
  pastedCharsMax: 8192,
  /** The whole `.mcp.json` or Codex file, in UTF-8 bytes (256 KiB). */
  fileBytesMax: 256 * 1024,
  /** Nesting inside a JSON file. */
  depthMax: 32,
  /** Secrets one provider form can ask for. */
  secretsMax: 8,
} as const satisfies Record<string, number>;

export const MCP_TRANSPORTS = ['stdio', 'http', 'sse'] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

/** An environment variable or a header: order is kept, names are unique within a server. */
export interface McpPair {
  readonly name: string;
  readonly value: string;
}

export type McpServerConfig =
  | { readonly transport: 'stdio'; readonly command: string; readonly args: readonly string[]; readonly env: readonly McpPair[] }
  | { readonly transport: 'http' | 'sse'; readonly url: string; readonly headers: readonly McpPair[] };

export const MCP_PROBLEM_CODES = [
  'expected-object',
  'expected-string',
  'expected-array',
  'unknown-transport',
  'missing-target',
  'both-targets',
  'bad-url',
  'bad-name',
  'bad-pair',
  'duplicate-pair',
  'too-long',
  'too-many',
  'control-characters',
] as const;
export type McpProblemCode = (typeof MCP_PROBLEM_CODES)[number];

/** What is wrong and where: `path` is dotted from the document root, such as `mcpServers.Sanity.url`. */
export interface McpProblem {
  readonly code: McpProblemCode;
  readonly path: string;
}

const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const PLACEHOLDER_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A header name is an HTTP token; this is the subset browsers and servers agree on.
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
// A control character other than tab has no place in a command, a URL or a header.
const CONTROL_PATTERN = /[\u0000-\u0008\u000a-\u001f\u007f]/;

/** A server's name as the file keys it: 1 to 64 of letters, digits, `_`, `.` and `-`. */
export function isMcpServerName(name: string): boolean {
  return name.length > 0 && name.length <= MCP_LIMITS.nameCharsMax && NAME_PATTERN.test(name);
}

export function isMcpEnvName(name: string): boolean {
  return name.length > 0 && name.length <= MCP_LIMITS.nameCharsMax * 2 && ENV_NAME_PATTERN.test(name);
}

export function isMcpHeaderName(name: string): boolean {
  return name.length > 0 && name.length <= MCP_LIMITS.nameCharsMax && HEADER_NAME_PATTERN.test(name);
}

export function hasControlCharacters(value: string): boolean {
  return CONTROL_PATTERN.test(value);
}

/** The names a value refers to as `${NAME}` (or `${NAME:-default}`), in order, without repeats. */
export function mcpPlaceholders(value: string): readonly string[] {
  assert(value.length <= MCP_LIMITS.pastedCharsMax * 2, 'A value is bounded before it is scanned');
  const names: string[] = [];
  for (const match of value.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1];
    if (name !== undefined && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

/** Whether a value is nothing but one reference, such as `${API_KEY}`: not a secret itself. */
export function isMcpReference(value: string): boolean {
  const names = mcpPlaceholders(value);
  const only = names[0];
  return names.length === 1 && only !== undefined && (value === `\${${only}}` || /^\$\{[A-Za-z_][A-Za-z0-9_]*:-[^}]*\}$/.test(value));
}

/** Every secret name a server refers to, across its command, arguments, URL, headers and variables. */
export function mcpConfigPlaceholders(config: McpServerConfig): readonly string[] {
  const texts =
    config.transport === 'stdio'
      ? [config.command, ...config.args, ...config.env.map((pair) => pair.value)]
      : [config.url, ...config.headers.map((pair) => pair.value)];
  const names: string[] = [];
  for (const text of texts) {
    for (const name of mcpPlaceholders(text)) {
      if (!names.includes(name)) {
        names.push(name);
      }
    }
  }
  assert(names.length <= texts.length * 4 + 1, 'References cannot outnumber what holds them');
  return names;
}

const REQUIRED_PLACEHOLDER_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** The secrets a server needs: the `${NAME}` references with no `:-default`, since a default stands in when `.env` has none. */
export function mcpRequiredSecrets(config: McpServerConfig): readonly string[] {
  const texts =
    config.transport === 'stdio'
      ? [config.command, ...config.args, ...config.env.map((pair) => pair.value)]
      : [config.url, ...config.headers.map((pair) => pair.value)];
  const names: string[] = [];
  for (const text of texts) {
    assert(text.length <= MCP_LIMITS.urlCharsMax, 'A value is bounded before it is scanned');
    for (const match of text.matchAll(REQUIRED_PLACEHOLDER_PATTERN)) {
      const name = match[1];
      if (name !== undefined && !names.includes(name)) {
        names.push(name);
      }
    }
  }
  return names;
}

/**
 * What a listing may show of a server: names and references, never a literal value. A pair whose
 * value is (or contains) a `${NAME}` reference shows that text; any other value is hidden.
 */
export interface McpPairSummary {
  readonly name: string;
  /** The text when it holds a reference; `undefined` when the value is a literal that stays hidden. */
  readonly reference: string | undefined;
}

export type McpServerSummary =
  | {
      readonly transport: 'stdio';
      readonly command: string;
      readonly argumentCount: number;
      readonly env: readonly McpPairSummary[];
      /** The `.env` names the server cannot start without: references that have no `:-default`. */
      readonly secretNames: readonly string[];
    }
  | { readonly transport: 'http' | 'sse'; readonly host: string; readonly headers: readonly McpPairSummary[]; readonly secretNames: readonly string[] };

/** The words a card shows: the command's program name only, the URL's host only, never an argument or a query. */
export function summarizeMcpServer(config: McpServerConfig): McpServerSummary {
  if (config.transport === 'stdio') {
    return {
      transport: 'stdio',
      command: programName(config.command),
      argumentCount: config.args.length,
      env: config.env.map(pairSummary),
      secretNames: mcpRequiredSecrets(config),
    };
  }
  return { transport: config.transport, host: hostOf(config.url), headers: config.headers.map(pairSummary), secretNames: mcpRequiredSecrets(config) };
}

function pairSummary(pair: McpPair): McpPairSummary {
  return { name: pair.name, reference: mcpPlaceholders(pair.value).length > 0 ? pair.value : undefined };
}

// The program a command runs: `/usr/bin/npx` shows as `npx`, so a path with a person's folder is not displayed.
function programName(command: string): string {
  const parts = command.split(/[\\/]/);
  const last = parts[parts.length - 1];
  return last === undefined || last.length === 0 ? command : last;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** A copy for the clipboard or a screen: literal values become `***`, references stay readable. */
export function redactMcpConfig(config: McpServerConfig): McpServerConfig {
  const redact = (pair: McpPair): McpPair => ({ name: pair.name, value: mcpPlaceholders(pair.value).length > 0 ? pair.value : '***' });
  return config.transport === 'stdio' ? { ...config, env: config.env.map(redact) } : { ...config, headers: config.headers.map(redact) };
}

/** Checks one string field of a server; `undefined` when it is fine. */
export function textProblem(value: string, path: string, charsMax: number): McpProblem | undefined {
  if (value.length > charsMax) {
    return { code: 'too-long', path };
  }
  if (hasControlCharacters(value)) {
    return { code: 'control-characters', path };
  }
  return undefined;
}

/**
 * Whether a URL is one an agent can connect to: `http` or `https`, a host, no embedded line breaks.
 * A `${NAME}` reference may stand in a path or query, so `new URL` is run on the text with each
 * reference replaced by a plain word.
 */
export function isMcpUrl(url: string): boolean {
  if (url.length === 0 || url.length > MCP_LIMITS.urlCharsMax || hasControlCharacters(url)) {
    return false;
  }
  try {
    const parsed = new URL(url.replace(PLACEHOLDER_PATTERN, 'x'));
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.host.length > 0;
  } catch {
    return false;
  }
}

/**
 * The boundary parser for a server arriving as untyped data in the panel's wire shape
 * (`transport`, `command`, `args`, `env`, `url`, `headers`). Every bound is checked here once.
 */
export function parseMcpServerConfig(input: unknown, path: string): Result<McpServerConfig, McpProblem> {
  const fields = toRecord(input);
  if (fields === undefined) {
    return err({ code: 'expected-object', path });
  }
  const transport = MCP_TRANSPORTS.find((known) => known === fields['transport']);
  if (transport === undefined) {
    return err({ code: 'unknown-transport', path: `${path}.transport` });
  }
  if (transport === 'stdio') {
    return parseStdio(fields, path);
  }
  return parseRemote(fields, path, transport);
}

function parseStdio(fields: Readonly<Record<string, unknown>>, path: string): Result<McpServerConfig, McpProblem> {
  const command = fields['command'];
  if (typeof command !== 'string') {
    return err({ code: 'expected-string', path: `${path}.command` });
  }
  if (command.trim().length === 0) {
    return err({ code: 'missing-target', path: `${path}.command` });
  }
  const commandProblem = textProblem(command, `${path}.command`, MCP_LIMITS.argCharsMax);
  if (commandProblem !== undefined) {
    return err(commandProblem);
  }
  const args = parseArgs(fields['args'], `${path}.args`);
  if (!args.ok) {
    return args;
  }
  const env = parsePairs(fields['env'], `${path}.env`, isMcpEnvName);
  if (!env.ok) {
    return env;
  }
  return ok({ transport: 'stdio', command, args: args.value, env: env.value });
}

function parseRemote(fields: Readonly<Record<string, unknown>>, path: string, transport: 'http' | 'sse'): Result<McpServerConfig, McpProblem> {
  const url = fields['url'];
  if (typeof url !== 'string') {
    return err({ code: 'expected-string', path: `${path}.url` });
  }
  if (url.length > MCP_LIMITS.urlCharsMax) {
    return err({ code: 'too-long', path: `${path}.url` });
  }
  if (!isMcpUrl(url)) {
    return err({ code: 'bad-url', path: `${path}.url` });
  }
  const headers = parsePairs(fields['headers'], `${path}.headers`, isMcpHeaderName);
  if (!headers.ok) {
    return headers;
  }
  return ok({ transport, url, headers: headers.value });
}

/** Arguments: an array of bounded strings; absent is no arguments. */
export function parseArgs(input: unknown, path: string): Result<readonly string[], McpProblem> {
  if (input === undefined) {
    return ok([]);
  }
  if (!Array.isArray(input)) {
    return err({ code: 'expected-array', path });
  }
  if (input.length > MCP_LIMITS.argsMax) {
    return err({ code: 'too-many', path });
  }
  const args: string[] = [];
  for (const [at, item] of input.entries()) {
    if (typeof item !== 'string') {
      return err({ code: 'expected-string', path: `${path}.${at}` });
    }
    const problem = textProblem(item, `${path}.${at}`, MCP_LIMITS.argCharsMax);
    if (problem !== undefined) {
      return err(problem);
    }
    args.push(item);
  }
  return ok(args);
}

/** Pairs from a wire array `[{ name, value }]` or a plain object `{ NAME: "value" }`; absent is none. */
export function parsePairs(input: unknown, path: string, isName: (name: string) => boolean): Result<readonly McpPair[], McpProblem> {
  if (input === undefined) {
    return ok([]);
  }
  const entries = pairEntries(input);
  if (entries === undefined) {
    return err({ code: 'expected-object', path });
  }
  if (entries.length > MCP_LIMITS.pairsMax) {
    return err({ code: 'too-many', path });
  }
  const pairs: McpPair[] = [];
  for (const [name, value] of entries) {
    if (typeof value !== 'string') {
      return err({ code: 'bad-pair', path: `${path}.${name}` });
    }
    if (!isName(name)) {
      return err({ code: 'bad-name', path: `${path}.${name}` });
    }
    if (pairs.some((pair) => pair.name === name)) {
      return err({ code: 'duplicate-pair', path: `${path}.${name}` });
    }
    const problem = textProblem(value, `${path}.${name}`, MCP_LIMITS.argCharsMax);
    if (problem !== undefined) {
      return err(problem);
    }
    pairs.push({ name, value });
  }
  return ok(pairs);
}

function pairEntries(input: unknown): readonly (readonly [string, unknown])[] | undefined {
  if (Array.isArray(input)) {
    const entries: (readonly [string, unknown])[] = [];
    for (const item of input) {
      const fields = toRecord(item);
      if (fields === undefined) {
        return undefined;
      }
      const name = fields['name'];
      if (typeof name !== 'string') {
        return undefined;
      }
      entries.push([name, fields['value']]);
    }
    return entries;
  }
  const fields = toRecord(input);
  return fields === undefined ? undefined : Object.entries(fields);
}

/**
 * The JSON fields Claude Code reads for a server, in the order its own CLI writes them. Only these
 * keys are produced; the file codec merges them over whatever else the entry already holds.
 */
export function mcpFileFields(config: McpServerConfig): Readonly<Record<string, unknown>> {
  const pairs = (list: readonly McpPair[]): Record<string, string> => Object.fromEntries(list.map((pair) => [pair.name, pair.value]));
  if (config.transport === 'stdio') {
    const fields: Record<string, unknown> = { type: 'stdio', command: config.command, args: [...config.args] };
    if (config.env.length > 0) {
      fields['env'] = pairs(config.env);
    }
    return fields;
  }
  const fields: Record<string, unknown> = { type: config.transport, url: config.url };
  if (config.headers.length > 0) {
    fields['headers'] = pairs(config.headers);
  }
  return fields;
}

/** The keys `mcpFileFields` can produce: a merge removes the ones a new config does not set. */
export const MCP_FILE_FIELD_NAMES = ['type', 'command', 'args', 'env', 'url', 'headers'] as const;

/**
 * Reads a `.mcp.json` entry. A missing `type` with a `command` is `stdio` (Claude Code's default); with a
 * `url` it is `http`. Unknown extra keys are ignored here and kept by the codec.
 */
export function mcpConfigFromFileEntry(entry: unknown, path: string): Result<McpServerConfig, McpProblem> {
  const fields = toRecord(entry);
  if (fields === undefined) {
    return err({ code: 'expected-object', path });
  }
  const declared = fields['type'];
  const hasCommand = fields['command'] !== undefined;
  const hasUrl = fields['url'] !== undefined;
  if (hasCommand && hasUrl) {
    return err({ code: 'both-targets', path });
  }
  if (declared !== undefined && typeof declared !== 'string') {
    return err({ code: 'expected-string', path: `${path}.type` });
  }
  const transport = declared ?? (hasCommand ? 'stdio' : hasUrl ? 'http' : undefined);
  if (transport === undefined) {
    return err({ code: 'missing-target', path });
  }
  if (transport === 'streamable-http') {
    return parseMcpServerConfig({ ...fields, transport: 'http' }, path);
  }
  return parseMcpServerConfig({ ...fields, transport }, path);
}

/** A name for a server that has none yet, from what it connects to; `undefined` when nothing usable is in it. */
export function suggestMcpServerName(config: McpServerConfig): string | undefined {
  const raw = config.transport === 'stdio' ? packageWord(config) : hostWord(config.url);
  if (raw === undefined) {
    return undefined;
  }
  const cleaned = raw.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return isMcpServerName(cleaned) ? cleaned : undefined;
}

// `mcp.sanity.io` is Sanity: the service's label, not the subdomain that says it is an MCP endpoint.
function hostWord(url: string): string | undefined {
  const host = hostOf(url);
  if (host.length === 0) {
    return undefined;
  }
  const labels = host.split(':')[0]?.split('.') ?? [];
  const meaningful = labels.filter((label) => !['mcp', 'www', 'api', 'app'].includes(label));
  const picked = meaningful.length >= 2 ? meaningful[meaningful.length - 2] : meaningful[0];
  return picked ?? labels[0];
}

// `npx -y @scope/server-github@1.2` is `github`: the package's own word, without scope, version or `mcp` filler.
function packageWord(config: Extract<McpServerConfig, { readonly transport: 'stdio' }>): string | undefined {
  const target = config.args.find((arg) => !arg.startsWith('-'));
  const base = target ?? config.command;
  const lastSegment = base.split(/[\\/]/).pop() ?? base;
  const withoutVersion = lastSegment.replace(/@[^@]*$/, '');
  const stripped = withoutVersion.replace(/^(mcp-server-|server-|mcp-)/, '').replace(/(-mcp-server|-mcp|-server)$/, '');
  return stripped.length > 0 ? stripped : withoutVersion;
}
