// How long things took, in the words the transcript uses ("1.4s", "12s", "1m 17s"), and how old a chat is in the list.
// Desktop's chatStatus.ts holds the same formats but also the agent-session model, which Studio does not have, so the
// two small formatters are kept here; the shared tests of Desktop pin the formats these follow.
import { assert } from '../../../vendor/stacki/shared/core/assert';
import type { Formatters } from '../../../vendor/stacki/shared/core/i18n/format';
import type { Translator } from '../../../vendor/stacki/shared/properties/i18n/messageRef';

/** A duration as people read it: `1.4s`, `12s`, `1m 17s`, `1h 2m`. Never negative. */
export function formatDuration(milliseconds: number, formatNumber: Formatters['formatNumber']): string {
  assert(Number.isFinite(milliseconds), 'formatDuration: a finite number');
  const clamped = Math.max(0, milliseconds);
  // The unit marks come from `Intl` (narrow unit style), so they follow the language.
  const unit = (value: number, name: 'second' | 'minute' | 'hour', fractionDigits: number): string =>
    formatNumber(value, { style: 'unit', unit: name, unitDisplay: 'narrow', minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits });
  if (clamped < 10_000) {
    return unit(Math.floor(clamped / 100) / 10, 'second', 1);
  }
  const seconds = Math.floor(clamped / 1000);
  if (seconds < 60) {
    return unit(seconds, 'second', 0);
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${unit(minutes, 'minute', 0)} ${unit(seconds % 60, 'second', 0)}`;
  }
  return `${unit(Math.floor(minutes / 60), 'hour', 0)} ${unit(minutes % 60, 'minute', 0)}`;
}

/** The age of a chat for its row: `now`, `5m`, `3h`, `2d`, `6w`. A chat stored before ages were kept (0) has none. */
export function ageLabel(updatedAt: number, now: number, words: { readonly translate: Translator; readonly formatNumber: Formatters['formatNumber'] }): string {
  if (updatedAt <= 0) {
    return '';
  }
  const unit = (value: number, name: 'minute' | 'hour' | 'day' | 'week'): string =>
    words.formatNumber(value, { style: 'unit', unit: name, unitDisplay: 'narrow', maximumFractionDigits: 0 });
  const minutes = Math.floor(Math.max(0, now - updatedAt) / 60_000);
  if (minutes < 1) {
    return words.translate('ai.sessions.now');
  }
  if (minutes < 60) {
    return unit(minutes, 'minute');
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return unit(hours, 'hour');
  }
  const days = Math.floor(hours / 24);
  return days < 7 ? unit(days, 'day') : unit(Math.floor(days / 7), 'week');
}
