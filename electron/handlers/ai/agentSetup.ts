// Guided setup for designers who never open a terminal: buttons that run each
// agent's own official installer and its own sign-in underneath.
//
// What runs, per agent (AGENT_SETUP below):
// - Claude. Install: Anthropic's native installer, `curl -fsSL https://claude.ai/install.sh | bash`
//   (macOS, Linux; into ~/.local/bin, no sudo), or `irm https://claude.ai/install.ps1 | iex` in
//   PowerShell on Windows. Status: `claude auth status` (JSON). Sign in: `claude auth login
//   --claudeai`. Sign out: `claude auth logout`.
// - Codex. Install: `npm install --global --prefix ~/.local @openai/codex` (into ~/.local/bin, no
//   sudo; on Windows npm's own global folder). Status: `codex login status`. Sign in: `codex login`
//   (ChatGPT). Sign out: `codex logout`.
//
// Sign-in runs in a hidden pseudo-terminal, as the CLI expects. The first sign-in page it prints
// (an https address on the provider's own hosts) is opened in the person's browser; when the CLI
// asks for a code to be pasted back, the panel shows a field and the code is typed into the CLI.
// The CLI stores the credentials itself: Stacki never sees or keeps them, and only reads what the
// status command prints (the account's email and plan).
//
// A sign-in is never an endless wait: it ends ready, or failed with a sentence and the CLI's own
// words (links and tokens left out) when the CLI exits without signing in, or after
// SETUP_LIMITS.signInMsMax. The CLI's output is also written to the main-process log, redacted.
//
// Bounds: one setup process per agent at a time; output kept to SETUP_LIMITS.outputCharsMax; install
// and sign-in each end after their timeout.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert } from '../../../shared/core/assert';
import { toRecord } from '../../../shared/core/record';
import type { Result } from '../../../shared/core/result';
import { SETUP_DETAILS_CHARS_MAX, type SetupAccount, type SetupAction, type SetupState } from '../../../shared/ipc/aiChat';
import { AGENTS, type AgentId } from '../../../shared/properties/ai/agentIds';
import { findCli } from './agentRegistry';
import { describeAttempt, realFileSystem, resolveWindowsCommand, type CommandFileSystem, type CommandLine, type ResolvedCommand } from './windowsCommand';

export const SETUP_LIMITS = {
  outputCharsMax: SETUP_DETAILS_CHARS_MAX,
  installMsMax: 10 * 60 * 1000,
  signInMsMax: 5 * 60 * 1000,
  statusMsMax: 20_000,
} as const satisfies Record<string, number>;

/**
 * A command as an argument list: never a string a shell would re-read, except the official installer pipe.
 * On Windows a .cmd shim is never started directly (windowsCommand.ts explains why); it is replaced by what it runs.
 */
export type SetupCommand = CommandLine;

interface AgentSetupCommands {
  readonly install: (home: string, platform: NodeJS.Platform) => SetupCommand;
  readonly status: readonly string[];
  readonly signIn: readonly string[];
  readonly signOut: readonly string[];
  /** Hosts a sign-in page may be on; any other address the CLI prints is not opened. */
  readonly signInHosts: readonly string[];
  /** Reads the status command's output: signed in (with the account it names), or not. */
  readonly readStatus: (output: string, exitCode: number) => { readonly signedIn: boolean; readonly account: SetupAccount };
}

export const AGENT_SETUP: Readonly<Record<AgentId, AgentSetupCommands>> = {
  claude: {
    install: (_home, platform) =>
      platform === 'win32'
        ? { command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex'] }
        : { command: '/bin/bash', args: ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'] },
    status: ['auth', 'status'],
    signIn: ['auth', 'login', '--claudeai'],
    signOut: ['auth', 'logout'],
    signInHosts: ['claude.ai', 'claude.com', 'anthropic.com', 'console.anthropic.com', 'platform.claude.com'],
    readStatus: readClaudeStatus,
  },
  codex: {
    install: (home, platform) =>
      platform === 'win32'
        ? { command: 'npm.cmd', args: ['install', '--global', '@openai/codex'] }
        : { command: 'npm', args: ['install', '--global', '--prefix', path.join(home, '.local'), '@openai/codex'] },
    status: ['login', 'status'],
    signIn: ['login'],
    signOut: ['logout'],
    signInHosts: ['auth.openai.com', 'chatgpt.com', 'openai.com'],
    readStatus: readCodexStatus,
  },
};

/** A process the setup drives: a pipe for installs and status, a pseudo-terminal for sign-in. */
export interface SetupProcess {
  readonly onData: (listener: (text: string) => void) => void;
  readonly onExit: (listener: (exitCode: number) => void) => void;
  readonly write: (text: string) => void;
  readonly kill: () => void;
}

export interface SetupDeps {
  readonly environment: () => Readonly<Record<string, string | undefined>>;
  /** Opens a sign-in page in the person's browser. */
  readonly openExternal: (url: string) => void;
  readonly publish: (state: SetupState) => void;
  /** One line for the main-process log; the text is already redacted. */
  readonly log?: (line: string) => void;
  readonly spawnPipe?: (command: SetupCommand, environment: Readonly<Record<string, string | undefined>>) => SetupProcess;
  readonly spawnTerminal?: (command: SetupCommand, environment: Readonly<Record<string, string | undefined>>) => Promise<SetupProcess>;
  readonly home?: string;
  readonly platform?: NodeJS.Platform;
  /** Where Windows shims are looked up; tests give a fake one. */
  readonly fileSystem?: CommandFileSystem;
  /** Stacki's own binary, the Node of last resort for a Windows shim. */
  readonly execPath?: string;
}

/** What a running sign-in has printed so far, and what Stacki did about it. */
interface SignInWatch {
  /** Everything printed, escape codes included: they are stripped over the whole text, not per chunk, because a chunk can end inside one. */
  raw: string;
  output: string;
  opened: string | undefined;
  needsCode: boolean;
}

interface Running {
  readonly process: SetupProcess;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class AgentSetup {
  private readonly states = new Map<AgentId, SetupState>();
  private readonly running = new Map<AgentId, Running>();
  private readonly signInWatch = new Map<AgentId, SignInWatch>();

  constructor(private readonly deps: SetupDeps) {}

  async act(agent: AgentId, action: SetupAction): Promise<SetupState> {
    switch (action.kind) {
      case 'detect':
        return this.running.has(agent) ? this.state(agent) : this.detect(agent);
      case 'install':
        return this.install(agent);
      case 'signIn':
        return this.signIn(agent);
      case 'code':
        return this.paste(agent, action.code);
      case 'cancel':
        return this.cancel(agent);
      case 'signOut':
        return this.signOut(agent);
      default: {
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  }

  /** Stops every setup process: the app is quitting. */
  stopAll(): void {
    for (const agent of [...this.running.keys()]) {
      this.stop(agent);
    }
    assert(this.running.size === 0, 'AgentSetup.stopAll: nothing is left running');
  }

  private state(agent: AgentId): SetupState {
    return this.states.get(agent) ?? { agent, step: 'missing' };
  }

  private set(state: SetupState): SetupState {
    this.states.set(state.agent, state);
    this.deps.publish(state);
    return state;
  }

  private cli(agent: AgentId): string | undefined {
    return findCli(agent, this.deps.environment()['PATH'] ?? '');
  }

  private async detect(agent: AgentId): Promise<SetupState> {
    const cli = this.cli(agent);
    if (cli === undefined) {
      return this.set({ agent, step: 'missing' });
    }
    const { output, exitCode } = await this.collect(agent, { command: cli, args: AGENT_SETUP[agent].status }, SETUP_LIMITS.statusMsMax);
    const status = AGENT_SETUP[agent].readStatus(output, exitCode);
    return this.set(status.signedIn ? { agent, step: 'ready', account: status.account } : { agent, step: 'signed-out' });
  }

  private async install(agent: AgentId): Promise<SetupState> {
    if (this.running.has(agent)) {
      return this.state(agent);
    }
    this.set({ agent, step: 'installing' });
    const command = AGENT_SETUP[agent].install(this.deps.home ?? os.homedir(), this.deps.platform ?? process.platform);
    const { output, exitCode, attempt } = await this.collect(agent, command, SETUP_LIMITS.installMsMax);
    if (exitCode !== 0) {
      return this.set({
        agent,
        step: 'failed',
        during: 'install',
        message: installFailure(agent, command, output),
        details: this.attemptDetails(attempt, output),
      });
    }
    const after = await this.detect(agent);
    if (after.step === 'missing') {
      return this.set({
        agent,
        step: 'failed',
        during: 'install',
        message: `${AGENTS[agent].label} was installed, but Stacki cannot find it yet. Restart Stacki, then try again.`,
        details: output,
      });
    }
    return after;
  }

  private async signIn(agent: AgentId): Promise<SetupState> {
    const cli = this.cli(agent);
    if (cli === undefined) {
      return this.set({ agent, step: 'missing' });
    }
    if (this.running.has(agent)) {
      return this.state(agent);
    }
    const spawnTerminal = this.deps.spawnTerminal ?? spawnPseudoTerminal;
    const resolved = this.resolve({ command: cli, args: AGENT_SETUP[agent].signIn });
    if (!resolved.ok) {
      return this.set({
        agent,
        step: 'failed',
        during: 'sign-in',
        message: `The sign-in could not start. ${resolved.error}`,
        details: this.attemptDetails(cli, resolved.error),
      });
    }
    let process: SetupProcess;
    try {
      process = await spawnTerminal(resolved.value.command, { ...this.deps.environment(), ...resolved.value.environment });
    } catch (error: unknown) {
      return this.set({
        agent,
        step: 'failed',
        during: 'sign-in',
        message: signInStartFailure(String(error)),
        details: this.attemptDetails(resolved.value.description, String(error)),
      });
    }
    const watch: SignInWatch = { raw: '', output: '', opened: undefined, needsCode: false };
    this.signInWatch.set(agent, watch);
    const timer = setTimeout(() => {
      this.stop(agent);
      this.log(agent, `sign-in stopped after ${Math.round(SETUP_LIMITS.signInMsMax / 60_000)} minutes without finishing`);
      this.set({
        agent,
        step: 'failed',
        during: 'sign-in',
        message: `Sign-in didn’t finish in ${Math.round(SETUP_LIMITS.signInMsMax / 60_000)} minutes. Try again.`,
        details: redactSignInOutput(watch.output),
      });
    }, SETUP_LIMITS.signInMsMax);
    // The bound must never keep the process alive: a sign-in nobody finishes would otherwise hold the app
    // (and any test that starts one) open for the full five minutes after everything else has ended.
    timer.unref();
    this.running.set(agent, { process, timer });
    process.onData((text) => this.signInOutput(agent, text));
    process.onExit((exitCode) => {
      if (this.running.get(agent)?.process !== process) {
        return; // Cancelled or timed out: already settled.
      }
      this.stop(agent);
      this.log(agent, `sign-in process exited with code ${exitCode}`);
      const details = redactSignInOutput(watch.output);
      if (exitCode !== 0) {
        // No status read: a CLI whose saved sign-in has expired still reports "signed in", which would
        // pass a failed sign-in off as a success.
        this.set({ agent, step: 'failed', during: 'sign-in', message: signInStopped(exitCode, details), details });
        return;
      }
      void this.detect(agent).then((state) => {
        if (state.step !== 'ready') {
          this.set({ agent, step: 'failed', during: 'sign-in', message: 'Sign-in did not finish. Try again.', details });
        }
      });
    });
    return this.set({ agent, step: 'signing-in', url: undefined, needsCode: false, output: '' });
  }

  private signInOutput(agent: AgentId, text: string): void {
    const watch = this.signInWatch.get(agent);
    if (watch === undefined) {
      return;
    }
    watch.raw = (watch.raw + text).slice(-SETUP_LIMITS.outputCharsMax * 2);
    const before = watch.output;
    watch.output = stripTerminalCodes(watch.raw).slice(-SETUP_LIMITS.outputCharsMax);
    if (watch.output !== before) {
      this.log(agent, redactSignInOutput(stripTerminalCodes(text)).trim());
    }
    const url = signInURL(watch.output, AGENT_SETUP[agent].signInHosts);
    const needsCode = asksForCode(watch.output);
    if (url !== undefined && url !== watch.opened) {
      watch.opened = url;
      this.deps.openExternal(url);
    }
    if (watch.output !== before || needsCode !== watch.needsCode || url !== undefined) {
      watch.needsCode = needsCode;
      this.set({ agent, step: 'signing-in', url: watch.opened, needsCode, output: redactSignInOutput(watch.output) });
    }
  }

  private log(agent: AgentId, line: string): void {
    if (line !== '') {
      (this.deps.log ?? ((text: string) => console.info(text)))(`[ai-setup] ${agent}: ${line}`);
    }
  }

  private paste(agent: AgentId, code: string): SetupState {
    const running = this.running.get(agent);
    const watch = this.signInWatch.get(agent);
    if (running === undefined || watch === undefined) {
      return this.state(agent);
    }
    assert(!/[\r\n]/.test(code), 'AgentSetup.paste: one line, parsed at the boundary');
    running.process.write(`${code}\r`);
    watch.needsCode = false;
    // Only the prompt that asked is answered; a later one will ask again.
    watch.raw = '';
    watch.output = '';
    this.log(agent, 'a pasted code was sent to the sign-in');
    return this.set({ agent, step: 'signing-in', url: watch.opened, needsCode: false, output: '' });
  }

  private async cancel(agent: AgentId): Promise<SetupState> {
    this.stop(agent);
    return this.detect(agent);
  }

  private async signOut(agent: AgentId): Promise<SetupState> {
    const cli = this.cli(agent);
    if (cli === undefined) {
      return this.set({ agent, step: 'missing' });
    }
    const { output, exitCode, attempt } = await this.collect(agent, { command: cli, args: AGENT_SETUP[agent].signOut }, SETUP_LIMITS.statusMsMax);
    if (exitCode !== 0) {
      return this.set({ agent, step: 'failed', during: 'sign-out', message: 'Signing out did not work.', details: this.attemptDetails(attempt, output) });
    }
    return this.detect(agent);
  }

  private stop(agent: AgentId): void {
    const running = this.running.get(agent);
    if (running === undefined) {
      return;
    }
    this.running.delete(agent);
    this.signInWatch.delete(agent);
    clearTimeout(running.timer);
    running.process.kill();
    assert(!this.running.has(agent), 'AgentSetup.stop: the process is let go');
  }

  /** Runs a command to its end through a pipe, its output bounded; never rejects. */
  private collect(agent: AgentId, command: SetupCommand, timeoutMs: number): Promise<CollectedRun> {
    const spawnPipe = this.deps.spawnPipe ?? spawnPipeProcess;
    return new Promise((resolve) => {
      let output = '';
      let process: SetupProcess;
      const resolved = this.resolve(command);
      if (!resolved.ok) {
        // Nothing was started: the program is missing, so the person is told that (127, as a shell would).
        resolve({ output: resolved.error, exitCode: 127, attempt: describe(command) });
        return;
      }
      const attempt = resolved.value.description;
      try {
        process = spawnPipe(resolved.value.command, { ...this.deps.environment(), ...resolved.value.environment });
      } catch (error: unknown) {
        resolve({ output: String(error), exitCode: -1, attempt });
        return;
      }
      const timer = setTimeout(() => {
        process.kill();
        resolve({ output: `${output}\n(stopped after ${Math.round(timeoutMs / 1000)} s)`, exitCode: -1, attempt });
      }, timeoutMs);
      process.onData((text) => {
        output = (output + stripTerminalCodes(text)).slice(-SETUP_LIMITS.outputCharsMax);
      });
      process.onExit((exitCode) => {
        clearTimeout(timer);
        resolve({ output, exitCode, attempt });
      });
      assert(agent.length > 0, 'collect: on behalf of an agent');
    });
  }

  /** The command Windows can start for `command` (a shim becomes what it runs); unchanged elsewhere. */
  private resolve(command: SetupCommand): Result<ResolvedCommand, string> {
    return resolveWindowsCommand(command, {
      platform: this.deps.platform ?? process.platform,
      environment: this.deps.environment(),
      home: this.deps.home ?? os.homedir(),
      execPath: this.deps.execPath ?? process.execPath,
      fileSystem: this.deps.fileSystem ?? realFileSystem(fs),
    });
  }

  /** Details for a failure: where it happened and what was tried, then the last of what was printed, within the card's bound. */
  private attemptDetails(attempt: string, output: string): string {
    const header = `${describeAttempt(this.deps.platform ?? process.platform, os.arch(), attempt)}\n\n`;
    const tail = output.trim();
    assert(header.length < SETUP_LIMITS.outputCharsMax, 'attemptDetails: the header leaves room for the output');
    return `${header}${tail.slice(-(SETUP_LIMITS.outputCharsMax - header.length))}`;
  }
}

/** A finished command: its (bounded) output, exit code and what was run, as a person reads it. */
interface CollectedRun {
  readonly output: string;
  readonly exitCode: number;
  readonly attempt: string;
}

function describe(command: SetupCommand): string {
  return [command.command, ...command.args].join(' ');
}

// ---------------------------------------------------------------------------
// Output readers (pure, tested on their own)
// ---------------------------------------------------------------------------

/** The first https address on an allowed host, as the CLI printed it. */
export function signInURL(output: string, hosts: readonly string[]): string | undefined {
  for (const match of output.matchAll(/https:\/\/[^\s"'<>\x00-\x1f]+/g)) {
    const text = match[0].replace(/[).,;]+$/, '');
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      continue;
    }
    const allowed = hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
    if (allowed && url.username === '' && url.password === '') {
      return url.href;
    }
  }
  return undefined;
}

/** Whether the CLI is waiting for a code to be pasted back. */
export function asksForCode(output: string): boolean {
  const tail = output.slice(-600);
  return /paste (the |your )?(authorization |auth )?code|enter (the |your )?(authorization |auth )?code|code here/i.test(tail);
}

/**
 * The CLI's words with what must not be kept left out: sign-in links (their query holds the one-time
 * state; the card offers the link by its own buttons) and anything shaped like a token or a code.
 */
export function redactSignInOutput(text: string): string {
  return text
    .replace(/https?:\/\/[^\s"'<>\x00-\x1f]+/g, '[sign-in link]')
    .replace(/\b(sk-ant-|sk-|ghp_|gho_|xox[bap]-)[A-Za-z0-9_-]{8,}/g, '[token]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [token]')
    .replace(/\b(access_token|refresh_token|id_token|code|authorization_code)(["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{8,}/gi, '$1$2[token]');
}

/** The sentence for a sign-in whose process exited with a failure: the CLI's last line when it said one, else the code. */
export function signInStopped(exitCode: number, redactedOutput: string): string {
  const lastLine = redactedOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.includes('[sign-in link]') && !/paste code here/i.test(line))
    .at(-1);
  if (lastLine !== undefined && lastLine.length <= 140) {
    return `Sign-in stopped: ${lastLine}`;
  }
  return `Sign-in stopped (code ${exitCode}). Open Details for what the CLI said.`;
}

export function stripTerminalCodes(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g, '');
}

const NO_ACCOUNT: SetupAccount = { name: undefined, plan: undefined, email: undefined };

/**
 * `claude auth status`: signed in, the organisation's name when it is a name (a personal account's is
 * "<email>'s Organization", which is not), the plan, and the email for the account menu only.
 */
export function readClaudeStatus(output: string, exitCode: number): { readonly signedIn: boolean; readonly account: SetupAccount } {
  const start = output.indexOf('{');
  let value: unknown;
  try {
    value = JSON.parse(start === -1 ? output : output.slice(start));
  } catch {
    return { signedIn: false, account: NO_ACCOUNT };
  }
  const status = toRecord(value);
  if (status === undefined || status['loggedIn'] !== true || exitCode !== 0) {
    return { signedIn: false, account: NO_ACCOUNT };
  }
  const text = (key: string): string | undefined => (typeof status[key] === 'string' && status[key] !== '' ? status[key] : undefined);
  const organisation = text('orgName');
  const name = organisation === undefined || organisation.includes('@') ? undefined : organisation;
  const plan = text('subscriptionType');
  return { signedIn: true, account: { name, plan: plan === undefined ? undefined : planName(plan), email: text('email') } };
}

/** `codex login status`: "Logged in using ChatGPT" names how, not who; no name or email is printed. */
export function readCodexStatus(output: string, exitCode: number): { readonly signedIn: boolean; readonly account: SetupAccount } {
  const line = output.split('\n').find((candidate) => /logged in/i.test(candidate) && !/not logged in/i.test(candidate));
  if (exitCode !== 0 || line === undefined) {
    return { signedIn: false, account: NO_ACCOUNT };
  }
  return { signedIn: true, account: NO_ACCOUNT };
}

/** A plan as a person reads it: "max" → "Max", "team_plus" → "Team Plus". */
export function planName(plan: string): string {
  const name = plan
    .split(/[_\s-]+/)
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
  assert(!name.includes('@'), 'planName: a plan, not an address');
  return name;
}

/** Why a sign-in terminal did not start, in words a person can act on. */
export function signInStartFailure(detail: string): string {
  if (/posix_spawnp/i.test(detail)) {
    // node-pty's helper lost its execute bit (an install that skipped scripts); `npm run fix:pty` restores it.
    return 'The sign-in could not start: the terminal helper is not executable. Run “npm run fix:pty”, restart Stacki, then try again.';
  }
  return 'The sign-in could not start.';
}

function installFailure(agent: AgentId, command: SetupCommand, output: string): string {
  const label = AGENTS[agent].label;
  if (/ENOENT|not found|command not found/i.test(output) && /(^|[\\/])npm(\.cmd)?$/i.test(command.command)) {
    return `Installing ${label} needs Node.js. Install Node.js from nodejs.org, then try again.`;
  }
  if (/EINVAL/.test(output)) {
    // Windows refused to start a script directly. Stacki starts npm's JavaScript itself, so this means no way to do that was found.
    return `Stacki could not start the ${label} installer on this computer. Open Details, or install it yourself in a terminal: npm install --global @openai/codex`;
  }
  if (/EACCES|permission denied|password/i.test(output)) {
    return `Installing ${label} needs permission Stacki does not ask for. Use “Copy details” and run it in Terminal.`;
  }
  return `${label} could not be installed. Check your connection and try again.`;
}

function spawnPipeProcess(command: SetupCommand, environment: Readonly<Record<string, string | undefined>>): SetupProcess {
  const child = spawn(command.command, [...command.args], {
    env: { ...environment },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // A cmd.exe command line (windowsCommand.ts) is already quoted: Node must not quote it again.
    windowsVerbatimArguments: command.argumentStyle === 'verbatim',
  });
  return {
    onData: (listener) => {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', listener);
      child.stderr.on('data', listener);
    },
    onExit: (listener) => {
      child.on('error', (error) => listener(errorExit(error)));
      child.on('close', (code) => listener(code ?? -1));
    },
    write: (text) => child.stdin.write(text),
    kill: () => child.kill(),
  };
}

/** node-pty writes every value into the child's environment block, so an undefined one would arrive as the text "undefined". */
function definedEnvironment(environment: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const defined: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) {
      defined[key] = value;
    }
  }
  return defined;
}

function errorExit(error: unknown): number {
  return toRecord(error)?.['code'] === 'ENOENT' ? 127 : -1;
}

async function spawnPseudoTerminal(command: SetupCommand, environment: Readonly<Record<string, string | undefined>>): Promise<SetupProcess> {
  const pty = await import('node-pty');
  // On Windows node-pty takes the arguments as one ready command line, which is how a verbatim one is handed over.
  const args = command.argumentStyle === 'verbatim' ? command.args.join(' ') : [...command.args];
  const terminal = pty.spawn(command.command, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: os.homedir(),
    env: definedEnvironment({ ...environment, BROWSER: 'none' }),
  });
  return {
    onData: (listener) => terminal.onData(listener),
    onExit: (listener) => terminal.onExit((info) => listener(info.exitCode)),
    write: (text) => terminal.write(text),
    kill: () => terminal.kill(),
  };
}
