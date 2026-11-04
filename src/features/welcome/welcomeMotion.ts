import { assert } from '../../../shared/core/assert';

// Decoration must leave headroom for project startup. These are conservative
// eligibility hints, not a GPU benchmark; unavailable CPU data chooses stillness.
const MOTION_LIMITS = {
  processorsMin: 5,
  processorsMax: 1024,
  memoryGBMin: 4,
  memoryGBMax: 1024,
  dimensionMax: 1280,
  pixelsMax: 1280 * 720,
  frameIntervalMs: 1000 / 30,
} as const;

export function welcomeMotionAllowed(processors: unknown, memoryGB: unknown): boolean {
  if (typeof processors !== 'number') {
    return false;
  }
  if (!Number.isSafeInteger(processors)) {
    return false;
  }
  if (processors < MOTION_LIMITS.processorsMin) {
    return false;
  }
  if (processors > MOTION_LIMITS.processorsMax) {
    return false;
  }
  // Some platforms omit deviceMemory. CPU eligibility and the WebGL performance
  // caveat still apply there; malformed reported memory never enables motion.
  if (memoryGB === undefined) {
    return true;
  }
  if (typeof memoryGB !== 'number') {
    return false;
  }
  if (!Number.isFinite(memoryGB)) {
    return false;
  }
  if (memoryGB > MOTION_LIMITS.memoryGBMax) {
    return false;
  }
  return memoryGB > MOTION_LIMITS.memoryGBMin;
}

export function welcomeDrawingSize(width: number, height: number) {
  assert(Number.isFinite(width), 'WelcomeShaderBackground: width must be finite');
  assert(Number.isFinite(height), 'WelcomeShaderBackground: height must be finite');
  const widthPixels = Math.max(1, width);
  const heightPixels = Math.max(1, height);
  // This blurred artwork gains little from Retina resolution. Bound both its
  // longest edge and total shaded pixels, regardless of display pixel density.
  const scale = Math.min(
    1,
    MOTION_LIMITS.dimensionMax / Math.max(widthPixels, heightPixels),
    Math.sqrt(MOTION_LIMITS.pixelsMax / (widthPixels * heightPixels)),
  );
  const size = {
    width: Math.max(1, Math.floor(widthPixels * scale)),
    height: Math.max(1, Math.floor(heightPixels * scale)),
  };
  assert(size.width <= MOTION_LIMITS.dimensionMax, 'WelcomeShaderBackground: width exceeds budget');
  assert(size.height <= MOTION_LIMITS.dimensionMax, 'WelcomeShaderBackground: height exceeds budget');
  return size;
}

// Own exactly one pending frame. An inactive window has no animation callbacks,
// and a fast display cannot increase shader or pointer-field work past 30 fps.
export function welcomeFrames(draw: (now: number) => void): () => void {
  let frame: number | undefined;
  let lastDrawMs = -Infinity;
  const render = (now: number): void => {
    if (now - lastDrawMs >= MOTION_LIMITS.frameIntervalMs) {
      draw(now);
      lastDrawMs = now;
    }
    frame = window.requestAnimationFrame(render);
  };
  const pause = (): void => {
    if (frame !== undefined) {
      window.cancelAnimationFrame(frame);
      frame = undefined;
    }
  };
  const resume = (): void => {
    pause();
    if (document.hidden) {
      return;
    }
    if (!document.hasFocus()) {
      return;
    }
    lastDrawMs = -Infinity;
    frame = window.requestAnimationFrame(render);
  };
  window.addEventListener('blur', pause);
  window.addEventListener('focus', resume);
  document.addEventListener('visibilitychange', resume);
  resume();
  return () => {
    pause();
    window.removeEventListener('blur', pause);
    window.removeEventListener('focus', resume);
    document.removeEventListener('visibilitychange', resume);
  };
}
