// One JSON-RPC connection to an ACP adapter over its stdio: newline-framed
// lines in, newline-framed lines out (shared/properties/ai/acpWire.ts parses each).
//
// Bounds (AGENTS.md §10): a line longer than AI_LIMITS.lineBytesMax closes the
// connection, since an adapter that never ends a line would otherwise grow the
// buffer forever; at most AI_LIMITS.pendingRequestsMax requests wait for an
// answer, and each has a timeout, so a silent adapter cannot pile them up.
// Reading can be paused (flow control: agentHost.ts stops reading while the
// renderer is behind), which pauses the adapter through its pipe.
import type { Readable, Writable } from 'node:stream';
import { assert } from '../../../shared/core/assert';
import { err, ok, type Result } from '../../../shared/core/result';
import { JSON_RPC_METHOD_NOT_FOUND, parseAcpLine, type JsonRpcId } from '../../../shared/properties/ai/acpWire';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';

export type AcpRequestFailure =
  | { readonly kind: 'rpc'; readonly code: number; readonly message: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'closed' }
  | { readonly kind: 'busy' };

/** What an incoming request answers: a result, or a JSON-RPC error. */
export type AcpAnswer = Result<unknown, { readonly code: number; readonly message: string }>;

export interface AcpConnectionHandlers {
  readonly onRequest: (method: string, params: unknown) => Promise<AcpAnswer>;
  readonly onNotification: (method: string, params: unknown) => void;
  /** A line that was not JSON-RPC, or the line bound was hit; the adapter keeps running unless `fatal`. */
  readonly onProtocolError: (message: string, severity: 'fatal' | 'skipped') => void;
  readonly onClose: () => void;
}

interface Pending {
  readonly resolve: (result: Result<unknown, AcpRequestFailure>) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class AcpConnection {
  private buffer = '';
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly streams: { readonly input: Readable; readonly output: Writable },
    private readonly handlers: AcpConnectionHandlers,
  ) {
    streams.input.setEncoding('utf8');
    streams.input.on('data', (chunk: string) => this.receive(chunk));
    streams.input.on('end', () => this.close());
    streams.input.on('error', () => this.close());
    streams.output.on('error', () => this.close());
  }

  /** Sends a request; resolves with its result, or why there is none. Never rejects. */
  request(method: string, params: unknown, timeoutMs: number): Promise<Result<unknown, AcpRequestFailure>> {
    assert(method.length > 0, 'AcpConnection.request: a method is named');
    assert(timeoutMs > 0, 'AcpConnection.request: a request has a timeout');
    if (this.closed) {
      return Promise.resolve(err({ kind: 'closed' }));
    }
    if (this.pending.size >= AI_LIMITS.pendingRequestsMax) {
      return Promise.resolve(err({ kind: 'busy' }));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(err({ kind: 'timeout' }));
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    assert(method.length > 0, 'AcpConnection.notify: a method is named');
    if (!this.closed) {
      this.write({ jsonrpc: '2.0', method, params });
    }
  }

  /** Stops reading the adapter's output; its pipe fills and the adapter waits. */
  pause(): void {
    this.streams.input.pause();
  }

  resume(): void {
    this.streams.input.resume();
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Ends the connection: every waiting request resolves `closed`. Safe to call twice. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const [, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.resolve(err({ kind: 'closed' }));
    }
    this.pending.clear();
    this.buffer = '';
    assert(this.pending.size === 0, 'AcpConnection.close: nothing is left waiting');
    this.handlers.onClose();
  }

  private write(message: Readonly<Record<string, unknown>>): void {
    const line = JSON.stringify(message);
    assert(!line.includes('\n'), 'AcpConnection.write: JSON.stringify never emits a raw newline');
    try {
      this.streams.output.write(`${line}\n`);
    } catch {
      this.close();
    }
  }

  private receive(chunk: string): void {
    if (this.closed) {
      return;
    }
    this.buffer += chunk;
    // Each pass consumes one line, so the loop is bounded by the newlines in the buffer.
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > AI_LIMITS.lineBytesMax) {
        this.fail('A message from the agent exceeded the size limit.');
        return;
      }
      if (line.trim() !== '') {
        this.dispatch(line);
      }
      if (this.closed) {
        return;
      }
      newline = this.buffer.indexOf('\n');
    }
    if (this.buffer.length > AI_LIMITS.lineBytesMax) {
      this.fail('A message from the agent exceeded the size limit.');
    }
  }

  private fail(message: string): void {
    this.handlers.onProtocolError(message, 'fatal');
    this.close();
  }

  private dispatch(line: string): void {
    const parsed = parseAcpLine(line);
    if (!parsed.ok) {
      this.handlers.onProtocolError(parsed.error.message, 'skipped');
      return;
    }
    const message = parsed.value;
    switch (message.kind) {
      case 'notification':
        this.handlers.onNotification(message.method, message.params);
        return;
      case 'request':
        void this.answer(message.id, message.method, message.params);
        return;
      case 'result':
        this.settle(message.id, ok(message.result));
        return;
      case 'error':
        this.settle(message.id, err({ kind: 'rpc', code: message.code, message: message.message }));
        return;
      default: {
        const exhaustive: never = message;
        return exhaustive;
      }
    }
  }

  private settle(id: JsonRpcId, result: Result<unknown, AcpRequestFailure>): void {
    if (typeof id !== 'number') {
      return; // Stacki only ever sends numeric ids; an answer to another is not ours.
    }
    const waiting = this.pending.get(id);
    if (waiting === undefined) {
      return; // Timed out already, or never asked.
    }
    this.pending.delete(id);
    clearTimeout(waiting.timer);
    waiting.resolve(result);
  }

  private async answer(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    let answer: AcpAnswer;
    try {
      answer = await this.handlers.onRequest(method, params);
    } catch (error: unknown) {
      // A handler that throws is a Stacki bug; the agent still hears an answer, so its turn does not hang.
      console.error(`[ai] ${method} handler failed:`, error);
      answer = err({ code: -32603, message: 'Internal error' });
    }
    if (answer.ok) {
      this.write({ jsonrpc: '2.0', id, result: answer.value ?? {} });
    } else {
      this.write({ jsonrpc: '2.0', id, error: answer.error });
    }
  }
}

/** The answer for a method this client does not implement. */
export const METHOD_NOT_FOUND: AcpAnswer = err({ code: JSON_RPC_METHOD_NOT_FOUND, message: 'Method not found' });
