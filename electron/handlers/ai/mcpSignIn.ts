// Signing in to an MCP server from Stacki, through the agent's own CLI, so a designer never needs a terminal and
// Stacki never handles a token: the CLI runs the browser callback on this computer, stores the token where its
// own sessions read it (the panel's agents are those sessions: same CLI, same environment, same project folder),
// and keeps it across chats and restarts.
//
// What runs, per agent, from the project folder:
// - Claude. Where a server stands: `claude mcp get <name>` (its "Status:" line). Sign in: `claude mcp login
//   <name> --no-browser`, in a pseudo-terminal because the CLI gives up without one (nothing is typed into it).
//   Sign out: `claude mcp logout <name>`. These refuse a `.mcp.json` server nobody approved in Claude's own
//   screen, although the panel's agents (a non-interactive session) use it. So each command is given
//   `--settings {"enabledMcpjsonServers":["<name>"]}`: that one server, for that one command, written nowhere.
//   A server the person rejected stays rejected.
// - Codex. Where servers stand: `codex mcp list --json` (`auth_status`). Sign in: `codex mcp login <name>
//   --no-browser`. Sign out: `codex mcp logout <name>`.
// A CLI that lists no `mcp login` in its help is too old; one without `--no-browser` opens the page itself.
//
// The sign-in page: with `--no-browser` the CLI prints it and Stacki opens it, only when it is an https address
// with no user name in it. It carries one-time values, so it is held in memory for "open again" and goes nowhere
// else: not to the window, not to a log. Nothing a CLI prints here is logged: its listings hold header values.
//
// Only what the CLI says is shown. A local command and a server with its own Authorization header have no
// sign-in. Because asking Claude about a server connects to it, nothing is asked on its own until the project is
// allowed to run agents; a person's press is that allowance for that server.
//
// Bounds: MCP_SIGN_IN_LIMITS. A sign-in always ends: finished, failed, cancelled or timed out.
import fs from 'node:fs';
import os from 'node:os';
import { assert } from '../../../shared/core/assert';
import { toRecord } from '../../../shared/core/record';
import {
  isSignInServerName,
  type McpAuthEntry,
  type McpAuthNotice,
  type McpAuthRequest,
  type McpAuthReply,
  type McpAuthState,
} from '../../../shared/properties/mcp';
import { MCP_LIMITS } from '../../../shared/properties/mcpConfig';
import type { AgentId } from '../../../shared/properties/ai/agentIds';
import { spawnPipeProcess, spawnPseudoTerminal, stripTerminalCodes, type SetupCommand, type SetupProcess } from './agentSetup';
import { realFileSystem, resolveWindowsCommand, type CommandFileSystem } from './windowsCommand';
import { claudeSettingsArguments, withoutClaudeAPIKey } from '../../lib/claudeSubscriptionOnly';

export const MCP_SIGN_IN_LIMITS = {
  /** How long a sign-in may wait for the browser: the CLIs' own limit. */
  signInMsMax: 5 * 60 * 1000,
  /** One status, help or sign-out command. */
  commandMsMax: 45_000,
  /** How long what a CLI said about a server is used before it is asked again. */
  freshMsMax: 5 * 60 * 1000,
  /** `claude mcp get` connects to its server, so only a few run at once. */
  checksAtOnceMax: 3,
  signInsAtOnceMax: 4,
  outputCharsMax: 64 * 1024,
  urlCharsMax: 8 * 1024,
} as const satisfies Record<string, number>;

type Environment = Readonly<Record<string, string | undefined>>;

/** A server of the project as its `.mcp.json` describes it, reduced to what decides whether a sign-in can apply. */
export interface ProjectServer {
  readonly name: string;
  /** `oauth-capable`: a remote address with no Authorization header of its own. */
  readonly kind: 'oauth-capable' | 'other';
}

export interface McpSignInDeps {
  readonly findCli: (agent: AgentId) => string | undefined;
  /** The environment the agent's own sessions start in, so the sign-in lands where they look. */
  readonly environment: (agent: AgentId) => Promise<Environment>;
  /** The project's `.mcp.json` servers. */
  readonly projectServers: (root: string) => readonly ProjectServer[];
  /** Whether the project may run agents (so its servers may be contacted without a press). */
  readonly trusted: (root: string) => boolean;
  readonly openExternal: (url: string) => void;
  readonly publish: (root: string, entry: McpAuthEntry, notice: McpAuthNotice | undefined) => void;
  /** A sign-in or sign-out went through: the agent's idle sessions should start again. */
  readonly changed: (agent: AgentId) => void;
  readonly log?: (line: string) => void;
  readonly now?: () => number;
  readonly spawnPipe?: (command: SetupCommand, environment: Environment, cwd: string) => SetupProcess;
  readonly spawnTerminal?: (command: SetupCommand, environment: Environment, cwd: string) => Promise<SetupProcess>;
  readonly platform?: NodeJS.Platform;
  readonly fileSystem?: CommandFileSystem;
  readonly signInMs?: number;
  readonly commandMs?: number;
}

/** What a CLI's help says it can do. */
type LoginSupport = 'none' | 'opens-browser' | 'prints-page';

/** One sign-in under way. What changes in it changes only through its methods. */
class SignIn {
  private process: SetupProcess | undefined = undefined;
  private timer: ReturnType<typeof setTimeout> | undefined = undefined;
  /** The sign-in page, once opened; never leaves this object but to the browser. */
  page: string | undefined = undefined;
  output = '';

  constructor(
    readonly root: string,
    readonly agent: AgentId,
    readonly name: string,
  ) {}

  attach(process: SetupProcess, timer: ReturnType<typeof setTimeout>): void {
    assert(this.process === undefined, 'SignIn.attach: one program per sign-in');
    this.process = process;
    this.timer = timer;
  }

  /** What the CLI printed, its start dropped past the bound. */
  note(chunk: string): string {
    this.output = (this.output + chunk).slice(-MCP_SIGN_IN_LIMITS.outputCharsMax);
    return this.output;
  }

  opened(page: string): void {
    this.page = page;
  }

  release(): void {
    clearTimeout(this.timer);
    this.process?.kill();
    this.page = undefined;
    this.output = '';
  }
}

interface Remembered {
  readonly state: McpAuthState;
  readonly at: number;
}

interface Finished {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export class McpSignIn {
  private readonly signIns = new Map<string, SignIn>();
  private readonly known = new Map<string, Remembered>();
  private readonly support = new Map<string, Promise<LoginSupport>>();
  /** The listing under way per project: asking again while it runs (the window focused twice) starts nothing more. */
  private readonly listings = new Map<string, Promise<readonly McpAuthEntry[]>>();

  constructor(private readonly deps: McpSignInDeps) {}

  async act(root: string, request: McpAuthRequest): Promise<McpAuthReply> {
    switch (request.kind) {
      case 'list':
        return { servers: await this.list(root, request.freshness), notice: undefined };
      case 'check':
        return this.reply(await this.check(root, request.agent, request.name), undefined);
      case 'signIn':
        return this.signIn(root, request.agent, request.name);
      case 'reopen':
        return this.reopen(root, request.agent, request.name);
      case 'cancel':
        return this.cancel(root, request.agent, request.name);
      case 'signOut':
        return this.signOut(root, request.agent, request.name);
      default: {
        const exhaustive: never = request;
        return exhaustive;
      }
    }
  }

  /** Stops every sign-in: the project closed or the app is quitting. */
  stopAll(): void {
    for (const key of [...this.signIns.keys()]) {
      this.end(key);
    }
    assert(this.signIns.size === 0, 'McpSignIn.stopAll: nothing is left waiting');
  }

  private reply(entry: McpAuthEntry, notice: McpAuthNotice | undefined): McpAuthReply {
    return { servers: [entry], notice };
  }

  private list(root: string, freshness: 'cached' | 'fresh'): Promise<readonly McpAuthEntry[]> {
    const running = this.listings.get(root);
    if (running !== undefined) {
      return running;
    }
    const listing = this.listBoth(root, freshness).finally(() => this.listings.delete(root));
    this.listings.set(root, listing);
    return listing;
  }

  private async listBoth(root: string, freshness: 'cached' | 'fresh'): Promise<readonly McpAuthEntry[]> {
    const [claude, codex] = await Promise.all([this.listClaude(root, freshness), this.listCodex(root, freshness)]);
    return [...claude, ...codex];
  }

  private async listClaude(root: string, freshness: 'cached' | 'fresh'): Promise<readonly McpAuthEntry[]> {
    if (this.deps.findCli('claude') === undefined) {
      return [];
    }
    const servers = this.deps
      .projectServers(root)
      .filter((server) => server.kind === 'oauth-capable' && isSignInServerName(server.name))
      .slice(0, MCP_LIMITS.serversMax);
    return mapBounded(servers, MCP_SIGN_IN_LIMITS.checksAtOnceMax, async ({ name }) => {
      const current = this.current(root, 'claude', name, freshness);
      if (current !== undefined) {
        return { agent: 'claude', name, state: current };
      }
      return this.deps.trusted(root) ? this.check(root, 'claude', name) : { agent: 'claude', name, state: 'not-checked' };
    });
  }

  /** The state to answer without asking the CLI: a sign-in under way, or what was said recently enough. */
  private current(root: string, agent: AgentId, name: string, freshness: 'cached' | 'fresh'): McpAuthState | undefined {
    const key = keyOf(root, agent, name);
    if (this.signIns.has(key)) {
      return 'signing-in';
    }
    const known = this.known.get(key);
    const recent = known !== undefined && this.now() - known.at < MCP_SIGN_IN_LIMITS.freshMsMax;
    return freshness === 'cached' && recent ? known.state : undefined;
  }

  private async listCodex(root: string, freshness: 'cached' | 'fresh'): Promise<readonly McpAuthEntry[]> {
    const cli = this.deps.findCli('codex');
    if (cli === undefined) {
      return [];
    }
    const prefix = keyOf(root, 'codex', '');
    const cached = [...this.known].filter(([key]) => key.startsWith(prefix));
    if (freshness === 'cached' && cached.length > 0 && cached.every(([, known]) => this.now() - known.at < MCP_SIGN_IN_LIMITS.freshMsMax)) {
      return cached.map(([key, known]) => {
        const name = key.slice(prefix.length);
        return { agent: 'codex', name, state: this.signIns.has(key) ? 'signing-in' : known.state };
      });
    }
    const states = await this.codexStates(root);
    return [...(states ?? [])].map(([name, state]) => this.remember(root, 'codex', name, this.signIns.has(keyOf(root, 'codex', name)) ? 'signing-in' : state));
  }

  /** Every remote server Codex lists, with where it stands; undefined when the listing could not be read. */
  private async codexStates(root: string): Promise<ReadonlyMap<string, McpAuthState> | undefined> {
    const run = await this.run(root, 'codex', ['mcp', 'list', '--json']);
    return run === undefined || run.exitCode !== 0 ? undefined : parseCodexServers(run.stdout);
  }

  private async check(root: string, agent: AgentId, name: string): Promise<McpAuthEntry> {
    if (this.signIns.has(keyOf(root, agent, name))) {
      return { agent, name, state: 'signing-in' };
    }
    return this.remember(root, agent, name, await this.ask(root, agent, name));
  }

  /** What the agent's CLI says about one server now. */
  private async ask(root: string, agent: AgentId, name: string): Promise<McpAuthState> {
    if (agent === 'codex') {
      const states = await this.codexStates(root);
      return states === undefined ? 'unknown' : (states.get(name) ?? 'none');
    }
    if (!this.isOAuthCapable(root, name)) {
      return 'none';
    }
    const run = await this.run(root, 'claude', [...approval(name), 'mcp', 'get', name]);
    return run === undefined ? 'unknown' : parseClaudeServerStatus(run.stdout);
  }

  private isOAuthCapable(root: string, name: string): boolean {
    return this.deps.projectServers(root).some((server) => server.name === name && server.kind === 'oauth-capable');
  }

  private async loginSupport(root: string, agent: AgentId): Promise<LoginSupport> {
    const cli = this.deps.findCli(agent);
    if (cli === undefined) {
      return 'none';
    }
    // Keyed by the resolved program: an update is a different file, so it is asked again.
    let support = this.support.get(cli);
    if (support === undefined) {
      support = this.run(root, agent, [...(agent === 'claude' ? claudeSettingsArguments() : []), 'mcp', 'login', '--help']).then((run) => {
        if (run === undefined || run.exitCode < 0) {
          this.support.delete(cli); // Nothing was learned; ask again next time.
          return 'none';
        }
        return parseLoginSupport(run.exitCode, `${run.stdout}\n${run.stderr}`);
      });
      this.support.set(cli, support);
    }
    return support;
  }

  private async signIn(root: string, agent: AgentId, name: string): Promise<McpAuthReply> {
    const key = keyOf(root, agent, name);
    if (this.signIns.has(key)) {
      return this.reply({ agent, name, state: 'signing-in' }, undefined);
    }
    // The project's own file says whether a sign-in can apply to Claude's server; Codex is asked about its own.
    if (agent === 'claude' && !this.isOAuthCapable(root, name)) {
      return this.reply(this.remember(root, agent, name, 'none'), 'not-needed');
    }
    if (this.signIns.size >= MCP_SIGN_IN_LIMITS.signInsAtOnceMax) {
      return this.reply({ agent, name, state: 'needs-sign-in' }, 'busy');
    }
    // Taken before anything is waited for, so two presses cannot start two sign-ins.
    const signIn = new SignIn(root, agent, name);
    this.signIns.set(key, signIn);
    const support = await this.loginSupport(root, agent);
    if (this.signIns.get(key) !== signIn) {
      return this.reply(this.state(root, agent, name), undefined);
    }
    if (support === 'none') {
      this.end(key);
      return this.reply(this.remember(root, agent, name, 'unsupported-cli'), 'unsupported-cli');
    }
    const browser = support === 'prints-page' ? ['--no-browser'] : [];
    const args = [...(agent === 'claude' ? approval(name) : []), 'mcp', 'login', name, ...browser];
    let started: SetupProcess;
    try {
      started = await this.startTerminal(root, agent, args);
    } catch {
      this.log(agent, 'a server sign-in could not be started');
      this.end(key);
      return this.reply(this.remember(root, agent, name, 'needs-sign-in'), 'failed');
    }
    if (this.signIns.get(key) !== signIn) {
      started.kill(); // Cancelled while the program was starting.
      return this.reply(this.state(root, agent, name), undefined);
    }
    const timer = setTimeout(() => this.settle(signIn, 'needs-sign-in', 'timed-out'), this.deps.signInMs ?? MCP_SIGN_IN_LIMITS.signInMsMax);
    timer.unref();
    signIn.attach(started, timer);
    started.onData((chunk) => this.signInOutput(signIn, chunk, support));
    started.onExit((exitCode) => void this.signInExit(signIn, exitCode));
    const waiting: McpAuthEntry = { agent, name, state: 'signing-in' };
    this.deps.publish(root, waiting, undefined);
    return this.reply(waiting, undefined);
  }

  private signInOutput(signIn: SignIn, chunk: string, support: LoginSupport): void {
    const output = signIn.note(chunk);
    if (support !== 'prints-page' || signIn.page !== undefined || !this.isWaiting(signIn)) {
      return;
    }
    const page = authorizationPage(stripTerminalCodes(output));
    if (page.kind === 'unsafe') {
      this.settle(signIn, 'needs-sign-in', 'unsafe-page');
    } else if (page.kind === 'page') {
      signIn.opened(page.url);
      this.deps.openExternal(page.url);
    }
  }

  private async signInExit(signIn: SignIn, exitCode: number): Promise<void> {
    if (!this.isWaiting(signIn)) {
      return; // Cancelled or timed out: already settled.
    }
    const { root, agent, name } = signIn;
    this.log(agent, `a server sign-in ended with code ${exitCode}`);
    if (exitCode !== 0) {
      const failure = signInFailure(stripTerminalCodes(signIn.output));
      this.settle(signIn, failure.state, failure.notice);
      return;
    }
    // Asked while the sign-in still counts as under way, so the window shows one step: waiting, then the answer.
    const state = await this.ask(root, agent, name);
    if (!this.isWaiting(signIn)) {
      return;
    }
    if (state === 'needs-sign-in') {
      this.settle(signIn, state, 'failed');
      return;
    }
    // The CLI said it worked; a check that cannot be made does not unsay that.
    this.settle(signIn, state === 'unknown' ? 'connected' : state, 'signed-in');
    this.deps.changed(agent);
  }

  private isWaiting(signIn: SignIn): boolean {
    return this.signIns.get(keyOf(signIn.root, signIn.agent, signIn.name)) === signIn;
  }

  /** Ends a sign-in and tells the window where the server stands and what happened. */
  private settle(signIn: SignIn, state: McpAuthState, notice: McpAuthNotice): void {
    const { root, agent, name } = signIn;
    this.end(keyOf(root, agent, name));
    this.deps.publish(root, this.remember(root, agent, name, state), notice);
  }

  private end(key: string): void {
    const signIn = this.signIns.get(key);
    if (signIn === undefined) {
      return;
    }
    this.signIns.delete(key);
    signIn.release();
    assert(!this.signIns.has(key), 'McpSignIn.end: the sign-in is let go');
  }

  private reopen(root: string, agent: AgentId, name: string): McpAuthReply {
    const page = this.signIns.get(keyOf(root, agent, name))?.page;
    if (page !== undefined) {
      this.deps.openExternal(page);
    }
    return this.reply(this.state(root, agent, name), undefined);
  }

  private cancel(root: string, agent: AgentId, name: string): McpAuthReply {
    const signIn = this.signIns.get(keyOf(root, agent, name));
    if (signIn === undefined) {
      return this.reply(this.state(root, agent, name), undefined);
    }
    this.end(keyOf(root, agent, name));
    // Claude removes a stored sign-in before it starts a new one, so a cancelled one leaves none.
    return this.reply(this.remember(root, agent, name, 'needs-sign-in'), 'cancelled');
  }

  private async signOut(root: string, agent: AgentId, name: string): Promise<McpAuthReply> {
    this.end(keyOf(root, agent, name));
    const run = await this.run(root, agent, [...(agent === 'claude' ? approval(name) : []), 'mcp', 'logout', name]);
    if (run === undefined || run.exitCode !== 0) {
      return this.reply(await this.check(root, agent, name), 'sign-out-failed');
    }
    this.deps.changed(agent);
    return this.reply(await this.check(root, agent, name), 'signed-out');
  }

  private state(root: string, agent: AgentId, name: string): McpAuthEntry {
    const key = keyOf(root, agent, name);
    return { agent, name, state: this.signIns.has(key) ? 'signing-in' : (this.known.get(key)?.state ?? 'unknown') };
  }

  private remember(root: string, agent: AgentId, name: string, state: McpAuthState): McpAuthEntry {
    const key = keyOf(root, agent, name);
    this.known.delete(key);
    this.known.set(key, { state, at: this.now() });
    const oldest = this.known.keys().next();
    // Several projects' worth of servers; the one remembered longest ago is simply asked again.
    if (this.known.size > MCP_LIMITS.serversMax * 8 && oldest.done !== true) {
      this.known.delete(oldest.value);
    }
    return { agent, name, state };
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private async command(agent: AgentId, args: readonly string[]): Promise<{ readonly command: SetupCommand; readonly environment: Environment } | undefined> {
    const cli = this.deps.findCli(agent);
    if (cli === undefined) {
      return undefined;
    }
    const environment = withoutClaudeAPIKey(agent, await this.deps.environment(agent));
    const resolved = resolveWindowsCommand(
      { command: cli, args: [...args] },
      {
        platform: this.deps.platform ?? process.platform,
        environment,
        home: os.homedir(),
        execPath: process.execPath,
        fileSystem: this.deps.fileSystem ?? realFileSystem(fs),
      },
    );
    return resolved.ok ? { command: resolved.value.command, environment: { ...environment, ...resolved.value.environment } } : undefined;
  }

  private async startTerminal(root: string, agent: AgentId, args: readonly string[]): Promise<SetupProcess> {
    const prepared = await this.command(agent, args);
    if (prepared === undefined) {
      throw new Error('the CLI could not be started');
    }
    return (this.deps.spawnTerminal ?? spawnPseudoTerminal)(prepared.command, prepared.environment, root);
  }

  /** One command run to its end in the project folder, its output bounded; undefined when it did not finish. */
  private async run(root: string, agent: AgentId, args: readonly string[]): Promise<Finished | undefined> {
    const prepared = await this.command(agent, args);
    if (prepared === undefined) {
      return undefined;
    }
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let child: SetupProcess;
      try {
        child = (this.deps.spawnPipe ?? spawnPipeProcess)(prepared.command, prepared.environment, root);
      } catch {
        resolve(undefined);
        return;
      }
      const timer = setTimeout(() => {
        child.kill();
        resolve(undefined);
      }, this.deps.commandMs ?? MCP_SIGN_IN_LIMITS.commandMsMax);
      child.onData((chunk, stream) => {
        const clean = stripTerminalCodes(chunk);
        if (stream === 'stderr') {
          stderr = (stderr + clean).slice(-MCP_SIGN_IN_LIMITS.outputCharsMax);
        } else {
          // The start is kept: a listing cut at the front could not be read at all.
          stdout = (stdout + clean).slice(0, MCP_SIGN_IN_LIMITS.outputCharsMax);
        }
      });
      child.onExit((exitCode) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode });
      });
    });
  }

  private log(agent: AgentId, line: string): void {
    (this.deps.log ?? ((message: string) => console.info(message)))(`[mcp-sign-in] ${agent}: ${line}`);
  }
}

function keyOf(root: string, agent: AgentId, name: string): string {
  return `${root}\0${agent}\0${name}`;
}

/** The one-command approval of this project server (see the head comment). The name is a plain identifier. */
function approval(name: string): readonly string[] {
  assert(isSignInServerName(name), 'approval: a plain server name');
  return claudeSettingsArguments({ enabledMcpjsonServers: [name] });
}

async function mapBounded<T, R>(items: readonly T[], atOnce: number, run: (item: T) => Promise<R>): Promise<readonly R[]> {
  assert(atOnce > 0, 'mapBounded: at least one at a time');
  const results: R[] = [];
  for (let start = 0; start < items.length; start += atOnce) {
    results.push(...(await Promise.all(items.slice(start, start + atOnce).map(run))));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Output readers (pure, tested on their own)
// ---------------------------------------------------------------------------

/** What `claude mcp get` says on its "Status:" line. Its other lines are never read: they hold header values. */
export function parseClaudeServerStatus(stdout: string): McpAuthState {
  const status = stdout
    .split('\n')
    .map((line) => /^\s*Status:\s*(.+?)\s*$/.exec(line)?.[1])
    .find((value) => value !== undefined);
  if (status === undefined) {
    return 'unknown';
  }
  if (/needs authentication/i.test(status)) {
    return 'needs-sign-in';
  }
  // "✔ Connected", also "! Connected · tools fetch failed": reached, which is what a sign-in is about.
  if (/^[^a-z]*connected\b/i.test(status)) {
    return 'connected';
  }
  if (/rejected|disabled|blocked|pending approval/i.test(status)) {
    return 'blocked';
  }
  return 'unknown';
}

/**
 * `codex mcp list --json`: each remote server and its `auth_status` (codex-rs/protocol, McpAuthStatus, in
 * snake_case, so OAuth may be spelled "o_auth"). A local command has no sign-in and is left out. A Codex that
 * reports no status for a remote server is too old for this.
 */
export function parseCodexServers(stdout: string): ReadonlyMap<string, McpAuthState> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const servers = new Map<string, McpAuthState>();
  for (const item of value.slice(0, MCP_LIMITS.serversMax)) {
    const server = toRecord(item);
    const name = server?.['name'];
    const transport = toRecord(server?.['transport'])?.['type'];
    if (typeof name !== 'string' || !isSignInServerName(name) || transport === 'stdio') {
      continue;
    }
    servers.set(name, codexAuthState(server?.['auth_status']));
  }
  return servers;
}

function codexAuthState(status: unknown): McpAuthState {
  switch (status) {
    case 'not_logged_in':
      return 'needs-sign-in';
    case 'o_auth':
    case 'oauth':
    case 'o_auth_logged_in':
      return 'connected';
    case 'unsupported':
    case 'bearer_token':
      return 'none';
    case undefined:
      return 'unsupported-cli';
    default:
      return 'unknown';
  }
}

export function parseLoginSupport(exitCode: number, help: string): LoginSupport {
  // An older CLI answers with the help of `mcp` itself, or an "unknown command" error.
  if (exitCode !== 0 || !/usage:[^\n]*\bmcp login\b/i.test(help)) {
    return 'none';
  }
  return help.includes('--no-browser') ? 'prints-page' : 'opens-browser';
}

/** The words each CLI prints before the sign-in page; an address printed any other way is never opened. */
const PAGE_MARKS = /(?:Visit this URL to authorize:|If the browser didn't open, visit:|by opening this URL in your browser:)\s*(\S+)(?=\s)/;

export type AuthorizationPage = { readonly kind: 'none' } | { readonly kind: 'unsafe' } | { readonly kind: 'page'; readonly url: string };

/** The sign-in page in what the CLI has printed so far: only a whole line, and only a secure web address. */
export function authorizationPage(output: string): AuthorizationPage {
  const printed = PAGE_MARKS.exec(output)?.[1];
  if (printed === undefined) {
    return { kind: 'none' };
  }
  if (printed.length > MCP_SIGN_IN_LIMITS.urlCharsMax) {
    return { kind: 'unsafe' };
  }
  let url: URL;
  try {
    url = new URL(printed);
  } catch {
    return { kind: 'unsafe' };
  }
  const secure = url.protocol === 'https:' && url.username === '' && url.password === '';
  return secure ? { kind: 'page', url: url.href } : { kind: 'unsafe' };
}

/** Why a sign-in command failed, from the CLI's own sentences; the sentences themselves go nowhere. */
export function signInFailure(output: string): { readonly state: McpAuthState; readonly notice: McpAuthNotice } {
  if (/was rejected|awaiting approval/i.test(output)) {
    return { state: 'blocked', notice: 'blocked' };
  }
  if (/support OAuth|only supported for|authenticates with the|authenticates automatically/i.test(output)) {
    return { state: 'none', notice: 'not-needed' };
  }
  if (/authentication timeout|timed out waiting/i.test(output)) {
    return { state: 'needs-sign-in', notice: 'timed-out' };
  }
  return { state: 'needs-sign-in', notice: 'failed' };
}
