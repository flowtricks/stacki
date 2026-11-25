// Transcript events on their way to disk and to the renderer, in batches.
//
// An adapter streams a token at a time; storing and sending each one would cost
// a write and an IPC message per token. So events wait up to
// AI_LIMITS.eventBatchMs, consecutive text is joined (chatEvents.ts
// coalesceEvents), each chat's share is appended to its file in one write and
// sent in one `ai:events` message.
//
// Flow control copies the terminal's (electron/terminal/terminal.ts): the
// characters sent and not yet acknowledged are counted, and above the high
// watermark every adapter's output stops being read (`pause`) until the
// renderer's `ai:ack`s bring the count under the low one. The queue itself is
// bounded too: past AI_LIMITS.eventsQueuedMax it flushes at once.
import { assert } from '../../../shared/core/assert';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';
import { chatEventChars, type ChatEvent, type ChatId } from '../../../shared/properties/ai/chatModel';
import { noticeText } from './aiMessages';
import { coalesceEvents } from './chatEvents';

export interface PumpTarget {
  /** Stores one chat's batch; false when its transcript is full. */
  readonly store: (projectPath: string, chat: ChatId, events: readonly ChatEvent[]) => boolean;
  readonly send: (channel: 'ai:events', payload: unknown) => void;
  readonly pause: () => void;
  readonly resume: () => void;
}

interface Queued {
  readonly projectPath: string;
  readonly chat: ChatId;
  readonly event: ChatEvent;
}

export class EventPump {
  private queue: Queued[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unacked = 0;
  private paused = false;

  constructor(private readonly target: PumpTarget) {}

  push(projectPath: string, chat: ChatId, events: readonly ChatEvent[]): void {
    for (const event of events) {
      this.queue.push({ projectPath, chat, event });
    }
    if (this.queue.length >= AI_LIMITS.eventsQueuedMax) {
      this.flush();
      return;
    }
    if (this.timer === undefined && this.queue.length > 0) {
      this.timer = setTimeout(() => this.flush(), AI_LIMITS.eventBatchMs);
      this.timer.unref?.();
    }
  }

  /** Stores and sends everything queued, one message per chat run, in the order it came. */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const queued = this.queue;
    this.queue = [];
    let index = 0;
    while (index < queued.length) {
      const first = queued[index];
      assert(first !== undefined, 'EventPump.flush: inside the queue');
      const run: ChatEvent[] = [];
      while (index < queued.length && queued[index]?.chat === first.chat && queued[index]?.projectPath === first.projectPath) {
        const next = queued[index];
        assert(next !== undefined, 'EventPump.flush: a run reads inside the queue');
        run.push(next.event);
        index += 1;
      }
      this.deliver(first.projectPath, first.chat, coalesceEvents(run));
    }
    assert(index === queued.length, 'EventPump.flush: every queued event was delivered');
  }

  /** The renderer applied `chars` characters of events. */
  acknowledge(chars: number): void {
    assert(Number.isSafeInteger(chars), 'EventPump.acknowledge: a parsed count');
    this.unacked = Math.max(0, this.unacked - chars);
    if (this.paused && this.unacked <= AI_LIMITS.flowLowWatermark) {
      this.paused = false;
      this.target.resume();
    }
  }

  /** A renderer that reloaded will never acknowledge what the old one was sent. */
  reset(): void {
    this.unacked = 0;
    if (this.paused) {
      this.paused = false;
      this.target.resume();
    }
  }

  get unacknowledged(): number {
    return this.unacked;
  }

  private deliver(projectPath: string, chat: ChatId, events: readonly ChatEvent[]): void {
    if (events.length === 0) {
      return;
    }
    const stored = this.target.store(projectPath, chat, events);
    const delivered: readonly ChatEvent[] = stored ? events : [...events, { kind: 'notice', severity: 'warning', ...noticeText('ai.notice.chatFull') }];
    const chars = delivered.reduce((total, event) => total + chatEventChars(event), 0);
    this.target.send('ai:events', { projectPath, chat, events: delivered, chars });
    this.unacked += chars;
    if (!this.paused && this.unacked >= AI_LIMITS.flowHighWatermark) {
      this.paused = true;
      this.target.pause();
    }
  }
}
