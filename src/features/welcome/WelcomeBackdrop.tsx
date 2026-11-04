// The start screen's backdrop: the reel shader or the classic wave, picked by
// WELCOME_BACKGROUND in welcomeBackgroundChoice.ts. The shader falls back to the
// classic wave for the rest of the mount once WebGL refuses or loses its context.
import { useCallback, useState } from 'react';
import WelcomeBackground from './WelcomeBackground';
import { WELCOME_BACKGROUND, welcomeBackgroundKind, type WelcomeShaderStatus } from './welcomeBackgroundChoice';
import WelcomeShaderBackground from './WelcomeShaderBackground';

export default function WelcomeBackdrop() {
  const [status, setStatus] = useState<WelcomeShaderStatus>('available');
  // Stable identity, so the shader's effect does not restart on every render.
  const unavailable = useCallback(() => setStatus('unavailable'), []);
  const kind = welcomeBackgroundKind(WELCOME_BACKGROUND, status);
  switch (kind) {
    case 'classic':
      return <WelcomeBackground />;
    case 'shader':
      return <WelcomeShaderBackground onUnavailable={unavailable} />;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}
