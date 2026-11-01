import { useSyncExternalStore } from 'react';
import './soundToggle.css';
import { getSoundPreference, setSoundPreference, subscribeSoundPreference } from './soundPreference';

export function SoundToggle() {
  const enabled = useSyncExternalStore(subscribeSoundPreference, getSoundPreference);
  return (
    <button type="button" className="sound-toggle" role="switch" aria-label="Sound effects" aria-checked={enabled} onClick={() => setSoundPreference(!enabled)}>
      <span>Sound effects</span>
      <span className="sound-toggle-track" aria-hidden="true">
        <span className="sound-toggle-thumb" />
      </span>
    </button>
  );
}
