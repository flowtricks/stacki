// Shader source and pure timing helpers for the start screen's noise backdrop.
// The effect is ported from the launch reel's Background (Remotion): there the
// clock was frame / fps; here it is elapsed wall time in seconds, scaled by
// SHADER_LIMITS.timeScale so the screen drifts slower than the video.
import { assert } from '../../../shared/core/assert';

export const SHADER_LIMITS = {
  // The pattern is soft noise; beyond 1.5 device pixels per CSS pixel the extra
  // fragments are invisible but still cost GPU time on Retina displays.
  pixelRatioMax: 1.5,
  pixelRatioMin: 1,
  // Shader seconds per wall second. The reel's pace (1) reads as busy behind a
  // screen people sit on, so the app runs it at a little under half.
  timeScale: 0.45,
  // The loop, in shader seconds (about 22 minutes on screen at timeScale).
  // Every motion in the shader repeats exactly over it (shaderLoop below), so
  // wrapping the clock here is seamless; the wrap also bounds the float
  // magnitude fed to sin() and the noise offsets, which lose precision as
  // they grow.
  secondsPeriod: 600,
  // The shader time shown when motion is off: the light edge has swung into the lower
  // right, matching the reel's resting composition.
  secondsStill: 2.5,
} as const satisfies Record<string, number>;

// One cycle per loop, in radians per shader second.
const LOOP_RADIANS_PER_SECOND = (2 * Math.PI) / SHADER_LIMITS.secondsPeriod;

/** The nearest frequency (radians per shader second) that completes a whole
 *  number of cycles in one loop, so a sine at it ends the loop where it began. */
export function loopFrequency(radiansPerSecond: number): number {
  assert(radiansPerSecond > 0, 'loopFrequency: a frequency is positive');
  const cycles = Math.max(1, Math.round(radiansPerSecond / LOOP_RADIANS_PER_SECOND));
  const snapped = cycles * LOOP_RADIANS_PER_SECOND;
  assert(Math.abs(snapped - radiansPerSecond) <= LOOP_RADIANS_PER_SECOND / 2, 'loopFrequency: the snap stays within half a cycle per loop');
  return snapped;
}

/** The circle a straight drift at `velocity` (noise units per shader second)
 *  becomes so that it closes once per loop: same speed, same starting
 *  direction, radius speed / ω. Over one loop its direction turns a full
 *  turn, far too slowly to see. */
export function loopDriftRadius(velocity: readonly [number, number]): number {
  const speed = Math.hypot(velocity[0], velocity[1]);
  assert(speed > 0, 'loopDriftRadius: a drift moves');
  const radius = speed / LOOP_RADIANS_PER_SECOND;
  assert(Number.isFinite(radius), 'loopDriftRadius: the radius is finite');
  return radius;
}

// GLSL float literals for the constants above: always with a decimal point.
const glsl = (value: number): string => {
  assert(Number.isFinite(value), 'glsl: a literal is finite');
  return value.toFixed(9);
};

// The noise layers' drifts, as the reel had them (noise units per shader second).
const DRIFT_SLOW = [0.28, -0.2] as const;
const DRIFT_QUICK = [-0.4, 0.32] as const;

export const SHADER_VERTEX_SOURCE = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

// Ashima 2D simplex noise, as the reel vendors it.
const SIMPLEX_SOURCE = `
vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
`;

// Domain-warped simplex noise mapped onto the brand ramp: near-black purple,
// electric violet, lavender, pink-white. The reel's beat pulse (a lift on every
// 128 bpm beat) is left out: without its music it reads as flicker.
export const SHADER_FRAGMENT_SOURCE = `
precision highp float;
uniform vec2 u_res;
uniform float u_time;

${SIMPLEX_SOURCE}

const float LOOP_W = ${glsl(LOOP_RADIANS_PER_SECOND)};

// A drift along a circle that closes once per loop: it starts moving along
// \`dir\` at the drift's own speed and returns to its start at the loop's end,
// so the noise is the same picture when the clock wraps.
vec2 loopDrift(vec2 dir, float radius, float t) {
  vec2 d = normalize(dir);
  vec2 side = vec2(-d.y, d.x);
  return radius * (d * sin(LOOP_W * t) + side * (1.0 - cos(LOOP_W * t)));
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = uv - 0.5;
  float t = u_time;

  // Big soft shapes that keep flowing: two low-frequency layers, one slow, one quicker.
  float n = snoise(p * 0.5 + loopDrift(vec2(${glsl(DRIFT_SLOW[0])}, ${glsl(DRIFT_SLOW[1])}), ${glsl(loopDriftRadius(DRIFT_SLOW))}, t)) * 0.65
    + snoise(p * 0.9 + loopDrift(vec2(${glsl(DRIFT_QUICK[0])}, ${glsl(DRIFT_QUICK[1])}), ${glsl(loopDriftRadius(DRIFT_QUICK))}, t) + 3.0) * 0.35;

  // Dark at the top (behind headings), light lower right; the light edge sways back and forth.
  // The sway's frequencies are snapped to whole cycles per loop (loopFrequency).
  float a = sin(t * ${glsl(loopFrequency(0.7))}) * 0.45;
  vec2 dir = vec2(sin(a) * 0.3 + 0.3, -cos(a));
  float base = dot(p, dir) + 0.5 + sin(uv.x * 3.0 + t * ${glsl(loopFrequency(1.3))}) * 0.06;
  float v = base * 1.05 + n * 0.24;

  vec3 c = vec3(0.045, 0.0, 0.05);
  c = mix(c, vec3(0.17, 0.02, 0.33), smoothstep(0.1, 0.4, v));
  c = mix(c, vec3(0.38, 0.0, 1.0), smoothstep(0.3, 0.58, v));
  c = mix(c, vec3(0.7, 0.6, 1.0), smoothstep(0.5, 0.78, v));
  c = mix(c, vec3(0.99, 0.94, 0.99), smoothstep(0.65, 1.0, v));

  gl_FragColor = vec4(c, 1.0);
}
`;

export type WelcomeShaderMotion = 'animated' | 'still';

export function welcomeShaderMotion(options: { readonly reducedMotion: boolean; readonly hardwareAllowed: boolean }): WelcomeShaderMotion {
  if (options.reducedMotion) {
    return 'still';
  }
  if (options.hardwareAllowed) {
    return 'animated';
  }
  return 'still';
}

// Shader time for a frame, in the reel's units. The animation clock (requestAnimationFrame) may stamp
// a frame slightly before the start captured by performance.now(), so a small
// negative elapsed time is clamped rather than treated as a bug.
export function welcomeShaderSeconds(elapsedMs: number): number {
  assert(Number.isFinite(elapsedMs), 'WelcomeShaderBackground: elapsed time must be finite');
  const seconds = (Math.max(0, elapsedMs) / 1000) * SHADER_LIMITS.timeScale;
  const wrapped = seconds % SHADER_LIMITS.secondsPeriod;
  assert(wrapped >= 0, 'WelcomeShaderBackground: shader time is not negative');
  assert(wrapped < SHADER_LIMITS.secondsPeriod, 'WelcomeShaderBackground: shader time stays inside its period');
  return wrapped;
}

// The device pixel ratio is read from the platform, so it is checked like input.
export function welcomeShaderPixelRatio(ratio: unknown): number {
  if (typeof ratio !== 'number') {
    return SHADER_LIMITS.pixelRatioMin;
  }
  if (!Number.isFinite(ratio)) {
    return SHADER_LIMITS.pixelRatioMin;
  }
  const clamped = Math.min(SHADER_LIMITS.pixelRatioMax, Math.max(SHADER_LIMITS.pixelRatioMin, ratio));
  assert(clamped <= SHADER_LIMITS.pixelRatioMax, 'WelcomeShaderBackground: pixel ratio exceeds its cap');
  return clamped;
}

// Where the WebGL context stands. Only a drawn frame shows the canvas: before it,
// and for good once WebGL is refused (no context, software rendering, a failed
// compile) or lost, the backdrop's static CSS gradient shows instead, so the
// screen is never blank.
export type WelcomeShaderContext = 'pending' | 'drawn' | 'refused' | 'lost';
export type WelcomeShaderSurface = 'canvas' | 'gradient';

export function welcomeShaderSurface(context: WelcomeShaderContext): WelcomeShaderSurface {
  switch (context) {
    case 'drawn':
      return 'canvas';
    case 'pending':
    case 'refused':
    case 'lost':
      return 'gradient';
    default: {
      const exhaustive: never = context;
      return exhaustive;
    }
  }
}
