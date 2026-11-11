// The account menu's switch for hiding this person's details from apps
// (docs/apps.md, "The person"): Desktop's Settings, Privacy has the same one.
// It looks like the sound switch beside it (soundToggle.css), which it reuses.
import { useSyncExternalStore } from 'react';
import '../settings/soundToggle.css';
import { onStudioPersonChange, setStudioPersonHidden, studioPersonHidden } from './appDataClient';

export function AppsPrivacyToggle() {
  const hidden = useSyncExternalStore(onStudioPersonChange, studioPersonHidden);
  return (
    <button
      type="button"
      className="sound-toggle"
      role="switch"
      aria-label="Hide my details from apps"
      aria-checked={hidden}
      title="Apps see only an id that is the same for you in this project."
      onClick={() => setStudioPersonHidden(!hidden)}
    >
      <span>Hide my details from apps</span>
      <span className="sound-toggle-track" aria-hidden="true">
        <span className="sound-toggle-thumb" />
      </span>
    </button>
  );
}
