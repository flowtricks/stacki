// The Language row of Editor settings: "System default", then each language written in itself.
// The choice applies at once (LocaleProvider listens to the store) and is kept on this computer.
import { useSyncExternalStore } from 'react';
import { LOCALE_NATIVE_NAMES, LOCALE_PREFERENCES, type LocalePreference } from '../../../shared/core/i18n/locales';
import { readLocalePreference, subscribeLocalePreference, writeLocalePreference } from '../../lib/i18n/localeStore';
import { useTranslate } from '../../lib/i18n/useTranslate';
import Dropdown, { type DropdownOption } from '../../ui/Dropdown';
import { SettingsRow } from './SettingsLayout';

export function LanguageSetting() {
  const translate = useTranslate();
  const preference = useSyncExternalStore(subscribeLocalePreference, readLocalePreference, readLocalePreference);
  const options: readonly DropdownOption<LocalePreference>[] = LOCALE_PREFERENCES.map((value) => ({
    value,
    label: value === 'system' ? translate('settings.language.system') : LOCALE_NATIVE_NAMES[value],
  }));
  return (
    <SettingsRow label={translate('settings.language.label')} info={translate('settings.language.info')}>
      <Dropdown<LocalePreference> ariaLabel={translate('settings.language.label')} value={preference} options={options} onChange={writeLocalePreference} />
    </SettingsRow>
  );
}
