// Why the design canvas can still be showing its loader, in terms a person can report.
// The shell waits for two things before it hides the loader: the frame loads a page, and
// that page's editor script says it is ready. When the wait runs long, saying which of
// the two is missing turns "it spins forever" into a cause.

export const HANDSHAKE_LIMITS = {
  /** The loader names the missing step after this long without a ready message. */
  slowAfterMs: 15_000,
} as const satisfies Record<string, number>;

export type HandshakeWait =
  | { readonly kind: 'address' } // No preview address has been granted yet.
  | { readonly kind: 'frame' } // The address exists but the frame has not finished loading a page.
  | { readonly kind: 'script' }; // A page loaded in the frame and its editor script has not said ready.

export function handshakeWait(input: { readonly url: string | undefined; readonly frames: number; readonly framesLoaded: number }): HandshakeWait {
  if (!Number.isSafeInteger(input.frames) || !Number.isSafeInteger(input.framesLoaded)) {
    throw new Error('Assertion failed: frame counts are integers');
  }
  if (input.framesLoaded > input.frames) {
    throw new Error('Assertion failed: no more frames have loaded than exist');
  }
  if (input.url === undefined) {
    return { kind: 'address' };
  }
  if (input.framesLoaded > 0) {
    return { kind: 'script' };
  }
  return { kind: 'frame' };
}
