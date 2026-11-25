import { useSyncExternalStore } from 'react';
import './soundToggle.css';
import { useTranslate } from '../../../vendor/stacki/src/lib/i18n/useTranslate';
import { getSoundPreference, setSoundPreference, subscribeSoundPreference } from './soundPreference';

export function SoundToggle() {
  const translate = useTranslate();
  const enabled = useSyncExternalStore(subscribeSoundPreference, getSoundPreference);
  return (
    <button
      type="button"
      className="sound-toggle"
      role="switch"
      aria-label={translate('settings.element.sound')}
      aria-checked={enabled}
      onClick={() => setSoundPreference(!enabled)}
    >
      <span>{translate('settings.element.sound')}</span>
      <span className="sound-toggle-track" aria-hidden="true">
        <span className="sound-toggle-thumb" />
      </span>
    </button>
  );
}
