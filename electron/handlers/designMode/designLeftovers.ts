// Design mode (experimental, removable: docs/design-mode/REMOVE.md): finding and stopping what still runs from a
// sandbox copy, which after a crash is the copy's dev server. It has to be gone before the copy can be: Windows
// refuses to delete a folder that is a process's working directory, or a program that is running (the copy's own
// esbuild.exe), and a server left running anywhere would go on serving a copy that holds the project's `.env`.
//
// Which processes: only those that run from the copy, never one that merely names it. A process runs from the copy
// when its program is a file in the copy, or when it is a JavaScript runtime (or, on Windows, cmd.exe running a
// package shim) whose command line names a path in the copy or, where the system tells (Linux), whose working
// directory is in it; and so is a runtime such a process started. An editor with a file of the copy open, `tail` on
// its log, a shell standing in it and a browser a dev server opened are none of these, and are left alone.
//
// How processes are read: Linux from /proc, macOS from `ps`, Windows from PowerShell's Win32_Process (wmic is no
// longer installed). Stopping is by process id, one at a time, each round only after a fresh listing says the id
// still names the same process: no process group and no `taskkill /T`, which would follow a parent id that Windows
// has since given to somebody else.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const DESIGN_LEFTOVER_LIMITS = {
  /** Listing the processes. PowerShell takes a second or two, and much longer on a loaded machine's first run. */
  listMsMax: 30_000,
  listBytesMax: 64 * 1024 * 1024,
  processesMax: 100_000,
  /** Ancestors of this process looked up, none of which is ever stopped. */
  ancestorsMax: 64,
  /** Signal rounds: the first asks (SIGTERM), the others force (SIGKILL). Windows ends a process either way. */
  roundsMax: 3,
  /** How long one round waits for the signalled processes to end. */
  graceMs: 3_000,
  pollMs: 100,
} as const satisfies Record<string, number>;

export interface ListedProcess {
  readonly pid: number;
  readonly parentPid: number;
  /** The program's file or name; empty when the system does not tell. */
  readonly program: string;
  readonly commandLine: string;
  /** The working directory, where the system tells (Linux). */
  readonly cwd: string | undefined;
  /** When it started, where parent ids can outlive the parent (Windows). */
  readonly startedMs: number | undefined;
}

/** What stopping did. `unlisted`: the processes could not be read, so nothing is known about the copy's. */
export type StopOutcome =
  | { readonly kind: 'stopped'; readonly signalled: number }
  | { readonly kind: 'running'; readonly pids: readonly number[] }
  | { readonly kind: 'unlisted'; readonly detail: string };

export interface RunsFrom {
  /** The copy's folder, in every spelling it may be named by. */
  readonly roots: readonly string[];
  readonly platform: NodeJS.Platform;
  readonly ownPid: number;
  /** The file this app runs from: Electron runs a project's dev server as Node, under its own name. */
  readonly ownProgram: string;
}

const RUNTIME_NAMES: ReadonlySet<string> = new Set(['node', 'nodejs', 'bun', 'deno', 'electron']);

/** Paths as they are compared: Windows ignores case and takes either slash. */
function comparable(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? value.replaceAll('\\', '/').toLowerCase() : value;
}

function programName(program: string, platform: NodeJS.Platform): string {
  const name = comparable(program, platform).split('/').at(-1) ?? '';
  return platform === 'win32' ? name.replace(/\.exe$/, '') : name;
}

function isRuntime(process_: ListedProcess, where: RunsFrom): boolean {
  const name = programName(process_.program, where.platform);
  if (name === '') {
    return false;
  }
  return RUNTIME_NAMES.has(name) || name === programName(where.ownProgram, where.platform);
}

/** Whether `text` names `root` itself or a path in it, not just a longer name that begins the same way. */
function names(text: string, root: string): boolean {
  // Every match starts further along than the last, so the text's length bounds the loop.
  for (let at = text.indexOf(root); at >= 0; at = text.indexOf(root, at + 1)) {
    const next = text.charAt(at + root.length);
    if (next === '' || next === '/' || next === ' ' || next === '"' || next === "'") {
      return true;
    }
  }
  return false;
}

function runsFromOne(listed: ListedProcess, root: string, where: RunsFrom): boolean {
  const inside = `${root}/`;
  const program = comparable(listed.program, where.platform);
  const commandLine = comparable(listed.commandLine, where.platform);
  if (program.startsWith(inside)) {
    return true;
  }
  // The command itself is a file in the copy: a package's binary or shim started by its path.
  if (commandLine.replace(/^["']/, '').startsWith(inside)) {
    return true;
  }
  // Windows runs a package's `.cmd` shim through cmd.exe; any other command prompt in the copy is the person's own.
  const shimShell = where.platform === 'win32' && programName(listed.program, where.platform) === 'cmd' && commandLine.includes('/node_modules/.bin/');
  if (!isRuntime(listed, where) && !shimShell) {
    return false;
  }
  if (names(commandLine, root)) {
    return true;
  }
  const cwd = listed.cwd === undefined ? undefined : comparable(listed.cwd, where.platform);
  if (cwd === undefined) {
    return false;
  }
  return cwd === root || cwd.startsWith(inside);
}

/** This process and what started it: never stopped, whatever their command lines say. */
function protectedPids(processes: readonly ListedProcess[], ownPid: number): ReadonlySet<number> {
  const parents = new Map(processes.map((listed) => [listed.pid, listed.parentPid]));
  const own = new Set<number>([ownPid]);
  let current = ownPid;
  for (let climbed = 0; climbed < DESIGN_LEFTOVER_LIMITS.ancestorsMax; climbed += 1) {
    const parent = parents.get(current);
    if (parent === undefined || own.has(parent)) {
      break;
    }
    own.add(parent);
    current = parent;
  }
  return own;
}

/** The processes that run from the copy, by the rule at the top of this file. */
export function leftoverProcesses(processes: readonly ListedProcess[], where: RunsFrom): readonly ListedProcess[] {
  const roots = where.roots.map((root) => comparable(root, where.platform).replace(/\/+$/, ''));
  if (roots.some((root) => root.split('/').length < 3)) {
    throw new Error('Assertion failed: leftoverProcesses: a copy is a folder deep inside another, never a drive or a top folder');
  }
  const spared = protectedPids(processes, where.ownPid);
  const eligible = processes.filter((listed) => listed.pid > 1 && !spared.has(listed.pid));
  const found = new Map<number, ListedProcess>();
  for (const listed of eligible) {
    if (roots.some((root) => runsFromOne(listed, root, where))) {
      found.set(listed.pid, listed);
    }
  }
  // Then the runtimes those started, whose own command lines need not name the copy. The queue only grows by
  // processes not yet found, so it ends within the listing's length.
  const children = new Map<number, ListedProcess[]>();
  for (const listed of eligible) {
    children.set(listed.parentPid, [...(children.get(listed.parentPid) ?? []), listed]);
  }
  const queue = [...found.values()];
  for (let index = 0; index < queue.length; index += 1) {
    const parent = queue[index];
    for (const child of children.get(parent?.pid ?? 0) ?? []) {
      if (parent !== undefined && !found.has(child.pid) && isRuntime(child, where) && startedAfter(child, parent)) {
        found.set(child.pid, child);
        queue.push(child);
      }
    }
  }
  return [...found.values()];
}

// Windows keeps a process's parent id after the parent has gone, and gives the id out again: a child older than its
// "parent" is somebody else's.
function startedAfter(child: ListedProcess, parent: ListedProcess): boolean {
  if (child.startedMs === undefined || parent.startedMs === undefined) {
    return true;
  }
  return child.startedMs >= parent.startedMs;
}

function bounded(processes: readonly ListedProcess[]): readonly ListedProcess[] {
  if (processes.length > DESIGN_LEFTOVER_LIMITS.processesMax) {
    throw new Error('Design leftovers: more processes than a computer runs');
  }
  // A listing always holds at least the process that asked: an empty one is a listing that failed.
  if (processes.length === 0) {
    throw new Error('Design leftovers: no process listed');
  }
  return processes;
}

function wholeNumber(input: unknown): number | undefined {
  return typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 ? input : undefined;
}

function field(input: unknown, key: string): unknown {
  return typeof input === 'object' && input !== null ? Object.getOwnPropertyDescriptor(input, key)?.value : undefined;
}

function textOf(input: unknown): string {
  return typeof input === 'string' ? input : '';
}

/** PowerShell's answer (WINDOWS_QUERY): one object a process, or a single object where there is only one. */
export function parseWindowsProcesses(output: string): readonly ListedProcess[] {
  const parsed: unknown = JSON.parse(output.replace(/^\uFEFF/, '').trim());
  const rows: readonly unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const processes: ListedProcess[] = [];
  for (const row of rows) {
    const pid = wholeNumber(field(row, 'pid'));
    const parentPid = wholeNumber(field(row, 'parent'));
    if (pid === undefined || parentPid === undefined) {
      throw new Error('Design leftovers: a process without an id');
    }
    const started = wholeNumber(field(row, 'started'));
    processes.push({
      pid,
      parentPid,
      // Windows keeps a program's path and command line from other people's processes: those read as empty.
      program: textOf(field(row, 'program')) || textOf(field(row, 'name')),
      commandLine: textOf(field(row, 'command')),
      cwd: undefined,
      startedMs: started === 0 ? undefined : started,
    });
  }
  return bounded(processes);
}

/** `ps -o pid=,ppid=,command=` and `ps -o pid=,comm=`, joined by pid. Two calls: both columns may hold spaces. */
export function parsePosixProcesses(commands: string, programs: string): readonly ListedProcess[] {
  const programByPid = new Map<number, string>();
  for (const line of programs.split('\n')) {
    const found = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (found !== null) {
      programByPid.set(Number(found[1]), found[2] ?? '');
    }
  }
  const processes: ListedProcess[] = [];
  for (const line of commands.split('\n')) {
    const found = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (found !== null) {
      const pid = Number(found[1]);
      const parentPid = Number(found[2]);
      processes.push({
        pid,
        parentPid,
        program: programByPid.get(pid) ?? '',
        commandLine: found[3] ?? '',
        cwd: undefined,
        startedMs: undefined,
      });
    }
  }
  return bounded(processes);
}

function output(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const options = {
      env,
      timeout: DESIGN_LEFTOVER_LIMITS.listMsMax,
      maxBuffer: DESIGN_LEFTOVER_LIMITS.listBytesMax,
      encoding: 'utf8',
      windowsHide: true,
    } as const;
    execFile(command, [...args], options, (error, stdout) => (error === null ? resolve(stdout) : reject(error)));
  });
}

// The console's encoding is set so a folder name outside ASCII arrives as it is; a locked-down PowerShell refuses
// the assignment, and the listing still runs.
const WINDOWS_QUERY = [
  "$ErrorActionPreference = 'Stop'",
  'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
  'Get-CimInstance -ClassName Win32_Process | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; parent = $_.ParentProcessId; name = $_.Name; program = $_.ExecutablePath; command = $_.CommandLine; started = $(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }) } } | ConvertTo-Json -Compress',
].join('; ');

async function listWindows(): Promise<readonly ListedProcess[]> {
  // By its full path: a `powershell.exe` somewhere on PATH is not the one to ask.
  const system = process.env['SystemRoot'] ?? 'C:\\Windows';
  const powershell = path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return parseWindowsProcesses(await output(powershell, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_QUERY], process.env));
}

async function listDarwin(): Promise<readonly ListedProcess[]> {
  // An app started from the Finder has no locale, and `ps` would then escape a folder name outside ASCII.
  const env = { ...process.env, LC_ALL: 'en_US.UTF-8' };
  const commands = await output('/bin/ps', ['-A', '-ww', '-o', 'pid=,ppid=,command='], env);
  const programs = await output('/bin/ps', ['-A', '-ww', '-o', 'pid=,comm='], env);
  return parsePosixProcesses(commands, programs);
}

async function linkOf(file: string): Promise<string | undefined> {
  try {
    // A program or folder deleted from under a process is still named, with this ending.
    return (await fs.promises.readlink(file)).replace(/ \(deleted\)$/, '');
  } catch {
    return undefined;
  }
}

/** One process of /proc, or undefined when it ended while being read or has no command line (a zombie, a thread of the kernel). */
async function readProc(pid: number): Promise<ListedProcess | undefined> {
  const folder = `/proc/${pid}`;
  try {
    const commandLine = (await fs.promises.readFile(`${folder}/cmdline`, 'utf8')).replace(/\0+$/, '').replaceAll('\0', ' ');
    const stat = await fs.promises.readFile(`${folder}/stat`, 'utf8');
    // "pid (name) state parent …": the name may hold spaces and brackets, so the fields are read after the last one.
    const parentPid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    if (commandLine === '' || !Number.isSafeInteger(parentPid)) {
      return undefined;
    }
    // Both links are kept from other people's processes, which cannot be stopped either.
    const program = (await linkOf(`${folder}/exe`)) ?? '';
    return { pid, parentPid, program, commandLine, cwd: await linkOf(`${folder}/cwd`), startedMs: undefined };
  } catch {
    return undefined;
  }
}

async function listLinux(): Promise<readonly ListedProcess[]> {
  const pids = (await fs.promises.readdir('/proc')).filter((name) => /^\d+$/.test(name)).map(Number);
  const processes: ListedProcess[] = [];
  // One at a time: a computer runs a few thousand, each three small reads.
  for (const pid of pids.slice(0, DESIGN_LEFTOVER_LIMITS.processesMax)) {
    const listed = await readProc(pid);
    if (listed !== undefined) {
      processes.push(listed);
    }
  }
  return bounded(processes);
}

/** Every process the system shows this person. Rejects where they cannot be read. */
export function listProcesses(platform: NodeJS.Platform = process.platform): Promise<readonly ListedProcess[]> {
  if (platform === 'win32') {
    return listWindows();
  }
  return platform === 'linux' ? listLinux() : listDarwin();
}

/** The folder as a command line may name it: as given, and with its links (and Windows short names) resolved. */
function spellings(root: string): readonly string[] {
  const found = new Set([path.resolve(root)]);
  try {
    found.add(fs.realpathSync.native(root));
    found.add(fs.realpathSync(root));
  } catch {
    // Gone already: the spelling it was given is the one left to look for.
  }
  return [...found];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signal(pid: number, name: 'SIGTERM' | 'SIGKILL'): void {
  try {
    process.kill(pid, name);
  } catch {
    // Gone already, or not ours to stop: the next listing says which.
  }
}

async function waitForExit(pids: readonly number[]): Promise<void> {
  const polls = Math.ceil(DESIGN_LEFTOVER_LIMITS.graceMs / DESIGN_LEFTOVER_LIMITS.pollMs);
  for (let poll = 0; poll < polls && pids.some(isAlive); poll += 1) {
    await new Promise((resolve) => setTimeout(resolve, DESIGN_LEFTOVER_LIMITS.pollMs));
  }
}

/** What runs from the copy now: by the rule, or as an earlier round found it. */
function stillRunning(processes: readonly ListedProcess[], where: RunsFrom, seen: ReadonlyMap<number, string>): readonly ListedProcess[] {
  const found = new Map(leftoverProcesses(processes, where).map((listed) => [listed.pid, listed]));
  for (const listed of processes) {
    if (seen.get(listed.pid) === listed.commandLine) {
      found.set(listed.pid, listed);
    }
  }
  return [...found.values()];
}

/**
 * Stops every process that runs from `root` and says whether any is left. Bounded: at most `roundsMax` rounds of one
 * signal and one grace period, and one listing more than that. Never rejects.
 */
export async function stopServersIn(root: string, list: () => Promise<readonly ListedProcess[]> = () => listProcesses()): Promise<StopOutcome> {
  const where: RunsFrom = { roots: spellings(root), platform: process.platform, ownPid: process.pid, ownProgram: process.execPath };
  // What an earlier round found, by id: a child whose parent that round ended is no longer found through it, and is
  // still the same process while its command line is the same.
  const seen = new Map<number, string>();
  try {
    for (let round = 0; round < DESIGN_LEFTOVER_LIMITS.roundsMax; round += 1) {
      const found = stillRunning(await list(), where, seen);
      if (found.length === 0) {
        return { kind: 'stopped', signalled: seen.size };
      }
      for (const listed of found) {
        seen.set(listed.pid, listed.commandLine);
        signal(listed.pid, round === 0 ? 'SIGTERM' : 'SIGKILL');
      }
      await waitForExit(found.map((listed) => listed.pid));
    }
    const left = stillRunning(await list(), where, seen);
    return left.length === 0 ? { kind: 'stopped', signalled: seen.size } : { kind: 'running', pids: left.map((listed) => listed.pid) };
  } catch (error: unknown) {
    return { kind: 'unlisted', detail: String(error) };
  }
}
