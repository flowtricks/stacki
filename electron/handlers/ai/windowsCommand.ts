// Turns a setup command into one Windows can start, without ever spawning a .cmd or .bat shim.
//
// Why: since the April 2024 Node security fix for CVE-2024-27980, `spawn("npm.cmd", [...])` and
// `spawn("codex.cmd", [...])` without `shell: true` throw `Error: spawn EINVAL` synchronously (Electron
// ships the fixed Node). The shims npm creates (`npm.cmd`, `codex.cmd`) are exactly such files, so the
// Codex install and every `codex` status, sign-in and sign-out command failed on Windows.
//
// What is done instead, in order of preference:
// 1. A real executable (`.exe`, `.com`) is started as it is.
// 2. A shim is replaced by what it runs: the package's JavaScript entry (found by reading the shim, or
//    npm's known place beside it) under a real `node.exe` found beside the shim or on PATH, else under
//    Stacki's own binary with ELECTRON_RUN_AS_NODE=1. No shell is involved, so a path with spaces or
//    non-ASCII characters needs no quoting: Node passes each argument through as one.
// 3. Only when no entry can be found, `cmd.exe /d /s /c "<shim>" <args>` with a verbatim command line.
//    Every piece is checked first: the arguments are Stacki's constants (flags and a package name) and
//    must match a short safe alphabet, and the shim path must not hold a character cmd.exe would read
//    as syntax inside quotes (`"`, `%`, `!`, line breaks). Anything else is refused, never escaped.
//
// On any other platform the command is returned unchanged.
import path from 'node:path';
import { assert } from '../../../shared/core/assert';
import { err, ok, type Result } from '../../../shared/core/result';

export const WINDOWS_COMMAND_LIMITS = {
  pathEntriesMax: 4_096,
  argumentsMax: 32,
  argumentCharsMax: 256,
  shimBytesMax: 65_536,
  vendorDirectoriesMax: 64,
} as const satisfies Record<string, number>;

export const NODE_DOWNLOAD_URL = 'https://nodejs.org';

/** A program and its arguments; `verbatim` arguments are one ready command line that must not be quoted again. */
export interface CommandLine {
  readonly command: string;
  readonly args: readonly string[];
  readonly argumentStyle?: 'array' | 'verbatim';
}

export interface CommandFileSystem {
  readonly fileExists: (file: string) => boolean;
  /** A text file's content, or undefined when it cannot be read. */
  readonly readText: (file: string) => string | undefined;
  /** The names in a folder, or an empty list when it cannot be read. */
  readonly listDirectory: (directory: string) => readonly string[];
}

export interface ResolveOptions {
  readonly platform: NodeJS.Platform;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  /** Stacki's own binary: the Node of last resort (with ELECTRON_RUN_AS_NODE). */
  readonly execPath: string;
  readonly fileSystem: CommandFileSystem;
}

export interface ResolvedCommand {
  readonly command: CommandLine;
  /** Variables to add to the environment the command starts with. */
  readonly environment: Readonly<Record<string, string>>;
  /** The command as a person reads it, for Details. */
  readonly description: string;
}

export type CommandResolution = Result<ResolvedCommand, string>;

const SAFE_ARGUMENT = /^[A-Za-z0-9@._:/=-]+$/;
const CMD_SYNTAX_IN_PATH = /["%!\r\n\0]/;
const SHIM_EXTENSIONS = ['.cmd', '.bat'] as const;
const EXECUTABLE_EXTENSIONS = ['.exe', '.com'] as const;
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** Where a package's entry sits under the shim's folder when the shim cannot be read. */
const KNOWN_ENTRIES: Readonly<Record<string, readonly string[]>> = {
  npm: ['node_modules/npm/bin/npm-cli.js'],
  codex: ['node_modules/@openai/codex/bin/codex.js'],
};

export const realFileSystem = (fs: typeof import('node:fs')): CommandFileSystem => ({
  fileExists: (file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  },
  readText: (file) => {
    try {
      const text = fs.readFileSync(file, 'utf8');
      return text.length <= WINDOWS_COMMAND_LIMITS.shimBytesMax ? text : undefined;
    } catch {
      return undefined;
    }
  },
  listDirectory: (directory) => {
    try {
      return fs.readdirSync(directory).slice(0, WINDOWS_COMMAND_LIMITS.vendorDirectoriesMax);
    } catch {
      return [];
    }
  },
});

export function nodeMissingMessage(name: string): string {
  return `${name} was not found. Install Node.js from ${NODE_DOWNLOAD_URL} (it includes npm), restart Stacki, then try again.`;
}

/** The command Windows can start for `command`; unchanged off Windows. */
export function resolveWindowsCommand(command: CommandLine, options: ResolveOptions): CommandResolution {
  assert(command.command.length > 0, 'resolveWindowsCommand: a command has a name');
  assert(command.args.length <= WINDOWS_COMMAND_LIMITS.argumentsMax, 'resolveWindowsCommand: arguments are bounded');
  if (options.platform !== 'win32') {
    return ok({ command, environment: {}, description: describe(command.command, command.args) });
  }
  const api = path.win32;
  const extension = api.extname(command.command).toLowerCase();
  if (isOneOf(extension, EXECUTABLE_EXTENSIONS)) {
    return ok({ command, environment: {}, description: describe(command.command, command.args) });
  }
  const name = api.basename(command.command, extension === '' ? undefined : extension);
  const shim = findProgram(command.command, name, options);
  if (shim === undefined) {
    return err(name.toLowerCase() === 'npm' ? nodeMissingMessage('npm') : `${name} was not found on this computer.`);
  }
  if (isOneOf(api.extname(shim).toLowerCase(), EXECUTABLE_EXTENSIONS)) {
    return ok({ command: { command: shim, args: command.args }, environment: {}, description: describe(shim, command.args) });
  }
  const entry = findEntry(shim, name, options);
  if (entry !== undefined) {
    return ok(nodeCommand(entry, shim, command.args, options));
  }
  return commandProcessorCommand(shim, command.args, options);
}

/**
 * The real program behind a CLI path for something that spawns it itself (the Codex adapter reads
 * CODEX_PATH): the shim's native `.exe` when it can be found, else the path unchanged. Off Windows, unchanged.
 */
export function runnableCliPath(cli: string, options: ResolveOptions): string {
  if (options.platform !== 'win32') {
    return cli;
  }
  const api = path.win32;
  if (!isOneOf(api.extname(cli).toLowerCase(), SHIM_EXTENSIONS)) {
    return cli;
  }
  const packageRoot = api.join(api.dirname(cli), 'node_modules', '@openai', 'codex', 'node_modules', '@openai');
  for (const platformPackage of options.fileSystem.listDirectory(packageRoot)) {
    if (!platformPackage.toLowerCase().startsWith('codex-win32-')) {
      continue;
    }
    const vendor = api.join(packageRoot, platformPackage, 'vendor');
    for (const triple of options.fileSystem.listDirectory(vendor)) {
      const candidate = api.join(vendor, triple, 'codex', 'codex.exe');
      if (options.fileSystem.fileExists(candidate)) {
        return candidate;
      }
    }
  }
  return cli;
}

/** The command for Details: what was tried on which platform, with nothing secret in it (arguments are constants). */
export function describeAttempt(platform: NodeJS.Platform, arch: string, attempt: string): string {
  assert(attempt.length > 0, 'describeAttempt: a command was tried');
  return `Platform: ${platform} ${arch}\nTried: ${attempt}`;
}

export function describe(command: string, args: readonly string[]): string {
  return [command, ...args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(' ');
}

// ---------------------------------------------------------------------------

function nodeCommand(entry: string, shim: string, args: readonly string[], options: ResolveOptions): ResolvedCommand {
  const node = findNode(shim, options);
  if (node !== undefined) {
    const line = { command: node, args: [entry, ...args] };
    return { command: line, environment: {}, description: describe(line.command, line.args) };
  }
  // No node.exe anywhere: Stacki's own binary runs the entry as Node.
  const line = { command: options.execPath, args: [entry, ...args] };
  assert(line.args[0] === entry, 'nodeCommand: the entry leads the arguments');
  return { command: line, environment: { ELECTRON_RUN_AS_NODE: '1' }, description: `ELECTRON_RUN_AS_NODE=1 ${describe(line.command, line.args)}` };
}

function commandProcessorCommand(shim: string, args: readonly string[], options: ResolveOptions): CommandResolution {
  if (CMD_SYNTAX_IN_PATH.test(shim)) {
    return err(`${path.win32.basename(shim)} lives in a folder whose name Windows cannot run safely from here. Run it in a terminal instead.`);
  }
  for (const argument of args) {
    assert(SAFE_ARGUMENT.test(argument), `commandProcessorCommand: ${JSON.stringify(argument)} is a safe constant argument`);
    assert(argument.length <= WINDOWS_COMMAND_LIMITS.argumentCharsMax, 'commandProcessorCommand: an argument is bounded');
  }
  const processor = commandProcessor(options);
  // `/s` strips the outer quotes, so the program's own quotes survive and a path with spaces stays one word.
  const line = `"${[`"${shim}"`, ...args].join(' ')}"`;
  const command: CommandLine = { command: processor, args: ['/d', '/s', '/c', line], argumentStyle: 'verbatim' };
  return ok({ command, environment: {}, description: `${processor} /d /s /c ${line}` });
}

function commandProcessor(options: ResolveOptions): string {
  const configured = options.environment['ComSpec'] ?? options.environment['COMSPEC'];
  if (configured !== undefined && /^[A-Za-z]:\\/.test(configured) && !CMD_SYNTAX_IN_PATH.test(configured)) {
    return configured;
  }
  const root = options.environment['SystemRoot'] ?? options.environment['SYSTEMROOT'];
  return root === undefined ? 'cmd.exe' : path.win32.join(root, 'System32', 'cmd.exe');
}

function findEntry(shim: string, name: string, options: ResolveOptions): string | undefined {
  const api = path.win32;
  const folder = api.dirname(shim);
  const relatives: string[] = [];
  const text = options.fileSystem.readText(shim);
  const parsed = text === undefined ? undefined : (/%dp0%\\([^"%\r\n]+\.(?:js|mjs|cjs))"/i.exec(text) ?? undefined);
  if (parsed?.[1] !== undefined) {
    relatives.push(parsed[1]);
  }
  for (const known of KNOWN_ENTRIES[name.toLowerCase()] ?? []) {
    relatives.push(known.split('/').join('\\'));
  }
  for (const relative of relatives) {
    const parts = relative.split(/[\\/]+/);
    // Only inside the shim's own node_modules: a shim cannot point this at another place.
    if (parts[0] !== 'node_modules' || parts.includes('..') || parts.includes('.')) {
      continue;
    }
    const entry = api.join(folder, ...parts);
    if (options.fileSystem.fileExists(entry)) {
      return entry;
    }
  }
  return undefined;
}

function findNode(shim: string, options: ResolveOptions): string | undefined {
  const candidates = [
    path.win32.join(path.win32.dirname(shim), 'node.exe'),
    ...searchDirectories(options).map((directory) => path.win32.join(directory, 'node.exe')),
  ];
  return candidates.find((candidate) => options.fileSystem.fileExists(candidate));
}

function findProgram(command: string, name: string, options: ResolveOptions): string | undefined {
  const api = path.win32;
  if (api.isAbsolute(command)) {
    return options.fileSystem.fileExists(command) ? command : undefined;
  }
  const extensions = pathExtensions(options.environment);
  for (const directory of searchDirectories(options)) {
    for (const extension of extensions) {
      const candidate = api.join(directory, `${name}${extension}`);
      if (options.fileSystem.fileExists(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/** PATH's folders, then the places a GUI-launched app's PATH usually lacks: npm's user prefix and Node's install folders. */
function searchDirectories(options: ResolveOptions): readonly string[] {
  const api = path.win32;
  const environment = options.environment;
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === 'path');
  const pathValue = pathKey === undefined ? '' : (environment[pathKey] ?? '');
  const fromPath = pathValue
    .split(';')
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry.length > 0);
  assert(fromPath.length <= WINDOWS_COMMAND_LIMITS.pathEntriesMax, 'searchDirectories: a PATH is bounded');
  const roaming = environment['APPDATA'] ?? api.join(options.home, 'AppData', 'Roaming');
  const programFiles = environment['ProgramFiles'] ?? 'C:\\Program Files';
  const programFilesX86 = environment['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const local = environment['LOCALAPPDATA'] ?? api.join(options.home, 'AppData', 'Local');
  const fallbacks = [api.join(roaming, 'npm'), api.join(programFiles, 'nodejs'), api.join(programFilesX86, 'nodejs'), api.join(local, 'Programs', 'nodejs')];
  const seen = new Set<string>();
  const directories: string[] = [];
  for (const directory of [...fromPath, ...fallbacks]) {
    const key = directory.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      directories.push(directory);
    }
  }
  return directories;
}

/** PATHEXT's executable kinds in the system's order, always including the two shim kinds so a bare `npm` finds `npm.cmd`. */
function pathExtensions(environment: Readonly<Record<string, string | undefined>>): readonly string[] {
  const key = Object.keys(environment).find((candidate) => candidate.toLowerCase() === 'pathext');
  const configured = (key === undefined ? undefined : environment[key]) ?? DEFAULT_PATHEXT;
  const wanted: readonly string[] = [...EXECUTABLE_EXTENSIONS, ...SHIM_EXTENSIONS];
  const extensions = configured
    .split(';')
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => wanted.includes(extension));
  for (const extension of SHIM_EXTENSIONS) {
    if (!extensions.includes(extension)) {
      extensions.push(extension);
    }
  }
  return extensions;
}

function isOneOf(value: string, allowed: readonly string[]): boolean {
  return allowed.includes(value);
}
