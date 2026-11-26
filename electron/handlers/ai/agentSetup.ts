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
// status command prints (the account's email and plan, and which kind of sign-in is in use).
//
// Claude runs here on a Claude subscription only. Its commands go without the other routes
// (lib/claudeSubscriptionOnly.ts), and "signed in" takes proof (`readClaudeStatus`): a claude.ai sign-in with a paid
// plan, or a subscription token the CLI names as the token it will use (`CLAUDE_TOKEN_CHECK_ARGS`, asked with no
// message, so nothing is sent to the model). Anything else reads as signed out, and the card asks for a subscription
// sign-in. Every message and new session asks again (`permit`), and what a running session reports is watched
// (`sessionSignal`): a reply billed per use stops, and the panel says so.
//
// A status check has three answers, never two: signed in, signed out (the CLI said so), or "couldn't
// check" (it timed out, stopped, or printed something that cannot be read). Only a real "not signed
// in" blocks the composer. A check that could not be made is tried again after each delay in
// STATUS_RETRY_DELAYS_MS and then left until the panel asks again (a chat opening, the window being
// focused, or the person pressing the note under the composer).
//
// A sign-in is never an endless wait: it ends ready, or failed with a sentence and the CLI's own
// words (links and tokens left out) when the CLI exits without signing in, or after
// SETUP_LIMITS.signInMsMax. The CLI's output is also written to the main-process log, redacted.
//
// Bounds: one setup process per agent at a time; output kept to SETUP_LIMITS.outputCharsMax per
// stream; install, sign-in and each status check end after their timeout; a failed check is retried
// at most STATUS_RETRY_DELAYS_MS.length times.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert } from '../../../shared/core/assert';
import { toRecord } from '../../../shared/core/record';
import type { Result } from '../../../shared/core/result';
import { SETUP_DETAILS_CHARS_MAX, type SetupAccount, type SetupAction, type SetupState, type SignInSource } from '../../../shared/ipc/aiChat';
import { NO_KEY_SOURCE, SAVED_KEY_SOURCE, type ClaudeBillingSignal } from '../../../shared/properties/ai/claudeBilling';
import { AGENTS, AGENT_IDS, type AgentId } from '../../../shared/properties/ai/agentIds';
import { findCli, type CliFileSystem } from './agentRegistry';
import { claudeSettingsArguments, claudeSubscriptionEnvironment } from '../../lib/claudeSubscriptionOnly';
import { describeAttempt, realFileSystem, resolveWindowsCommand, type CommandFileSystem, type CommandLine, type ResolvedCommand } from './windowsCommand';
import { described } from './aiMessages';
import type { Described, TypedMessageRef } from '../../../shared/properties/i18n/messageRef';

/** Whether a Claude session may take a message: yes, not until the person signs in, or not while the sign-in cannot be checked. */
export type SessionPermit = 'allowed' | 'sign-in' | 'unchecked';

/** What becomes of a running turn after a signal from its session. */
export type SessionVerdict = 'continue' | 'stop';

/** The plans `claude auth status` names (`subscriptionType`) that are a subscription; a sign-in without one bills per use. */
const CLAUDE_SUBSCRIPTION_PLANS: readonly string[] = ['pro', 'max', 'team', 'enterprise'];

/** The token variable of `claude setup-token`, as the CLI names the token's source. */
const CLAUDE_SUBSCRIPTION_TOKEN = 'CLAUDE_CODE_OAUTH_TOKEN';

/**
 * Asks Claude which token it will use, without a message: only the `initialize` request is written, which Claude
 * Code 2.1.332 answers with its `account` record and no request to the model. `auth status` says only "oauth_token"
 * for every kind of token. No hooks run, no MCP server starts and no session is saved.
 */
export const CLAUDE_TOKEN_CHECK_ARGS: readonly string[] = [
  ...claudeSettingsArguments({ disableAllHooks: true }),
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--strict-mcp-config',
  '--no-session-persistence',
];

const CLAUDE_TOKEN_CHECK_INPUT = `${JSON.stringify({ type: 'control_request', request_id: 'stacki', request: { subtype: 'initialize' } })}\n`;

export const SETUP_LIMITS = {
  outputCharsMax: SETUP_DETAILS_CHARS_MAX,
  installMsMax: 10 * 60 * 1000,
  signInMsMax: 5 * 60 * 1000,
  statusMsMax: 20_000,
  /**
   * The token check's own wait. Why longer than a status: for a token, Claude Code 2.1.332 calls Anthropic before it
   * answers, and with the network refusing every try it took 18 s (0.1 s when the service answers).
   */
  tokenCheckMsMax: 30_000,
  /** The most of the token check's answer that is read: it lists the commands and models beside the account. */
  tokenCheckCharsMax: 4 * 1024 * 1024,
} as const satisfies Record<string, number>;

/** The waits before each new try of a status check that could not be made; its length is the number of retries. */
export const STATUS_RETRY_DELAYS_MS: readonly number[] = [2_000, 10_000];

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
  /** Reads what a status command that ran to its end printed. */
  readonly readStatus: (printed: StatusOutput) => StatusReading;
}

/** What a finished status command printed, the two streams kept apart, and how it ended. */
export interface StatusOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** What a status command's output says. `unreadable` is not an answer about the sign-in: nothing was learned. */
export type StatusReading =
  | { readonly kind: 'signed-in'; readonly account: SetupAccount }
  /** `reason`: Claude is signed in, but not in a way that is proven to be a subscription. */
  | { readonly kind: 'signed-out'; readonly reason?: 'not-subscription' }
  /** Claude would use some token: only the token check (`CLAUDE_TOKEN_CHECK_ARGS`) says which. */
  | { readonly kind: 'token' }
  | { readonly kind: 'unreadable' };

export const AGENT_SETUP: Readonly<Record<AgentId, AgentSetupCommands>> = {
  claude: {
    install: (_home, platform) =>
      platform === 'win32'
        ? { command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex'] }
        : { command: '/bin/bash', args: ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'] },
    status: [...claudeSettingsArguments(), 'auth', 'status'],
    signIn: [...claudeSettingsArguments(), 'auth', 'login', '--claudeai'],
    signOut: [...claudeSettingsArguments(), 'auth', 'logout'],
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
  /** `stream` is the pipe the text came from; absent means normal output (a terminal has only one). */
  readonly onData: (listener: (text: string, stream?: 'stdout' | 'stderr') => void) => void;
  readonly onExit: (listener: (exitCode: number) => void) => void;
  readonly write: (text: string) => void;
  readonly kill: () => void;
}

export interface SetupDeps {
  readonly environment: () => Readonly<Record<string, string | undefined>>;
  /**
   * The environment the agent's own CLI starts in for its status, sign-in and sign-out: `environment` plus the
   * sign-in settings the person's login shell sets (lib/loginShellSettings.ts). Installers never get these.
   * Absent: `environment`.
   */
  readonly agentEnvironment?: (agent: AgentId) => Promise<Readonly<Record<string, string | undefined>>>;
  /** A sign-in command succeeded but the status could not be checked: the agent is no longer held as signed out. */
  readonly signInCompleted?: (agent: AgentId) => void;
  /** The clock extra usage ends by; tests set it. */
  readonly now?: () => number;
  /** The status check's bounds; tests shorten them. */
  readonly statusTimeoutMs?: number;
  readonly statusRetryDelaysMs?: readonly number[];
  /** Opens a sign-in page in the person's browser. */
  readonly openExternal: (url: string) => void;
  readonly publish: (state: SetupState) => void;
  /** One line for the main-process log; the text is already redacted. */
  readonly log?: (line: string) => void;
  readonly spawnPipe?: (command: SetupCommand, environment: Readonly<Record<string, string | undefined>>) => SetupProcess;
  readonly spawnTerminal?: (command: SetupCommand, environment: Readonly<Record<string, string | undefined>>) => Promise<SetupProcess>;
  readonly home?: string;
  readonly platform?: NodeJS.Platform;
  /** The platform whose PATH rules find the CLI, when it differs from `platform` (a test runs real files on the host it is on). */
  readonly cliPlatform?: NodeJS.Platform;
  /** Where the CLI is looked for on PATH; tests give a fake one. */
  readonly cliFileSystem?: CliFileSystem;
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
  /** Counts what has decided each agent's state: a check started before the newest has nothing left to say. */
  private readonly revisions = new Map<AgentId, number>();
  private readonly checks = new Map<AgentId, { readonly revision: number; readonly result: Promise<SetupState> }>();
  private readonly retries = new Map<AgentId, ReturnType<typeof setTimeout>>();
  /** Agents a running session showed to be billed per use: held as signed out until a sign-in or sign-out here. */
  private readonly billedPerUse = new Set<AgentId>();
  /** Agents charging extra usage past their plan, with when the included usage returns (seconds; undefined unknown). */
  private readonly extraUsage = new Map<AgentId, { readonly resetsAtSeconds: number | undefined }>();
  /** The check a permit is waiting for, so sessions starting together share one status process. */
  private readonly permits = new Map<AgentId, Promise<SessionPermit>>();

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

  /**
   * Whether a Claude session may take a message now. Asked every time, never remembered: a sign-in can change in a
   * terminal at any moment. Only a status that proved a subscription allows it, because some other routes cannot be
   * switched off for a session; while the status cannot be checked, nothing is sent. Messages asking together share
   * one check. Other agents, and a missing CLI (the session says so itself), are always allowed.
   */
  permit(agent: AgentId): Promise<SessionPermit> {
    if (agent !== 'claude') {
      return Promise.resolve('allowed');
    }
    if (this.running.has(agent)) {
      return Promise.resolve('sign-in'); // Installing or signing in.
    }
    const waiting = this.permits.get(agent);
    if (waiting !== undefined) {
      return waiting;
    }
    const asked = this.detect(agent)
      .then((state): SessionPermit => {
        if (state.step === 'ready' || state.step === 'missing') {
          return 'allowed';
        }
        return state.step === 'unchecked' ? 'unchecked' : 'sign-in';
      })
      .finally(() => this.permits.delete(agent));
    this.permits.set(agent, asked);
    return asked;
  }

  /**
   * What a running session says about who pays. Extra usage past the plan cannot be switched off here, so the turn
   * goes on and the panel warns. An API key in the session stops the turn and signs the panel out, saying why. The
   * saved Console key's source is also reported beside a subscription that pays, so it is settled by asking again.
   */
  async sessionSignal(agent: AgentId, signal: ClaudeBillingSignal): Promise<SessionVerdict> {
    if (signal.kind === 'usage') {
      this.noteExtraUsage(agent, signal);
      return 'continue';
    }
    if (signal.source === NO_KEY_SOURCE) {
      return 'continue';
    }
    if (signal.source === SAVED_KEY_SOURCE) {
      return (await this.permit(agent)) === 'allowed' ? 'continue' : 'stop';
    }
    this.log(agent, 'a running session reported an API key: the turn is stopped');
    this.billedPerUse.add(agent);
    this.set({ agent, step: 'signed-out', reason: 'billed' });
    return 'stop';
  }

  private noteExtraUsage(agent: AgentId, usage: Extract<ClaudeBillingSignal, { readonly kind: 'usage' }>): void {
    const before = this.extraUsage.has(agent);
    if (usage.extra) {
      this.extraUsage.set(agent, { resetsAtSeconds: usage.resetsAtSeconds });
    } else {
      this.extraUsage.delete(agent);
    }
    const state = this.states.get(agent);
    if (before !== usage.extra && state?.step === 'ready') {
      // Only the warning changes: a check under way still has the say about the sign-in.
      this.publish({ agent, step: 'ready', account: state.account });
    }
  }

  /** Whether extra usage is still being charged: it ends when the included usage returns. */
  private chargesExtra(agent: AgentId): boolean {
    const usage = this.extraUsage.get(agent);
    if (usage === undefined) {
      return false;
    }
    if (usage.resetsAtSeconds !== undefined && this.now() >= usage.resetsAtSeconds * 1000) {
      this.extraUsage.delete(agent);
      return false;
    }
    return true;
  }

  /** The person signed in or out here: what earlier sessions showed no longer describes this sign-in. */
  private forgetBilling(agent: AgentId): void {
    this.billedPerUse.delete(agent);
    this.extraUsage.delete(agent);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Stops every setup process and pending retry: the app is quitting. */
  stopAll(): void {
    for (const agent of AGENT_IDS) {
      this.supersede(agent);
    }
    assert(this.retries.size === 0, 'AgentSetup.stopAll: no check is left waiting');
    for (const agent of [...this.running.keys()]) {
      this.stop(agent);
    }
    assert(this.running.size === 0, 'AgentSetup.stopAll: nothing is left running');
  }

  private state(agent: AgentId): SetupState {
    return this.states.get(agent) ?? { agent, step: 'missing' };
  }

  private set(state: SetupState): SetupState {
    this.supersede(state.agent);
    return this.publish(state);
  }

  private publish(state: SetupState): SetupState {
    const shown: SetupState = state.step === 'ready' && this.chargesExtra(state.agent) ? { ...state, billing: 'extra-usage' } : state;
    this.states.set(shown.agent, shown);
    this.deps.publish(shown);
    return shown;
  }

  private cliFileSystem(): { readonly fileSystem?: CliFileSystem } {
    return this.deps.cliFileSystem === undefined ? {} : { fileSystem: this.deps.cliFileSystem };
  }

  private cli(agent: AgentId): string | undefined {
    return findCli(agent, {
      environment: this.deps.environment(),
      platform: this.deps.cliPlatform ?? this.deps.platform ?? process.platform,
      ...this.cliFileSystem(),
    });
  }

  /** Forgets any pending retry, and makes every check already under way out of date. */
  private supersede(agent: AgentId): number {
    const timer = this.retries.get(agent);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.retries.delete(agent);
    }
    const revision = (this.revisions.get(agent) ?? 0) + 1;
    this.revisions.set(agent, revision);
    return revision;
  }

  /** Where the agent's CLI stands. `retried` counts the automatic tries already made; a new request starts at none. */
  private detect(agent: AgentId, retried = 0): Promise<SetupState> {
    const revision = this.supersede(agent);
    const result = this.check(agent, revision, retried);
    this.checks.set(agent, { revision, result });
    return result;
  }

  private async check(agent: AgentId, revision: number, retried: number): Promise<SetupState> {
    const cli = this.cli(agent);
    if (cli === undefined) {
      return this.set({ agent, step: 'missing' });
    }
    const environment = await this.agentEnvironment(agent);
    const timeoutMs = this.deps.statusTimeoutMs ?? SETUP_LIMITS.statusMsMax;
    const run = await this.collect(agent, { command: cli, args: AGENT_SETUP[agent].status }, { timeoutMs, environment });
    if (this.revisions.get(agent) !== revision) {
      return this.newerAnswer(agent, revision);
    }
    let reading: StatusReading = run.end === 'exited' ? AGENT_SETUP[agent].readStatus(run) : { kind: 'unreadable' };
    if (reading.kind === 'token') {
      reading = await this.checkToken(cli, environment, this.deps.statusTimeoutMs ?? SETUP_LIMITS.tokenCheckMsMax);
      if (this.revisions.get(agent) !== revision) {
        return this.newerAnswer(agent, revision);
      }
    }
    switch (reading.kind) {
      case 'signed-in':
        return this.billedPerUse.has(agent)
          ? this.set({ agent, step: 'signed-out', reason: 'billed' })
          : this.set({ agent, step: 'ready', account: reading.account });
      case 'signed-out':
        return this.set({ agent, step: 'signed-out', ...(reading.reason === undefined ? {} : { reason: reading.reason }) });
      case 'token': // The token check never answers with another one.
      case 'unreadable': {
        // How it ended and the exit code only: what an unreadable status printed may name the account.
        this.log(agent, `the sign-in status could not be checked (${run.end}, code ${run.exitCode})`);
        const state = this.set({ agent, step: 'unchecked' });
        this.retryLater(agent, retried);
        return state;
      }
      default: {
        const exhaustive: never = reading;
        return exhaustive;
      }
    }
  }

  /**
   * Whether the token Claude would use is a subscription token (`CLAUDE_TOKEN_CHECK_ARGS`). The process waits for
   * a message that never comes, so it is stopped as soon as it has answered. No answer in time is unreadable.
   */
  private checkToken(cli: string, environment: Readonly<Record<string, string | undefined>>, timeoutMs: number): Promise<StatusReading> {
    const resolved = this.resolve({ command: cli, args: CLAUDE_TOKEN_CHECK_ARGS });
    if (!resolved.ok) {
      return Promise.resolve({ kind: 'unreadable' });
    }
    const spawnPipe = this.deps.spawnPipe ?? spawnPipeProcess;
    return new Promise((resolve) => {
      let child: SetupProcess;
      try {
        child = spawnPipe(resolved.value.command, { ...environment, ...resolved.value.environment });
      } catch {
        resolve({ kind: 'unreadable' });
        return;
      }
      let output = '';
      let settled = false;
      const settle = (reading: StatusReading): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          output = ''; // It names the account.
          child.kill();
          resolve(reading);
        }
      };
      const timer = setTimeout(() => settle({ kind: 'unreadable' }), timeoutMs);
      child.onData((text, stream) => {
        if (settled || stream === 'stderr') {
          return;
        }
        output += text;
        const answer = readClaudeTokenCheck(output);
        if (answer !== undefined) {
          settle(answer);
        } else if (output.length > SETUP_LIMITS.tokenCheckCharsMax) {
          settle({ kind: 'unreadable' });
        }
      });
      child.onExit(() => settle(readClaudeTokenCheck(`${output}\n`) ?? { kind: 'unreadable' }));
      child.write(CLAUDE_TOKEN_CHECK_INPUT);
    });
  }

  /** What an overtaken check answers: the newer check's result, or the state something newer set. */
  private newerAnswer(agent: AgentId, revision: number): Promise<SetupState> | SetupState {
    const latest = this.checks.get(agent);
    if (latest !== undefined && latest.revision > revision && latest.revision === this.revisions.get(agent)) {
      return latest.result;
    }
    return this.state(agent);
  }

  private retryLater(agent: AgentId, retried: number): void {
    const delays = this.deps.statusRetryDelaysMs ?? STATUS_RETRY_DELAYS_MS;
    const delayMs = delays[retried];
    if (delayMs === undefined) {
      return; // The bound is reached: the next try waits for the person or the panel to ask.
    }
    assert(retried < delays.length, 'AgentSetup.retryLater: retries are bounded');
    const timer = setTimeout(() => {
      this.retries.delete(agent);
      void this.detect(agent, retried + 1);
    }, delayMs);
    timer.unref();
    this.retries.set(agent, timer);
  }

  private async agentEnvironment(agent: AgentId): Promise<Readonly<Record<string, string | undefined>>> {
    const environment = this.deps.agentEnvironment === undefined ? this.deps.environment() : await this.deps.agentEnvironment(agent);
    return claudeSubscriptionEnvironment(agent, environment);
  }

  private async install(agent: AgentId): Promise<SetupState> {
    if (this.running.has(agent)) {
      return this.state(agent);
    }
    this.set({ agent, step: 'installing' });
    const command = AGENT_SETUP[agent].install(this.deps.home ?? os.homedir(), this.deps.platform ?? process.platform);
    // An installer is not the agent: it gets the plain environment, never the sign-in settings.
    const { output, exitCode, attempt } = await this.collect(agent, command, {
      timeoutMs: SETUP_LIMITS.installMsMax,
      environment: claudeSubscriptionEnvironment(agent, this.deps.environment()),
    });
    if (exitCode !== 0) {
      return this.set({
        agent,
        step: 'failed',
        during: 'install',
        ...installFailureText(agent, command, output),
        details: this.attemptDetails(attempt, output),
      });
    }
    const after = await this.detect(agent);
    if (after.step === 'missing') {
      return this.set({
        agent,
        step: 'failed',
        during: 'install',
        ...described('ai.setupError.notFoundYet', { agent: AGENTS[agent].label }),
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
    const environment = await this.agentEnvironment(agent);
    // Checked after the wait, so two presses cannot start two sign-ins.
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
        ...described('ai.setupError.signInStartDetail', { detail: resolved.error }),
        details: this.attemptDetails(cli, resolved.error),
      });
    }
    let process: SetupProcess;
    try {
      process = await spawnTerminal(resolved.value.command, { ...environment, ...resolved.value.environment });
    } catch (error: unknown) {
      return this.set({
        agent,
        step: 'failed',
        during: 'sign-in',
        ...signInStartFailureText(String(error)),
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
        ...described('ai.setupError.signInTimeout', { count: Math.round(SETUP_LIMITS.signInMsMax / 60_000) }),
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
        this.set({ agent, step: 'failed', during: 'sign-in', ...signInStoppedText(exitCode, details), details });
        return;
      }
      this.forgetBilling(agent);
      void this.detect(agent).then((state) => {
        if (state.step === 'unchecked') {
          // The CLI said the sign-in worked and then could not be asked: that is not a failed sign-in. The next
          // message checks again before anything is sent.
          this.deps.signInCompleted?.(agent);
          this.deps.publish(this.state(agent));
        } else if (state.step !== 'ready' && !(state.step === 'signed-out' && state.reason !== undefined)) {
          // A sign-in that worked but is no subscription keeps the card that says so.
          this.set({ agent, step: 'failed', during: 'sign-in', ...described('ai.setupError.signInUnfinished'), details });
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
    const { output, exitCode, attempt } = await this.collect(
      agent,
      { command: cli, args: AGENT_SETUP[agent].signOut },
      { timeoutMs: SETUP_LIMITS.statusMsMax, environment: await this.agentEnvironment(agent) },
    );
    if (exitCode !== 0) {
      return this.set({ agent, step: 'failed', during: 'sign-out', ...described('ai.setupError.signOut'), details: this.attemptDetails(attempt, output) });
    }
    this.forgetBilling(agent);
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
  private collect(
    agent: AgentId,
    command: SetupCommand,
    options: { readonly timeoutMs: number; readonly environment: Readonly<Record<string, string | undefined>> },
  ): Promise<CollectedRun> {
    const spawnPipe = this.deps.spawnPipe ?? spawnPipeProcess;
    return new Promise((resolve) => {
      let output = '';
      let stdout = '';
      let stderr = '';
      let process: SetupProcess;
      const resolved = this.resolve(command);
      if (!resolved.ok) {
        // Nothing was started: the program is missing, so the person is told that (127, as a shell would).
        resolve({ output: resolved.error, stdout: '', stderr: '', exitCode: 127, end: 'not-started', attempt: describe(command) });
        return;
      }
      const attempt = resolved.value.description;
      try {
        process = spawnPipe(resolved.value.command, { ...options.environment, ...resolved.value.environment });
      } catch (error: unknown) {
        resolve({ output: String(error), stdout: '', stderr: '', exitCode: -1, end: 'not-started', attempt });
        return;
      }
      const timer = setTimeout(() => {
        process.kill();
        const stopped = `${output}\n(stopped after ${Math.round(options.timeoutMs / 1000)} s)`;
        resolve({ output: stopped, stdout, stderr, exitCode: -1, end: 'timed-out', attempt });
      }, options.timeoutMs);
      process.onData((text, stream) => {
        const clean = stripTerminalCodes(text);
        output = (output + clean).slice(-SETUP_LIMITS.outputCharsMax);
        if (stream === 'stderr') {
          stderr = (stderr + clean).slice(-SETUP_LIMITS.outputCharsMax);
        } else {
          stdout = (stdout + clean).slice(-SETUP_LIMITS.outputCharsMax);
        }
      });
      process.onExit((exitCode) => {
        clearTimeout(timer);
        // A negative code or 127 is a process that never ran or was stopped by a signal: it did not answer.
        const end = exitCode < 0 || exitCode === 127 ? 'crashed' : 'exited';
        resolve({ output, stdout, stderr, exitCode, end, attempt });
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

/** A finished command: its (bounded) output, how it ended and what was run, as a person reads it. */
interface CollectedRun extends StatusOutput {
  /** Both streams together, as they arrived: what a person reads in Details. */
  readonly output: string;
  readonly end: 'exited' | 'timed-out' | 'crashed' | 'not-started';
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
  return signInStoppedText(exitCode, redactedOutput).message;
}

/** The sign-in stop as English text plus the reference the renderer translates. */
export function signInStoppedText(exitCode: number, redactedOutput: string): Described & { readonly messageRef: TypedMessageRef } {
  const lastLine = redactedOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.includes('[sign-in link]') && !/paste code here/i.test(line))
    .at(-1);
  if (lastLine !== undefined && lastLine.length <= 140) {
    return described('ai.setupError.stoppedWith', { detail: lastLine });
  }
  return described('ai.setupError.stoppedCode', { code: exitCode });
}

export function stripTerminalCodes(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g, '');
}

const NO_ACCOUNT: SetupAccount = { name: undefined, plan: undefined, email: undefined, source: 'account' };

/**
 * `claude auth status`, from normal output only (warnings go to the other stream): `loggedIn` true or false is an
 * answer; anything else is not. Signed in takes proof of a subscription: Anthropic's own service (`apiProvider`), by a
 * claude.ai sign-in with a paid plan, or by a token the token check then has to name. Everything else the CLI can
 * report (a key, a key helper, a cloud provider, a claude.ai sign-in without a plan, a way not known here) is not
 * one. `apiKeySource` is not read: a key saved beside a subscription sign-in is reported and lies unused.
 * Of the account: the organisation's name when it is a name (a personal account's is "<email>'s Organization",
 * which is not), the plan, and the email for the account menu only.
 */
export function readClaudeStatus(printed: StatusOutput): StatusReading {
  const status = parseStatusJson(printed.stdout);
  if (status === undefined) {
    return { kind: 'unreadable' };
  }
  if (status['loggedIn'] === false) {
    return { kind: 'signed-out' };
  }
  if (status['loggedIn'] !== true || printed.exitCode !== 0) {
    return { kind: 'unreadable' };
  }
  const text = (key: string): string | undefined => (typeof status[key] === 'string' && status[key] !== '' ? status[key] : undefined);
  const refused: StatusReading = { kind: 'signed-out', reason: 'not-subscription' };
  if (text('apiProvider') !== 'firstParty') {
    return refused;
  }
  const method = text('authMethod');
  if (method === 'oauth_token') {
    return { kind: 'token' };
  }
  const plan = text('subscriptionType');
  if (method !== 'claude.ai' || plan === undefined || !CLAUDE_SUBSCRIPTION_PLANS.includes(plan)) {
    return refused;
  }
  const organisation = text('orgName');
  const name = organisation === undefined || organisation.includes('@') ? undefined : organisation;
  return { kind: 'signed-in', account: { name, plan: planName(plan), email: text('email'), source: 'account' } };
}

/**
 * The token check's answer in `output`, once its line is whole: signed in only when Claude names the subscription
 * token variable as its token's source, on Anthropic's own service. A saved Console key may be named beside it,
 * unused, as in `auth status`. undefined while there is no answer yet.
 */
export function readClaudeTokenCheck(output: string): StatusReading | undefined {
  // The last piece has no line end yet, so it may be half a line.
  for (const line of output.split('\n').slice(0, -1)) {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const envelope = toRecord(toRecord(message)?.['response']);
    if (toRecord(message)?.['type'] !== 'control_response' || envelope?.['request_id'] !== 'stacki') {
      continue;
    }
    const account = toRecord(toRecord(envelope['response'])?.['account']);
    if (account === undefined) {
      return { kind: 'unreadable' };
    }
    const keySource = account['apiKeySource'];
    const unusedKey = keySource === undefined || keySource === SAVED_KEY_SOURCE;
    return account['tokenSource'] === CLAUDE_SUBSCRIPTION_TOKEN && account['apiProvider'] === 'firstParty' && unusedKey
      ? { kind: 'signed-in', account: { ...NO_ACCOUNT, source: 'token' } }
      : { kind: 'signed-out', reason: 'not-subscription' };
  }
  return undefined;
}

/** The status object in normal output: the whole of it, or the object a chatty wrapper printed lines before. */
function parseStatusJson(stdout: string): Readonly<Record<string, unknown>> | undefined {
  const whole = stdout.trim();
  // The object starts a line of its own; a brace inside a warning's sentence does not.
  const lineStart = /^\{/m.exec(whole)?.index;
  const end = whole.lastIndexOf('}');
  if (lineStart === undefined || end < lineStart) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(whole.slice(lineStart, end + 1));
    return toRecord(value);
  } catch {
    return undefined;
  }
}

/**
 * `codex login status` prints its answer on the error stream (codex-rs/cli/src/login.rs uses eprintln! for every
 * outcome), so both are read, line by line. "Logged in using ChatGPT" names how, not who. An API key line carries
 * part of the key: the line is read for its kind only and never kept.
 */
export function readCodexStatus(printed: StatusOutput): StatusReading {
  const lines = `${printed.stdout}\n${printed.stderr}`.split('\n').map((line) => line.trim());
  if (lines.some((line) => /^not logged in\b/i.test(line))) {
    return { kind: 'signed-out' };
  }
  const line = lines.find((candidate) => /^(logged in\b|api key configured\b)/i.test(candidate));
  if (printed.exitCode !== 0 || line === undefined) {
    return { kind: 'unreadable' };
  }
  return { kind: 'signed-in', account: { ...NO_ACCOUNT, source: codexSignInSource(line) } };
}

function codexSignInSource(line: string): SignInSource {
  if (/bedrock/i.test(line)) {
    return 'cloud';
  }
  if (/api key/i.test(line)) {
    return 'api-key';
  }
  return /access token|workload identity/i.test(line) ? 'token' : 'account';
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
  return signInStartFailureText(detail).message;
}

export function signInStartFailureText(detail: string): Described & { readonly messageRef: TypedMessageRef } {
  if (/posix_spawnp/i.test(detail)) {
    // node-pty's helper lost its execute bit (an install that skipped scripts); `npm run fix:pty` restores it.
    return described('ai.setupError.helperNotExecutable');
  }
  return described('ai.setupError.signInStart');
}

function installFailureText(agent: AgentId, command: SetupCommand, output: string): Described & { readonly messageRef: TypedMessageRef } {
  const label = AGENTS[agent].label;
  if (/ENOENT|not found|command not found/i.test(output) && /(^|[\\/])npm(\.cmd)?$/i.test(command.command)) {
    return described('ai.setupError.needsNode', { agent: label });
  }
  if (/EINVAL/.test(output)) {
    // Windows refused to start a script directly. Stacki starts npm's JavaScript itself, so this means no way to do that was found.
    return described('ai.setupError.installerStart', { agent: label });
  }
  if (/EACCES|permission denied|password/i.test(output)) {
    return described('ai.setupError.needsPermission', { agent: label });
  }
  return described('ai.setupError.installFailed', { agent: label });
}

/** `cwd` is the folder the command runs in; the app's own by default. */
export function spawnPipeProcess(command: SetupCommand, environment: Readonly<Record<string, string | undefined>>, cwd?: string): SetupProcess {
  const child = spawn(command.command, [...command.args], {
    env: { ...environment },
    ...(cwd === undefined ? {} : { cwd }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // A cmd.exe command line (windowsCommand.ts) is already quoted: Node must not quote it again.
    windowsVerbatimArguments: command.argumentStyle === 'verbatim',
  });
  // A command that ends before it reads what is written to it (the token check's request) breaks the pipe; its exit
  // says what happened, and an unheard pipe error would take the main process down.
  child.stdin.on('error', () => undefined);
  return {
    onData: (listener) => {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (text: string) => listener(text, 'stdout'));
      child.stderr.on('data', (text: string) => listener(text, 'stderr'));
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

export async function spawnPseudoTerminal(
  command: SetupCommand,
  environment: Readonly<Record<string, string | undefined>>,
  cwd: string = os.homedir(),
): Promise<SetupProcess> {
  const pty = await import('node-pty');
  // On Windows node-pty takes the arguments as one ready command line, which is how a verbatim one is handed over.
  const args = command.argumentStyle === 'verbatim' ? command.args.join(' ') : [...command.args];
  const terminal = pty.spawn(command.command, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: definedEnvironment({ ...environment, BROWSER: 'none' }),
  });
  return {
    onData: (listener) => terminal.onData(listener),
    onExit: (listener) => terminal.onExit((info) => listener(info.exitCode)),
    write: (text) => terminal.write(text),
    kill: () => terminal.kill(),
  };
}
