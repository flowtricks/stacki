// The small mark beside a language in the switcher: the country flag from LOCALE_INFO, round and 16px, or, only when the flag has no artwork,
// a rounded tile holding the short code (EN, DE, 简). The callers only pass a locale.
// The flags are vendored from circle-flags, an exception the user granted for flags alone: the central-icon-system Figma file has none.
import { assert } from '../../../shared/core/assert';
import { LOCALE_INFO, type Locale } from '../../../shared/core/i18n/locales';
import { Flag, hasFlag } from '../../ui/flags/Flag';

export function LocaleMark(props: { readonly locale: Locale }) {
  const { flag, mark } = LOCALE_INFO[props.locale];
  assert(mark.length > 0, 'Every locale has a mark');
  assert(mark.length <= 2, 'A mark fits the 16px icon column');
  if (hasFlag(flag)) {
    return (
      <span className="app-locale-flag" data-locale-mark={props.locale} data-locale-flag={flag} aria-hidden="true">
        <Flag country={flag} size={16} />
      </span>
    );
  }
  return (
    <span className="app-locale-mark" data-locale-mark={props.locale} aria-hidden="true">
      {mark}
    </span>
  );
}
