// Which backdrop the start screen paints. Both backgrounds stay in the tree so
// switching between them is a one-word change here, not a code restore.
export type WelcomeBackgroundKind = 'shader' | 'classic';

// Flip this to 'classic' to restore the previous interactive wave background
// (WelcomeBackground.tsx). 'shader' is the flowing violet noise ported from the
// launch reel (WelcomeShaderBackground.tsx), which itself falls back to 'classic'
// whenever WebGL is unavailable or its context is lost.
export const WELCOME_BACKGROUND: WelcomeBackgroundKind = 'shader';

// The shader reports only whether it can draw; a failure is final for the mount,
// because a lost or refused context is not worth retrying on a decorative layer.
export type WelcomeShaderStatus = 'available' | 'unavailable';

export function welcomeBackgroundKind(chosen: WelcomeBackgroundKind, status: WelcomeShaderStatus): WelcomeBackgroundKind {
  switch (chosen) {
    case 'classic':
      return 'classic';
    case 'shader':
      return status === 'available' ? 'shader' : 'classic';
    default: {
      const exhaustive: never = chosen;
      return exhaustive;
    }
  }
}
