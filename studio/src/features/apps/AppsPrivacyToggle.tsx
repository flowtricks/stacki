// The account menu's switch for hiding this person's details from apps
// (docs/apps.md, "The person"): Desktop's Settings, Privacy has the same one.
// It looks like the sound switch beside it (soundToggle.css), which it reuses.
import { useSyncExternalStore } from 'react';
import { useTranslate } from '../../../vendor/stacki/src/lib/i18n/useTranslate';
import '../settings/soundToggle.css';
import { onStudioPersonChange, setStudioPersonHidden, studioPersonHidden } from './appDataClient';

export function AppsPrivacyToggle() {
  const translate = useTranslate();
  const hidden = useSyncExternalStore(onStudioPersonChange, studioPersonHidden);
  return (
    <button
      type="button"
      className="sound-toggle"
      role="switch"
      aria-label={translate('apps.privacy.hide')}
      aria-checked={hidden}
      title={translate('apps.privacy.hint')}
      onClick={() => setStudioPersonHidden(!hidden)}
    >
      <span>{translate('apps.privacy.hide')}</span>
      <span className="sound-toggle-track" aria-hidden="true">
        <span className="sound-toggle-thumb" />
      </span>
    </button>
  );
}
