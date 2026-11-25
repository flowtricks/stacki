import type { Formatters } from '../../../shared/core/i18n/format';
import { formattersFor } from '../../../shared/core/i18n/format';
import { ENGLISH_TRANSLATE } from '../../../shared/properties/i18n/englishTranslator';
import type { Translator } from '../../../shared/properties/i18n/messageRef';
import type { HistoryCommit, HistoryCommitFile } from './historyBridge';

/** What the time and summary helpers need to speak in the active language; English when a caller has no language (tests, logs). */
export interface HistoryText {
  readonly translate: Translator;
  readonly format: Formatters;
}

const ENGLISH_TEXT: HistoryText = { translate: ENGLISH_TRANSLATE, format: formattersFor('en') };

export function relativeTime(iso: string, now = Date.now(), text: HistoryText = ENGLISH_TEXT): string {
  const { translate } = text;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) {
    return '';
  }
  const seconds = Math.round((now - time) / 1000);
  if (seconds < 45) {
    return translate('history.time.justNow');
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return translate('history.time.minutesAgo', { count: minutes });
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return translate('history.time.hoursAgo', { count: hours });
  }
  const days = Math.round(hours / 24);
  if (days === 1) {
    return translate('history.time.yesterday');
  }
  if (days < 7) {
    return translate('history.time.daysAgo', { count: days });
  }
  return formattedDate(time, now, 'short', text.format);
}

export function dayGroup(iso: string, now = Date.now(), text: HistoryText = ENGLISH_TEXT): string {
  const { translate } = text;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) {
    return '';
  }
  const days = Math.round((startOfDay(now) - startOfDay(time)) / 86_400_000);
  if (days <= 0) {
    return translate('history.day.today');
  }
  if (days === 1) {
    return translate('history.day.yesterday');
  }
  if (days < 7) {
    return translate('history.time.daysAgo', { count: days });
  }
  return formattedDate(time, now, 'long', text.format);
}

/**
 * The words a changed file is listed under. The main process names the home page "Home" in English; every other label is the file's own
 * name or route, which is the person's data. The home page's name comes from the catalog, as it does in the Pages panel.
 */
export function historyFileLabel(file: Pick<HistoryCommitFile, 'kind' | 'path' | 'label'>, translate: Translator): string {
  return file.kind === 'page' && /^src\/pages\/index\.(astro|mdx?)$/i.test(file.path) ? translate('ui.page.home') : file.label;
}

export function summarize(files: readonly HistoryCommitFile[] | undefined, text: HistoryText = ENGLISH_TEXT): string {
  const { translate } = text;
  if (!files?.length) {
    return translate('history.summary.none');
  }
  const labels = [...new Set(files.map((file) => historyFileLabel(file, translate)))];
  const pages = files.filter((file) => file.kind === 'page').length;
  const first = labels[0] ?? '';
  if (labels.length === 1) {
    return first === '' ? translate('history.summary.none') : first;
  }
  if (labels.length === 2) {
    return translate('history.summary.two', { first, second: labels[1] ?? '' });
  }
  const count = labels.length - 1;
  return pages === files.length ? translate('history.summary.morePages', { first, count }) : translate('history.summary.moreFiles', { first, count });
}

export function commitAuthor(commit: HistoryCommit, userEmail: string | undefined, translate: Translator = ENGLISH_TRANSLATE): string {
  return userEmail && commit.email === userEmail ? translate('history.commit.you') : commit.author;
}

function startOfDay(milliseconds: number): number {
  const date = new Date(milliseconds);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function formattedDate(time: number, now: number, month: 'short' | 'long', format: Formatters): string {
  const date = new Date(time);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  const options: Intl.DateTimeFormatOptions = sameYear ? { month, day: 'numeric' } : { month, day: 'numeric', year: 'numeric' };
  return format.formatDate(date, options);
}
