// The MCP tab's "Paste a command" box: turns a line a person copied from a terminal or a README
// (`claude mcp add Sanity -t http https://mcp.sanity.io --scope user`, `codex mcp add name -- npx -y pkg`,
// a bare URL, a bare `npx ...`) into a typed server, so a designer never has to open a terminal.
//
// The input is inert data. Nothing here runs a shell, evaluates text, reads the environment or touches
// a file: the line is split into words by a small hand-written tokenizer and the words are matched
// against the few options these commands have. `$NAME` and `${NAME}` stay literal text (they are the
// `.mcp.json` references the codec understands, never expanded). Any shell control construct outside
// quotes (`;`, `&&`, `|`, `>`, a backtick, `$(`, a new line, a leading `#`) refuses the whole line, so
// "a && b" can never be half-accepted. The one `JSON.parse` is for `add-json`, whose argument is JSON
// by definition, checked for size first and mapped through the same validators as the file codec.
//
// Failures are values with a fixed code and a short `detail` that is at most a flag or an operator:
// never a pasted value, URL, header or variable, because those may be secrets.
import { assert } from '../core/assert';
import { err, ok, type Result } from '../core/result';
import {
  MCP_LIMITS,
  isMcpEnvName,
  isMcpHeaderName,
  isMcpServerName,
  isMcpUrl,
  mcpConfigFromFileEntry,
  parseMcpServerConfig,
  suggestMcpServerName,
  type McpPair,
  type McpProblem,
  type McpServerConfig,
} from './mcpConfig';

export const MCP_PASTE_LIMITS = {
  /** Words in one pasted line. */
  tokensMax: 256,
  /** Characters of a flag or operator kept in a problem's detail. */
  detailCharsMax: 32,
} as const satisfies Record<string, number>;

export type McpPasteSource = 'claude' | 'codex' | 'json' | 'url' | 'package';
export type McpPasteScope = 'local' | 'project' | 'user';

export interface McpPasted {
  readonly name: string;
  /** True when the name was suggested from the URL or package, not typed by the person. */
  readonly nameDerived: boolean;
  readonly config: McpServerConfig;
  readonly scope: McpPasteScope | undefined;
  readonly source: McpPasteSource;
}

export type McpPasteProblemCode =
  | 'empty'
  | 'too-long'
  | 'unterminated-quote'
  | 'unsupported-syntax'
  | 'unknown-flag'
  | 'unsupported-flag'
  | 'missing-name'
  | 'missing-target'
  | 'bad-name'
  | 'bad-url'
  | 'bad-transport'
  | 'bad-scope'
  | 'bad-pair'
  | 'bad-json'
  | 'bad-config'
  | 'too-many'
  | 'not-mcp-command'
  | 'conflicting';

/** `detail` is a flag or an operator, at most 32 characters; it is never pasted text of any other kind. */
export interface McpPasteProblem {
  readonly code: McpPasteProblemCode;
  readonly detail: string | undefined;
}

const SCOPES = ['local', 'project', 'user'] as const;
const PACKAGE_RUNNERS: ReadonlySet<string> = new Set(['npx', 'uvx', 'bunx', 'pnpm', 'yarn', 'node', 'python', 'python3', 'docker', 'deno', 'bun', 'pipx']);
// Words a runner puts before the package, which say nothing about what the server is called.
const RUNNER_WORDS: ReadonlySet<string> = new Set(['dlx', 'exec', 'run']);
const URL_TARGET = /^https?:\/\//i;
const ENV_PAIR = /^[A-Za-z_][A-Za-z0-9_]*=/;
const HEADER_PAIR = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+: /;
const PROMPT_MARKERS = ['$ ', '> '] as const;

function problem(code: McpPasteProblemCode, detail?: string): McpPasteProblem {
  const bounded = detail === undefined ? undefined : detail.slice(0, MCP_PASTE_LIMITS.detailCharsMax);
  return { code, detail: bounded };
}

// --- The tokenizer -------------------------------------------------------------------------------

/**
 * Splits a line into words the way a POSIX shell would, without running anything. Quotes group, a
 * backslash escapes, `$` is ordinary text. A control operator outside quotes refuses the line.
 */
export function tokenizeShellLine(input: string): Result<readonly string[], McpPasteProblem> {
  assert(typeof input === 'string', 'The line to split is text');
  if (input.length > MCP_LIMITS.pastedCharsMax) {
    return err(problem('too-long'));
  }
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let mode: 'none' | 'single' | 'double' = 'none';
  let escaped = false;
  const text = input.trim();
  for (let at = 0; at < text.length; at += 1) {
    const character = text.charAt(at);
    if (mode === 'single') {
      if (character === "'") {
        mode = 'none';
      } else {
        current += character;
      }
      continue;
    }
    if (mode === 'double') {
      if (escaped) {
        escaped = false;
        if (character === '\n') {
          continue;
        }
        current += '"\\$`'.includes(character) ? character : `\\${character}`;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        mode = 'none';
      } else {
        current += character;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      if (character !== '\n') {
        current += character;
        started = true;
      }
      continue;
    }
    if (character === '\\') {
      escaped = true;
    } else if (character === "'" || character === '"') {
      mode = character === "'" ? 'single' : 'double';
      started = true;
    } else if (character === ' ' || character === '\t' || character === '\r') {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
    } else {
      const operator = character === '#' ? (started ? undefined : '#') : controlOperator(text, at);
      if (operator !== undefined) {
        return err(problem('unsupported-syntax', operator));
      }
      current += character;
      started = true;
    }
    if (tokens.length > MCP_PASTE_LIMITS.tokensMax) {
      return err(problem('too-many'));
    }
  }
  if (mode !== 'none') {
    return err(problem('unterminated-quote'));
  }
  if (escaped) {
    current += '\\';
    started = true;
  }
  if (started) {
    tokens.push(current);
  }
  if (tokens.length > MCP_PASTE_LIMITS.tokensMax) {
    return err(problem('too-many'));
  }
  assert(
    tokens.every((token) => token.length <= text.length),
    'A word cannot be longer than the line',
  );
  return ok(tokens);
}

// The unquoted construct at `at` that a shell would act on, or undefined for an ordinary character.
function controlOperator(text: string, at: number): string | undefined {
  const character = text.charAt(at);
  const next = text.charAt(at + 1);
  if (character === '\n') {
    return 'newline';
  }
  if (character === '$') {
    return next === '(' ? '$(' : undefined;
  }
  if (character === '&' || character === '|') {
    return next === character ? `${character}${character}` : character;
  }
  if (';<>`()'.includes(character)) {
    return character;
  }
  return undefined;
}

// --- Options -------------------------------------------------------------------------------------

type FlagKind = 'transport' | 'scope' | 'env' | 'header' | 'url' | 'bearer';

const CLAUDE_FLAGS: ReadonlyMap<string, FlagKind> = new Map<string, FlagKind>([
  ['-t', 'transport'],
  ['--transport', 'transport'],
  ['-s', 'scope'],
  ['--scope', 'scope'],
  ['-e', 'env'],
  ['--env', 'env'],
  ['-H', 'header'],
  ['--header', 'header'],
]);
// Real Claude Code options for signing in to a server; this tab cannot carry them, so it says so.
const CLAUDE_UNSUPPORTED: ReadonlySet<string> = new Set(['--client-id', '--client-secret', '--callback-port']);
const ADD_JSON_FLAGS: ReadonlyMap<string, FlagKind> = new Map<string, FlagKind>([
  ['-s', 'scope'],
  ['--scope', 'scope'],
]);
// verify: Codex's `mcp add` options, from its documentation as remembered; check against `codex mcp add --help`.
const CODEX_FLAGS: ReadonlyMap<string, FlagKind> = new Map<string, FlagKind>([
  ['--env', 'env'],
  ['--url', 'url'],
  ['--bearer-token-env-var', 'bearer'],
]);

interface Scanned {
  readonly positional: readonly string[];
  readonly tail: readonly string[] | undefined;
  readonly transport: string | undefined;
  readonly scope: string | undefined;
  readonly url: string | undefined;
  readonly bearer: string | undefined;
  readonly env: readonly McpPair[];
  readonly headers: readonly McpPair[];
}

interface FlagTable {
  readonly flags: ReadonlyMap<string, FlagKind>;
  readonly unsupported: ReadonlySet<string>;
  /** The code for a flag in neither table. */
  readonly unrecognized: 'unknown-flag' | 'unsupported-flag';
}

function parseEnvPair(text: string): McpPair | undefined {
  const equals = text.indexOf('=');
  if (equals <= 0) {
    return undefined;
  }
  const name = text.slice(0, equals);
  return isMcpEnvName(name) ? { name, value: text.slice(equals + 1) } : undefined;
}

function parseHeaderPair(text: string): McpPair | undefined {
  const colon = text.indexOf(':');
  if (colon <= 0) {
    return undefined;
  }
  const name = text.slice(0, colon).trim();
  return isMcpHeaderName(name) ? { name, value: text.slice(colon + 1).trim() } : undefined;
}

function missingValue(kind: FlagKind): McpPasteProblem {
  switch (kind) {
    case 'transport':
      return problem('bad-transport');
    case 'scope':
      return problem('bad-scope');
    case 'env':
    case 'header':
      return problem('bad-pair');
    case 'url':
      return problem('missing-target');
    case 'bearer':
      return problem('bad-pair');
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function applyFlag(scanned: Scanned, kind: FlagKind, value: string): Result<Scanned, McpPasteProblem> {
  if (kind === 'transport') {
    return ok({ ...scanned, transport: value });
  }
  if (kind === 'scope') {
    return ok({ ...scanned, scope: value });
  }
  if (kind === 'url') {
    return ok({ ...scanned, url: value });
  }
  if (kind === 'bearer') {
    return ok({ ...scanned, bearer: value });
  }
  if (kind === 'env') {
    const pair = parseEnvPair(value);
    return pair === undefined ? err(problem('bad-pair')) : ok({ ...scanned, env: [...scanned.env, pair] });
  }
  const pair = parseHeaderPair(value);
  return pair === undefined ? err(problem('bad-pair')) : ok({ ...scanned, headers: [...scanned.headers, pair] });
}

// Splits words into options and positional words. Everything after a bare `--` is the command, verbatim.
function scanOptions(tokens: readonly string[], table: FlagTable): Result<Scanned, McpPasteProblem> {
  let scanned: Scanned = { positional: [], tail: undefined, transport: undefined, scope: undefined, url: undefined, bearer: undefined, env: [], headers: [] };
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at];
    if (token === undefined) {
      break;
    }
    if (token === '--') {
      scanned = { ...scanned, tail: tokens.slice(at + 1) };
      break;
    }
    if (!token.startsWith('-') || token.length === 1) {
      scanned = { ...scanned, positional: [...scanned.positional, token] };
      continue;
    }
    const equals = token.startsWith('--') ? token.indexOf('=') : -1;
    const flag = equals > 0 ? token.slice(0, equals) : token;
    const inline = equals > 0 ? token.slice(equals + 1) : undefined;
    const kind = table.flags.get(flag);
    if (kind === undefined) {
      return err(problem(table.unsupported.has(flag) ? 'unsupported-flag' : table.unrecognized, flag));
    }
    let value = inline;
    if (value === undefined) {
      at += 1;
      value = tokens[at];
    }
    if (value === undefined) {
      return err(missingValue(kind));
    }
    const applied = applyFlag(scanned, kind, value);
    if (!applied.ok) {
      return applied;
    }
    scanned = applied.value;
    if (inline === undefined && (kind === 'env' || kind === 'header')) {
      // Claude's own option swallows following words, so `-e A=1 B=2 name` is read the same way here.
      const pattern = kind === 'env' ? ENV_PAIR : HEADER_PAIR;
      for (let more = at + 1; more < tokens.length; more += 1) {
        const next = tokens[more];
        if (next === undefined || next === '--' || !pattern.test(next)) {
          break;
        }
        const extra = applyFlag(scanned, kind, next);
        if (!extra.ok) {
          return extra;
        }
        scanned = extra.value;
        at = more;
      }
    }
  }
  assert(scanned.env.length <= tokens.length, 'Variables cannot outnumber the words they came from');
  assert(scanned.headers.length <= tokens.length, 'Headers cannot outnumber the words they came from');
  return ok(scanned);
}

function parseScope(value: string | undefined): Result<McpPasteScope | undefined, McpPasteProblem> {
  if (value === undefined) {
    return ok(undefined);
  }
  const scope = SCOPES.find((known) => known === value);
  return scope === undefined ? err(problem('bad-scope')) : ok(scope);
}

// --- Building the server -------------------------------------------------------------------------

function problemFromConfig(found: McpProblem): McpPasteProblem {
  switch (found.code) {
    case 'bad-url':
      return problem('bad-url');
    case 'too-many':
      return problem('too-many');
    case 'bad-name':
    case 'bad-pair':
    case 'duplicate-pair':
      return problem('bad-pair');
    case 'expected-object':
    case 'expected-string':
    case 'expected-array':
    case 'unknown-transport':
    case 'missing-target':
    case 'both-targets':
    case 'too-long':
    case 'control-characters':
      return problem('bad-config');
    default: {
      const exhaustive: never = found.code;
      return exhaustive;
    }
  }
}

function validated(transport: string, fields: Readonly<Record<string, unknown>>): Result<McpServerConfig, McpPasteProblem> {
  const checked = parseMcpServerConfig({ ...fields, transport }, 'paste');
  return checked.ok ? ok(checked.value) : err(problemFromConfig(checked.error));
}

function checkedName(name: string | undefined): Result<string, McpPasteProblem> {
  if (name === undefined) {
    return err(problem('missing-name'));
  }
  return isMcpServerName(name) ? ok(name) : err(problem('bad-name'));
}

// `claude mcp add` and `codex mcp add` ... with the word list after the subcommand.
function buildFromClaude(tokens: readonly string[]): Result<McpPasted, McpPasteProblem> {
  const scanned = scanOptions(tokens, { flags: CLAUDE_FLAGS, unsupported: CLAUDE_UNSUPPORTED, unrecognized: 'unknown-flag' });
  if (!scanned.ok) {
    return scanned;
  }
  const { positional, tail, transport, env, headers } = scanned.value;
  const scope = parseScope(scanned.value.scope);
  if (!scope.ok) {
    return scope;
  }
  const name = checkedName(positional[0]);
  if (!name.ok) {
    return name;
  }
  if (transport !== undefined && transport !== 'stdio' && transport !== 'http' && transport !== 'sse') {
    return err(problem('bad-transport'));
  }
  const rest = positional.slice(1);
  if (tail !== undefined && rest.length > 0) {
    return err(problem('conflicting'));
  }
  // The command (or URL) and its arguments: after `--`, or the words that follow the name.
  const targetWords = tail ?? rest;
  const target = targetWords[0];
  if (target === undefined) {
    return err(problem('missing-target'));
  }
  const isUrl = URL_TARGET.test(target);
  const resolved = transport ?? (isUrl && tail === undefined ? 'http' : 'stdio');
  if (resolved === 'stdio' && isUrl && tail === undefined) {
    return err(problem('conflicting', '--transport'));
  }
  if (resolved !== 'stdio' && tail !== undefined) {
    return err(problem('conflicting', '--'));
  }
  const config =
    resolved === 'stdio' ? buildStdio(target, targetWords.slice(1), env, headers) : buildRemote(resolved, target, targetWords.length, env, headers);
  if (!config.ok) {
    return config;
  }
  return ok({ name: name.value, nameDerived: false, config: config.value, scope: scope.value, source: 'claude' });
}

function buildStdio(command: string, args: readonly string[], env: readonly McpPair[], headers: readonly McpPair[]): Result<McpServerConfig, McpPasteProblem> {
  if (headers.length > 0) {
    return err(problem('conflicting', '--header'));
  }
  return validated('stdio', { command, args, env });
}

function buildRemote(
  transport: 'http' | 'sse',
  target: string,
  wordCount: number,
  env: readonly McpPair[],
  headers: readonly McpPair[],
): Result<McpServerConfig, McpPasteProblem> {
  if (!URL_TARGET.test(target) || !isMcpUrl(target)) {
    return err(problem('bad-url'));
  }
  if (wordCount > 1) {
    return err(problem('conflicting'));
  }
  if (env.length > 0) {
    return err(problem('conflicting', '--env'));
  }
  return validated(transport, { url: target, headers });
}

function buildFromAddJson(tokens: readonly string[]): Result<McpPasted, McpPasteProblem> {
  const scanned = scanOptions(tokens, { flags: ADD_JSON_FLAGS, unsupported: new Set<string>(), unrecognized: 'unknown-flag' });
  if (!scanned.ok) {
    return scanned;
  }
  const scope = parseScope(scanned.value.scope);
  if (!scope.ok) {
    return scope;
  }
  const { positional } = scanned.value;
  const name = checkedName(positional[0]);
  if (!name.ok) {
    return name;
  }
  const json = positional[1];
  if (json === undefined || scanned.value.tail !== undefined) {
    return err(problem('missing-target'));
  }
  if (positional.length > 2) {
    return err(problem('conflicting'));
  }
  if (json.length > MCP_LIMITS.pastedCharsMax) {
    return err(problem('too-long'));
  }
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return err(problem('bad-json'));
  }
  const config = mcpConfigFromFileEntry(data, 'paste');
  if (!config.ok) {
    return err(problemFromConfig(config.error));
  }
  return ok({ name: name.value, nameDerived: false, config: config.value, scope: scope.value, source: 'json' });
}

function buildFromCodex(tokens: readonly string[]): Result<McpPasted, McpPasteProblem> {
  const scanned = scanOptions(tokens, { flags: CODEX_FLAGS, unsupported: new Set<string>(), unrecognized: 'unsupported-flag' });
  if (!scanned.ok) {
    return scanned;
  }
  const { positional, tail, url, bearer, env } = scanned.value;
  const name = checkedName(positional[0]);
  if (!name.ok) {
    return name;
  }
  if (positional.length > 1) {
    return err(problem('conflicting'));
  }
  if (url !== undefined) {
    if (env.length > 0 || tail !== undefined) {
      return err(problem('conflicting', '--url'));
    }
    return buildCodexRemote(name.value, url, bearer);
  }
  if (bearer !== undefined) {
    return err(problem('conflicting', '--bearer-token-env-var'));
  }
  const command = tail?.[0];
  if (command === undefined) {
    return err(problem('missing-target'));
  }
  const config = validated('stdio', { command, args: tail?.slice(1) ?? [], env });
  return config.ok ? ok({ name: name.value, nameDerived: false, config: config.value, scope: undefined, source: 'codex' }) : config;
}

function buildCodexRemote(name: string, url: string, bearer: string | undefined): Result<McpPasted, McpPasteProblem> {
  if (!URL_TARGET.test(url) || !isMcpUrl(url)) {
    return err(problem('bad-url'));
  }
  if (bearer !== undefined && !isMcpEnvName(bearer)) {
    return err(problem('bad-pair', '--bearer-token-env-var'));
  }
  const headers: McpPair[] = bearer === undefined ? [] : [{ name: 'Authorization', value: `Bearer \${${bearer}}` }];
  const config = validated('http', { url, headers });
  return config.ok ? ok({ name, nameDerived: false, config: config.value, scope: undefined, source: 'codex' }) : config;
}

// A line with no `claude` or `codex` in front: a URL, or the command that starts a package.
function buildBare(tokens: readonly string[]): Result<McpPasted, McpPasteProblem> {
  const first = tokens[0];
  if (first === undefined) {
    return err(problem('empty'));
  }
  if (tokens.length === 1 && URL_TARGET.test(first)) {
    if (!isMcpUrl(first)) {
      return err(problem('bad-url'));
    }
    const config = validated('http', { url: first, headers: [] });
    return config.ok ? withSuggestedName(config.value, 'url') : config;
  }
  if (!PACKAGE_RUNNERS.has(first)) {
    return err(problem('not-mcp-command'));
  }
  const config = validated('stdio', { command: first, args: tokens.slice(1), env: [] });
  return config.ok ? withSuggestedName(config.value, 'package') : config;
}

function withSuggestedName(config: McpServerConfig, source: 'url' | 'package'): Result<McpPasted, McpPasteProblem> {
  // `pnpm dlx pkg` and `docker run img` are named after the package, not the runner's subcommand.
  const forName =
    config.transport === 'stdio' && config.args[0] !== undefined && RUNNER_WORDS.has(config.args[0]) ? { ...config, args: config.args.slice(1) } : config;
  const suggested = suggestMcpServerName(forName);
  // `@playwright/mcp` is named for its scope: the package's own word is only "mcp".
  const name = suggested === 'mcp' ? (scopeWord(forName) ?? suggested) : suggested;
  if (name === undefined) {
    return err(problem('missing-name'));
  }
  return ok({ name, nameDerived: true, config, scope: undefined, source });
}

/** Reads a pasted line into a server to add, or says in a fixed code why it cannot. Nothing is run. */
export function parseMcpCommand(input: string): Result<McpPasted, McpPasteProblem> {
  assert(typeof input === 'string', 'The pasted line is text');
  if (input.length > MCP_LIMITS.pastedCharsMax) {
    return err(problem('too-long'));
  }
  let line = input.trim();
  for (const marker of PROMPT_MARKERS) {
    if (line.startsWith(marker) || line === marker.trim()) {
      line = line.slice(marker.length).trim();
      break;
    }
  }
  if (line.trim().length === 0) {
    return err(problem('empty'));
  }
  const split = tokenizeShellLine(line);
  if (!split.ok) {
    return split;
  }
  const tokens = split.value;
  const [program, group, subcommand] = tokens;
  if (program === 'claude' || program === 'codex') {
    if (group !== 'mcp') {
      return err(problem('not-mcp-command'));
    }
    const rest = tokens.slice(3);
    if (program === 'claude' && subcommand === 'add') {
      return buildFromClaude(rest);
    }
    if (program === 'claude' && subcommand === 'add-json') {
      return buildFromAddJson(rest);
    }
    if (program === 'codex' && subcommand === 'add') {
      return buildFromCodex(rest);
    }
    return err(problem('not-mcp-command'));
  }
  return buildBare(tokens);
}

function scopeWord(config: McpServerConfig): string | undefined {
  if (config.transport !== 'stdio') {
    return undefined;
  }
  const scoped = config.args.find((word) => /^@[A-Za-z0-9_.-]+\//.test(word));
  const word = scoped?.slice(1, scoped.indexOf('/'));
  return word !== undefined && isMcpServerName(word) ? word : undefined;
}
