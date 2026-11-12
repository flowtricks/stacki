// How long things took, in the words the transcript uses ("1.4s", "12s", "1m 17s"), and how old a chat is in the list.
// Desktop's chatStatus.ts holds the same formats but also the agent-session model, which Studio does not have, so the
// two small formatters are kept here; the shared tests of Desktop pin the formats these follow.
import { assert } from '../../../vendor/stacki/shared/core/assert';

/** A duration as people read it: `1.4s`, `12s`, `1m 17s`, `1h 2m`. Never negative. */
export function formatDuration(milliseconds: number): string {
  assert(Number.isFinite(milliseconds), 'formatDuration: a finite number');
  const clamped = Math.max(0, milliseconds);
  if (clamped < 10_000) {
    return `${(Math.floor(clamped / 100) / 10).toFixed(1)}s`;
  }
  const seconds = Math.floor(clamped / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The age of a chat for its row: `now`, `5m`, `3h`, `2d`, `6w`. A chat stored before ages were kept (0) has none. */
export function ageLabel(updatedAt: number, now: number): string {
  if (updatedAt <= 0) {
    return '';
  }
  const minutes = Math.floor(Math.max(0, now - updatedAt) / 60_000);
  if (minutes < 1) {
    return 'now';
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : `${Math.floor(days / 7)}w`;
}
