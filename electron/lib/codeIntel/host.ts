// The intelligence process's keeper, in main. The process is started by the first question and stopped when the project
// closes or changes, or after sitting unused. One question is with it at a time; those waiting are bounded, and a newer
// question of a kind replaces an older one still waiting. A question that outlasts its time, or a process that dies,
// answers "unavailable" and the next question starts a fresh process; after a few of those close together it stays off
// until the project changes. Nothing here blocks: every answer is a promise.
import { assert } from '../../../shared/core/assert';
import { CODE_INTEL_LIMITS, parseCodeIntelReply, UNAVAILABLE, type CodeIntelReply, type CodeIntelRequest } from '../../../shared/ipc/codeIntel';
import { parseServiceAnswer } from './messages';

/** What the host needs of a child process: Electron's utility process, or a stand-in in tests. */
export interface IntelChild {
  readonly post: (message: unknown) => void;
  readonly onMessage: (listener: (message: unknown) => void) => void;
  readonly onExit: (listener: () => void) => void;
  readonly kill: () => void;
}

export interface Timer {
  readonly cancel: () => void;
}

export interface IntelHostParts {
  readonly spawn: () => IntelChild;
  readonly now: () => number;
  readonly setTimer: (action: () => void, delayMs: number) => Timer;
  readonly log: (message: string) => void;
}

export interface IntelHost {
  readonly request: (request: CodeIntelRequest) => Promise<CodeIntelReply>;
  /** Ends the process and forgets its failures: the project closed, or the app is quitting. */
  readonly stop: () => void;
}

interface Waiting {
  readonly request: CodeIntelRequest;
  readonly resolve: (reply: CodeIntelReply) => void;
}

interface Running {
  readonly child: IntelChild;
  readonly projectPath: string;
}

export function createIntelHost(parts: IntelHostParts): IntelHost {
  const keeper = new Keeper(parts);
  return { request: (request) => keeper.request(request), stop: () => keeper.reset() };
}

class Keeper {
  private running: Running | undefined;
  private asked: { readonly id: number; readonly waiting: Waiting; readonly timer: Timer } | undefined;
  private readonly queue: Waiting[] = [];
  private failures: readonly number[] = [];
  private disabledFor: string | undefined;
  private idle: Timer | undefined;
  private id = 0;
  /** The process that has answered once. */
  private warm: IntelChild | undefined;

  constructor(private readonly parts: IntelHostParts) {}

  request(request: CodeIntelRequest): Promise<CodeIntelReply> {
    if (this.disabledFor === request.projectPath) {
      return Promise.resolve(UNAVAILABLE);
    }
    if (this.running !== undefined && this.running.projectPath !== request.projectPath) {
      this.reset();
    }
    return new Promise((resolve) => {
      this.enqueue({ request, resolve });
      this.pump();
    });
  }

  reset(): void {
    this.end();
    this.drain();
    this.failures = [];
    this.disabledFor = undefined;
  }

  private drain(): void {
    for (const waiting of this.queue.splice(0)) {
      waiting.resolve(UNAVAILABLE);
    }
  }

  // Ends the process and answers whatever it was working on.
  private end(): void {
    this.idle?.cancel();
    this.idle = undefined;
    const running = this.running;
    this.running = undefined;
    const asked = this.asked;
    this.asked = undefined;
    if (asked !== undefined) {
      asked.timer.cancel();
      asked.waiting.resolve(UNAVAILABLE);
    }
    running?.child.kill();
  }

  private enqueue(waiting: Waiting): void {
    const { kind } = waiting.request.query;
    // Only the latest of these is still wanted; a resolve belongs to a suggestion someone accepted, so each is kept.
    if (kind !== 'resolve') {
      const stale = this.queue.findIndex((entry) => entry.request.query.kind === kind && entry.request.path === waiting.request.path);
      if (stale !== -1) {
        this.queue.splice(stale, 1)[0]?.resolve(UNAVAILABLE);
      }
    }
    this.queue.push(waiting);
    if (this.queue.length > CODE_INTEL_LIMITS.pendingMax) {
      this.queue.shift()?.resolve(UNAVAILABLE);
    }
    assert(this.queue.length <= CODE_INTEL_LIMITS.pendingMax, 'The waiting questions stay within their bound');
  }

  private pump(): void {
    if (this.asked !== undefined) {
      return;
    }
    // Squiggles can wait for what the person is looking at.
    const urgent = this.queue.findIndex((entry) => entry.request.query.kind !== 'diagnostics');
    const waiting = this.queue.splice(Math.max(0, urgent), 1)[0];
    if (waiting === undefined) {
      this.idleSoon();
      return;
    }
    this.idle?.cancel();
    this.idle = undefined;
    const running = this.running ?? this.start(waiting.request.projectPath);
    if (running === undefined) {
      waiting.resolve(UNAVAILABLE);
      this.drain();
      return;
    }
    this.id += 1;
    const id = this.id;
    const timeoutMs = this.warm === running.child ? CODE_INTEL_LIMITS.requestTimeoutMs : CODE_INTEL_LIMITS.firstRequestTimeoutMs;
    const timer = this.parts.setTimer(() => this.failed(running, 'a request ran past its time'), timeoutMs);
    this.asked = { id, waiting, timer };
    try {
      running.child.post({ id, request: waiting.request });
    } catch (error: unknown) {
      this.failed(running, `a request could not be sent: ${String(error)}`);
    }
  }

  private start(projectPath: string): Running | undefined {
    let child: IntelChild;
    try {
      child = this.parts.spawn();
    } catch (error: unknown) {
      this.parts.log(`[code intelligence] could not start: ${String(error)}`);
      this.disabledFor = projectPath;
      return undefined;
    }
    const running: Running = { child, projectPath };
    this.running = running;
    child.onMessage((message) => this.answered(running, message));
    child.onExit(() => this.failed(running, 'the process ended'));
    return running;
  }

  private answered(running: Running, message: unknown): void {
    const asked = this.asked;
    if (this.running !== running || asked === undefined) {
      return;
    }
    let reply: CodeIntelReply;
    try {
      const parsed = parseServiceAnswer(message);
      if (parsed.id !== asked.id) {
        return;
      }
      reply = parseCodeIntelReply(parsed.reply);
    } catch (error: unknown) {
      this.failed(running, `an answer did not parse: ${String(error)}`);
      return;
    }
    // The first answer built the project's types; what follows is held to the shorter time.
    this.warm = running.child;
    asked.timer.cancel();
    this.asked = undefined;
    asked.waiting.resolve(reply);
    this.pump();
  }

  private failed(running: Running, why: string): void {
    // A process already replaced or stopped on purpose is not a failure.
    if (this.running?.child !== running.child) {
      return;
    }
    this.parts.log(`[code intelligence] ${why}`);
    this.end();
    const now = this.parts.now();
    this.failures = [...this.failures.filter((at) => now - at < CODE_INTEL_LIMITS.crashWindowMs), now];
    if (this.failures.length > CODE_INTEL_LIMITS.restartsMax) {
      this.parts.log('[code intelligence] stopped until the project is opened again');
      this.disabledFor = running.projectPath;
      this.drain();
      return;
    }
    this.pump();
  }

  private idleSoon(): void {
    if (this.running === undefined || this.idle !== undefined) {
      return;
    }
    this.idle = this.parts.setTimer(() => {
      this.idle = undefined;
      this.end();
    }, CODE_INTEL_LIMITS.idleStopMs);
  }
}
