// Which tile renders next. A preview render is a whole page render on the project's dev server, which the
// canvas shares, so renders are few at a time and the tile the person is looking at comes first. The queue
// is a plain value: every function returns the next queue, so the policy is tested without timers.

import { assert } from '../core/assert';

/** Bounds of the queue; a full queue refuses work (the tile stays idle) instead of growing. */
export const PREVIEW_QUEUE_LIMITS = {
  /** Renders at once. The dev server does them one at a time per request; more only lengthens each. */
  concurrencyMax: 3,
  queuedMax: 1024,
} as const;

/** `visible` tiles are on screen now, `near` are a screen away either side, `background` is everything else. */
export const PREVIEW_PRIORITIES = ['visible', 'near', 'background'] as const;
export type PreviewPriority = (typeof PREVIEW_PRIORITIES)[number];

export interface QueueEntry {
  readonly id: string;
  readonly priority: PreviewPriority;
  /** The tile's position in the grid, so a tied priority renders top to bottom. */
  readonly order: number;
}

export interface PreviewQueue {
  readonly waiting: readonly QueueEntry[];
  readonly running: readonly string[];
}

export const EMPTY_PREVIEW_QUEUE: PreviewQueue = { waiting: [], running: [] };

function rank(priority: PreviewPriority): number {
  return PREVIEW_PRIORITIES.indexOf(priority);
}

function byTurn(left: QueueEntry, right: QueueEntry): number {
  return rank(left.priority) - rank(right.priority) || left.order - right.order || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

/** Adds an entry, or changes the priority of one that is waiting. A running or full queue changes nothing. */
export function enqueue(queue: PreviewQueue, entry: QueueEntry): PreviewQueue {
  if (queue.running.includes(entry.id)) {
    return queue;
  }
  const others = queue.waiting.filter((waiting) => waiting.id !== entry.id);
  if (others.length >= PREVIEW_QUEUE_LIMITS.queuedMax) {
    return queue;
  }
  return { ...queue, waiting: [...others, entry].sort(byTurn) };
}

/** Takes an entry back: it is no longer wanted (the tile left, the project closed). A running one is left to finish. */
export function cancel(queue: PreviewQueue, id: string): PreviewQueue {
  return queue.waiting.some((entry) => entry.id === id) ? { ...queue, waiting: queue.waiting.filter((entry) => entry.id !== id) } : queue;
}

/** Drops everything waiting, for a project that closed or a dev server that restarted. */
export function cancelAll(queue: PreviewQueue): PreviewQueue {
  return { ...queue, waiting: [] };
}

/** Re-ranks what is waiting after the grid scrolled: `priorities` says what each id is now, the rest become background. */
export function reprioritize(queue: PreviewQueue, priorities: ReadonlyMap<string, PreviewPriority>): PreviewQueue {
  const waiting = queue.waiting.map((entry) => ({ ...entry, priority: priorities.get(entry.id) ?? ('background' as const) })).sort(byTurn);
  return { ...queue, waiting };
}

/** Starts as many waiting entries as the concurrency allows, best first. */
export function startNext(queue: PreviewQueue, concurrency: number): { readonly queue: PreviewQueue; readonly started: readonly QueueEntry[] } {
  assert(concurrency >= 1, 'The queue renders at least one at a time');
  assert(concurrency <= PREVIEW_QUEUE_LIMITS.concurrencyMax, 'The queue stays within its concurrency bound');
  const free = Math.max(0, concurrency - queue.running.length);
  const started = queue.waiting.slice(0, free);
  const next: PreviewQueue = { waiting: queue.waiting.slice(started.length), running: [...queue.running, ...started.map((entry) => entry.id)] };
  assert(next.running.length <= concurrency || queue.running.length > concurrency, 'Never more renders than the concurrency');
  return { queue: next, started };
}

/** Marks a render finished, which frees its place. */
export function finish(queue: PreviewQueue, id: string): PreviewQueue {
  return queue.running.includes(id) ? { ...queue, running: queue.running.filter((running) => running !== id) } : queue;
}
