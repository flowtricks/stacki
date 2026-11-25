// Goal: the meter shows a voice honestly: silence is flat, speech lifts the bars, the bars never
// leave 0 to 1, they rise quickly and fall slowly, and the bar count is bounded.
// Methodology: synthetic sample buffers (silence, a loud tone, one loud half) through the pure maths,
// including empty and oversized buffers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { barsFromSamples, hasSound, silentBars, smoothBars } from '#dist/shared/properties/voice/waveform.js';
import { VOICE_LIMITS } from '#dist/shared/properties/voice/voiceLimits.js';

const silence = (length: number): number[] => Array.from({ length }, () => 128);
const tone = (length: number, amplitude: number): number[] => Array.from({ length }, (_, index) => 128 + (index % 2 === 0 ? amplitude : -amplitude));

test('silence is flat and a tone is raised, within 0 to 1', () => {
  assert.deepEqual(barsFromSamples(silence(256), 8), silentBars(8));
  const loud = barsFromSamples(tone(256, 120), 8);
  assert.ok(loud.every((level) => level > 0.9 && level <= 1));
  const quiet = barsFromSamples(tone(256, 8), 8);
  assert.ok(quiet.every((level) => level > 0 && level < 0.5));
});

test('each bar reads its own slice of the buffer', () => {
  const samples = [...silence(128), ...tone(128, 100)];
  const bars = barsFromSamples(samples, 2);
  assert.equal(bars[0], 0);
  assert.ok((bars[1] ?? 0) > 0.8);
});

test('an empty buffer is silence and a buffer shorter than the bars still gives every bar', () => {
  assert.deepEqual(barsFromSamples([], 4), [0, 0, 0, 0]);
  assert.equal(barsFromSamples([200, 50], 4).length, 4);
});

test('the bar count is an integer within the bound', () => {
  assert.throws(() => barsFromSamples([128], 0), /is positive/u);
  assert.throws(() => barsFromSamples([128], VOICE_LIMITS.waveformBarsMax + 1), /within the bound/u);
  assert.throws(() => barsFromSamples([128], 2.5), /an integer/u);
  assert.throws(() => silentBars(0), /is positive/u);
});

test('bars rise fast and fall slowly', () => {
  const up = smoothBars([0, 0], [1, 1]);
  const down = smoothBars([1, 1], [0, 0]);
  assert.ok((up[0] ?? 0) > 0.5);
  assert.ok((down[0] ?? 0) > 0.8);
  assert.throws(() => smoothBars([0], [0, 0]), /same bars/u);
});

test('speech is told from the noise floor', () => {
  assert.equal(hasSound([0.01, 0.05, 0.1]), false);
  assert.equal(hasSound([0.01, 0.5]), true);
  assert.equal(hasSound([]), false);
});
