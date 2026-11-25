// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// Reading a command's arguments from a shell line or an MCP tool call, checked against the command's row in the table.
//
// Why one reader for both: `stacki guides set --opacity 0.1` and the tool call `{ "opacity": 0.1 }` must mean the same, and refuse the same
// mistakes (an unknown flag, a missing argument, a value of the wrong kind) with the same sentence. Unknown names are refused, never ignored: a
// misspelt option that is silently dropped would apply a plan the person did not ask for.
import { assert } from '../../core/assert';
import { toRecord } from '../../core/record';
import { err, ok, type Result } from '../../core/result';
import { COMMANDS, commandByWords, type ArgSpec, type CommandSpec } from './stackiCommands';
import type { CliError } from './stackiOutput';

export const ARGS_LIMITS = {
  /** Words in one command line; a command is at most four words and its arguments are bounded by its table row. */
  tokensMax: 256,
  /** Characters in one argument value: a JSON value for a setting, not a file body. */
  valueCharsMax: 262_144,
} as const satisfies Record<string, number>;

/** The options every command takes, never part of a tool call (the MCP server owns project, role and apply). */
export interface GlobalOptions {
  readonly project?: string;
  readonly role?: string;
  readonly login?: string;
  readonly json: 'json' | 'text';
  readonly apply: 'apply' | 'plan';
  readonly yes: 'yes' | 'no';
  readonly waitSeconds: number;
  readonly help: 'help' | 'run';
}

export interface ParsedLine {
  readonly kind: 'run';
  readonly spec: CommandSpec;
  readonly args: Readonly<Record<string, unknown>>;
  readonly options: GlobalOptions;
}

/**
 * `stacki --help`, `stacki <words> --help` or `stacki help <words>`: help for the whole table (no words), for a group (`roles`) or for one command.
 * The options still carry `--project`, `--as-role` and `--login`, so help lists only what that role may run.
 */
export interface HelpRequest {
  readonly kind: 'help';
  readonly words: readonly string[];
  readonly options: GlobalOptions;
}

const usage = (message: string): Result<never, CliError> => err({ code: 'usage', message });

/** The flag spelling of an argument name: `widthMax` is `--width-max`. */
export function flagOf(name: string): string {
  assert(name.length > 0, 'An argument has a name');
  return `--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

/** How an argument is written on a line: `<id>` for a positional one, `--unit <rem|px>` for a flag, `--network` for a boolean flag. */
export function spellingOf(spec: ArgSpec): string {
  assert(spec.name.length > 0, 'An argument has a name');
  const placeholder = spec.placeholder ?? (spec.kind === 'enum' ? (spec.values ?? []).join('|') : spec.kind);
  if (spec.positional === true) {
    return spec.kind === 'enum' ? `<${placeholder}>` : `<${spec.name}>`;
  }
  return spec.kind === 'boolean' ? flagOf(spec.name) : `${flagOf(spec.name)} <${placeholder}>`;
}

/** The usage line of a command, from its row: `stacki breakpoints sync <id> --value <number> [--unit <rem|px>]`. */
export function usageOf(spec: Pick<CommandSpec, 'words' | 'args'>): string {
  assert(spec.words.length > 0, 'A command has words');
  const parts = spec.args.map((argument) => (argument.required ? spellingOf(argument) : `[${spellingOf(argument)}]`));
  return ['stacki', ...spec.words, ...parts].join(' ');
}

/** A value read as the argument's kind, or why it is not. */
export function readArgValue(spec: ArgSpec, raw: unknown): Result<unknown, CliError> {
  assert(spec.name.length > 0, 'An argument spec has a name');
  switch (spec.kind) {
    case 'string':
      return typeof raw === 'string' && raw.length <= ARGS_LIMITS.valueCharsMax ? ok(raw) : usage(`${spec.name}: expected text`);
    case 'enum':
      return typeof raw === 'string' && (spec.values ?? []).includes(raw) ? ok(raw) : usage(`${spec.name}: expected one of ${(spec.values ?? []).join(', ')}`);
    case 'integer': {
      const value = typeof raw === 'string' && /^-?\d{1,15}$/.test(raw) ? Number(raw) : raw;
      return typeof value === 'number' && Number.isSafeInteger(value) ? ok(value) : usage(`${spec.name}: expected a whole number`);
    }
    case 'number': {
      const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
      return typeof value === 'number' && Number.isFinite(value) ? ok(value) : usage(`${spec.name}: expected a number`);
    }
    case 'boolean': {
      const value = raw === 'true' ? true : raw === 'false' ? false : raw;
      return typeof value === 'boolean' ? ok(value) : usage(`${spec.name}: expected true or false`);
    }
    case 'json':
      return readJson(spec, raw);
    default: {
      const exhaustive: never = spec.kind;
      return exhaustive;
    }
  }
}

function readJson(spec: ArgSpec, raw: unknown): Result<unknown, CliError> {
  assert(spec.kind === 'json', 'Only a JSON argument reads JSON');
  if (typeof raw !== 'string') {
    // A tool call already carries a JSON value.
    return raw === undefined ? usage(`${spec.name}: a value is required`) : ok(raw);
  }
  if (raw.length > ARGS_LIMITS.valueCharsMax) {
    return usage(`${spec.name}: the value is too long`);
  }
  try {
    return ok(JSON.parse(raw) as unknown);
  } catch {
    // Bare text is a string: `config set guide settings.color red`.
    return ok(raw);
  }
}

/** Arguments from a tool call or a parsed line, checked against the row: unknown names, missing required ones, wrong kinds. */
export function checkArgs(spec: CommandSpec, input: Readonly<Record<string, unknown>>): Result<Readonly<Record<string, unknown>>, CliError> {
  assert(spec.words.length > 0, 'A command has words');
  const known = new Set(spec.args.map((argument) => argument.name));
  for (const name of Object.keys(input)) {
    if (!known.has(name)) {
      return usage(`${spec.words.join(' ')}: unknown option "${name}" (known: ${[...known].join(', ') || 'none'})`);
    }
  }
  const checked: Record<string, unknown> = {};
  for (const argument of spec.args) {
    const raw = input[argument.name];
    if (raw === undefined) {
      if (argument.required) {
        return usage(`${spec.words.join(' ')}: "${argument.name}" is required`);
      }
      continue;
    }
    const value = readArgValue(argument, raw);
    if (!value.ok) {
      return value;
    }
    checked[argument.name] = value.value;
  }
  return ok(checked);
}

/** The words of a command line, at most four, and where its arguments start. */
const COMMAND_WORDS_MAX = 4;

/**
 * Splits a shell line (after the program name) into the command, its arguments and the global options.
 *
 * Global options may come before the command (`stacki --json doctor`) or after it (`stacki doctor --json`): scripts and CI put them in either
 * place. Before the command only the global options are read; after it, a command's own argument wins a shared spelling (`roles members add`
 * has a `role` argument, so `--role` after it is that argument, and `--as-role` names the role to act as).
 */
export function parseLine(tokens: readonly string[], extra: readonly CommandSpec[] = []): Result<ParsedLine | HelpRequest, CliError> {
  assert(extra.length >= 0, 'Extra commands are a list');
  const table = [...COMMANDS, ...extra];
  if (tokens.length > ARGS_LIMITS.tokensMax) {
    return usage('Too many arguments.');
  }
  const leading: string[] = [];
  const words: string[] = [];
  let helpWord = false;
  let index = 0;
  // Each pass consumes at least one token, so the loop ends within tokens.length passes (at most ARGS_LIMITS.tokensMax).
  while (index < tokens.length && words.length < COMMAND_WORDS_MAX) {
    const token = tokens[index] ?? '';
    if (token.startsWith('--')) {
      if (words.length > 0) {
        // A flag after a command word ends the words: from here on a command's own argument wins a shared spelling (readRest).
        break;
      }
      const consumed = leadingGlobal(tokens, index);
      if (!consumed.ok) {
        return consumed;
      }
      if (consumed.value === 0) {
        break;
      }
      leading.push(...tokens.slice(index, index + consumed.value));
      index += consumed.value;
      continue;
    }
    if (words.length === 0 && !helpWord && token === 'help') {
      helpWord = true;
      index += 1;
      continue;
    }
    const candidate = [...words, token];
    if (!table.some((entry) => candidate.every((word, position) => entry.words[position] === word))) {
      break;
    }
    words.push(token);
    index += 1;
  }
  assert(index <= tokens.length, 'The command words never run past the line');
  const rest = tokens.slice(index);
  const helpAsked = helpWord || leading.includes('--help') || rest.includes('--help');
  if (helpAsked || tokens.length === 0) {
    const options = readGlobals([...leading, ...rest], 'lenient');
    return options.ok ? ok({ kind: 'help', words, options: options.value }) : options;
  }
  if (words.length === 0) {
    const first = rest[0] ?? '';
    return first.startsWith('--')
      ? usage(`Unknown option "${first}" before the command. Run "stacki --help".`)
      : usage(`Unknown command "${first}". Run "stacki --help".`);
  }
  const spec =
    commandByWords(words) ?? extra.find((entry) => entry.words.length === words.length && entry.words.every((word, position) => word === words[position]));
  if (spec === undefined) {
    return usage(
      `"${words.join(' ')}" needs a subcommand: ${table
        .filter((entry) => entry.words[0] === words[0])
        .map((entry) => entry.words.join(' '))
        .join(', ')}.`,
    );
  }
  return readRest(spec, leading, rest);
}

const GLOBAL_BARE = ['--json', '--apply', '--yes', '--help', '--plan'];
const GLOBAL_WITH_VALUE = ['--project', '--role', '--as-role', '--login', '--wait'];

/** How many tokens a global option at `index` takes (1 or 2), 0 when the token is not a global option, or why it is incomplete. */
function leadingGlobal(tokens: readonly string[], index: number): Result<number, CliError> {
  const token = tokens[index] ?? '';
  assert(token.startsWith('--'), 'Only a flag can be a global option');
  const equals = token.indexOf('=');
  const flag = equals > 0 ? token.slice(0, equals) : token;
  if (GLOBAL_BARE.includes(flag)) {
    return equals > 0 ? usage(`${flag} takes no value`) : ok(1);
  }
  if (!GLOBAL_WITH_VALUE.includes(flag)) {
    return ok(0);
  }
  if (equals > 0) {
    return ok(1);
  }
  const value = tokens[index + 1];
  return value === undefined || value.startsWith('--') ? usage(`${flag} needs a value`) : ok(2);
}

/**
 * The global options in `tokens`. `strict` refuses a flag that is not a global option; `lenient` (help, which runs nothing) skips it.
 * A later spelling wins, so an option after the command replaces the same option before it.
 */
function readGlobals(tokens: readonly string[], mode: 'strict' | 'lenient'): Result<GlobalOptions, CliError> {
  const global: Record<string, string> = {};
  for (let position = 0; position < tokens.length; position += 1) {
    const token = tokens[position] ?? '';
    const consumed = token.startsWith('--') ? leadingGlobal(tokens, position) : ok(0);
    if (!consumed.ok) {
      return consumed;
    }
    if (consumed.value === 0) {
      if (mode === 'strict') {
        return usage(`Unknown option "${token}".`);
      }
      continue;
    }
    const equals = token.indexOf('=');
    const flag = equals > 0 ? token.slice(0, equals) : token;
    global[flag] = GLOBAL_BARE.includes(flag) ? 'true' : equals > 0 ? token.slice(equals + 1) : (tokens[position + 1] ?? '');
    position += consumed.value - 1;
  }
  return optionsOf(global);
}

function optionsOf(global: Readonly<Record<string, string>>): Result<GlobalOptions, CliError> {
  const wait = global['--wait'] === undefined ? 0 : Number(global['--wait']);
  if (!Number.isInteger(wait) || wait < 0 || wait > 120) {
    return usage('--wait is a whole number of seconds, 0 to 120.');
  }
  const role = global['--as-role'] ?? global['--role'];
  return ok({
    ...(global['--project'] === undefined ? {} : { project: global['--project'] }),
    ...(role === undefined ? {} : { role }),
    ...(global['--login'] === undefined ? {} : { login: global['--login'] }),
    json: global['--json'] === undefined ? 'text' : 'json',
    apply: global['--apply'] === undefined ? 'plan' : 'apply',
    yes: global['--yes'] === undefined ? 'no' : 'yes',
    waitSeconds: wait,
    help: global['--help'] === undefined ? 'run' : 'help',
  });
}

function readRest(spec: CommandSpec, leading: readonly string[], rest: readonly string[]): Result<ParsedLine, CliError> {
  assert(spec.words.length > 0, 'A command has words');
  const raw: Record<string, unknown> = {};
  const before = readGlobals(leading, 'strict');
  if (!before.ok) {
    return before;
  }
  const global: Record<string, string> = {};
  // Bare words are placed after the flags are read, into the positional arguments no flag named, in order: in
  // `roles members add --role editor newbie`, --role fills <role>, so `newbie` is the <login>.
  const bare: string[] = [];
  for (let position = 0; position < rest.length; position += 1) {
    const token = rest[position] ?? '';
    const equals = token.startsWith('--') ? token.indexOf('=') : -1;
    const flag = equals > 0 ? token.slice(0, equals) : token;
    if (!token.startsWith('--')) {
      bare.push(token);
      continue;
    }
    if (GLOBAL_BARE.includes(flag)) {
      global[flag] = 'true';
      continue;
    }
    const argument = spec.args.find((entry) => flagOf(entry.name) === flag);
    const takesGlobal = GLOBAL_WITH_VALUE.includes(flag);
    if (argument === undefined && !takesGlobal) {
      return usage(`${spec.words.join(' ')}: unknown option "${flag}"`);
    }
    const next = rest[position + 1];
    const inline = equals > 0 ? token.slice(equals + 1) : undefined;
    const takesBare = argument?.kind === 'boolean' && inline === undefined && (next === undefined || next.startsWith('--'));
    const value = takesBare ? 'true' : (inline ?? next);
    if (value === undefined) {
      return usage(`${flag} needs a value`);
    }
    if (inline === undefined && !takesBare) {
      position += 1;
    }
    if (argument === undefined) {
      global[flag] = value;
    } else {
      raw[argument.name] = value;
    }
  }
  const open = spec.args.filter((argument) => argument.positional === true && raw[argument.name] === undefined);
  for (const [index, token] of bare.entries()) {
    const target = open[index];
    if (target === undefined) {
      return usage(`${spec.words.join(' ')}: unexpected argument "${token}"`);
    }
    raw[target.name] = token;
  }
  assert(bare.length <= open.length, 'Every bare word found a positional argument');
  const checked = checkArgs(spec, raw);
  if (!checked.ok) {
    return checked;
  }
  const after = optionsOf(global);
  if (!after.ok) {
    return after;
  }
  return ok({ kind: 'run', spec, args: checked.value, options: mergedOptions(before.value, after.value, global) });
}

// The options before the command, replaced by any the line names after it (`global` holds the flags spelt after the command).
function mergedOptions(before: GlobalOptions, after: GlobalOptions, global: Readonly<Record<string, string>>): GlobalOptions {
  const project = global['--project'] === undefined ? before.project : after.project;
  const role = global['--as-role'] === undefined && global['--role'] === undefined ? before.role : after.role;
  const login = global['--login'] === undefined ? before.login : after.login;
  return {
    ...(project === undefined ? {} : { project }),
    ...(role === undefined ? {} : { role }),
    ...(login === undefined ? {} : { login }),
    json: before.json === 'json' || after.json === 'json' ? 'json' : 'text',
    apply: before.apply === 'apply' || after.apply === 'apply' ? 'apply' : 'plan',
    yes: before.yes === 'yes' || after.yes === 'yes' ? 'yes' : 'no',
    waitSeconds: global['--wait'] === undefined ? before.waitSeconds : after.waitSeconds,
    help: 'run',
  };
}

export function recordOf(value: unknown): Record<string, unknown> {
  assert(typeof value !== 'function', 'A value read is data, never a function');
  return toRecord(value) ?? {};
}
