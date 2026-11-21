// The live waveform: turns the microphone's time-domain samples into a few bar heights.
// Pure and bounded, so the meter's maths is tested without audio hardware. A bar is the
// loudness (root mean square) of its slice of the buffer; a gain lifts normal speech, which
// sits well under full scale, to a readable height; smoothing makes bars rise fast and fall
// slowly, which reads as a voice instead of noise.
import { assert } from '../../core/assert';
import { VOICE_LIMITS } from './voiceLimits';

/** Speech peaks near 0.2 of full scale; the gain puts that near the top of the bar. */
const GAIN = 4;
const ATTACK = 0.6;
const RELEASE = 0.15;
/** Time-domain samples from an analyser are bytes centred on 128. */
const BYTE_CENTER = 128;

/** Bar heights, each 0 to 1, from `samples` (bytes 0 to 255, silence at 128). An empty buffer is silence. */
export function barsFromSamples(samples: ArrayLike<number>, barCount: number): readonly number[] {
  assert(Number.isSafeInteger(barCount), 'barsFromSamples: the bar count is an integer');
  assert(barCount > 0, 'barsFromSamples: the bar count is positive');
  assert(barCount <= VOICE_LIMITS.waveformBarsMax, 'barsFromSamples: the bar count is within the bound');
  const bars: number[] = [];
  const perBar = Math.max(1, Math.floor(samples.length / barCount));
  for (let bar = 0; bar < barCount; bar += 1) {
    let sum = 0;
    let count = 0;
    const from = bar * perBar;
    const to = Math.min(samples.length, from + perBar);
    for (let index = from; index < to; index += 1) {
      const centered = ((samples[index] ?? BYTE_CENTER) - BYTE_CENTER) / BYTE_CENTER;
      sum += centered * centered;
      count += 1;
    }
    const level = count === 0 ? 0 : Math.sqrt(sum / count) * GAIN;
    bars.push(Math.min(1, Math.max(0, level)));
  }
  return bars;
}

/** The bars after one frame: each rises quickly toward the new level and falls slowly. */
export function smoothBars(previous: readonly number[], next: readonly number[]): readonly number[] {
  assert(previous.length === next.length, 'smoothBars: both frames have the same bars');
  return next.map((level, index) => {
    const before = previous[index] ?? 0;
    return before + (level - before) * (level > before ? ATTACK : RELEASE);
  });
}

/** Whether any bar is above the noise floor: the signal for "speech is happening" (resets the silence timer). */
export function hasSound(bars: readonly number[]): boolean {
  return bars.some((level) => level > 0.12);
}

export function silentBars(barCount: number): readonly number[] {
  assert(barCount > 0, 'silentBars: the bar count is positive');
  assert(barCount <= VOICE_LIMITS.waveformBarsMax, 'silentBars: the bar count is within the bound');
  return Array.from({ length: barCount }, () => 0);
}
