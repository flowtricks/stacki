// When something changed, as people read it: "just now", "5 min ago", "3 h ago",
// then a date and time. Recent changes read at a glance; older ones exactly.

import { assert } from '../../../shared/core/assert';

export function relativeTime(iso: string, now = Date.now()): string {
  assert(Number.isFinite(now), 'Now is a moment in time');
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return '';
  }
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  return new Date(then).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
