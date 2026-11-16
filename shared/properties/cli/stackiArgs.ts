// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// Reading a command's arguments from a shell line or an MCP tool call, checked against the command's row in the table.
//
// Why one reader for both: `stacki guides set --opacity 0.1` and the tool call `{ "opacity": 0.1 }` must mean the same, and refuse the same
// mistakes (an unknown flag, a missing argument, a value of the wrong kind) with the same sentence. Unknown names are refused, never ignored: a
// misspelt option that is silently dropped would apply a plan the person did not ask for.
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
  readonly spec: CommandSpec;
  readonly args: Readonly<Record<string, unknown>>;
  readonly options: GlobalOptions;
}

const usage = (message: string): Result<never, CliError> => err({ code: 'usage', message });

/** The flag spelling of an argument name: `widthMax` is `--width-max`. */
export function flagOf(name: string): string {
  return `--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

/** A value read as the argument's kind, or why it is not. */
export function readArgValue(spec: ArgSpec, raw: unknown): Result<unknown, CliError> {
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

/** Splits a shell line (after the program name) into the command, its arguments and the global options. */
export function parseLine(tokens: readonly string[], extra: readonly CommandSpec[] = []): Result<ParsedLine | 'top-help', CliError> {
  const table = [...COMMANDS, ...extra];
  if (tokens.length > ARGS_LIMITS.tokensMax) {
    return usage('Too many arguments.');
  }
  const words: string[] = [];
  const index = { value: 0 };
  while (index.value < tokens.length && !(tokens[index.value] ?? '').startsWith('-') && words.length < 4) {
    const candidate = [...words, tokens[index.value] ?? ''];
    if (!table.some((entry) => candidate.every((word, position) => entry.words[position] === word))) {
      break;
    }
    words.push(tokens[index.value] ?? '');
    index.value += 1;
  }
  if (words.length === 0) {
    return tokens.length === 0 || tokens.includes('--help') ? ok('top-help') : usage(`Unknown command "${tokens[0] ?? ''}". Run "stacki --help".`);
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
  return readRest(spec, tokens.slice(index.value));
}

const GLOBAL_WITH_VALUE = ['--project', '--role', '--as-role', '--login', '--wait'];

function readRest(spec: CommandSpec, rest: readonly string[]): Result<ParsedLine, CliError> {
  const raw: Record<string, unknown> = {};
  const global: Record<string, string> = {};
  const positional = spec.args.filter((argument) => argument.positional === true);
  let nextPositional = 0;
  for (let position = 0; position < rest.length; position += 1) {
    const token = rest[position] ?? '';
    const equals = token.startsWith('--') ? token.indexOf('=') : -1;
    const flag = equals > 0 ? token.slice(0, equals) : token;
    if (!token.startsWith('--')) {
      const target = positional[nextPositional];
      if (target === undefined) {
        return usage(`${spec.words.join(' ')}: unexpected argument "${token}"`);
      }
      raw[target.name] = token;
      nextPositional += 1;
      continue;
    }
    if (['--json', '--apply', '--yes', '--help', '--plan'].includes(flag)) {
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
  const checked = checkArgs(spec, raw);
  if (!checked.ok) {
    return checked;
  }
  const wait = global['--wait'] === undefined ? 0 : Number(global['--wait']);
  if (!Number.isInteger(wait) || wait < 0 || wait > 120) {
    return usage('--wait is a whole number of seconds, 0 to 120.');
  }
  const role = global['--role'] ?? global['--as-role'];
  return ok({
    spec,
    args: checked.value,
    options: {
      ...(global['--project'] === undefined ? {} : { project: global['--project'] }),
      ...(role === undefined ? {} : { role }),
      ...(global['--login'] === undefined ? {} : { login: global['--login'] }),
      json: global['--json'] === undefined ? 'text' : 'json',
      apply: global['--apply'] === undefined ? 'plan' : 'apply',
      yes: global['--yes'] === undefined ? 'no' : 'yes',
      waitSeconds: wait,
      help: global['--help'] === undefined ? 'run' : 'help',
    },
  });
}

export function recordOf(value: unknown): Record<string, unknown> {
  return toRecord(value) ?? {};
}
