import type { HistoryCommit, HistoryCommitFile } from './historyBridge';

export function relativeTime(iso: string, now = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) {
    return '';
  }
  const seconds = Math.round((now - time) / 1000);
  if (seconds < 45) {
    return 'just now';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const days = Math.round(hours / 24);
  if (days === 1) {
    return 'yesterday';
  }
  if (days < 7) {
    return `${days} days ago`;
  }
  return formattedDate(time, now, 'short');
}

export function dayGroup(iso: string, now = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) {
    return '';
  }
  const days = Math.round((startOfDay(now) - startOfDay(time)) / 86_400_000);
  if (days <= 0) {
    return 'Today';
  }
  if (days === 1) {
    return 'Yesterday';
  }
  if (days < 7) {
    return `${days} days ago`;
  }
  return formattedDate(time, now, 'long');
}

export function summarize(files: readonly HistoryCommitFile[] | undefined): string {
  if (!files?.length) {
    return 'No files changed';
  }
  const labels = [...new Set(files.map((file) => file.label))];
  const pages = files.filter((file) => file.kind === 'page').length;
  const noun = pages === files.length ? 'page' : 'file';
  if (labels.length === 1) {
    return labels[0] ?? 'No files changed';
  }
  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }
  return `${labels[0]} and ${labels.length - 1} other ${noun}s`;
}

export function commitAuthor(commit: HistoryCommit, userEmail: string | undefined): string {
  return userEmail && commit.email === userEmail ? 'You' : commit.author;
}

function startOfDay(milliseconds: number): number {
  const date = new Date(milliseconds);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function formattedDate(time: number, now: number, month: 'short' | 'long'): string {
  const date = new Date(time);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  const options: Intl.DateTimeFormatOptions = sameYear ? { month, day: 'numeric' } : { month, day: 'numeric', year: 'numeric' };
  return date.toLocaleDateString(undefined, options);
}
