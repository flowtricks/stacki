// When something changed, as people read it: "just now", "5 min ago", "3 h ago",
// then a date and time. Recent changes read at a glance; older ones exactly.
// The words and the date format follow the interface language, so every
// function here takes the language it should speak (RemoteText).

import { assert } from '../../../shared/core/assert';
import { formattersFor, type Formatters } from '../../../shared/core/i18n/format';
import { ENGLISH_TRANSLATE } from '../../../shared/properties/i18n/englishTranslator';
import type { Translator } from '../../../shared/properties/i18n/messageRef';

/** What the remote CMS helpers need to speak in the active language: the hooks' `translate` and `format`. */
export interface RemoteText {
  readonly translate: Translator;
  readonly format: Formatters;
}

/** English, for code that has no language to follow (tests, logs). */
export const ENGLISH_REMOTE_TEXT: RemoteText = { translate: ENGLISH_TRANSLATE, format: formattersFor('en') };

export function relativeTime(iso: string, now = Date.now(), text: RemoteText = ENGLISH_REMOTE_TEXT): string {
  assert(Number.isFinite(now), 'Now is a moment in time');
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return '';
  }
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) {
    return text.translate('cmsRemote.time.justNow');
  }
  if (minutes < 60) {
    return text.translate('cmsRemote.time.minutesAgo', { count: minutes });
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return text.translate('cmsRemote.time.hoursAgo', { count: hours });
  }
  return text.format.formatDate(then, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
