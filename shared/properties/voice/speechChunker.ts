// Where live speech is, and where to cut it for Whisper. Whisper reads windows of at most 30 seconds
// and does best on whole phrases, but given silence, a breath or a fan it writes words nobody said
// ("Thank you.", "Okay.", "You"). So nothing reaches it that this detector has not heard as speech:
//
//   - a frame is 30 ms; it has a loudness (root mean square) and a zero-crossing rate;
//   - the room's noise floor is measured from the first 300 ms of the session (the person has not
//     started talking yet), so the threshold follows the room: the floor times a factor, between an
//     absolute floor and a ceiling;
//   - a frame is a speech candidate when it is over the threshold and crosses zero like a voice
//     (white noise crosses about every other sample, voiced speech far less);
//   - speech starts after three candidate frames in a row and lasts, with hysteresis, while frames
//     stay over a lower release level, tolerating 120 ms of quiet (a hangover) inside a word;
//   - a window with under 300 ms of speech is never decoded, and a decoded window is trimmed to its
//     speech plus 150 ms on each side, so Whisper never sees a long quiet span it could fill;
//   - a pause is `pauseMsMin` of quiet after speech: the audio before the middle of the last pause is a
//     finished segment (committed: decoded once, written to the box, dropped);
//   - a buffer close to the window bound with no pause is cut at its quietest frame.
//
// Everything here is pure except `SpeechBuffer`, whose one preallocated array is its private state
// (AGENTS.md §11: local, centralized mutation; a copy per 100 ms chunk would allocate 2 MB a second).
import { assert } from '../../core/assert';
import { DICTATION_LIMITS, msOf, samplesOf } from './dictationLimits';

export const FRAME_SAMPLES = samplesOf(DICTATION_LIMITS.frameMs);
/** Silero's window: 512 samples, 32 ms at 16 kHz (vadWorkerProtocol.ts). */
const VAD_SAMPLES = 512;
const PAUSE_FRAMES = Math.ceil(DICTATION_LIMITS.pauseMsMin / DICTATION_LIMITS.frameMs);
const SPEECH_FRAMES_MIN = Math.ceil(DICTATION_LIMITS.speechMsMin / DICTATION_LIMITS.frameMs);
const PADDING_SAMPLES = samplesOf(DICTATION_LIMITS.speechPaddingMs);
const NOISE_FRAMES = Math.ceil(DICTATION_LIMITS.noiseMeasureMs / DICTATION_LIMITS.frameMs);
/** Silence before any speech after which the quiet audio is dropped. */
const IDLE_SAMPLES_MAX = samplesOf(2_000);
/** The buffer is cut without a pause this close to its bound. */
const FORCE_SAMPLES = samplesOf(DICTATION_LIMITS.windowMsMax - 2_000);
/** Without a measured floor, the quantile of frame loudness taken as the room. */
const NOISE_QUANTILE = 0.1;

/** Each whole 30 ms frame's loudness and zero-crossing rate (crossings per sample, 0 to 1). */
export interface Frames {
  readonly energies: Float32Array;
  readonly crossings: Float32Array;
  /** Silero VAD's speech probability per frame, when the detector runs; without it the energy detector decides alone. */
  readonly probabilities?: Float32Array;
}

/** The frames of `samples`; a trailing partial frame is left for the next call. */
export function measureFrames(samples: Float32Array): Frames {
  const count = Math.floor(samples.length / FRAME_SAMPLES);
  const energies = new Float32Array(count);
  const crossings = new Float32Array(count);
  for (let frame = 0; frame < count; frame += 1) {
    let sum = 0;
    let crossed = 0;
    const from = frame * FRAME_SAMPLES;
    let previous = samples[from] ?? 0;
    for (let index = from; index < from + FRAME_SAMPLES; index += 1) {
      const sample = samples[index] ?? 0;
      sum += sample * sample;
      if (sample >= 0 !== previous >= 0) {
        crossed += 1;
      }
      previous = sample;
    }
    energies[frame] = Math.sqrt(sum / FRAME_SAMPLES);
    crossings[frame] = crossed / FRAME_SAMPLES;
  }
  assert(energies.length === crossings.length, 'measureFrames: one loudness and one crossing rate per frame');
  assert(count * FRAME_SAMPLES <= samples.length, 'measureFrames: only whole frames are measured');
  return { energies, crossings };
}

/**
 * `frames` with Silero's probabilities attached: `windows` holds one probability per 512-sample window from
 * session window `windowBase`, and the buffer's first sample is session sample `bufferStart`. A frame takes the
 * window its middle falls in; a frame not scored yet counts as no speech.
 */
export function withProbabilities(frames: Frames, windows: { readonly values: ArrayLike<number>; readonly windowBase: number }, bufferStart: number): Frames {
  assert(bufferStart >= 0, 'withProbabilities: the buffer starts at a real sample');
  const probabilities = new Float32Array(frames.energies.length);
  for (let frame = 0; frame < probabilities.length; frame += 1) {
    const middle = bufferStart + frame * FRAME_SAMPLES + Math.floor(FRAME_SAMPLES / 2);
    const index = Math.floor(middle / VAD_SAMPLES) - windows.windowBase;
    probabilities[frame] = index >= 0 && index < windows.values.length ? (windows.values[index] ?? 0) : 0;
  }
  assert(probabilities.length === frames.energies.length, 'withProbabilities: one probability per frame');
  return { ...frames, probabilities };
}

/** The loudness of each whole frame alone. */
export function frameEnergies(samples: Float32Array): Float32Array {
  return measureFrames(samples).energies;
}

/** The room's noise floor: the median loudness of the session's first 300 ms, or undefined until that much was heard. */
export function noiseFloorOf(frames: Frames): number | undefined {
  if (frames.energies.length < NOISE_FRAMES) {
    return undefined;
  }
  const first = Float32Array.from(frames.energies.subarray(0, NOISE_FRAMES)).sort();
  const median = first[Math.floor(first.length / 2)] ?? 0;
  assert(Number.isFinite(median), 'noiseFloorOf: a finite floor');
  assert(median >= 0, 'noiseFloorOf: loudness is never negative');
  return median;
}

/** The loudness above which a frame may be speech: the floor (measured, or a quantile of `energies`) times a factor, within bounds. */
export function speechThreshold(floor: number | undefined, energies: Float32Array): number {
  // The quietest tenth of the buffer is the room as it is now; the louder of the two wins, so a room that
  // grows noisier after the first 300 ms (a fan, traffic, a hum) does not start reading as speech. A
  // session that begins mid-word is held by the ceiling: speech is louder than the highest threshold.
  const sorted = Float32Array.from(energies).sort();
  const quantile = sorted.length === 0 ? 0 : (sorted[Math.floor((sorted.length - 1) * NOISE_QUANTILE)] ?? 0);
  const room = floor === undefined ? quantile : Math.max(floor, quantile);
  const threshold = Math.max(DICTATION_LIMITS.speechRmsMin, Math.min(DICTATION_LIMITS.speechRmsMax, room * DICTATION_LIMITS.noiseFloorFactor));
  assert(threshold >= DICTATION_LIMITS.speechRmsMin, 'speechThreshold: never under the absolute floor');
  assert(threshold <= DICTATION_LIMITS.speechRmsMax, 'speechThreshold: never over the ceiling');
  return threshold;
}

/** Which frames are speech (1) and which are not (0), with onset, release level and hangover. */
export function speechMask(frames: Frames, threshold: number): Uint8Array {
  assert(threshold > 0, 'speechMask: a positive threshold');
  const { energies, crossings, probabilities } = frames;
  assert(probabilities === undefined || probabilities.length === energies.length, 'speechMask: one probability per frame');
  const mask = new Uint8Array(energies.length);
  const release = threshold * DICTATION_LIMITS.releaseFactor;
  let speaking = false;
  let run = 0;
  let quiet = 0;
  for (let frame = 0; frame < energies.length; frame += 1) {
    const energy = energies[frame] ?? 0;
    const probability = probabilities?.[frame];
    // With Silero: speech starts where the network says speech and the frame is louder than the room (so
    // a far-away voice or a quiet radio never starts it), and lasts while the network stays above its lower
    // level. Without it: speech starts only on voiced frames (every word has a vowel, and noise, however
    // loud, never crosses zero like one) and lasts while the frames stay over the release level.
    const voiceLike = (crossings[frame] ?? 1) <= DICTATION_LIMITS.crossingRateMax;
    const candidate = probability === undefined ? energy > threshold && voiceLike : probability >= DICTATION_LIMITS.vadStartProbability && energy > threshold;
    const keeps = probability === undefined ? energy > release : probability >= DICTATION_LIMITS.vadKeepProbability;
    if (speaking) {
      quiet = keeps ? 0 : quiet + 1;
      if (quiet > DICTATION_LIMITS.hangoverFrames) {
        speaking = false;
        run = 0;
        // The hangover frames were quiet after all.
        mask.fill(0, frame - DICTATION_LIMITS.hangoverFrames, frame);
      } else {
        mask[frame] = 1;
      }
      continue;
    }
    run = candidate ? run + 1 : 0;
    if (run >= DICTATION_LIMITS.onsetFrames) {
      speaking = true;
      quiet = 0;
      mask.fill(1, frame - run + 1, frame + 1);
    }
  }
  assert(mask.length === energies.length, 'speechMask: one mark per frame');
  return mask;
}

/** The speech frames between `from` and `to` (frame indexes, `to` exclusive). */
export function speechFrames(mask: Uint8Array, from = 0, to = mask.length): number {
  assert(from >= 0, 'speechFrames: from a real frame');
  assert(to <= mask.length, 'speechFrames: within the frames');
  let count = 0;
  for (let frame = from; frame < to; frame += 1) {
    count += mask[frame] ?? 0;
  }
  return count;
}

/** What the detector heard in a window, for the hallucination filter (hallucinations.ts). */
export interface SpeechEvidence {
  readonly speechMs: number;
  /** The mean loudness of the window's speech frames. */
  readonly speechRms: number;
  /** Speech frames over all frames of the decoded window, 0 to 1. */
  readonly speechRatio: number;
  /** Silero's mean probability over the window's speech frames; 1 when the detector does not run. */
  readonly meanProbability: number;
  /** The speech begins inside the window, after quiet: an audible onset, which continuous noise never has. */
  readonly onset: boolean;
}

/** A window to decode: samples `from` to `to` of the buffer, trimmed to its speech plus padding. */
export interface DecodeWindow {
  readonly from: number;
  readonly to: number;
  readonly evidence: SpeechEvidence;
}

/** What to do with the buffer now. Sample counts are from its start. */
export type ChunkPlan =
  /** Nothing finished yet: keep listening (a partial decode may still show the words). */
  | { readonly kind: 'keep' }
  /** Quiet before any speech, or a finished stretch with too little speech to decode: drop this many samples. */
  | { readonly kind: 'drop'; readonly samples: number }
  /** A finished segment: decode `window`, commit its words, then drop `samples`. */
  /** `forced`: cut at the window bound without a pause, so the next window starts inside speech. */
  | { readonly kind: 'commit'; readonly samples: number; readonly window: DecodeWindow; readonly forced: boolean };

/**
 * The plan for a buffer of `length` samples. `phase` is `final` when the microphone has closed: then
 * everything left is one last segment, or nothing. `floor` is the session's measured noise floor.
 */
export function planChunk(frames: Frames, length: number, phase: 'live' | 'final', floor: number | undefined): ChunkPlan {
  assert(frames.energies.length * FRAME_SAMPLES <= length, 'planChunk: the frames cover the buffer');
  assert(length <= samplesOf(DICTATION_LIMITS.windowMsMax), 'planChunk: the buffer stays within the window');
  const mask = speechMask(frames, speechThreshold(floor, frames.energies));
  const firstSpeech = mask.indexOf(1);
  if (firstSpeech < 0) {
    if (phase === 'final') {
      return length === 0 ? { kind: 'keep' } : { kind: 'drop', samples: length };
    }
    return length > IDLE_SAMPLES_MAX ? { kind: 'drop', samples: length - PADDING_SAMPLES } : { kind: 'keep' };
  }
  if (phase === 'final') {
    return finished(frames, mask, length, 'pause');
  }
  const leading = firstSpeech * FRAME_SAMPLES - PADDING_SAMPLES;
  if (leading > IDLE_SAMPLES_MAX) {
    return { kind: 'drop', samples: leading }; // A long quiet start: dropped so the window holds speech.
  }
  const pause = lastPauseCut(mask, firstSpeech);
  if (pause !== undefined) {
    return finished(frames, mask, pause * FRAME_SAMPLES, 'pause');
  }
  if (length >= FORCE_SAMPLES) {
    return finished(frames, mask, quietestFrame(frames.energies, Math.floor(frames.energies.length / 2)) * FRAME_SAMPLES, 'bound');
  }
  return { kind: 'keep' };
}

/** The window a partial decode reads now: the buffer's speech so far, or undefined while there is too little. */
export function planPartial(frames: Frames, length: number, floor: number | undefined): DecodeWindow | undefined {
  const mask = speechMask(frames, speechThreshold(floor, frames.energies));
  const window = speechWindow(frames, mask, length);
  if (window === undefined) {
    return undefined;
  }
  // The phrase being spoken, capped at its last 12 s: a shorter window is a shorter decode.
  const from = Math.max(window.from, window.to - samplesOf(DICTATION_LIMITS.interimWindowMsMax));
  assert(from < window.to, 'planPartial: the capped window has audio');
  return { ...window, from };
}

// The first `cut` samples are done: commit their speech, or drop them when there is too little of it.
function finished(frames: Frames, mask: Uint8Array, cut: number, at: 'pause' | 'bound'): ChunkPlan {
  assert(cut > 0, 'finished: a cut moves forward');
  const window = speechWindow(frames, mask, cut);
  return window === undefined ? { kind: 'drop', samples: cut } : { kind: 'commit', samples: cut, window, forced: at === 'bound' };
}

// The span from the first to the last speech frame before `cut`, padded, with what the detector heard in it.
function speechWindow(frames: Frames, mask: Uint8Array, cut: number): DecodeWindow | undefined {
  const cutFrame = Math.min(mask.length, Math.floor(cut / FRAME_SAMPLES));
  const first = mask.subarray(0, cutFrame).indexOf(1);
  const last = mask.subarray(0, cutFrame).lastIndexOf(1);
  if (first < 0 || speechFrames(mask, 0, cutFrame) < SPEECH_FRAMES_MIN) {
    return undefined;
  }
  const from = Math.max(0, first * FRAME_SAMPLES - PADDING_SAMPLES);
  const to = Math.min(cut, (last + 1) * FRAME_SAMPLES + PADDING_SAMPLES);
  let loudness = 0;
  let spoken = 0;
  let likelihood = 0;
  for (let frame = first; frame <= last; frame += 1) {
    if (mask[frame] === 1) {
      loudness += frames.energies[frame] ?? 0;
      likelihood += frames.probabilities?.[frame] ?? 1;
      spoken += 1;
    }
  }
  const windowFrames = Math.max(1, Math.ceil((to - from) / FRAME_SAMPLES));
  assert(from < to, 'speechWindow: a window has audio');
  assert(to <= cut, 'speechWindow: the window ends by the cut');
  const evidence: SpeechEvidence = {
    speechMs: msOf(spoken * FRAME_SAMPLES),
    speechRms: loudness / spoken,
    speechRatio: Math.min(1, spoken / windowFrames),
    meanProbability: likelihood / spoken,
    // Speech that starts at the buffer's first frame began before it: no onset was heard here.
    onset: first > 0,
  };
  return { from, to, evidence };
}

// The frame in the middle of the last run of at least PAUSE_FRAMES quiet frames after speech. A pause
// still running at the end of the buffer counts: the person has stopped talking, which is exactly when
// their words should land.
function lastPauseCut(mask: Uint8Array, firstSpeech: number): number | undefined {
  let runEnd = mask.length;
  for (let frame = mask.length - 1; frame > firstSpeech; frame -= 1) {
    if (mask[frame] === 1) {
      runEnd = frame;
      continue;
    }
    if (runEnd - frame >= PAUSE_FRAMES && mask[frame - 1] === 1) {
      const middle = frame + Math.floor((runEnd - frame) / 2);
      assert(middle > firstSpeech, 'lastPauseCut: the cut follows speech');
      return middle;
    }
  }
  return undefined;
}

/** The quietest frame at or after `fromFrame`: where a forced cut splits the fewest words. */
export function quietestFrame(energies: Float32Array, fromFrame: number): number {
  assert(fromFrame >= 0, 'quietestFrame: from a real frame');
  assert(fromFrame < energies.length, 'quietestFrame: within the frames');
  let best = fromFrame;
  for (let frame = fromFrame; frame < energies.length; frame += 1) {
    if ((energies[frame] ?? Infinity) < (energies[best] ?? Infinity)) {
      best = frame;
    }
  }
  // A cut at frame 0 would commit nothing and loop; the forced cut always moves forward.
  return Math.max(1, best);
}

/** `samples` at `fromHz` as `toHz`, by linear interpolation: enough for speech, which carries nothing above 8 kHz that Whisper reads. */
export function resampleLinear(samples: Float32Array, fromHz: number, toHz: number): Float32Array {
  assert(fromHz > 0, 'resampleLinear: a positive source rate');
  assert(toHz > 0, 'resampleLinear: a positive target rate');
  const length = Math.floor((samples.length * toHz) / fromHz);
  const output = new Float32Array(length);
  const step = fromHz / toHz;
  for (let index = 0; index < length; index += 1) {
    const position = index * step;
    const before = Math.floor(position);
    const weight = position - before;
    const first = samples[before] ?? 0;
    const second = samples[before + 1] ?? first;
    output[index] = first + (second - first) * weight;
  }
  return output;
}

/**
 * The session's uncommitted audio: one preallocated array of the window bound. `append` takes what
 * fits and says how much; the caller commits (or drops) before appending the rest, so the bound is
 * never passed and no audio is silently lost.
 */
export class SpeechBuffer {
  private readonly samples = new Float32Array(samplesOf(DICTATION_LIMITS.windowMsMax));
  private filled = 0;

  get length(): number {
    return this.filled;
  }

  get capacity(): number {
    return this.samples.length;
  }

  /** Copies as much of `chunk` as fits and returns how many samples were taken. */
  append(chunk: Float32Array): number {
    const taken = Math.min(chunk.length, this.samples.length - this.filled);
    this.samples.set(chunk.subarray(0, taken), this.filled);
    this.filled += taken;
    assert(this.filled <= this.samples.length, 'SpeechBuffer.append: within the window');
    assert(taken >= 0, 'SpeechBuffer.append: never takes a negative count');
    return taken;
  }

  /** A copy of samples `from` to `to`, for the worker (a transfer would detach the buffer itself). */
  copy(to: number, from = 0): Float32Array {
    assert(from >= 0, 'SpeechBuffer.copy: from a real sample');
    assert(to <= this.filled, 'SpeechBuffer.copy: only what was appended');
    return this.samples.slice(from, to);
  }

  /** The frames held now. */
  frames(): Frames {
    return measureFrames(this.samples.subarray(0, this.filled));
  }

  /** Forgets the first `count` samples and moves the rest to the front. */
  drop(count: number): void {
    assert(count >= 0, 'SpeechBuffer.drop: a count is never negative');
    assert(count <= this.filled, 'SpeechBuffer.drop: only what was appended');
    this.samples.copyWithin(0, count, this.filled);
    this.filled -= count;
  }

  clear(): void {
    this.filled = 0;
  }
}
