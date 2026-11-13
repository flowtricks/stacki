// The supervisor of the AI panel's agents: one adapter process per agent per
// project, started on the first prompt (or early: `prewarm`, with one empty
// session parked for the next new chat), stopped after AI_LIMITS.idleMsMax
// without a turn, restarted after a crash with doubling delays at most
// AI_LIMITS.restartsMax times, and stopped with the project or the app.
//
// A chat is one ACP session. A chat that comes back after its process ended
// resumes its session when the agent can (`session/resume`), loads it otherwise
// (`session/load`, whose replayed history is not news and is ignored), and only
// as a last resort starts a new one, saying so in the transcript.
//
// Each turn: the change ledger opens (changeLedger.ts), the prompt goes out,
// every update becomes transcript events (chatEvents.ts) through the event pump
// (eventPump.ts), permission requests wait on the person (permissionBroker.ts),
// and when the prompt answers, the ledger's changes and the turn's end close it.
//
// Beyond a plain turn the host steers a running turn (`_session/steering`),
// compacts a conversation (`/compact`, reported as compaction events), forks a
// session for a forked chat (`session/fork`), derives background work from tool
// calls, and keeps the chat record's context usage and unread mark current.
//
// Security: nothing runs before the person trusts the project (`ai:trust`,
// remembered per project in the chat index); every new chat starts in the
// agent's asking mode; the adapter's environment is the person's shell
// environment with Stacki's own variables and any host agent session's removed.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { assert } from '../../../shared/core/assert';
import { err, ok, type Result } from '../../../shared/core/result';
import type {
  AgentAvailability,
  AiAgentsReply,
  AiFailure,
  PermissionAnswer,
  PrewarmAction,
  PromptAttachment,
  ReviewAction,
  ReviewOutcome,
  SteerReply,
} from '../../../shared/ipc/aiChat';
import {
  ACP_AUTH_REQUIRED,
  ACP_PROTOCOL_VERSION,
  parseInitializeResult,
  parsePermissionRequest,
  parsePromptResult,
  parseReadFileRequest,
  parseSessionNotification,
  parseSessionResult,
  parseSteerResult,
  parseWriteFileRequest,
  type AcpInitialize,
  type AcpSession,
  type AcpToolCall,
  type AcpUpdate,
} from '../../../shared/properties/ai/acpWire';
import { canCompact, isDangerousMode } from '../../../shared/properties/ai/agentPresentation';
import { AGENTS, AGENT_IDS, parseAgentId, type AgentId } from '../../../shared/properties/ai/agentIds';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';
import {
  parseChatOption,
  toTurnId,
  type ChatContext,
  type ChatEvent,
  type ChatId,
  type ChatOption,
  type CompactionStatus,
  type PermissionRequestId,
  type SentPart,
  type TurnId,
  type TurnStop,
} from '../../../shared/properties/ai/chatModel';
import type { PromptPart } from '../../../shared/properties/ai/mentions';
import {
  applyRemember,
  overlaySettings,
  parseRememberedFile,
  serializeRememberedSettings,
  usableSettings,
  type RememberAction,
  type RememberedSettings,
} from '../../../shared/properties/ai/rememberedSettings';
import { described, noticeText } from './aiMessages';
import { stopProcessTree } from '../../lib/nodeTools';
import { AcpConnection, METHOD_NOT_FOUND, type AcpAnswer, type AcpRequestFailure } from './acpConnection';
import { installAdapter, runNpm, type NpmRunner } from './agentInstaller';
import { ADAPTERS, FALLBACK_OPTIONS, findCli, installedEntry } from './agentRegistry';
import { realFileSystem, runnableCliPath } from './windowsCommand';
import { ChangeLedger, parseLedgerTurns, serializeLedger, type LedgerDiff, type LedgerFiles, type TrackingMode } from './changeLedger';
import { chatOption, CompactionCalls, eventsForUpdate, toolPaths } from './chatEvents';
import { withAgentTitle, type ChatRecord, type ChatStore } from './chatStore';
import { EventPump } from './eventPump';
import { cancelled, PermissionBroker } from './permissionBroker';
import { buildPrompt, inside, type BuiltPrompt } from './promptBlocks';
import {
  idleTimeoutMs,
  oldestIdle,
  StartupTimings,
  WarmSlot,
  type ParkedSession,
  type Released,
  type SlotPhase,
  type WarmTarget,
  type WarmTicket,
} from './sessionPool';
import type { TreeSnapshots } from './treeSnapshot';

/** Whether a list of options carries the agent's own defaults (a new session, a probe) or the values of a chat after a change. */
type OptionsSource = 'defaults' | 'change';

/** The title a chat has until its first prompt names it. */
export const NEW_CHAT_TITLE = 'New chat';

/**
 * What Stacki tells every adapter it can do, exactly. Only open ACP capabilities: `session.compaction`
 * makes Claude report `/compact` as `compaction_update` instead of a tool call, `session.notices` makes
 * it send warnings as `notice` updates, and `_meta.terminal_output_delta` makes it stream a command's
 * output. NOT `_meta.jetbrains` (the adapters send background-task data, the recommended effort and
 * native subagent sessions only to JetBrains AIR clients, and Stacki does not impersonate one), NOT
 * `session.configOptions.boolean` (toggles stay two-choice selects) and NOT `elicitation`.
 */
export const CLIENT_CAPABILITIES = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: false,
  session: { compaction: {}, notices: {} },
  _meta: { terminal_output_delta: true },
} as const;

/**
 * Tool calls remembered per chat for output de-duplication and background tracking. Beside the code that
 * enforces it (AGENTS.md section 10); a call past it is forgotten oldest first, which only costs a
 * repeated line of output, never correctness.
 */
const TOOL_CALLS_TRACKED_MAX = 1_024;

/** The longest a turn waits for the branch name at its start or end; past it the answer is "unknown" and no notice is made. */
const BRANCH_READ_MS_MAX = 2_000;

/**
 * Words an adapter uses when the model API refuses the person's credentials. Claude reports an expired
 * login as an internal error carrying the HTTP 401 and the CLI's "run /login" hint, not as ACP's
 * authentication-required code, so the turn would otherwise end as a red error instead of the sign-in card.
 */
const SIGN_IN_MESSAGE = /API Error: 401\b|authentication_error|Invalid authentication credentials|Please run \/login/i;

/** How the host's own prompt of a turn was made: a person's message, or Stacki asking the agent to compact. */
type TurnPurpose = 'message' | 'compaction';

export interface AgentHostDeps {
  readonly userData: string;
  readonly store: ChatStore;
  readonly send: (channel: string, payload: unknown) => void;
  readonly files: LedgerFiles;
  readonly snapshots: TreeSnapshots;
  /** The person's shell environment (lib/shellEnvironment.ts), read at each start. */
  readonly environment: () => Readonly<Record<string, string | undefined>>;
  readonly now: () => number;
  /** The person's home folder, where user skills live (`~/.claude/skills`); the operating system's by default. */
  readonly home?: () => string;
  readonly version: string;
  /** Ask before agents work in a new project (Settings); when off, opening the panel allows it. */
  readonly askBeforeTrust?: () => boolean;
  /** Settings "Snapshot before & after each AI change": read when a turn begins and kept on that turn. Absent means on. */
  readonly trackChanges?: () => boolean;
  /**
   * The project's current git branch (`git rev-parse --abbrev-ref HEAD`), or undefined when it has none or is no repository. Read at a
   * turn's start and end, whatever the snapshot setting says, so a branch the AI made or switched to is announced. Absent means never.
   */
  readonly currentBranch?: (root: string) => Promise<string | undefined>;
  readonly spawnAdapter?: (entry: string, root: string, environment: Readonly<Record<string, string | undefined>>) => ChildProcess;
  readonly npm?: NpmRunner;
  /** The installed adapter's entry; tests point it at a stand-in adapter. */
  readonly entryOf?: (agent: AgentId) => string | undefined;
  /** Whether the app is in front (a visible window); an agent is only started early for a person who is looking. Absent means yes. */
  readonly isForeground?: () => boolean;
  /** Free memory over total memory, 0 to 1; the operating system's by default. Idle adapters leave sooner when it is low. */
  readonly freeMemoryRatio?: () => number;
}

// The two kinds of state the host owns. Their mutable fields change only
// through these methods, so every change is one named step the host takes.
class AgentProcess {
  stderr = '';
  idle: ReturnType<typeof setTimeout> | undefined = undefined;
  stopping = false;
  /** When a turn or startup work last finished here (the host's clock): the order idle processes are evicted in. */
  lastUsedAt = 0;

  constructor(
    readonly agent: AgentId,
    readonly root: string,
    readonly child: ChildProcess,
    readonly connection: AcpConnection,
    readonly ready: Promise<Result<AcpInitialize, AiFailure>>,
    /** Session id → the chat it belongs to. */
    readonly sessions: Map<string, ChatId>,
  ) {}

  noteStderr(chunk: string): void {
    this.stderr = (this.stderr + chunk).slice(-AI_LIMITS.stderrCharsMax);
    assert(this.stderr.length <= AI_LIMITS.stderrCharsMax, 'AgentProcess.noteStderr: bounded');
  }

  touch(at: number): void {
    this.lastUsedAt = at;
  }

  markStopping(): void {
    this.stopping = true;
    this.setIdle(undefined);
  }

  setIdle(timer: ReturnType<typeof setTimeout> | undefined): void {
    clearTimeout(this.idle);
    this.idle = timer;
  }
}

class ChatRuntime {
  sessionId: string | undefined = undefined;
  /** Session updates are replayed history while a `session/load` runs. */
  replaying = false;
  turn: TurnId | undefined = undefined;
  purpose: TurnPurpose | undefined = undefined;
  options: readonly ChatOption[] = [];
  /** How modes are set: as the `mode` config option, or (an agent that offers session modes only) with `session/set_mode`. */
  modeStyle: 'option' | 'session' = 'option';
  /** The slash commands the agent advertised last, without the slash. */
  commands: ReadonlySet<string> = new Set();
  /** Ids of tool calls that are compactions, so an update naming only the id is never shown as a tool. */
  readonly compactionCalls = new CompactionCalls();
  /** Compaction events seen in the running turn, for the compaction turn's closing row. */
  compactionSignals = 0;
  private readonly compactionStates = new Map<string, CompactionStatus>();
  private readonly streamedCalls = new Set<string>();
  /** Background tool calls and the turn that started each. */
  private readonly backgroundCalls = new Map<string, TurnId>();
  private lastNotice: string | undefined = undefined;
  private pendingContext: ChatContext | undefined = undefined;
  private idleWaiters: (() => void)[] = [];

  constructor(
    readonly chat: ChatId,
    readonly root: string,
    readonly agent: AgentId,
    readonly ledger: ChangeLedger,
  ) {}

  /** Whether a turn has started in this runtime: an agent title before that is the adapter re-announcing a stored one. */
  hasPrompted = false;

  /** The branch when the running turn began; undefined when unknown (no repository, no commits, or the read failed). */
  branchAtStart: string | undefined = undefined;

  /** The branch the turn began on, once: a second read answers undefined so one turn never announces twice. */
  takeBranchAtStart(): string | undefined {
    const branch = this.branchAtStart;
    this.branchAtStart = undefined;
    return branch;
  }

  claim(turn: TurnId, purpose: TurnPurpose): void {
    assert(this.turn === undefined, 'ChatRuntime.claim: one turn at a time');
    this.hasPrompted = true;
    this.turn = turn;
    this.purpose = purpose;
    this.lastNotice = undefined;
    this.compactionSignals = 0;
  }

  release(): void {
    this.turn = undefined;
    this.purpose = undefined;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const wake of waiters) {
      wake();
    }
    assert(this.turn === undefined, 'ChatRuntime.release: no turn is claimed');
  }

  /** Resolves when no turn is running, or after `timeoutMs`; a caller checks `turn` after. */
  untilIdle(timeoutMs: number): Promise<void> {
    if (this.turn === undefined || this.idleWaiters.length >= AI_LIMITS.pendingRequestsMax) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(wake, timeoutMs);
      timer.unref?.();
      this.idleWaiters.push(wake);
    });
  }

  bind(sessionId: string, modeStyle: 'option' | 'session'): void {
    assert(sessionId.length > 0, 'ChatRuntime.bind: a session has an id');
    this.sessionId = sessionId;
    this.modeStyle = modeStyle;
  }

  startReplay(): void {
    this.replaying = true;
  }

  endReplay(): void {
    this.replaying = false;
  }

  setOptions(options: readonly ChatOption[]): void {
    this.options = options.slice(0, AI_LIMITS.configOptionsMax);
  }

  noteCommands(names: readonly string[]): void {
    this.commands = new Set(names.map((name) => name.replace(/^\//, '')));
  }

  /**
   * Whether a compaction event is news. A compaction ends once: a repeated status, and anything after
   * a terminal status, is a duplicate (adapters repeat updates, and a replay can resend them).
   */
  noteCompaction(id: string, status: CompactionStatus): boolean {
    const known = this.compactionStates.get(id);
    if (known !== undefined && (known !== 'in_progress' || known === status)) {
      return false;
    }
    if (this.compactionStates.size >= AI_LIMITS.compactionsMax && known === undefined) {
      const oldest = this.compactionStates.keys().next();
      if (oldest.done !== true) {
        this.compactionStates.delete(oldest.value);
      }
    }
    this.compactionStates.set(id, status);
    this.compactionSignals += 1;
    assert(this.compactionStates.size <= AI_LIMITS.compactionsMax, 'ChatRuntime.noteCompaction: bounded');
    return true;
  }

  /** The compactions that started and have not ended. */
  openCompactions(): readonly string[] {
    return [...this.compactionStates].filter(([, status]) => status === 'in_progress').map(([id]) => id);
  }

  /** A notice the same as the one just before it is dropped (the `notices` capability can repeat a warning a message also carries). */
  noteNotice(text: string): boolean {
    if (this.lastNotice === text) {
      return false;
    }
    this.lastNotice = text;
    return true;
  }

  noteContext(context: ChatContext): void {
    this.pendingContext = context;
  }

  takeContext(): ChatContext | undefined {
    const context = this.pendingContext;
    this.pendingContext = undefined;
    return context;
  }

  /** The turn that started a background tool call (its input said `run_in_background`); undefined for any other call. */
  backgroundTurn(call: string): TurnId | undefined {
    return this.backgroundCalls.get(call);
  }

  hasBackground(): boolean {
    return this.backgroundCalls.size > 0;
  }

  /**
   * The tool event as it should be stored. Output the call already streamed as terminal deltas is not
   * sent again in its result text (the adapter repeats it there when the client takes deltas), and a
   * call started in the background is remembered so its late updates still reach the transcript.
   */
  refineTool(update: AcpUpdate, event: Extract<ChatEvent, { readonly kind: 'tool' }>): ChatEvent {
    const call = update.kind === 'tool-call' || update.kind === 'tool-call-update' ? update.call : undefined;
    if (event.background === true) {
      if (!this.backgroundCalls.has(event.call) && this.backgroundCalls.size >= AI_LIMITS.backgroundTasksMax) {
        const oldest = this.backgroundCalls.keys().next();
        if (oldest.done !== true) {
          this.backgroundCalls.delete(oldest.value);
        }
      }
      this.backgroundCalls.set(event.call, event.turn);
      assert(this.backgroundCalls.size <= AI_LIMITS.backgroundTasksMax, 'ChatRuntime.refineTool: background calls are bounded');
    }
    if (call === undefined || event.output === undefined) {
      return event;
    }
    if (call.outputDelta !== undefined) {
      remember(this.streamedCalls, event.call, TOOL_CALLS_TRACKED_MAX);
      return { ...event, output: call.outputDelta.slice(-AI_LIMITS.toolOutputCharsMax) };
    }
    return this.streamedCalls.has(event.call) ? { ...event, output: undefined } : event;
  }
}

/** Hands the ledger what a tool call names, and whether the call changes files (an untracked turn only needs that much). */
function noteCall(ledger: ChangeLedger, call: AcpToolCall): void {
  for (const file of toolPaths(call)) {
    ledger.noteTouch(file);
  }
  const kind = call.toolKind;
  if (kind === 'edit' || kind === 'delete' || kind === 'move') {
    ledger.noteEdit();
  } else if (call.content?.some((content) => content.kind === 'diff') === true) {
    ledger.noteEdit();
  }
}

function remember(set: Set<string>, value: string, max: number): void {
  if (!set.has(value) && set.size >= max) {
    const oldest = set.values().next();
    if (oldest.done !== true) {
      set.delete(oldest.value);
    }
  }
  set.add(value);
  assert(set.size <= max, 'remember: bounded');
}

interface Crashes {
  count: number;
  lastMessage: string;
}

export class AgentHost {
  private readonly processes = new Map<string, AgentProcess>();
  private readonly chats = new Map<ChatId, ChatRuntime>();
  private readonly crashes = new Map<string, Crashes>();
  private readonly installing = new Set<AgentId>();
  private readonly signIn = new Set<AgentId>();
  private readonly installFailures = new Map<AgentId, string>();
  private readonly permissions = new PermissionBroker();
  private readonly pump: EventPump;
  /** What each agent last reported it offers, so a new chat can be set up before its session exists. */
  private knownOptions: Partial<Record<AgentId, readonly ChatOption[]>> | undefined;
  /** The composer settings last used per agent; read from disk once, then kept current here. */
  private remembered: RememberedSettings | undefined;
  /** Agents being asked for their settings now, by process key: one probe at a time each. */
  private readonly probing = new Set<string>();
  /** The one empty session an agent started early, waiting for the next new chat (sessionPool.ts). */
  private readonly slot = new WarmSlot<AgentProcess>();
  private readonly timings = new StartupTimings();
  /** The start-early request waiting out its debounce; the last request wins, so at most one is ever queued. */
  private warmQueued: WarmTarget | undefined = undefined;
  private warmTimer: ReturnType<typeof setTimeout> | undefined = undefined;

  constructor(private readonly deps: AgentHostDeps) {
    this.pump = new EventPump({
      store: (projectPath, chat, events) => this.deps.store.append(projectPath, chat, events),
      send: (channel, payload) => this.deps.send(channel, payload),
      pause: () => this.forEachProcess((process) => process.connection.pause()),
      resume: () => this.forEachProcess((process) => process.connection.resume()),
    });
  }

  // -------------------------------------------------------------------------
  // Availability and install
  // -------------------------------------------------------------------------

  agents(root: string): AiAgentsReply {
    // The panel asks on mount: a renderer that reloaded acknowledges nothing it was sent before.
    this.pump.reset();
    const agents = AGENT_IDS.map((agent) => this.availability(agent, root));
    assert(agents.length === AGENT_IDS.length, 'agents: one row per agent');
    // Opening the panel (which asks this) counts as allowing agents here, unless Settings says to ask.
    // The asking permission mode of every new chat stays the safeguard either way.
    if (!this.deps.store.readIndex(root).trusted && this.deps.askBeforeTrust?.() !== true) {
      this.deps.store.trust(root);
    }
    const trusted = this.deps.store.readIndex(root).trusted;
    const options = AGENT_IDS.map((agent) => ({ agent, options: this.optionsOf(agent) }));
    // An agent that has never reported its settings is asked once, in the background, so the
    // new-chat row lists its real models and efforts. Only in a trusted project: nothing runs before.
    for (const availability of agents) {
      if (trusted && availability.state === 'ready' && this.loadKnownOptions()[availability.agent] === undefined) {
        void this.probe(availability.agent, root);
      }
    }
    return { trusted, agents, options, remembered: this.rememberedSettings() };
  }

  // -------------------------------------------------------------------------
  // Remembered composer settings
  // -------------------------------------------------------------------------

  /** What a new chat starts with, per agent. A missing or damaged file is nothing remembered: chats then start from the agent's own defaults. */
  rememberedSettings(): RememberedSettings {
    this.remembered ??= parseRememberedFile(this.deps.store.readRememberedSettings());
    return this.remembered;
  }

  /**
   * Remembers one choice (last writer wins) or forgets the agent's set. A choice the agent does not offer is
   * refused, so the file only ever holds what a menu showed. Only the person's own picks reach this: the
   * renderer's menus and a successful `setOption`; a mode the agent changes by itself is never remembered,
   * which is what keeps "Bypass permissions" from coming back unless it was chosen on purpose.
   */
  remember(agent: AgentId, action: RememberAction): Result<RememberedSettings, AiFailure> {
    if (action.kind === 'set') {
      const offered = this.optionsOf(agent);
      if (usableSettings(offered, [{ option: action.option, value: action.value }]).length === 0) {
        return err({ code: 'invalid', ...described('ai.error.settingUnavailable') });
      }
    }
    return ok(this.storeRemembered(agent, action));
  }

  private storeRemembered(agent: AgentId, action: RememberAction): RememberedSettings {
    const next = applyRemember(this.rememberedSettings(), agent, action);
    this.remembered = next;
    try {
      this.deps.store.writeRememberedSettings(serializeRememberedSettings(next));
    } catch (error: unknown) {
      // The choice still holds for this run; only the next launch forgets it.
      console.warn('[ai] the remembered settings were not saved:', error);
    }
    return next;
  }

  availability(agent: AgentId, root: string | undefined): AgentAvailability {
    const spec = ADAPTERS[agent];
    if (this.installing.has(agent)) {
      return { agent, state: 'installing' };
    }
    if (this.cliPath(agent) === undefined) {
      return { agent, state: 'missing-cli' };
    }
    if (this.entry(agent) === undefined) {
      const failure = this.installFailures.get(agent);
      return failure === undefined
        ? { agent, state: 'needs-install', adapterVersion: spec.version, downloadMegabytes: spec.installMegabytes }
        : { agent, state: 'failed', message: failure };
    }
    if (this.signIn.has(agent)) {
      return { agent, state: 'sign-in' };
    }
    const crashes = root === undefined ? undefined : this.crashes.get(processKey(agent, root));
    if (crashes !== undefined && crashes.count > AI_LIMITS.restartsMax) {
      return { agent, state: 'failed', message: crashes.lastMessage };
    }
    return { agent, state: 'ready', adapterVersion: spec.version, running: root !== undefined && this.processes.has(processKey(agent, root)) };
  }

  async install(agent: AgentId, root: string): Promise<Result<AgentAvailability, AiFailure>> {
    if (this.installing.has(agent)) {
      return err({ code: 'busy', ...described('ai.error.installing', { agent: AGENTS[agent].label }) });
    }
    // "Try again" after a failure comes here too: it clears what blocked the agent.
    this.installFailures.delete(agent);
    this.crashes.delete(processKey(agent, root));
    this.signIn.delete(agent);
    if (this.entry(agent) !== undefined) {
      return ok(this.publishStatus(agent, root));
    }
    this.installing.add(agent);
    this.publishStatus(agent, root);
    const installed = await installAdapter(this.deps.userData, ADAPTERS[agent], this.deps.environment(), this.deps.npm ?? runNpm);
    this.installing.delete(agent);
    if (!installed.ok) {
      this.installFailures.set(agent, installed.error);
    }
    const availability = this.publishStatus(agent, root);
    assert(!this.installing.has(agent), 'install: the install is over either way');
    return installed.ok ? ok(availability) : err({ code: 'agent-failed', message: installed.error });
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  /**
   * Starts a turn. `options.parts` are the mentions and text the person composed; `text` stays the
   * plain fallback the transcript and the chat's title are made of. A second prompt while a turn runs
   * is refused (`busy`): holding it for later is the renderer's queue, and `steer` injects into the turn.
   */
  async prompt(
    root: string,
    chat: ChatId,
    text: string,
    attachments: readonly PromptAttachment[],
    options: PromptOptions = {},
  ): Promise<Result<{ readonly turn: TurnId }, AiFailure>> {
    const opened = this.openChat(root, chat);
    if (!opened.ok) {
      return opened;
    }
    const { record, runtime } = opened.value;
    if (runtime.turn !== undefined) {
      return err({ code: 'busy', ...described('ai.error.stillAnswering') });
    }
    if (text.trim() === '' && attachments.length === 0 && (options.parts === undefined || options.parts.length === 0)) {
      return err({ code: 'busy', ...described('ai.error.writeFirst') });
    }
    const turn = toTurnId(`t${randomBytes(8).toString('hex')}`);
    // Claimed before any await, so a second prompt in the same moment is refused, not interleaved.
    runtime.claim(turn, 'message');
    // The clock for the first-token timing starts at the send, so a cold start is inside it.
    this.timings.noteSend(chat, this.deps.now());
    const started = await this.startTurn(runtime, record);
    if (!started.ok) {
      runtime.release();
      return started;
    }
    const process = started.value;
    const built = await this.promptOf(process, runtime, { text, attachments, parts: options.parts });
    if (!built.ok) {
      runtime.release();
      return built;
    }
    runtime.branchAtStart = await this.readBranch(runtime.root);
    await runtime.ledger.begin(turn, this.trackingMode());
    const now = this.deps.now();
    this.emit(runtime, [{ kind: 'turn-start', turn, at: now }, userEvent(turn, now, { text, attachments, sent: built.value.sent, mode: undefined })]);
    if (record.title === NEW_CHAT_TITLE) {
      this.retitle(runtime, titleFrom(text, attachments));
    }
    void this.runTurn(process, runtime, turn, built.value.blocks, 'message');
    assert(runtime.turn === turn, 'prompt: the turn is running');
    return ok({ turn });
  }

  /**
   * Injects a message into the turn that is running (`_session/steering`). With no turn running there is
   * nothing to steer, so the message starts one (`startedNewTurn`). An agent that does not offer steering
   * answers `unsupported`; an adapter that refuses answers its own failure. Either way nothing was sent, and
   * the renderer holds the message in its queue instead.
   */
  async steer(
    root: string,
    chat: ChatId,
    text: string,
    attachments: readonly PromptAttachment[],
    parts: readonly PromptPart[] | undefined,
  ): Promise<Result<SteerReply, AiFailure>> {
    const opened = this.openChat(root, chat);
    if (!opened.ok) {
      return opened;
    }
    const { runtime } = opened.value;
    const turn = runtime.turn;
    if (turn === undefined) {
      const started = await this.prompt(root, chat, text, attachments, { parts });
      return started.ok ? ok({ turn: started.value.turn, outcome: 'startedNewTurn' }) : started;
    }
    if (runtime.purpose === 'compaction') {
      return err({ code: 'busy', ...described('ai.error.compacting') });
    }
    const process = this.processes.get(processKey(runtime.agent, root));
    const ready = process === undefined ? undefined : await process.ready;
    if (process === undefined || ready === undefined || !ready.ok || runtime.sessionId === undefined) {
      return err({ code: 'agent-failed', ...described('ai.error.notRunning', { agent: AGENTS[runtime.agent].label }) });
    }
    if (!ready.value.steering) {
      return err({ code: 'unsupported', ...described('ai.error.cannotSteer', { agent: AGENTS[runtime.agent].label }) });
    }
    const built = await this.promptOf(process, runtime, { text, attachments, parts });
    if (!built.ok) {
      return built;
    }
    if (built.value.blocks.length === 0) {
      return err({ code: 'busy', ...described('ai.error.writeFirst') });
    }
    // `promptRequired` makes an adapter whose turn just ended say so instead of starting one Stacki cannot follow.
    const answer = await process.connection.request(
      '_session/steering',
      { sessionId: runtime.sessionId, prompt: built.value.blocks, _meta: { steering: { idleBehavior: 'promptRequired' } } },
      AI_LIMITS.requestMsMax,
    );
    if (!answer.ok) {
      return err(failureOf(answer.error, runtime.agent, process.stderr));
    }
    const outcome = parseSteerResult(answer.value);
    if (!outcome.ok) {
      return err({ code: 'agent-failed', ...described('ai.error.misunderstood', { agent: AGENTS[runtime.agent].label }) });
    }
    switch (outcome.value.outcome) {
      case 'steered': {
        this.emit(runtime, [userEvent(turn, this.deps.now(), { text, attachments, sent: built.value.sent, mode: 'steer' })]);
        return ok({ turn, outcome: 'steered' });
      }
      case 'promptRequired': {
        // The turn ended between Stacki's check and the adapter's: it is finishing, then this message is a prompt.
        await runtime.untilIdle(AI_LIMITS.requestMsMax);
        if (runtime.turn !== undefined) {
          return err({ code: 'busy', ...described('ai.error.stillAnswering') });
        }
        const started = await this.prompt(root, chat, text, attachments, { parts });
        return started.ok ? ok({ turn: started.value.turn, outcome: 'startedNewTurn' }) : started;
      }
      case 'startedNewTurn':
        // An adapter that ignores the opt-in began a turn on its own; Stacki cannot follow it, so say so.
        return err({ code: 'agent-failed', ...described('ai.error.separateTurn', { agent: AGENTS[runtime.agent].label }) });
      default: {
        const exhaustive: never = outcome.value.outcome;
        return exhaustive;
      }
    }
  }

  /**
   * Compacts the conversation: the agent is sent `/compact` as an ordinary prompt (Claude executes it
   * itself; the command list does not name it). Progress arrives as compaction events, and the turn
   * ends like any other. Only for an agent that can (Codex has no compact command), only while idle.
   */
  async compact(root: string, chat: ChatId): Promise<Result<{ readonly started: true }, AiFailure>> {
    const opened = this.openChat(root, chat);
    if (!opened.ok) {
      return opened;
    }
    const { record, runtime } = opened.value;
    if (!canCompact(runtime.agent)) {
      return err({ code: 'unsupported', ...described('ai.error.cannotCompact', { agent: AGENTS[runtime.agent].label }) });
    }
    if (runtime.turn !== undefined) {
      return err({ code: 'busy', ...described('ai.error.stillAnsweringCompact') });
    }
    if (record.sessionId === undefined && runtime.sessionId === undefined) {
      return err({ code: 'invalid', ...described('ai.error.nothingToCompact') });
    }
    const turn = toTurnId(`t${randomBytes(8).toString('hex')}`);
    runtime.claim(turn, 'compaction');
    const started = await this.startTurn(runtime, record);
    if (!started.ok) {
      runtime.release();
      return started;
    }
    this.emit(runtime, [{ kind: 'turn-start', turn, at: this.deps.now() }]);
    void this.runTurn(started.value, runtime, turn, [{ type: 'text', text: '/compact' }], 'compaction');
    assert(runtime.turn === turn, 'compact: the compaction is running');
    return ok({ started: true });
  }

  cancel(root: string, chat: ChatId): void {
    const runtime = this.chats.get(chat);
    if (runtime === undefined || runtime.root !== root) {
      return;
    }
    // "Stop agent" also reaches a background command that outlives its turn; with neither there is nothing to stop.
    if (runtime.turn === undefined && !runtime.hasBackground()) {
      return;
    }
    this.permissions.cancel(chat);
    const process = this.processes.get(processKey(runtime.agent, root));
    if (process !== undefined && runtime.sessionId !== undefined) {
      process.connection.notify('session/cancel', { sessionId: runtime.sessionId });
    }
  }

  /**
   * One pending file's text before and after a turn, read from the chat's live ledger (the same one Keep
   * and Undo act on), so it is current even before the reviews file was written. Undefined once the
   * change is settled or no longer kept.
   */
  diff(root: string, chat: ChatId, turn: TurnId, file: string): LedgerDiff | undefined {
    const record = this.deps.store.find(root, chat);
    if (record === undefined) {
      return undefined;
    }
    return this.runtimeFor(root, record).ledger.diffOf(turn, file);
  }

  answerPermission(root: string, chat: ChatId, request: PermissionRequestId, answer: PermissionAnswer): Result<{ readonly answered: true }, AiFailure> {
    const runtime = this.chats.get(chat);
    if (runtime === undefined || runtime.root !== root) {
      return err({ code: 'chat-missing', ...described('ai.error.chatNotRunning') });
    }
    // A repeat of the person's own answer is a success: the first one stands and already ran.
    if (this.permissions.answer(chat, request, answer) === 'unknown') {
      return err({ code: 'busy', ...described('ai.error.requestAnswered') });
    }
    return ok({ answered: true });
  }

  async setOption(root: string, chat: ChatId, option: string, value: string): Promise<Result<{ readonly set: true }, AiFailure>> {
    const record = this.deps.store.find(root, chat);
    if (record === undefined) {
      return err({ code: 'chat-missing', ...described('ai.error.chatMissing') });
    }
    const runtime = this.runtimeFor(root, record);
    const started = await this.startTurnlessSession(runtime, record);
    if (!started.ok) {
      return started;
    }
    const known = runtime.options.find((candidate) => candidate.id === option);
    if (known === undefined || !known.choices.some((choice) => choice.value === value)) {
      return err({ code: 'busy', ...described('ai.error.settingUnavailable') });
    }
    const answer = await this.changeSetting(started.value, runtime, option, value);
    if (!answer.ok) {
      return err(failureOf(answer.error, runtime.agent));
    }
    this.updateOptions(runtime, optionsAfterChange(runtime, { option, value }, answer.value));
    // The person's own choice, in any chat, is what the next new chat starts with (last writer wins).
    this.storeRemembered(runtime.agent, { kind: 'set', option, value });
    return ok({ set: true });
  }

  async review(root: string, chat: ChatId, turn: TurnId, file: string, action: ReviewAction): Promise<ReviewOutcome> {
    const record = this.deps.store.find(root, chat);
    if (record === undefined) {
      return { tag: 'failed', ...described('ai.error.chatMissing') };
    }
    const runtime = this.runtimeFor(root, record);
    const outcome = await runtime.ledger.review(turn, file, action);
    if (outcome.tag === 'done') {
      this.deps.store.writeReviews(root, chat, serializeLedger(runtime.ledger.stored()));
      this.emit(runtime, [{ kind: 'review', turn, path: file, review: outcome.review }]);
      this.pump.flush();
    }
    return outcome;
  }

  /** The person signed in through the guided setup: the agent no longer waits on a sign-in. */
  noteSignedIn(agent: AgentId): void {
    this.signIn.delete(agent);
    this.dropWarm(agent);
    assert(!this.signIn.has(agent), 'noteSignedIn: the agent is no longer waiting');
  }

  /** A chat being deleted: its turn is stopped and its runtime forgotten. */
  forget(root: string, chat: ChatId): void {
    this.cancel(root, chat);
    this.timings.forget(chat);
    this.chats.delete(chat);
  }

  acknowledge(chars: number): void {
    this.pump.acknowledge(chars);
  }

  /** Stops every agent: the project closed, or the app is quitting. */
  stopAll(): void {
    this.permissions.cancel(undefined);
    this.pump.flush();
    this.releaseWarm();
    for (const process of [...this.processes.values()]) {
      this.stop(process);
    }
    this.chats.clear();
    assert(this.processes.size === 0, 'stopAll: no agent is left running');
  }

  // -------------------------------------------------------------------------
  // Processes and sessions
  // -------------------------------------------------------------------------

  // The checks every message to a chat begins with: allowed here, still exists, not full. Trust is remembered
  // when Settings does not ask first (opening the panel counts as yes).
  private openChat(root: string, chat: ChatId): Result<{ readonly record: ChatRecord; readonly runtime: ChatRuntime }, AiFailure> {
    if (!this.deps.store.readIndex(root).trusted && this.deps.askBeforeTrust?.() !== true) {
      this.deps.store.trust(root);
    }
    const index = this.deps.store.readIndex(root);
    if (!index.trusted) {
      return err({ code: 'not-trusted', ...described('ai.error.notTrusted') });
    }
    const record = index.chats.find((candidate) => candidate.id === chat);
    if (record === undefined) {
      return err({ code: 'chat-missing', ...described('ai.error.chatMissing') });
    }
    if (this.deps.store.read(root, chat).full) {
      return err({ code: 'read-only', ...described('ai.error.chatFull') });
    }
    return ok({ record, runtime: this.runtimeFor(root, record) });
  }

  // The blocks of a message for this agent: what it accepts (embedded files) and advertises (slash commands) decide them.
  private async promptOf(
    process: AgentProcess,
    runtime: ChatRuntime,
    content: { readonly text: string; readonly attachments: readonly PromptAttachment[]; readonly parts: readonly PromptPart[] | undefined },
  ): Promise<Result<BuiltPrompt, AiFailure>> {
    const ready = await process.ready;
    if (!ready.ok) {
      return ready;
    }
    return buildPrompt(
      {
        root: runtime.root,
        home: (this.deps.home ?? os.homedir)(),
        agent: runtime.agent,
        embeddedContext: ready.value.embeddedContext,
        commands: runtime.commands,
        read: (file) => this.deps.files.read(file),
      },
      content,
    );
  }

  /** The Settings toggle as it stands now. Asked once per turn, when it begins: the ledger keeps the answer on the turn. */
  private trackingMode(): TrackingMode {
    const enabled = this.deps.trackChanges === undefined ? true : this.deps.trackChanges();
    return enabled ? 'on' : 'off';
  }

  private async startTurn(runtime: ChatRuntime, record: ChatRecord): Promise<Result<AgentProcess, AiFailure>> {
    return this.startTurnlessSession(runtime, record);
  }

  private async startTurnlessSession(runtime: ChatRuntime, record: ChatRecord): Promise<Result<AgentProcess, AiFailure>> {
    const process = await this.ensureProcess(runtime.agent, runtime.root);
    if (!process.ok) {
      return process;
    }
    const session = await this.ensureSession(process.value, runtime, record);
    return session.ok ? ok(process.value) : session;
  }

  private async ensureProcess(agent: AgentId, root: string): Promise<Result<AgentProcess, AiFailure>> {
    const key = processKey(agent, root);
    const running = this.processes.get(key);
    if (running !== undefined) {
      const ready = await running.ready;
      return ready.ok ? ok(running) : ready;
    }
    const cli = this.cliPath(agent);
    if (cli === undefined) {
      return err({ code: 'missing-cli', ...described('ai.error.missingCli', { agent: AGENTS[agent].label }) });
    }
    const entry = this.entry(agent);
    if (entry === undefined) {
      return err({ code: 'not-installed', ...described('ai.error.installFirst', { agent: AGENTS[agent].label }) });
    }
    const crashes = this.crashes.get(key);
    if (crashes !== undefined && crashes.count > AI_LIMITS.restartsMax) {
      return err({ code: 'agent-failed', message: crashes.lastMessage });
    }
    if (crashes !== undefined && crashes.count > 0) {
      await delay(AI_LIMITS.restartDelayMsMin * 2 ** (crashes.count - 1));
    }
    if (this.processes.size >= AI_LIMITS.processesMax) {
      this.stopIdlest();
    }
    const process = this.spawnProcess(agent, root, entry, cli);
    this.processes.set(key, process);
    assert(this.processes.size <= AI_LIMITS.processesMax, 'ensureProcess: adapter processes are bounded');
    this.crowdIdleTimers();
    const ready = await process.ready;
    if (!ready.ok) {
      this.stop(process);
      return ready;
    }
    return ok(process);
  }

  private spawnProcess(agent: AgentId, root: string, entry: string, cli: string): AgentProcess {
    const runnable = runnableAdapterCli(cli, this.deps.environment());
    const environment = adapterEnvironment(this.deps.environment(), ADAPTERS[agent].cliVariable, runnable);
    const spawnedAt = this.deps.now();
    const child = (this.deps.spawnAdapter ?? spawnAdapter)(entry, root, environment);
    let spawnMs: number | undefined;
    child.once('spawn', () => {
      spawnMs = this.deps.now() - spawnedAt;
    });
    assert(child.stdout !== null, 'spawnProcess: the adapter has a stdout pipe');
    assert(child.stdin !== null, 'spawnProcess: the adapter has a stdin pipe');
    const sessions = new Map<string, ChatId>();
    let process: AgentProcess | undefined;
    const connection = new AcpConnection(
      { input: child.stdout, output: child.stdin },
      {
        onRequest: (method, params) => (process === undefined ? Promise.resolve(METHOD_NOT_FOUND) : this.handleRequest(process, method, params)),
        onNotification: (method, params) => {
          if (process !== undefined) {
            this.handleNotification(process, method, params);
          }
        },
        onProtocolError: (message) => console.warn(`[ai] ${agent}: ${message}`),
        onClose: () => {
          if (process !== undefined) {
            this.handleExit(process);
          }
        },
      },
    );
    const initializeAt = this.deps.now();
    const ready = connection
      .request(
        'initialize',
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: CLIENT_CAPABILITIES,
          // i18n-ignore: the client name sent to the agent, a brand.
          clientInfo: { name: 'stacki', title: 'Stacki', version: this.deps.version },
        },
        AI_LIMITS.requestMsMax,
      )
      .then((answer): Result<AcpInitialize, AiFailure> => {
        if (!answer.ok) {
          return err(failureOf(answer.error, agent, process?.stderr));
        }
        const parsed = parseInitializeResult(answer.value);
        if (!parsed.ok) {
          return err({ code: 'agent-failed', ...described('ai.error.misunderstood', { agent: AGENTS[agent].label }) });
        }
        if (parsed.value.protocolVersion !== ACP_PROTOCOL_VERSION) {
          return err({
            code: 'agent-failed',
            ...described('ai.error.protocol', { agent: AGENTS[agent].label, theirs: parsed.value.protocolVersion, ours: ACP_PROTOCOL_VERSION }),
          });
        }
        if (process !== undefined) {
          // Durations only, so the line can be shared: how long the process took to appear, and to answer `initialize`.
          const timing = { spawnMs, initializeMs: this.deps.now() - initializeAt };
          this.timings.noteProcess(process, timing);
          console.debug(`[ai] process: spawnMs=${timing.spawnMs ?? 'none'} initializeMs=${timing.initializeMs}`);
        }
        return ok(parsed.value);
      });
    process = new AgentProcess(agent, root, child, connection, ready, sessions);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (process !== undefined) {
        process.noteStderr(chunk);
      }
    });
    child.on('error', () => connection.close());
    child.on('exit', () => connection.close());
    return process;
  }

  private async ensureSession(process: AgentProcess, runtime: ChatRuntime, record: ChatRecord): Promise<Result<AcpSession | undefined, AiFailure>> {
    if (runtime.sessionId !== undefined && process.sessions.get(runtime.sessionId) === runtime.chat) {
      return ok(undefined);
    }
    const ready = await process.ready;
    if (!ready.ok) {
      return ready;
    }
    const init = ready.value;
    const stored = record.sessionId;
    const base = { cwd: runtime.root, mcpServers: [] };
    if (stored !== undefined && init.resumeSession) {
      const resumedAt = this.deps.now();
      const resumed = await this.openSession(process, runtime, 'session/resume', { ...base, sessionId: stored }, stored);
      if (resumed.ok) {
        this.timings.noteSession(runtime.chat, process, 'resumed', this.deps.now() - resumedAt);
        return resumed;
      }
    }
    if (stored !== undefined && init.loadSession) {
      const loadedAt = this.deps.now();
      runtime.startReplay();
      const loaded = await this.openSession(process, runtime, 'session/load', { ...base, sessionId: stored }, stored);
      runtime.endReplay();
      if (loaded.ok) {
        this.timings.noteSession(runtime.chat, process, 'resumed', this.deps.now() - loadedAt);
        return loaded;
      }
    }
    if (stored === undefined && record.forkOf !== undefined) {
      const forkedAt = this.deps.now();
      const forked = await this.forkSession(process, runtime, { record, init, base });
      if (forked !== undefined) {
        if (forked.ok) {
          this.timings.noteSession(runtime.chat, process, 'cold', this.deps.now() - forkedAt);
        }
        return forked;
      }
    }
    // A brand-new chat adopts the empty session an agent started early, when there is one for this very agent and
    // project; it is bound exactly as `session/new` would have bound it. Anything else (a chat that had a session, a
    // fork) starts its own.
    const parked = stored === undefined && record.forkOf === undefined ? await this.takeWarm(process, runtime) : undefined;
    const createdAt = this.deps.now();
    const created = parked === undefined ? await this.openSession(process, runtime, 'session/new', base, undefined) : this.adoptWarm(process, runtime, parked);
    if (!created.ok) {
      return created;
    }
    this.timings.noteSession(
      runtime.chat,
      process,
      parked === undefined ? 'cold' : 'prewarmed',
      parked === undefined ? this.deps.now() - createdAt : parked.sessionNewMs,
    );
    if (stored !== undefined) {
      this.emit(runtime, [
        {
          kind: 'notice',
          severity: 'warning',
          ...noticeText('ai.notice.cannotContinue', { agent: AGENTS[runtime.agent].label }),
        },
      ]);
    }
    // A new session starts from what the person used last, else from the agent's own defaults (the person's
    // own Claude `defaultMode` included). Nothing forces the asking mode here any more.
    await this.applySettings(process, runtime, overlaySettings(record.settings, this.rememberedSettings()[runtime.agent]));
    return created;
  }

  /**
   * A forked chat continues its original's agent session: `session/fork` from the original's session id.
   * Undefined when it cannot (the agent has no fork, the original never had a session, the fork failed),
   * after saying so in the transcript, so the caller starts a fresh session instead. A sign-in failure is
   * returned as the failure it is: a fresh session would only fail the same way.
   */
  private async forkSession(
    process: AgentProcess,
    runtime: ChatRuntime,
    context: { readonly record: ChatRecord; readonly init: AcpInitialize; readonly base: Readonly<Record<string, unknown>> },
  ): Promise<Result<AcpSession, AiFailure> | undefined> {
    const { record, init, base } = context;
    const source = record.forkOf === undefined ? undefined : this.deps.store.find(runtime.root, record.forkOf)?.sessionId;
    const label = AGENTS[runtime.agent].label;
    if (source === undefined || !init.fork) {
      this.emit(runtime, [{ kind: 'notice', severity: 'warning', ...noticeText('ai.notice.cannotFork', { agent: label }) }]);
      return undefined;
    }
    const forked = await this.openSession(process, runtime, 'session/fork', { ...base, sessionId: source }, undefined);
    if (!forked.ok) {
      if (forked.error.code === 'sign-in') {
        return forked;
      }
      this.emit(runtime, [{ kind: 'notice', severity: 'warning', ...noticeText('ai.notice.forkFailed', { agent: label }) }]);
      return undefined;
    }
    // A fork continues the original's mode; one that left the original unrestricted starts asking again.
    const mode = runtime.options.find((option) => option.category === 'mode' || option.id === 'mode');
    if (mode !== undefined && isDangerousMode(runtime.agent, mode.currentValue)) {
      await this.applyAskMode(process, runtime);
    }
    await this.applySettings(process, runtime, record.settings);
    assert(runtime.sessionId === forked.value.sessionId, 'forkSession: the chat is bound to the forked session');
    return forked;
  }

  private async openSession(
    process: AgentProcess,
    runtime: ChatRuntime,
    method: string,
    params: Readonly<Record<string, unknown>>,
    sessionId: string | undefined,
  ): Promise<Result<AcpSession, AiFailure>> {
    // Map first: a load replays its history as updates before it answers.
    if (sessionId !== undefined) {
      process.sessions.set(sessionId, runtime.chat);
    }
    const answer = await process.connection.request(method, params, AI_LIMITS.requestMsMax);
    if (!answer.ok) {
      if (sessionId !== undefined) {
        process.sessions.delete(sessionId);
      }
      return err(this.noteFailure(failureOf(answer.error, runtime.agent, process.stderr), runtime));
    }
    const session = parseSessionResult(answer.value, sessionId);
    if (!session.ok) {
      return err({ code: 'agent-failed', ...described('ai.error.misunderstood', { agent: AGENTS[runtime.agent].label }) });
    }
    return ok(this.bindSession(process, runtime, session.value, method === 'session/new' ? 'defaults' : 'change'));
  }

  /** Binds an opened session to its chat. Shared by every way a session comes to a chat, an adopted pre-warmed one included, so they cannot differ. */
  private bindSession(process: AgentProcess, runtime: ChatRuntime, session: AcpSession, source: OptionsSource): AcpSession {
    this.signIn.delete(runtime.agent);
    process.sessions.set(session.sessionId, runtime.chat);
    const settings = sessionSettings(session);
    runtime.bind(session.sessionId, settings.legacyModes ? 'session' : 'option');
    this.deps.store.update(runtime.root, runtime.chat, (current) => ({ ...current, sessionId: session.sessionId }));
    if (settings.options.length > 0) {
      // Only a brand-new session reports the agent's own defaults; a resumed one reports that chat's values.
      this.updateOptions(runtime, settings.options, source);
    }
    assert(process.sessions.get(session.sessionId) === runtime.chat, 'bindSession: the session is mapped to its chat');
    assert(runtime.sessionId === session.sessionId, 'bindSession: the chat is bound to the session');
    return session;
  }

  // A fork whose original ran unrestricted asks again: full access is never carried into a new conversation silently.
  private async applyAskMode(process: AgentProcess, runtime: ChatRuntime): Promise<void> {
    const ask = ADAPTERS[runtime.agent].askMode;
    const mode = runtime.options.find((option) => option.category === 'mode' || option.id === 'mode');
    if (mode === undefined || mode.currentValue === ask || !mode.choices.some((choice) => choice.value === ask)) {
      return;
    }
    const answer = await this.changeSetting(process, runtime, mode.id, ask);
    if (answer.ok) {
      this.updateOptions(runtime, withValue(runtime.options, mode.id, ask));
    }
  }

  // A setting is a config option, except the modes of an agent that offers them as session modes only.
  private changeSetting(process: AgentProcess, runtime: ChatRuntime, option: string, value: string): Promise<Result<unknown, AcpRequestFailure>> {
    if (runtime.modeStyle === 'session' && option === 'mode') {
      return process.connection.request('session/set_mode', { sessionId: runtime.sessionId, modeId: value }, AI_LIMITS.requestMsMax);
    }
    return process.connection.request('session/set_config_option', { sessionId: runtime.sessionId, configId: option, value }, AI_LIMITS.requestMsMax);
  }

  private async runTurn(process: AgentProcess, runtime: ChatRuntime, turn: TurnId, prompt: readonly unknown[], purpose: TurnPurpose): Promise<void> {
    this.holdAwake(process);
    const answer = await process.connection.request('session/prompt', { sessionId: runtime.sessionId, prompt }, AI_LIMITS.turnMsMax);
    let stop: TurnStop = 'error';
    let message: string | undefined;
    if (answer.ok) {
      const parsed = parsePromptResult(answer.value);
      stop = parsed.ok ? parsed.value.stopReason : 'end_turn';
      this.crashes.delete(processKey(runtime.agent, runtime.root));
    } else {
      if (answer.error.kind === 'timeout' && runtime.sessionId !== undefined) {
        process.connection.notify('session/cancel', { sessionId: runtime.sessionId });
      }
      const failure = this.noteFailure(failureOf(answer.error, runtime.agent, process.stderr), runtime);
      message = failure.message;
      // An auth failure ends the turn as its own stop, so the transcript can show one sign-in card instead of an error.
      stop = failure.code === 'sign-in' ? 'sign-in' : 'error';
    }
    this.permissions.cancel(runtime.chat);
    const events: ChatEvent[] = [];
    // A compaction has an end whatever happened: a row left "in progress" under a finished turn would spin forever.
    const at = this.deps.now();
    events.push(...this.closeCompactions(runtime, { turn, stop, purpose, at }));
    if (purpose === 'message') {
      const changes = await runtime.ledger.finish(turn);
      // Durations and the mode only: no prompt text, no file paths, so the log can be shared.
      console.debug(
        `[ai] turn ledger: tracking=${changes.tracking} snapshotBeforeMs=${changes.snapshotBeforeMs ?? 'none'} snapshotAfterMs=${changes.snapshotAfterMs ?? 'none'}`,
      );
      if (changes.entries.length > 0) {
        this.deps.store.writeReviews(runtime.root, runtime.chat, serializeLedger(runtime.ledger.stored()));
        events.push({ kind: 'changes', turn, files: ChangeLedger.changesOf(changes) });
      } else if (changes.edited && changes.tracking === 'off') {
        events.push({ kind: 'changes-untracked', turn, reason: 'off' });
      } else if (changes.edited && changes.tracking === 'unavailable') {
        events.push({ kind: 'changes-untracked', turn, reason: 'unavailable' });
      }
    }
    if (purpose === 'message') {
      events.push(...(await this.branchChangeEvents(runtime)));
    }
    events.push({ kind: 'turn-end', turn, stop, message, at: this.deps.now() });
    // The record first: the renderer clears `unread` when it sees the turn end, and must clear what is already set.
    const context = runtime.takeContext();
    this.deps.store.update(runtime.root, runtime.chat, (current) => ({
      ...current,
      updatedAt: Math.max(current.createdAt, this.deps.now()),
      unread: current.unread || endsUnread(stop),
      context: context ?? current.context,
    }));
    this.emit(runtime, events);
    this.pump.flush();
    runtime.release();
    this.releaseAwake(process);
  }

  /** The branch now, or undefined when none is known. A slow or failing git is no branch: it must never hold a turn's end. */
  private async readBranch(root: string): Promise<string | undefined> {
    const read = this.deps.currentBranch;
    if (read === undefined) {
      return undefined;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), BRANCH_READ_MS_MAX);
      timer.unref();
    });
    try {
      const branch = await Promise.race([read(root).catch(() => undefined), late]);
      return branch === undefined || branch.length === 0 ? undefined : branch;
    } finally {
      clearTimeout(timer);
    }
  }

  /** A notice when the branch differs from where the turn began: publishing sends the current branch, so the person must hear of a change. */
  private async branchChangeEvents(runtime: ChatRuntime): Promise<readonly ChatEvent[]> {
    const before = runtime.takeBranchAtStart();
    if (before === undefined) {
      return [];
    }
    const after = await this.readBranch(runtime.root);
    if (after === undefined || after === before) {
      return [];
    }
    // `rev-parse --abbrev-ref` prints HEAD when no branch is checked out.
    const notice = after === 'HEAD' ? noticeText('git.branch.aiDetached') : noticeText('git.branch.aiChanged', { name: after });
    return [{ kind: 'notice', severity: 'warning', ...notice }];
  }

  // The rows that close compactions the turn left open. The compaction turn that saw no signal at all (an
  // adapter that reports none) still answers the person's click with one row.
  private closeCompactions(
    runtime: ChatRuntime,
    ending: { readonly turn: TurnId; readonly stop: TurnStop; readonly purpose: TurnPurpose; readonly at: number },
  ): readonly ChatEvent[] {
    const { turn, stop, purpose, at } = ending;
    const status: CompactionStatus = stop === 'end_turn' ? 'completed' : stop === 'cancelled' ? 'cancelled' : 'failed';
    const events: ChatEvent[] = [];
    for (const id of runtime.openCompactions()) {
      if (runtime.noteCompaction(id, status)) {
        events.push({ kind: 'compaction', turn, id, status, at });
      }
    }
    if (purpose === 'compaction' && runtime.compactionSignals === 0) {
      events.push({ kind: 'compaction', turn, id: `compact-${turn}`, status, at });
    }
    return events;
  }

  private handleNotification(process: AgentProcess, method: string, params: unknown): void {
    if (method !== 'session/update') {
      return; // Auth status and other extensions: the turn's own answer says what matters.
    }
    const parsed = parseSessionNotification(params);
    if (!parsed.ok) {
      console.warn(`[ai] ${process.agent}: a session update was refused: ${parsed.error.message}`);
      return;
    }
    const chat = process.sessions.get(parsed.value.sessionId);
    const runtime = chat === undefined ? undefined : this.chats.get(chat);
    if (chat === undefined && parsed.value.update.kind === 'commands') {
      // An empty session an agent started early still announces its slash commands; the chat that adopts it needs them.
      this.slot.noteCommands(
        parsed.value.sessionId,
        parsed.value.update.commands.map((command) => command.name),
      );
    }
    if (runtime === undefined || runtime.replaying) {
      return;
    }
    const update = parsed.value.update;
    if (update.kind === 'message' && update.role !== 'user') {
      const line = this.timings.noteFirstToken(runtime.chat, this.deps.now());
      if (line !== undefined) {
        console.debug(`[ai] ${line}`);
      }
    }
    if (update.kind === 'tool-call' || update.kind === 'tool-call-update') {
      noteCall(runtime.ledger, update.call);
    }
    if (update.kind === 'commands') {
      runtime.noteCommands(update.commands.map((command) => command.name));
    }
    if (update.kind === 'config') {
      const incoming = update.options.map(chatOption);
      this.updateOptions(runtime, runtime.modeStyle === 'session' ? keepLegacyMode(runtime.options, incoming) : incoming);
      return;
    }
    if (update.kind === 'mode') {
      const mode = runtime.options.find((option) => option.category === 'mode' || option.id === 'mode');
      if (mode !== undefined) {
        this.updateOptions(runtime, withValue(runtime.options, mode.id, update.modeId));
      }
      return;
    }
    if (update.kind === 'info' && update.title !== undefined) {
      this.applyAgentTitle(runtime, update.title);
      return;
    }
    // A background command finishes after its turn did: its update still belongs to the turn that started it.
    const owner = update.kind === 'tool-call' || update.kind === 'tool-call-update' ? runtime.backgroundTurn(update.call.id) : undefined;
    const turn = owner ?? runtime.turn;
    const events = eventsForUpdate(update, turn, { at: this.deps.now(), compactions: runtime.compactionCalls }).flatMap((event) =>
      this.refine(runtime, update, event),
    );
    this.emit(runtime, events);
    if (update.kind === 'usage' && runtime.turn === undefined) {
      // Outside a turn (a compaction the CLI ran on its own) nothing will persist it later.
      this.deps.store.update(runtime.root, runtime.chat, (current) => ({ ...current, context: runtime.takeContext() ?? current.context }));
    }
  }

  // The per-chat rules that decide whether an event is stored as it came, changed, or dropped.
  private refine(runtime: ChatRuntime, update: AcpUpdate, event: ChatEvent): readonly ChatEvent[] {
    if (event.kind === 'tool') {
      return [runtime.refineTool(update, event)];
    }
    if (event.kind === 'compaction') {
      return runtime.noteCompaction(event.id, event.status) ? [event] : [];
    }
    if (event.kind === 'notice') {
      return runtime.noteNotice(event.text) ? [event] : [];
    }
    if (event.kind === 'usage') {
      runtime.noteContext({ used: event.used, size: event.size });
    }
    return [event];
  }

  private async handleRequest(process: AgentProcess, method: string, params: unknown): Promise<AcpAnswer> {
    switch (method) {
      case 'session/request_permission':
        return this.requestPermission(process, params);
      case 'fs/read_text_file':
        return this.answerReadFile(process, params);
      case 'fs/write_text_file':
        return this.answerWriteFile(process, params);
      default:
        return METHOD_NOT_FOUND;
    }
  }

  private requestPermission(process: AgentProcess, params: unknown): Promise<AcpAnswer> {
    const parsed = parsePermissionRequest(params);
    const runtime = parsed.ok ? this.runtimeOfSession(process, parsed.value.sessionId) : undefined;
    if (!parsed.ok || runtime === undefined || runtime.turn === undefined) {
      return Promise.resolve(cancelled());
    }
    const request = parsed.value;
    noteCall(runtime.ledger, request.call);
    const turn = runtime.turn;
    // The broker settles a request only after `ask` returns, so the id is known by then.
    let asking: PermissionRequestId | undefined;
    const asked = this.permissions.ask(
      runtime.chat,
      request.options.map((option) => option.optionId),
      (outcome) => {
        assert(asking !== undefined, 'requestPermission: answered after it was asked');
        this.emit(runtime, [{ kind: 'permission-answered', request: asking, ...outcome }]);
      },
    );
    asking = asked?.request;
    if (asked === undefined) {
      return Promise.resolve(cancelled());
    }
    this.emit(runtime, [
      {
        kind: 'permission',
        turn,
        request: asked.request,
        call: request.call.id,
        title: request.call.title ?? 'The agent asks for permission', // i18n-ignore: the stored fallback title of a request the agent did not name; the card's heading is translated from the tool kind.
        options: request.options.map((option) => ({ id: option.optionId, name: option.name, kind: option.kind })),
      },
    ]);
    this.pump.flush();
    return asked.answer;
  }

  private answerReadFile(process: AgentProcess, params: unknown): AcpAnswer {
    const parsed = parseReadFileRequest(params);
    if (!parsed.ok) {
      return err({ code: -32602, message: parsed.error.message });
    }
    const file = path.resolve(process.root, parsed.value.path);
    if (!inside(process.root, file)) {
      // i18n-ignore: a JSON-RPC answer read by the agent, not by a person.
      return err({ code: -32602, message: 'Stacki reads files inside the project only.' });
    }
    let text: string | undefined;
    try {
      text = this.deps.files.read(file);
    } catch {
      // i18n-ignore: a JSON-RPC answer read by the agent, not by a person.
      return err({ code: -32603, message: 'The file is not readable text.' });
    }
    if (text === undefined) {
      // i18n-ignore: a JSON-RPC answer read by the agent, not by a person.
      return err({ code: -32002, message: 'Resource not found' });
    }
    const line = parsed.value.line;
    const limit = parsed.value.limit;
    if (line === undefined && limit === undefined) {
      return ok({ content: text });
    }
    const lines = text.split('\n');
    const start = Math.max(0, (line ?? 1) - 1);
    return ok({ content: lines.slice(start, limit === undefined ? undefined : start + limit).join('\n') });
  }

  private answerWriteFile(process: AgentProcess, params: unknown): AcpAnswer {
    const parsed = parseWriteFileRequest(params);
    if (!parsed.ok) {
      return err({ code: -32602, message: parsed.error.message });
    }
    const runtime = this.runtimeOfSession(process, parsed.value.sessionId);
    const file = path.resolve(process.root, parsed.value.path);
    if (runtime === undefined || !inside(process.root, file)) {
      // i18n-ignore: a JSON-RPC answer read by the agent, not by a person.
      return err({ code: -32602, message: 'Stacki writes files inside the project only.' });
    }
    runtime.ledger.noteTouch(file);
    runtime.ledger.noteEdit();
    try {
      const current = this.deps.files.read(file);
      if (current === undefined) {
        this.deps.files.create(file, parsed.value.content);
      } else {
        this.deps.files.write(file, parsed.value.content, current);
      }
    } catch (error: unknown) {
      return err({ code: -32603, message: error instanceof Error ? error.message : String(error) });
    }
    return ok({});
  }

  private handleExit(process: AgentProcess): void {
    const key = processKey(process.agent, process.root);
    if (this.processes.get(key) === process) {
      this.processes.delete(key);
    }
    process.setIdle(undefined);
    // A session never outlives its process: one parked in it is gone with it.
    this.slot.releaseProcess(process);
    if (!process.stopping) {
      const crashes = this.crashes.get(key) ?? { count: 0, lastMessage: '' };
      crashes.count += 1;
      crashes.lastMessage = `${AGENTS[process.agent].label} stopped unexpectedly${lastLine(process.stderr)}`;
      this.crashes.set(key, crashes);
      this.publishStatus(process.agent, process.root);
    }
    assert(this.processes.get(key) !== process, 'handleExit: an exited process is no longer listed');
  }

  private stop(process: AgentProcess): void {
    process.markStopping();
    this.slot.releaseProcess(process);
    process.connection.close();
    stopProcessTree(process.child);
    const key = processKey(process.agent, process.root);
    if (this.processes.get(key) === process) {
      this.processes.delete(key);
    }
  }

  /** Evicts the idle process that was used longest ago (least recently used); a process with a turn running is never evicted. */
  private stopIdlest(): void {
    const all = [...this.processes.values()];
    const index = oldestIdle(all.map((process) => ({ lastUsedAt: process.lastUsedAt, busy: this.isBusy(process) })));
    const victim = index === undefined ? undefined : all[index];
    if (victim !== undefined) {
      this.stop(victim);
    }
  }

  private isBusy(process: AgentProcess): boolean {
    return [...process.sessions.values()].some((chat) => this.chats.get(chat)?.turn !== undefined);
  }

  private holdAwake(process: AgentProcess): void {
    process.setIdle(undefined);
  }

  private releaseAwake(process: AgentProcess): void {
    if (this.isBusy(process) || process.stopping) {
      return;
    }
    process.touch(this.deps.now());
    this.armIdle(process, idleTimeoutMs({ processes: this.processes.size, freeMemoryRatio: this.freeMemoryRatio() }));
  }

  private armIdle(process: AgentProcess, delayMs: number): void {
    assert(delayMs <= AI_LIMITS.idleMsMax, 'armIdle: an idle adapter never outlives the idle limit');
    const timer = setTimeout(() => this.stop(process), delayMs);
    timer.unref?.();
    process.setIdle(timer);
  }

  /**
   * A new process makes the others' wait count: when more than `processesComfortableMax` adapters are alive, the
   * idle ones are re-timed to the shorter limit (counted from when each was last used), so the oldest go first.
   */
  private crowdIdleTimers(): void {
    if (this.processes.size <= AI_LIMITS.processesComfortableMax) {
      return;
    }
    const now = this.deps.now();
    for (const process of this.processes.values()) {
      if (process.idle !== undefined && !process.stopping) {
        this.armIdle(process, Math.max(0, AI_LIMITS.idleMsCrowded - (now - process.lastUsedAt)));
      }
    }
  }

  private freeMemoryRatio(): number {
    if (this.deps.freeMemoryRatio !== undefined) {
      return this.deps.freeMemoryRatio();
    }
    const total = os.totalmem();
    return total > 0 ? os.freemem() / total : 1;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private runtimeFor(root: string, record: ChatRecord): ChatRuntime {
    const existing = this.chats.get(record.id);
    if (existing !== undefined) {
      assert(existing.root === root, 'runtimeFor: a chat belongs to one project');
      return existing;
    }
    const stored = parseLedgerTurns(this.deps.store.readReviews(root, record.id));
    const runtime = new ChatRuntime(record.id, root, record.agent, new ChangeLedger(root, this.deps.files, this.deps.snapshots, stored));
    this.chats.set(record.id, runtime);
    return runtime;
  }

  private runtimeOfSession(process: AgentProcess, sessionId: string): ChatRuntime | undefined {
    const chat = process.sessions.get(sessionId);
    return chat === undefined ? undefined : this.chats.get(chat);
  }

  private emit(runtime: ChatRuntime, events: readonly ChatEvent[]): void {
    if (events.length > 0) {
      this.pump.push(runtime.root, runtime.chat, events);
    }
  }

  private updateOptions(runtime: ChatRuntime, options: readonly ChatOption[], source: OptionsSource = 'change'): void {
    runtime.setOptions(options);
    this.rememberOptions(runtime.agent, runtime.options, source);
    this.emit(runtime, [{ kind: 'options', options: runtime.options }]);
  }

  /**
   * Reads the agent's settings with a session of its own. The session is kept for the first chat when the
   * warm slot is free (so the first message does not pay for a second `session/new`), and deleted otherwise, so
   * a probe leaves no conversation in the agent's history. The process stays for the first real prompt.
   */
  private async probe(agent: AgentId, root: string): Promise<void> {
    const key = processKey(agent, root);
    if (this.probing.has(key)) {
      return;
    }
    this.probing.add(key);
    try {
      const ticket = this.slot.phase() === 'empty' ? this.slot.begin({ agent, root }) : undefined;
      const run = this.startSession(agent, root, ticket);
      if (ticket !== undefined) {
        this.slot.attach(ticket, run);
      }
      await run;
    } finally {
      this.probing.delete(key);
    }
    assert(!this.probing.has(key), 'probe: the probe is over');
  }

  // -------------------------------------------------------------------------
  // Starting an agent early
  // -------------------------------------------------------------------------

  /**
   * The panel opened or the composer got focus (`warm`), or the panel closed or moved to another agent
   * (`release`). A warm request is debounced and single-flight, and starts the agent's process and one empty
   * session in the background; nothing of it is visible: no chat record, no transcript event, no change-ledger
   * snapshot, no model call. The chat that is sent a first message adopts the session, or starts its own as
   * it always did. Failure is a log line, never an error the person sees.
   */
  prewarm(root: string, agent: AgentId, action: PrewarmAction): void {
    const target: WarmTarget = { agent, root };
    if (action === 'release') {
      if (this.warmQueued?.agent === agent && this.warmQueued.root === root) {
        this.cancelQueuedWarm();
      }
      if (this.slot.holds(target)) {
        this.discardWarm(this.slot.release(), 'released');
      }
      return;
    }
    const blocked = this.warmBlocker(target);
    if (blocked !== undefined) {
      console.debug(`[ai] prewarm skipped: ${blocked}`);
      return;
    }
    // The last request wins: rapid focus changes queue one start, not many.
    this.warmQueued = target;
    if (this.warmTimer === undefined) {
      const timer = setTimeout(() => {
        this.warmTimer = undefined;
        const queued = this.warmQueued;
        this.warmQueued = undefined;
        if (queued !== undefined) {
          void this.warm(queued);
        }
      }, AI_LIMITS.prewarmDebounceMs);
      timer.unref?.();
      this.warmTimer = timer;
    }
  }

  /** What the warm slot holds, for tests and the log. */
  prewarmPhase(): SlotPhase {
    return this.slot.phase();
  }

  /**
   * Why an agent must not be started early now, or undefined when it may. Track changes is not a reason: it
   * only decides whether a turn takes snapshots, and a pre-warmed session takes none until a turn begins.
   */
  private warmBlocker(target: WarmTarget): 'background' | 'untrusted' | 'unavailable' | 'crashed' | 'held' | 'full' | undefined {
    if (this.deps.isForeground?.() === false) {
      return 'background';
    }
    if (!this.deps.store.readIndex(target.root).trusted) {
      return 'untrusted';
    }
    if (this.availability(target.agent, target.root).state !== 'ready') {
      return 'unavailable';
    }
    const key = processKey(target.agent, target.root);
    if ((this.crashes.get(key)?.count ?? 0) > 0) {
      return 'crashed';
    }
    if (this.slot.holds(target)) {
      return 'held';
    }
    // Starting early never evicts a process someone may be using, and never goes past the process limit.
    if (!this.processes.has(key) && this.processes.size >= AI_LIMITS.processesMax) {
      return 'full';
    }
    return undefined;
  }

  private async warm(target: WarmTarget): Promise<void> {
    const blocked = this.warmBlocker(target);
    if (blocked !== undefined) {
      console.debug(`[ai] prewarm skipped: ${blocked}`);
      return;
    }
    // Another agent or project: the person moved on, so what was started for the old one goes.
    if (this.slot.phase() !== 'empty') {
      this.discardWarm(this.slot.release(), 'replaced');
    }
    const ticket = this.slot.begin(target);
    if (ticket === undefined) {
      return;
    }
    const run = this.startSession(target.agent, target.root, ticket);
    this.slot.attach(ticket, run);
    await run;
  }

  /**
   * Starts the process (when needed) and asks it for one empty session with exactly the parameters a new chat
   * would use. A ticket keeps the session for the next new chat; without one (or when the ticket went stale
   * meanwhile) the session is deleted. Failures are logged and leave the cold path as it was.
   */
  private async startSession(agent: AgentId, root: string, ticket: WarmTicket | undefined): Promise<void> {
    try {
      const process = await this.ensureProcess(agent, root);
      if (!process.ok) {
        console.debug(`[ai] prewarm: the agent did not start (${process.error.code})`);
        return;
      }
      if (ticket !== undefined && !this.slot.current(ticket)) {
        this.releaseAwake(process.value);
        return;
      }
      const startedAt = this.deps.now();
      const answer = await process.value.connection.request('session/new', { cwd: root, mcpServers: [] }, AI_LIMITS.requestMsMax);
      const session = answer.ok ? parseSessionResult(answer.value, undefined) : undefined;
      if (session?.ok === true) {
        const options = session.value.options.map(chatOption);
        if (options.length > 0) {
          const before = JSON.stringify(this.optionsOf(agent));
          this.rememberOptions(agent, options, 'defaults');
          // Only news is published, so starting early never makes the panel redraw.
          if (JSON.stringify(this.optionsOf(agent)) !== before) {
            this.publishStatus(agent, root, this.optionsOf(agent));
          }
        }
        const kept =
          ticket !== undefined &&
          this.slot.park(ticket, { process: process.value, session: session.value, sessionNewMs: this.deps.now() - startedAt, commands: [] });
        if (!kept) {
          await process.value.connection.request('session/delete', { sessionId: session.value.sessionId }, AI_LIMITS.requestMsMax);
        }
      } else {
        console.debug('[ai] prewarm: the agent did not start a session');
      }
      this.releaseAwake(process.value);
    } catch (error: unknown) {
      // The name only: a message could carry a path.
      console.warn(`[ai] prewarm failed (${error instanceof Error ? error.name : 'error'}); the first message starts the agent as usual`);
    } finally {
      if (ticket !== undefined) {
        this.slot.abandon(ticket);
      }
    }
  }

  /** Takes the parked session for a chat of this agent and project, waiting for a start already under way. Undefined: start one as usual. */
  private async takeWarm(process: AgentProcess, runtime: ChatRuntime): Promise<ParkedSession<AgentProcess> | undefined> {
    const target: WarmTarget = { agent: runtime.agent, root: runtime.root };
    // The start in flight is cheaper to wait for than a second `session/new`; its own requests are bounded by `requestMsMax`.
    await this.slot.inflight(target);
    const parked = this.slot.take(target);
    if (parked === undefined) {
      return undefined;
    }
    if (parked.process !== process || process.stopping) {
      // Not this process's session (it restarted since): it cannot be used, and its own process owns deleting it.
      return undefined;
    }
    return parked;
  }

  private adoptWarm(process: AgentProcess, runtime: ChatRuntime, parked: ParkedSession<AgentProcess>): Result<AcpSession, AiFailure> {
    assert(parked.process === process, 'adoptWarm: the session lives in this chat’s process');
    const session = this.bindSession(process, runtime, parked.session, 'defaults');
    if (parked.commands.length > 0) {
      runtime.noteCommands(parked.commands);
    }
    return ok(session);
  }

  /** Lets go of a session that will not be used: asks its process to delete it, unless the process is going away anyway. */
  private discardWarm(released: Released<AgentProcess> | undefined, why: 'released' | 'replaced' | 'agent-changed'): void {
    if (released === undefined) {
      return;
    }
    console.debug(`[ai] prewarm discarded (${why}, ${released.phase})`);
    if (released.phase === 'parked' && !released.parked.process.stopping) {
      void released.parked.process.connection.request('session/delete', { sessionId: released.parked.session.sessionId }, AI_LIMITS.requestMsMax);
    }
  }

  /** Forgets everything started early without messaging any process (the app is quitting or the project closed). */
  private releaseWarm(): void {
    this.cancelQueuedWarm();
    this.slot.release();
  }

  private cancelQueuedWarm(): void {
    clearTimeout(this.warmTimer);
    this.warmTimer = undefined;
    this.warmQueued = undefined;
  }

  /** The agent's sign-in state changed: what was started under the old one is not trusted. */
  private dropWarm(agent: AgentId): void {
    if (this.slot.target()?.agent === agent) {
      this.discardWarm(this.slot.release(), 'agent-changed');
    }
  }

  private optionsOf(agent: AgentId): readonly ChatOption[] {
    const known = this.loadKnownOptions()[agent];
    return known !== undefined && known.length > 0 ? known : FALLBACK_OPTIONS[agent];
  }

  private loadKnownOptions(): Partial<Record<AgentId, readonly ChatOption[]>> {
    if (this.knownOptions === undefined) {
      this.knownOptions = parseKnownOptions(this.deps.store.readAgentOptions());
    }
    return this.knownOptions;
  }

  private rememberOptions(agent: AgentId, options: readonly ChatOption[], source: OptionsSource): void {
    // The choices, and the agent's own defaults as the current values: a change made in a chat is the
    // remembered settings' business, and caching it here would show it as the "default" after a reset.
    const known = this.loadKnownOptions();
    const earlier = known[agent] ?? [];
    const cached =
      source === 'defaults'
        ? options
        : options.map((option) => {
            const before = earlier.find((candidate) => candidate.id === option.id);
            return before !== undefined && option.choices.some((choice) => choice.value === before.currentValue)
              ? { ...option, currentValue: before.currentValue }
              : option;
          });
    if (cached.length === 0 || JSON.stringify(known[agent]) === JSON.stringify(cached)) {
      return;
    }
    this.knownOptions = { ...known, [agent]: cached };
    try {
      this.deps.store.writeAgentOptions(`${JSON.stringify(this.knownOptions)}\n`);
    } catch (error: unknown) {
      console.warn('[ai] the agents’ settings were not saved:', error);
    }
  }

  /**
   * Sets each wanted option the session offers, in the agent's own option order (a model first, since it can
   * change the efforts on offer). A value the agent no longer offers, or one the session already has, is
   * skipped; a request the agent refuses does not stop the chat: the rest still apply and one quiet notice
   * says the chat uses the agent's own setting.
   */
  private async applySettings(
    process: AgentProcess,
    runtime: ChatRuntime,
    settings: readonly { readonly option: string; readonly value: string }[],
  ): Promise<void> {
    const wanted = settings.slice(0, AI_LIMITS.configOptionsMax);
    const refused: string[] = [];
    for (const optionId of runtime.options.map((candidate) => candidate.id)) {
      const setting = wanted.find((candidate) => candidate.option === optionId);
      const option = runtime.options.find((candidate) => candidate.id === optionId);
      if (
        setting === undefined ||
        option === undefined ||
        option.currentValue === setting.value ||
        !option.choices.some((choice) => choice.value === setting.value)
      ) {
        continue;
      }
      const answer = await this.changeSetting(process, runtime, option.id, setting.value);
      if (answer.ok) {
        this.updateOptions(runtime, optionsAfterChange(runtime, setting, answer.value));
      } else {
        refused.push(option.name);
      }
    }
    if (refused.length > 0) {
      this.emit(runtime, [
        { kind: 'notice', severity: 'info', ...noticeText('ai.notice.settingsRefused', { agent: AGENTS[runtime.agent].label, settings: refused.join(', ') }) },
      ]);
    }
  }

  /**
   * The agent's own title for the chat (Claude's adapter sends one a few seconds after the first prompt).
   * It replaces the first-line placeholder or an earlier agent title, never a title the person typed, and
   * never the history an adapter replays or re-announces while a session loads, before any prompt of ours.
   */
  private applyAgentTitle(runtime: ChatRuntime, raw: string): void {
    if (runtime.replaying || !runtime.hasPrompted) {
      return;
    }
    let applied: string | undefined;
    this.deps.store.update(runtime.root, runtime.chat, (current) => {
      const next = withAgentTitle(current, raw);
      applied = next?.title;
      return next ?? current;
    });
    if (applied !== undefined) {
      this.emit(runtime, [{ kind: 'title', title: applied }]);
    }
  }

  private retitle(runtime: ChatRuntime, title: string): void {
    const cleaned = title.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (cleaned === '') {
      return;
    }
    this.deps.store.update(runtime.root, runtime.chat, (current) => ({ ...current, title: cleaned }));
    this.emit(runtime, [{ kind: 'title', title: cleaned }]);
  }

  private noteFailure(failure: AiFailure, runtime: ChatRuntime): AiFailure {
    if (failure.code === 'sign-in') {
      // The availability below is what the panel draws (one sign-in card). No transcript notice: it only repeated the card, in red.
      this.signIn.add(runtime.agent);
      this.dropWarm(runtime.agent);
      this.publishStatus(runtime.agent, runtime.root);
    }
    return failure;
  }

  private publishStatus(agent: AgentId, root: string, options?: readonly ChatOption[]): AgentAvailability {
    const availability = this.availability(agent, root);
    this.deps.send('ai:agentStatus', options === undefined ? { projectPath: root, availability } : { projectPath: root, availability, options });
    return availability;
  }

  private entry(agent: AgentId): string | undefined {
    return this.deps.entryOf === undefined ? installedEntry(this.deps.userData, ADAPTERS[agent]) : this.deps.entryOf(agent);
  }

  private cliPath(agent: AgentId): string | undefined {
    return findCli(agent, this.deps.environment()['PATH'] ?? '');
  }

  private forEachProcess(action: (process: AgentProcess) => void): void {
    for (const process of this.processes.values()) {
      action(process);
    }
  }
}

// ---------------------------------------------------------------------------

function processKey(agent: AgentId, root: string): string {
  return `${agent}\0${root}`;
}

/**
 * Windows: the adapter starts the person's CLI itself, and a .cmd shim would be refused (windowsCommand.ts), so the
 * native program behind it is handed over. A module function because `process` is a local name inside the host's methods.
 */
function runnableAdapterCli(cli: string, environment: Readonly<Record<string, string | undefined>>): string {
  return runnableCliPath(cli, { platform: process.platform, environment, home: os.homedir(), execPath: process.execPath, fileSystem: realFileSystem(fs) });
}

function spawnAdapter(entry: string, root: string, environment: Readonly<Record<string, string | undefined>>): ChildProcess {
  // Electron runs the adapter as Node (ELECTRON_RUN_AS_NODE), so the person needs no Node of their own for it.
  return spawn(process.execPath, [entry], {
    cwd: root,
    env: { ...environment },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
}

// Variables a host agent session sets for its own children: an adapter that
// inherited them (Stacki run from a Claude Code terminal) would act as that session's child.
const HOST_SESSION_VARIABLES =
  /^(CLAUDECODE|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|CHILD_SESSION|MESSAGING_.*|HOST_.*|SSE_PORT|EXECPATH)|CLAUDE_PID|CODEX_THREAD_ID|CODEX_SANDBOX.*)$/;

/** The adapter's environment: the person's shell's, without Stacki's own variables, plus where their CLI is. */
export function adapterEnvironment(
  shell: Readonly<Record<string, string | undefined>>,
  cliVariable: string,
  cli: string,
): Readonly<Record<string, string | undefined>> {
  const environment: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(shell)) {
    if (key.startsWith('STACKI_') || key.startsWith('ELECTRON_') || key.startsWith('VITE_') || HOST_SESSION_VARIABLES.test(key)) {
      continue;
    }
    environment[key] = value;
  }
  environment['ELECTRON_RUN_AS_NODE'] = '1';
  environment[cliVariable] = cli;
  // The adapter starts Claude sessions with `promptSuggestions: true` (adapter dist/v1/acp-agent.js:7571), which makes the CLI spend one
  // extra model call per turn predicting the next prompt; Stacki shows none. The CLI reads this variable first (SDK sdk.d.ts: "the
  // env var wins over the setting") and the adapter passes its process environment through (acp-agent.js:7530), so it is set here
  // for Stacki's adapter processes only, never in the person's own settings. Codex ignores it.
  environment['CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION'] = 'false';
  assert(!Object.keys(environment).some((key) => key.startsWith('STACKI_')), 'adapterEnvironment: no Stacki variable reaches an agent');
  assert(environment[cliVariable] === cli, 'adapterEnvironment: the adapter runs the person’s own CLI');
  return environment;
}

function failureOf(failure: AcpRequestFailure, agent: AgentId, stderr?: string): AiFailure {
  const label = AGENTS[agent].label;
  switch (failure.kind) {
    case 'rpc':
      if (failure.code === ACP_AUTH_REQUIRED || SIGN_IN_MESSAGE.test(failure.message)) {
        return { code: 'sign-in', ...described('ai.error.signIn', { agent: label }) };
      }
      return { code: 'agent-failed', message: failure.message.slice(0, AI_LIMITS.labelCharsMax) };
    case 'timeout':
      return { code: 'agent-failed', ...described('ai.error.timeout', { agent: label }) };
    case 'closed':
      return { code: 'agent-failed', ...described('ai.error.stopped', { agent: label, detail: lastLine(stderr ?? '') }) };
    case 'busy':
      return { code: 'busy', ...described('ai.error.busyRequests', { agent: label }) };
    default: {
      const exhaustive: never = failure;
      return exhaustive;
    }
  }
}

function lastLine(stderr: string): string {
  const line = stderr.trim().split('\n').pop()?.trim() ?? '';
  return line === '' ? '.' : `: ${line.slice(0, 300)}`;
}

function withValue(options: readonly ChatOption[], id: string, value: string): readonly ChatOption[] {
  return options.map((option) => (option.id === id ? { ...option, currentValue: value } : option));
}

/** A turn that ended is news to a person who is elsewhere, unless they ended it themselves or are shown the sign-in card. */
function endsUnread(stop: TurnStop): boolean {
  return stop !== 'cancelled' && stop !== 'sign-in';
}

/** What `prompt` takes besides the plain text and the attachments. */
export interface PromptOptions {
  /** The mentions and text the person composed; absent: the message is its text. */
  readonly parts?: readonly PromptPart[] | undefined;
}

function userEvent(
  turn: TurnId,
  at: number,
  sent: {
    readonly text: string;
    readonly attachments: readonly PromptAttachment[];
    readonly sent: readonly SentPart[] | undefined;
    readonly mode: 'steer' | undefined;
  },
): ChatEvent {
  return {
    kind: 'user',
    turn,
    text: sent.text,
    attachments: sent.attachments.map((attachment) => ({ kind: attachment.kind, name: attachment.kind === 'image' ? attachment.name : attachment.path })),
    at,
    ...(sent.sent === undefined ? {} : { parts: sent.sent }),
    ...(sent.mode === undefined ? {} : { mode: sent.mode }),
  };
}

// The settings a session reports. An agent that offers modes only as session modes (no `mode` config option)
// gets a `mode` option made of them, so the composer's mode menu works the same; `legacyModes` says to set it
// with `session/set_mode`.
function sessionSettings(session: AcpSession): { readonly options: readonly ChatOption[]; readonly legacyModes: boolean } {
  const options = session.options.map(chatOption);
  const offersMode = options.some((option) => option.category === 'mode' || option.id === 'mode');
  const first = session.modes[0];
  if (offersMode || first === undefined) {
    return { options, legacyModes: false };
  }
  const mode: ChatOption = {
    id: 'mode',
    name: 'Mode', // i18n-ignore: a legacy-mode option name, data like the adapters' own option names.
    category: 'mode',
    currentValue: session.currentModeId ?? first.id,
    choices: session.modes.map((candidate) => ({ value: candidate.id, name: candidate.name, description: candidate.description })),
  };
  return { options: [...options, mode], legacyModes: true };
}

// The options after the agent accepted one change. Some agents answer with every option; others only announce
// the change in an update. A mode set through `session/set_mode` answers nothing but success.
function optionsAfterChange(runtime: ChatRuntime, change: { readonly option: string; readonly value: string }, answer: unknown): readonly ChatOption[] {
  const reply = runtime.modeStyle === 'session' && change.option === 'mode' ? undefined : parseSessionResult(answer, runtime.sessionId);
  const options =
    reply?.ok === true && reply.value.options.length > 0 ? reply.value.options.map(chatOption) : withValue(runtime.options, change.option, change.value);
  return runtime.modeStyle === 'session' ? keepLegacyMode(runtime.options, options) : options;
}

// A config update names every option the agent has, and a session-mode agent's list has no `mode` in it.
function keepLegacyMode(current: readonly ChatOption[], incoming: readonly ChatOption[]): readonly ChatOption[] {
  const mode = current.find((option) => option.id === 'mode');
  return mode === undefined || incoming.some((option) => option.id === 'mode') ? incoming : [...incoming, mode];
}

function titleFrom(text: string, attachments: readonly PromptAttachment[]): string {
  const first = text.split('\n').find((line) => line.trim() !== '');
  if (first !== undefined) {
    return first;
  }
  const attachment = attachments[0];
  return attachment === undefined ? NEW_CHAT_TITLE : attachment.kind === 'image' ? attachment.name : attachment.path;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** The saved settings file: one bounded list per known agent; anything unreadable is dropped. */
function parseKnownOptions(input: unknown): Partial<Record<AgentId, readonly ChatOption[]>> {
  const known: Partial<Record<AgentId, readonly ChatOption[]>> = {};
  if (typeof input !== 'object' || input === null) {
    return known;
  }
  for (const [key, value] of Object.entries(input)) {
    try {
      const agent = parseAgentId(key);
      if (Array.isArray(value) && value.length <= AI_LIMITS.configOptionsMax) {
        known[agent] = value.map(parseChatOption);
      }
    } catch {
      continue;
    }
  }
  assert(Object.keys(known).length <= AGENT_IDS.length, 'parseKnownOptions: one list per agent');
  return known;
}
