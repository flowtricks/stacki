// What the transcript says about a tool, in a designer's words. The agent names its tools for itself
// (`WebSearch`, `mcp__ccd_session__start_session`) and returns what they gave back as raw JSON; neither
// belongs on screen by default. This file turns a tool's name into a short phrase ("Searched the web"),
// decides when a title is a bare tool name rather than a sentence the agent wrote, and tells JSON a
// person should not have to read from output they should (a command's log, a file's text).
//
// It also sorts a call into the kind of step it was for a designer ("Read a file", "Ran the tests",
// "Committed changes"): a table of tool names, then the call's kind, then, for a command, a table of the
// programs and scripts people recognise, with "Ran a command" for everything else (`classifyStep`).
//
// Pure: no clock, no DOM. The wording lives in the catalogs (`ai.toolName.*`, `ai.step.*`); the tables below
// only map names to keys and kinds, so a new tool is one line and an unknown one still reads as plain words.
import { assert } from '../../../../shared/core/assert';
import { AI_LIMITS } from '../../../../shared/properties/ai/aiLimits';
import type { ToolKindName } from '../../../../shared/properties/ai/chatModel';
import { UNNAMED_TOOL_TITLE } from '../chatReducer';
import type { MessageKey } from '../../../../shared/properties/i18n/messageRef';
import type { Translator } from '../../../lib/i18n/localeContext';

/** Characters of a made-up phrase ("Used Get Page Layout") before it is cut. Why: a tool name is data from outside and can be any length. */
export const TOOL_PHRASE_CHARS_MAX = 60;

/** Characters of a name that are read at all; the rest of an absurd name is dropped before any work is done on it. */
const TOOL_NAME_CHARS_READ = 200;

/** Tool names (lower case, without `_`, `-` or spaces) and what each did, as a message. Unknown names fall back to "Used <Words>". */
const TOOL_PHRASES: ReadonlyMap<string, MessageKey> = new Map<string, MessageKey>([
  ['read', 'ai.toolName.read'],
  ['notebookread', 'ai.toolName.read'],
  ['edit', 'ai.toolName.edit'],
  ['multiedit', 'ai.toolName.edit'],
  ['notebookedit', 'ai.toolName.edit'],
  ['write', 'ai.toolName.write'],
  ['bash', 'ai.toolName.run'],
  ['bashoutput', 'ai.toolName.run'],
  ['killbash', 'ai.toolName.run'],
  ['killshell', 'ai.toolName.run'],
  ['grep', 'ai.toolName.searchCode'],
  ['glob', 'ai.toolName.findFiles'],
  ['ls', 'ai.toolName.findFiles'],
  ['websearch', 'ai.toolName.searchWeb'],
  ['webfetch', 'ai.toolName.readWebPage'],
  ['task', 'ai.toolName.helper'],
  ['agent', 'ai.toolName.helper'],
  ['todowrite', 'ai.toolName.todo'],
  ['toolsearch', 'ai.toolName.findTool'],
  ['skill', 'ai.toolName.skill'],
  ['workflow', 'ai.toolName.workflow'],
  ['sendmessage', 'ai.toolName.followUp'],
  ['startsession', 'ai.toolName.session'],
  ['exitplanmode', 'ai.toolName.plan'],
  ['askuserquestion', 'ai.toolName.ask'],
]);

/**
 * A tool's name as a short sentence: "Searched the web" for a tool in the table; "Used Get Page Layout" for any
 * other (its `mcp__server__` prefix dropped, its words capitalised, bounded to `TOOL_PHRASE_CHARS_MAX`); "Used a
 * tool" for an empty one. Always non-empty.
 */
export function toolPhrase(name: string, translate: Translator): string {
  const tool = toolPart(name.slice(0, TOOL_NAME_CHARS_READ));
  const known = TOOL_PHRASES.get(tableKey(tool));
  if (known !== undefined) {
    return translate(known);
  }
  const words = titleWords(tool);
  const phrase = words === '' ? translate('ai.toolName.generic') : translate('ai.toolName.used', { name: words });
  assert(phrase !== '', 'toolPhrase: a phrase');
  return phrase;
}

/**
 * The phrase a call's title should be shown as, or undefined when the title is already words the agent wrote
 * ("Read src/index.astro", "Edit Hero.astro") and shows as it is. A title is a bare name when it is the tool's own
 * name, an `mcp__` name, an identifier written with underscores, `server/tool`, a name in the table on its own, or
 * JSON; `toolName` (when the agent said) names the tool for a title that is JSON.
 */
export function friendlyToolTitle(title: string, toolName: string | undefined, translate: Translator): string | undefined {
  const line = (title.split('\n')[0] ?? title).trim();
  if (line === '') {
    return undefined;
  }
  if (line.startsWith('{') || line.startsWith('[')) {
    return toolPhrase(toolName ?? '', translate);
  }
  if (/\s/u.test(line) || line.length > TOOL_NAME_CHARS_READ) {
    return undefined;
  }
  if (line === toolName || line.startsWith('mcp__') || /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+$/u.test(line) || SLASHED_NAME.test(line)) {
    return toolPhrase(line, translate);
  }
  return TOOL_PHRASES.has(tableKey(line)) && /^[A-Z]/u.test(line) ? toolPhrase(line, translate) : undefined;
}

const SLASHED_NAME = /^[A-Za-z][\w-]*\/[A-Za-z][\w-]*$/u;

/** The words of a title for the row, whichever way it was written: the phrase for a bare name, the title's first line otherwise. */
export function toolTitleText(title: string, toolName: string | undefined, translate: Translator): string {
  return friendlyToolTitle(title, toolName, translate) ?? title;
}

/** The tool part of a name: `start_session` of `mcp__ccd_session__start_session`, `tool` of `server/tool`. */
function toolPart(name: string): string {
  const trimmed = name.trim();
  if (trimmed.startsWith('mcp__')) {
    const parts = trimmed.split('__');
    return parts.length > 2 ? parts.slice(2).join(' ') : (parts[parts.length - 1] ?? '');
  }
  const slash = trimmed.indexOf('/');
  return SLASHED_NAME.test(trimmed) && slash > 0 ? trimmed.slice(slash + 1) : trimmed;
}

function tableKey(tool: string): string {
  return tool.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

/** "get_page_layout" and "getPageLayout" as "Get Page Layout", cut to the bound. */
function titleWords(tool: string): string {
  const words = tool
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .split(/[^A-Za-z0-9]+/u)
    .filter((word) => word !== '')
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ');
  const cut = words.length <= TOOL_PHRASE_CHARS_MAX ? words : `${words.slice(0, TOOL_PHRASE_CHARS_MAX - 1)}…`;
  assert(cut.length <= TOOL_PHRASE_CHARS_MAX, 'titleWords: bounded');
  return cut;
}

// ---------------------------------------------------------------------------
// Raw payloads
// ---------------------------------------------------------------------------

/** Whether the text is a JSON object or array (or the tail of one that was cut), not prose. */
export function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '' || (trimmed.charAt(0) !== '{' && trimmed.charAt(0) !== '[')) {
    return false;
  }
  if (trimmed.length > AI_LIMITS.toolOutputCharsMax) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    // A payload cut to its bound is not parseable, but it still starts as JSON and holds `"key":`.
    return /"\s*:/u.test(trimmed);
  }
}

/** The payload as indented JSON when it parses, as it is otherwise: what "Show details" opens to. */
export function payloadText(text: string): string {
  const trimmed = text.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null ? JSON.stringify(parsed, null, 2) : text;
  } catch {
    return text;
  }
}

/** Kinds whose output is the thing the person asked for (a command's log, a file's text, a change) and shows as it is. */
function showsOutputAsIs(kind: ToolKindName): boolean {
  switch (kind) {
    case 'execute':
    case 'read':
    case 'edit':
    case 'delete':
    case 'move':
      return true;
    case 'search':
    case 'fetch':
    case 'think':
    case 'switch_mode':
    case 'other':
      return false;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/**
 * Whether a call's output is a payload for developers, to sit behind "Show details": JSON from a tool whose
 * output is not the work itself (a search, a web fetch, any other tool), or what a call that failed said (an error
 * with a stack trace is not for the transcript's default view; a command's own failure log is its output and stays).
 */
export function isRawPayload(call: { readonly toolKind: ToolKindName; readonly status: string; readonly output: string }): boolean {
  if (call.output === '') {
    return false;
  }
  if (call.status === 'failed' && call.toolKind !== 'execute') {
    return true;
  }
  return !showsOutputAsIs(call.toolKind) && looksLikeJson(call.output);
}

// ---------------------------------------------------------------------------
// Steps: what kind of work a call was
// ---------------------------------------------------------------------------

/** The kinds of step a designer reads, each worded once (agentSteps.ts). The order is the order of the table, not a rank. */
export const STEP_KINDS = [
  'read',
  'edit',
  'files',
  'search',
  'web',
  'test',
  'check',
  'build',
  'install',
  'devServer',
  'script',
  'commit',
  'push',
  'history',
  'git',
  'ask',
  'plan',
  'todo',
  'helper',
  'message',
  'command',
  'tool',
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** What a call was, for the step it belongs to. */
export interface StepFacts {
  readonly kind: StepKind;
  /**
   * What the step was about, safe for the default view: a file's name, the words searched for, a script's name.
   * Undefined when there is none, when it is too odd to be a name, or when it could be a secret.
   */
  readonly subject: string | undefined;
  /** A `tool` step's tool (its name, or its title when the agent gave no name); a `command` step's program. Undefined otherwise. */
  readonly name: string | undefined;
}

/** The fields of a call a step is read from: the reducer's `ToolItem`, or any older record that has them. */
export interface StepInput {
  readonly toolKind: ToolKindName;
  readonly toolName: string | undefined;
  readonly title: string;
  readonly command: string | undefined;
  readonly paths: readonly string[];
  readonly diffs: readonly { readonly path: string }[];
}

/** Bounds on what of a command is read. Why: a command is data from outside and can be any length (AGENTS.md §10). */
export const STEP_WORDS_LIMITS = {
  /** Characters of a command line read to sort it; the rest is never looked at. */
  commandCharsRead: 2_000,
  /** Pieces of a command line (split at `&&`, `;`, `|`, a newline) read; a longer chain is sorted by its first ones. */
  piecesRead: 16,
  /** Words of one piece read. */
  wordsRead: 32,
  /** Characters of a subject (a file's name, a search) shown; a longer one is cut with an ellipsis. */
  subjectCharsMax: 48,
  /** Characters of a program's name shown ("python3 command"); a longer one is not a name. */
  programCharsMax: 24,
  /** How deep `npx` and `pnpm exec` may wrap a command and still be read. Why: `npx npx npx …` must end. */
  wrapDepthMax: 3,
} as const satisfies Record<string, number>;

/** Tools by name (lower case, no separators) and the step each is. Tools named here are sorted by name alone. */
const TOOL_STEPS: ReadonlyMap<string, StepKind> = new Map<string, StepKind>([
  ['read', 'read'],
  ['notebookread', 'read'],
  ['edit', 'edit'],
  ['multiedit', 'edit'],
  ['notebookedit', 'edit'],
  ['write', 'edit'],
  ['grep', 'search'],
  ['glob', 'search'],
  ['ls', 'search'],
  ['websearch', 'web'],
  ['webfetch', 'web'],
  ['task', 'helper'],
  ['agent', 'helper'],
  ['todowrite', 'todo'],
  ['exitplanmode', 'plan'],
  ['askuserquestion', 'ask'],
  ['sendmessage', 'message'],
  ['bashoutput', 'command'],
  ['killbash', 'command'],
  ['killshell', 'command'],
]);

/** Tools whose input is a command line, sorted by what the command runs. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['bash', 'powershell', 'shell', 'terminal']);

/** Programs sorted by name alone (lower case, without a path). Programs with sub-commands are read by `pieceStep`. */
const PROGRAM_STEPS: ReadonlyMap<string, StepKind> = new Map<string, StepKind>([
  ['vitest', 'test'],
  ['jest', 'test'],
  ['mocha', 'test'],
  ['pytest', 'test'],
  ['ava', 'test'],
  ['eslint', 'check'],
  ['prettier', 'check'],
  ['tsc', 'check'],
  ['stylelint', 'check'],
  ['biome', 'check'],
  ['oxlint', 'check'],
  ['webpack', 'build'],
  ['esbuild', 'build'],
  ['rollup', 'build'],
  ['tsup', 'build'],
  ['curl', 'web'],
  ['wget', 'web'],
  ['mkdir', 'files'],
  ['cp', 'files'],
  ['mv', 'files'],
  ['rm', 'files'],
  ['rmdir', 'files'],
  ['touch', 'files'],
  ['ln', 'files'],
  ['rsync', 'files'],
  ['unzip', 'files'],
  ['zip', 'files'],
  ['tar', 'files'],
  ['chmod', 'files'],
  ['grep', 'search'],
  ['rg', 'search'],
  ['ag', 'search'],
  ['ack', 'search'],
  ['find', 'search'],
  ['fd', 'search'],
  ['ls', 'search'],
  ['tree', 'search'],
  ['cat', 'read'],
  ['head', 'read'],
  ['tail', 'read'],
  ['less', 'read'],
  ['wc', 'read'],
  ['bat', 'read'],
  ['gh', 'git'],
]);

/** Package managers: `npm test`, `pnpm add`, `yarn build`. */
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/** Runners of a package's binary: `npx vitest`, `bunx prettier`. */
const BINARY_RUNNERS: ReadonlySet<string> = new Set(['npx', 'bunx', 'pnpx']);
/** Interpreters that run a script file: `node scripts/build.mjs`, `python3 tools/icons.py`. */
const INTERPRETERS: ReadonlySet<string> = new Set(['node', 'deno', 'tsx', 'ts-node', 'python', 'python3', 'ruby', 'perl', 'bash', 'sh', 'zsh']);
/** Site tools whose sub-command is the step: `astro build`, `vite`, `next dev`. */
const SITE_TOOLS: ReadonlySet<string> = new Set(['astro', 'vite', 'next', 'nuxt', 'remix', 'svelte-kit', 'eleventy']);
/** Installers of other ecosystems: `pip install`, `brew install`. */
const INSTALLERS: ReadonlySet<string> = new Set(['pip', 'pip3', 'brew', 'gem', 'poetry', 'composer', 'cargo', 'uv', 'apt', 'apt-get']);
/** Words in front of a command that do not change what it is. */
const WRAPPERS: ReadonlySet<string> = new Set(['sudo', 'time', 'env', 'command', 'exec', 'nohup', 'nice']);
/** Pieces that only set the scene (`cd site`, `export X=1`): never the step. */
const SCENE_SETTERS: ReadonlySet<string> = new Set(['cd', 'pushd', 'popd', 'export', 'source', '.', 'set', 'true', ':', 'echo', 'printf', 'sleep', 'clear']);

/** Which piece of a chained command names the step: the first kind listed here that any piece has. */
const COMMAND_PRIORITY: readonly StepKind[] = [
  'commit',
  'push',
  'test',
  'check',
  'build',
  'install',
  'devServer',
  'script',
  'web',
  'edit',
  'files',
  'search',
  'read',
  'history',
  'git',
  'command',
];

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const SCRIPT_FILE = /\.(?:[cm]?[jt]s|py|rb|pl|sh|zsh)$/u;
const TEST_FILE = /(?:\.test\.|\.spec\.|(?:^|\/)tests?\/)/u;

/**
 * The step a call was: by the agent's name for its tool when the table knows it, by the command it ran when it ran
 * one, else by the call's kind. Total: an unknown tool is a `tool` step named by its name, an unknown command is
 * "Ran a command". Never throws, whatever the strings hold.
 */
export function classifyStep(call: StepInput): StepFacts {
  const tool = call.toolName === undefined ? '' : tableKey(toolPart(call.toolName.slice(0, TOOL_NAME_CHARS_READ)));
  const known = TOOL_STEPS.get(tool);
  if (known !== undefined) {
    return toolStep(known, call);
  }
  if (call.toolKind === 'execute' || SHELL_TOOLS.has(tool)) {
    return commandStep(call.command ?? call.title);
  }
  const step = kindStep(call);
  assert(STEP_KINDS.includes(step.kind), 'classifyStep: a known kind');
  return step;
}

/** A known tool's step, with what it was about: the file it read or edited, the words it searched for. */
function toolStep(kind: StepKind, call: StepInput): StepFacts {
  switch (kind) {
    case 'read':
    case 'edit':
      return { kind, subject: fileSubject(call), name: undefined };
    case 'search':
      // Claude titles a Grep call as the grep command it stands for; a Glob call as "Find `pattern`", which names no words.
      return { kind, subject: call.title.startsWith('grep') ? searchSubject(commandPieces(call.title)[0] ?? []) : undefined, name: undefined };
    case 'files':
    case 'web':
    case 'test':
    case 'check':
    case 'build':
    case 'install':
    case 'devServer':
    case 'script':
    case 'commit':
    case 'push':
    case 'history':
    case 'git':
    case 'ask':
    case 'plan':
    case 'todo':
    case 'helper':
    case 'message':
    case 'command':
    case 'tool':
      return { kind, subject: undefined, name: undefined };
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** A call of a tool the table does not know, by its kind. */
function kindStep(call: StepInput): StepFacts {
  switch (call.toolKind) {
    case 'read':
      return { kind: 'read', subject: fileSubject(call), name: undefined };
    case 'edit':
      return { kind: 'edit', subject: fileSubject(call), name: undefined };
    case 'delete':
    case 'move':
      return { kind: 'files', subject: undefined, name: undefined };
    case 'search':
      return { kind: 'search', subject: undefined, name: undefined };
    case 'fetch':
      return { kind: 'web', subject: undefined, name: undefined };
    case 'switch_mode':
      return { kind: 'plan', subject: undefined, name: undefined };
    case 'execute':
    case 'think':
    case 'other': {
      const name = call.toolName ?? (call.title.split('\n')[0] ?? '').trim().slice(0, TOOL_NAME_CHARS_READ);
      // The reducer's stand-in title for a call the agent never named says nothing: the step is "Used a tool".
      return { kind: 'tool', subject: undefined, name: name === '' || name === UNNAMED_TOOL_TITLE ? undefined : name };
    }
    default: {
      const exhaustive: never = call.toolKind;
      return exhaustive;
    }
  }
}

/** A command line's step: each piece of a chain is sorted, and the one highest in `COMMAND_PRIORITY` names it. */
function commandStep(text: string): StepFacts {
  const pieces = commandPieces(text);
  let best: StepFacts | undefined;
  for (const words of pieces) {
    const step = pieceStep(words, { depth: 0 });
    if (step !== undefined && (best === undefined || COMMAND_PRIORITY.indexOf(step.kind) < COMMAND_PRIORITY.indexOf(best.kind))) {
      best = step;
    }
  }
  const result = best ?? { kind: 'command', subject: undefined, name: undefined };
  assert(COMMAND_PRIORITY.includes(result.kind), 'commandStep: a command’s kind');
  return result;
}

/** One piece of a command line (its words, wrappers and settings taken off); undefined for a piece that only sets the scene. */
function pieceStep(raw: readonly string[], context: { readonly depth: number }): StepFacts | undefined {
  assert(context.depth <= STEP_WORDS_LIMITS.wrapDepthMax, 'pieceStep: wrapped at most wrapDepthMax deep');
  const words = withoutPrefixes(raw);
  const first = words[0];
  if (first === undefined || SCENE_SETTERS.has(first)) {
    return undefined;
  }
  const program = programOf(first);
  const args = words.slice(1);
  const plain = PROGRAM_STEPS.get(program);
  if (plain !== undefined) {
    return programStep(plain, program, args);
  }
  if (program === 'git') {
    return { kind: gitKind(args), subject: undefined, name: undefined };
  }
  if (PACKAGE_MANAGERS.has(program)) {
    return packageStep(program, args, context);
  }
  if (BINARY_RUNNERS.has(program)) {
    return context.depth < STEP_WORDS_LIMITS.wrapDepthMax
      ? pieceStep(
          args.filter((word) => !word.startsWith('-')),
          { depth: context.depth + 1 },
        )
      : commandOf(program);
  }
  if (INTERPRETERS.has(program)) {
    return interpreterStep(program, args);
  }
  if (SITE_TOOLS.has(program)) {
    return siteStep(program, args);
  }
  if (INSTALLERS.has(program)) {
    return installerStep(program, args);
  }
  if (program === 'playwright') {
    return args[0] === 'test' ? step('test') : args[0] === 'install' ? step('install') : commandOf(program);
  }
  if (program === 'sed') {
    return args.some((word) => word.startsWith('-i')) ? step('edit') : step('read');
  }
  if (program === 'make') {
    return { kind: scriptKind(args[0] ?? '') ?? 'build', subject: undefined, name: undefined };
  }
  if (SCRIPT_FILE.test(first)) {
    return scriptFile(first);
  }
  return commandOf(program);
}

function step(kind: StepKind): StepFacts {
  return { kind, subject: undefined, name: undefined };
}

/** A program the table sorts by name; a search says what it looked for, a read which file. */
function programStep(kind: StepKind, program: string, args: readonly string[]): StepFacts {
  if (kind === 'search') {
    return {
      kind,
      subject: program === 'find' || program === 'fd' ? findSubject(args) : program === 'ls' || program === 'tree' ? undefined : searchSubject(args),
      name: undefined,
    };
  }
  if (kind === 'read') {
    const file = args.find((word) => !word.startsWith('-') && !/^\d+$/u.test(word));
    return { kind, subject: file === undefined ? undefined : safeSubject(baseName(file)), name: undefined };
  }
  return step(kind);
}

function gitKind(args: readonly string[]): StepKind {
  let index = 0;
  // `git -C dir status`, `git -c key=value commit`: the options before the sub-command take a value each.
  while (index < args.length && (args[index] ?? '').startsWith('-')) {
    index += args[index] === '-C' || args[index] === '-c' ? 2 : 1;
  }
  switch (args[index]) {
    case 'commit':
      return 'commit';
    case 'push':
      return 'push';
    case 'status':
    case 'diff':
    case 'log':
    case 'show':
    case 'blame':
    case 'ls-files':
    case 'rev-parse':
    case 'shortlog':
    case 'describe':
      return 'history';
    case undefined:
    default:
      return 'git';
  }
}

/** Options of a package manager that take a value before its verb (`npm --prefix site run build`). */
const PACKAGE_VALUE_OPTIONS: ReadonlySet<string> = new Set(['--prefix', '-C', '--dir', '--filter', '-F', '-w', '--workspace', '--cwd']);

function packageStep(manager: string, args: readonly string[], context: { readonly depth: number }): StepFacts {
  let index = 0;
  while (index < args.length && (args[index] ?? '').startsWith('-')) {
    index += PACKAGE_VALUE_OPTIONS.has(args[index] ?? '') ? 2 : 1;
  }
  const verb = args[index];
  const rest = args.slice(index + 1);
  if (verb === undefined) {
    return manager === 'yarn' || manager === 'bun' ? step('install') : commandOf(manager);
  }
  switch (verb) {
    case 'install':
    case 'i':
    case 'ci':
    case 'add':
    case 'remove':
    case 'uninstall':
    case 'un':
    case 'rm':
    case 'update':
    case 'up':
    case 'upgrade':
      return step('install');
    case 'test':
    case 't':
    case 'tst':
      return step('test');
    case 'start':
      return step('devServer');
    case 'run':
    case 'run-script':
      return packageScript(rest.find((word) => !word.startsWith('-')) ?? '');
    case 'exec':
    case 'x':
    case 'dlx':
      return context.depth < STEP_WORDS_LIMITS.wrapDepthMax
        ? (pieceStep(
            rest.filter((word) => !word.startsWith('-')),
            { depth: context.depth + 1 },
          ) ?? commandOf(manager))
        : commandOf(manager);
    default:
      // `pnpm build`, `yarn dev`, `bun scripts/x.ts`: a script of the package, or a file to run; npm has no such shorthand.
      if (manager === 'npm') {
        return commandOf(manager);
      }
      return SCRIPT_FILE.test(verb) ? scriptFile(verb) : packageScript(verb);
  }
}

/** A package script by its name: the tests, the checks, the build and the dev server are known by their names; any other is "Ran <name>". */
function packageScript(name: string): StepFacts {
  const kind = scriptKind(name);
  return kind === undefined ? { kind: 'script', subject: safeSubject(name), name: undefined } : step(kind);
}

function scriptKind(name: string): StepKind | undefined {
  const lower = name.toLowerCase();
  if (/^(?:test|vitest|jest|e2e|spec|playwright)/u.test(lower)) {
    return 'test';
  }
  if (/^(?:check|lint|format|fmt|typecheck|type-check|types|tsc|prettier|eslint|stylelint)/u.test(lower)) {
    return 'check';
  }
  if (/^(?:build|compile|bundle|dist)/u.test(lower)) {
    return 'build';
  }
  if (/^(?:dev|start|serve|preview|watch)/u.test(lower)) {
    return 'devServer';
  }
  return undefined;
}

/** `node scripts/x.mjs`, `python3 -m pytest`, `node --test`; inline code (`node -e`, `bash -c`) names nothing. */
function interpreterStep(program: string, args: readonly string[]): StepFacts {
  if (args.includes('--test')) {
    return step('test');
  }
  const module = args.indexOf('-m');
  if (module !== -1) {
    const name = args[module + 1] ?? '';
    if (name === 'pytest' || name === 'unittest') {
      return step('test');
    }
    if (name === 'pip') {
      return step('install');
    }
    if (name === 'http.server') {
      return step('devServer');
    }
    return { kind: 'script', subject: safeSubject(name), name: undefined };
  }
  if (args.some((word) => word === '-e' || word === '-c' || word === '-p' || word === '--eval')) {
    return commandOf(program);
  }
  const file = args.find((word) => !word.startsWith('-'));
  return file === undefined ? commandOf(program) : scriptFile(file);
}

function scriptFile(file: string): StepFacts {
  return TEST_FILE.test(file) ? step('test') : { kind: 'script', subject: safeSubject(baseName(file)), name: undefined };
}

function siteStep(program: string, args: readonly string[]): StepFacts {
  const verb = args.find((word) => !word.startsWith('-'));
  if (verb === undefined) {
    return program === 'vite' ? step('devServer') : commandOf(program);
  }
  if (verb === 'build') {
    return step('build');
  }
  if (verb === 'check') {
    return step('check');
  }
  if (verb === 'dev' || verb === 'preview' || verb === 'start' || verb === 'serve') {
    return step('devServer');
  }
  return commandOf(program);
}

function installerStep(program: string, args: readonly string[]): StepFacts {
  const verbs = args.filter((word) => !word.startsWith('-'));
  const verb = program === 'uv' && verbs[0] === 'pip' ? verbs[1] : verbs[0];
  if (verb === 'install' || verb === 'add' || verb === 'require' || verb === 'sync') {
    return step('install');
  }
  if (program === 'cargo' && verb === 'build') {
    return step('build');
  }
  if (program === 'cargo' && verb === 'test') {
    return step('test');
  }
  return commandOf(program);
}

function commandOf(program: string): StepFacts {
  const name = program.length <= STEP_WORDS_LIMITS.programCharsMax && /^[a-z0-9][a-z0-9._+-]*$/u.test(program) && !looksSecret(program) ? program : undefined;
  return { kind: 'command', subject: undefined, name };
}

/** `grep -rn "arrow" src`: the first word that is not an option (or the value of `-e`); options that take a value are skipped with it. */
function searchSubject(args: readonly string[]): string | undefined {
  const words = args[0] === 'grep' || args[0] === 'rg' ? args.slice(1) : args;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? '';
    if (word === '-e' || word === '--regexp') {
      return safeSubject(words[index + 1] ?? '');
    }
    if (word.startsWith('-')) {
      if (/^-(?:[ABCmgt]|-max-count|-glob|-type|-context|-after-context|-before-context)$/u.test(word)) {
        index += 1;
      }
      continue;
    }
    return safeSubject(word);
  }
  return undefined;
}

/** `find . -name "*.astro"`: the pattern of `-name`. */
function findSubject(args: readonly string[]): string | undefined {
  const at = args.findIndex((word) => word === '-name' || word === '-iname' || word === '-path');
  return at === -1 ? undefined : safeSubject(args[at + 1] ?? '');
}

/** The name of the file a read or edit touched: its diff's path, else its first location. */
function fileSubject(call: StepInput): string | undefined {
  const path = call.diffs[0]?.path ?? call.paths[0];
  return path === undefined || path === '' ? undefined : safeSubject(baseName(path));
}

/**
 * A command line in pieces of words: split at `&&`, `||`, `;`, `|`, `&` and newlines outside quotes, each piece split at
 * spaces outside quotes, quotes taken off. Bounded by `STEP_WORDS_LIMITS` in characters, pieces and words.
 */
export function commandPieces(text: string): readonly (readonly string[])[] {
  const source = text.slice(0, STEP_WORDS_LIMITS.commandCharsRead);
  const pieces: (readonly string[])[] = [];
  let words: string[] = [];
  let word = '';
  let quoted = false;
  let quote: string | undefined;
  const endWord = (): void => {
    if ((word !== '' || quoted) && words.length < STEP_WORDS_LIMITS.wordsRead) {
      words.push(word);
    }
    word = '';
    quoted = false;
  };
  const endPiece = (): void => {
    endWord();
    if (words.length > 0 && pieces.length < STEP_WORDS_LIMITS.piecesRead) {
      pieces.push(words);
    }
    words = [];
  };
  for (const character of source) {
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else {
        word += character;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
      quoted = true;
    } else if (character === ';' || character === '&' || character === '|' || character === '\n') {
      endPiece();
    } else if (/\s/u.test(character)) {
      endWord();
    } else {
      word += character;
    }
  }
  endPiece();
  assert(pieces.length <= STEP_WORDS_LIMITS.piecesRead, 'commandPieces: bounded');
  return pieces;
}

/** The words with what is in front of the command taken off: `FOO=1`, `sudo`, `env -u NAME`, `time`. */
function withoutPrefixes(words: readonly string[]): readonly string[] {
  let index = 0;
  while (index < words.length) {
    const word = words[index] ?? '';
    if (ENV_ASSIGNMENT.test(word)) {
      index += 1;
    } else if (WRAPPERS.has(word)) {
      index += 1;
      // `env -u NAME -i …`: its options, `-u` with the name it takes.
      while (word === 'env' && index < words.length && (words[index] ?? '').startsWith('-')) {
        index += words[index] === '-u' ? 2 : 1;
      }
    } else {
      break;
    }
  }
  assert(index <= words.length + 1, 'withoutPrefixes: within the words');
  return words.slice(index);
}

/** `./node_modules/.bin/vitest` as `vitest`, lower case. */
function programOf(word: string): string {
  return baseName(word).toLowerCase();
}

function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

/** Words of the default view drawn from a command must look like a name: printable, short, and nothing like a secret. */
function safeSubject(text: string): string | undefined {
  const trimmed = text.trim();
  // A control character or a line break is no name; nor is an empty word.
  if (trimmed === '' || /[\p{Cc}\p{Cf}]/u.test(trimmed) || looksSecret(trimmed)) {
    return undefined;
  }
  const max = STEP_WORDS_LIMITS.subjectCharsMax;
  const cut = trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
  assert(cut.length <= max, 'safeSubject: bounded');
  return cut;
}

const SECRET_WORD = /(?:token|secret|passw(?:or)?d|api[-_]?key|bearer|credential|private[-_]?key|auth)/iu;
const SECRET_SHAPE = /(?:sk-|ghp_|gho_|ghs_|ghu_|github_pat_|xox[abpr]-|AKIA)[A-Za-z0-9_-]{6,}|[A-Za-z0-9+/_=-]{32,}/u;

/**
 * Whether a word could be a secret: it names one (`TOKEN`, `password`, `api_key`), carries a known key prefix
 * (`sk-…`, `ghp_…`), or is a long run of key-like characters. Such a word never reaches the default view.
 */
export function looksSecret(text: string): boolean {
  return SECRET_WORD.test(text) || SECRET_SHAPE.test(text);
}
