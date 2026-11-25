// The pure state behind starting an agent early: one pre-warmed, empty session
// parked for the next new chat; the timeout that decides how long an idle adapter
// process stays alive; and the startup timings the main-process log carries.
//
// Why a slot and not a pool: a pre-warmed session costs an adapter process's
// worth of MCP, plugin and hook loading, and the panel shows one project and one
// agent at a time. One slot app-wide gives "at most one pre-warm per project"
// for free, bounds the speculative work, and makes every discard rule one line:
// a different project or agent, a stopped process or a changed setting simply
// releases the slot. Nothing here touches a process, a timer or the disk; the
// host owns those, so this file is testable without any of them.
import { assert } from '../../../shared/core/assert';
import type { AcpSession } from '../../../shared/properties/ai/acpWire';
import type { AgentId } from '../../../shared/properties/ai/agentIds';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';

/** Which agent in which project a pre-warmed session is for. */
export interface WarmTarget {
  readonly agent: AgentId;
  readonly root: string;
}

/** An empty session an adapter started and no chat uses yet. */
export interface ParkedSession<Process extends object = object> {
  /** The adapter process that holds the session; a session never outlives it. */
  readonly process: Process;
  readonly session: AcpSession;
  /** How long the adapter took to answer `session/new`, for the startup log. */
  readonly sessionNewMs: number;
  /** The slash commands the adapter announced after the session began, without the slash. */
  commands: readonly string[];
}

/** Proof that a warm-up still owns the slot; a release makes every earlier ticket stale. */
export interface WarmTicket {
  readonly generation: number;
  readonly target: WarmTarget;
}

type SlotEntry<Process extends object> =
  | { readonly phase: 'starting'; readonly ticket: WarmTicket; settled: Promise<void> | undefined }
  | { readonly phase: 'parked'; readonly ticket: WarmTicket; readonly parked: ParkedSession<Process> };

/** What a release removed, so the caller can delete a parked session it no longer wants. */
export type Released<Process extends object = object> =
  | { readonly phase: 'starting'; readonly target: WarmTarget }
  | { readonly phase: 'parked'; readonly target: WarmTarget; readonly parked: ParkedSession<Process> };

export type SlotPhase = 'empty' | 'starting' | 'parked';

export class WarmSlot<Process extends object = object> {
  private entry: SlotEntry<Process> | undefined = undefined;
  private generation = 0;

  phase(): SlotPhase {
    return this.entry === undefined ? 'empty' : this.entry.phase;
  }

  /** The target the slot is working for or holds, if any. */
  target(): WarmTarget | undefined {
    return this.entry?.ticket.target;
  }

  holds(target: WarmTarget): boolean {
    return this.entry !== undefined && sameTarget(this.entry.ticket.target, target);
  }

  /**
   * Claims the empty slot for a warm-up. Undefined when the slot is taken, by this target (single-flight:
   * a second focus while one is starting or parked does nothing) or by another (the caller releases first).
   */
  begin(target: WarmTarget): WarmTicket | undefined {
    if (this.entry !== undefined) {
      return undefined;
    }
    this.generation += 1;
    const ticket: WarmTicket = { generation: this.generation, target };
    this.entry = { phase: 'starting', ticket, settled: undefined };
    assert(this.phase() === 'starting', 'WarmSlot.begin: the slot is starting');
    return ticket;
  }

  /** Records the promise a send can wait on instead of starting a second session. */
  attach(ticket: WarmTicket, settled: Promise<void>): void {
    if (this.entry?.phase === 'starting' && this.entry.ticket.generation === ticket.generation) {
      this.entry.settled = settled;
    }
  }

  /** The warm-up in flight for this target, to wait on; undefined when none is running. */
  inflight(target: WarmTarget): Promise<void> | undefined {
    const entry = this.entry;
    return entry !== undefined && entry.phase === 'starting' && sameTarget(entry.ticket.target, target) ? entry.settled : undefined;
  }

  /** Parks the finished session. False when the ticket went stale meanwhile: the caller deletes the session. */
  park(ticket: WarmTicket, parked: ParkedSession<Process>): boolean {
    const entry = this.entry;
    if (entry === undefined || entry.phase !== 'starting' || entry.ticket.generation !== ticket.generation) {
      return false;
    }
    this.entry = { phase: 'parked', ticket, parked };
    assert(this.phase() === 'parked', 'WarmSlot.park: the slot is parked');
    return true;
  }

  /** Whether the ticket still owns the slot: false once anything released it. */
  current(ticket: WarmTicket): boolean {
    return this.entry !== undefined && this.entry.ticket.generation === ticket.generation;
  }

  /** The warm-up failed or found nothing to park: frees the slot if the ticket is still current. */
  abandon(ticket: WarmTicket): void {
    if (this.entry !== undefined && this.entry.phase === 'starting' && this.entry.ticket.generation === ticket.generation) {
      this.entry = undefined;
    }
  }

  /** Hands the parked session to its chat. Undefined unless a parked session is for exactly this target. */
  take(target: WarmTarget): ParkedSession<Process> | undefined {
    const entry = this.entry;
    if (entry === undefined || entry.phase !== 'parked' || !sameTarget(entry.ticket.target, target)) {
      return undefined;
    }
    this.entry = undefined;
    this.generation += 1;
    assert(this.phase() === 'empty', 'WarmSlot.take: a session is adopted once');
    return entry.parked;
  }

  /** Empties the slot whatever it holds and makes every outstanding ticket stale. */
  release(): Released<Process> | undefined {
    const entry = this.entry;
    this.entry = undefined;
    this.generation += 1;
    assert(this.entry === undefined, 'WarmSlot.release: the slot is empty');
    if (entry === undefined) {
      return undefined;
    }
    return entry.phase === 'parked'
      ? { phase: 'parked', target: entry.ticket.target, parked: entry.parked }
      : { phase: 'starting', target: entry.ticket.target };
  }

  /** Releases the slot when its session lives in this process (the process ended or was stopped). */
  releaseProcess(process: Process): Released<Process> | undefined {
    const entry = this.entry;
    if (entry !== undefined && entry.phase === 'parked' && entry.parked.process === process) {
      return this.release();
    }
    return undefined;
  }

  /** A parked session keeps hearing from its adapter (the slash commands arrive after `session/new`); remembered for the chat that adopts it. */
  noteCommands(sessionId: string, commands: readonly string[]): boolean {
    const entry = this.entry;
    if (entry === undefined || entry.phase !== 'parked' || entry.parked.session.sessionId !== sessionId) {
      return false;
    }
    entry.parked.commands = commands.slice(0, AI_LIMITS.commandsMax);
    return true;
  }

  /** Whether this session id is the parked one, so the host does not treat its updates as an orphan's. */
  parkedSession(sessionId: string): ParkedSession<Process> | undefined {
    const entry = this.entry;
    return entry !== undefined && entry.phase === 'parked' && entry.parked.session.sessionId === sessionId ? entry.parked : undefined;
  }
}

function sameTarget(left: WarmTarget, right: WarmTarget): boolean {
  return left.agent === right.agent && left.root === right.root;
}

// ---------------------------------------------------------------------------
// How long an idle adapter stays
// ---------------------------------------------------------------------------

export interface IdleInputs {
  /** Adapter processes alive now, this one included. */
  readonly processes: number;
  /** Free memory over total memory, 0 to 1. */
  readonly freeMemoryRatio: number;
}

/**
 * The idle timeout for an adapter with no turn running. The long one keeps the next message fast; it
 * shortens when the machine is short on memory or when more than `processesComfortableMax` adapters
 * are alive, because each holds its CLI, MCP servers and plugins in memory. Both shortened cases use
 * the same value: the point is to give the memory back soon, not to rank the reasons.
 */
export function idleTimeoutMs(inputs: IdleInputs): number {
  assert(Number.isSafeInteger(inputs.processes), 'idleTimeoutMs: a whole process count');
  assert(inputs.processes >= 0, 'idleTimeoutMs: a process count is not negative');
  const crowded = inputs.processes > AI_LIMITS.processesComfortableMax;
  const squeezed = inputs.freeMemoryRatio < AI_LIMITS.memoryFreeRatioMin;
  if (crowded) {
    return AI_LIMITS.idleMsCrowded;
  }
  return squeezed ? AI_LIMITS.idleMsCrowded : AI_LIMITS.idleMsMax;
}

export interface IdleCandidate {
  /** When the process last finished a turn or startup work, in the host's clock. */
  readonly lastUsedAt: number;
  /** A turn is running or waiting on the person. */
  readonly busy: boolean;
}

/**
 * The index of the idle process that was used longest ago (least recently used), or undefined when every
 * process is busy. Ties go to the earlier entry, which is the older process in map order.
 */
export function oldestIdle(candidates: readonly IdleCandidate[]): number | undefined {
  assert(candidates.length <= AI_LIMITS.processesMax + 1, 'oldestIdle: a bounded set of processes');
  let found: number | undefined;
  let foundAt = Number.POSITIVE_INFINITY;
  for (const [index, candidate] of candidates.entries()) {
    if (!candidate.busy && candidate.lastUsedAt < foundAt) {
      found = index;
      foundAt = candidate.lastUsedAt;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Startup timings
// ---------------------------------------------------------------------------

/** How a chat got its session: parked and pre-warmed, started on the first message, or an earlier one continued. */
export type SessionOrigin = 'prewarmed' | 'cold' | 'resumed';

export interface ProcessTiming {
  /** Spawn call to the child's `spawn` event; undefined while that has not been seen. */
  readonly spawnMs: number | undefined;
  /** `initialize` request to its answer: the adapter booting is most of it. */
  readonly initializeMs: number | undefined;
}

interface PendingStartup {
  readonly origin: SessionOrigin;
  readonly process: ProcessTiming;
  readonly sessionNewMs: number | undefined;
  readonly sentAt: number | undefined;
}

/** Chats whose first token the log still waits for; past it the oldest is forgotten, never the map grown. */
const PENDING_STARTUPS_MAX = 64;

/**
 * Durations only: no prompt text, no paths, no ids. The log line can be shared as it is.
 * A chat's startup is recorded when its session binds, stamped when the message goes out, and
 * reported once at the first streamed token.
 */
export class StartupTimings {
  private readonly processes = new WeakMap<object, ProcessTiming>();
  private readonly pending = new Map<string, PendingStartup>();
  /** Messages sent whose session had not bound yet: the clock starts at the send, so a cold start counts. */
  private readonly sends = new Map<string, number>();

  noteProcess(process: object, timing: ProcessTiming): void {
    this.processes.set(process, timing);
  }

  processTiming(process: object): ProcessTiming {
    return this.processes.get(process) ?? { spawnMs: undefined, initializeMs: undefined };
  }

  /** The message left the composer. Called before the session exists, so a cold start is inside the measure. */
  noteSend(chat: string, at: number): void {
    remember(this.sends, chat, at);
    assert(this.sends.size <= PENDING_STARTUPS_MAX, 'StartupTimings.noteSend: bounded');
  }

  /** The chat's session is bound: how it came to be, and how long the adapter took when it was asked for one. */
  noteSession(chat: string, process: object, origin: SessionOrigin, sessionNewMs: number | undefined): void {
    const startup: PendingStartup = { origin, process: this.processTiming(process), sessionNewMs, sentAt: this.sends.get(chat) };
    this.sends.delete(chat);
    if (this.pending.has(chat)) {
      this.pending.delete(chat);
    }
    remember(this.pending, chat, startup);
    assert(this.pending.size <= PENDING_STARTUPS_MAX, 'StartupTimings.noteSession: bounded');
  }

  /** The first streamed token: returns the log line once, then forgets the chat. */
  noteFirstToken(chat: string, at: number): string | undefined {
    this.sends.delete(chat);
    const startup = this.pending.get(chat);
    if (startup === undefined || startup.sentAt === undefined) {
      return undefined;
    }
    this.pending.delete(chat);
    return formatStartup({ ...startup, firstTokenMs: Math.max(0, at - startup.sentAt) });
  }

  forget(chat: string): void {
    this.pending.delete(chat);
    this.sends.delete(chat);
  }
}

function remember<T>(map: Map<string, T>, key: string, value: T): void {
  if (!map.has(key) && map.size >= PENDING_STARTUPS_MAX) {
    const oldest = map.keys().next();
    if (oldest.done !== true) {
      map.delete(oldest.value);
    }
  }
  map.set(key, value);
}

interface StartupFields {
  readonly origin: SessionOrigin;
  readonly process: ProcessTiming;
  readonly sessionNewMs: number | undefined;
  readonly firstTokenMs: number | undefined;
}

/** One log line from numbers and one of three words. */
export function formatStartup(fields: StartupFields): string {
  const part = (value: number | undefined): string => (value === undefined ? 'none' : String(Math.max(0, Math.round(value))));
  const line = `startup: session=${fields.origin} spawnMs=${part(fields.process.spawnMs)} initializeMs=${part(fields.process.initializeMs)} sessionNewMs=${part(fields.sessionNewMs)} firstTokenMs=${part(fields.firstTokenMs)}`;
  assert(!line.includes('/'), 'formatStartup: a startup line carries no path');
  assert(line.length < 200, 'formatStartup: a startup line is short');
  return line;
}
