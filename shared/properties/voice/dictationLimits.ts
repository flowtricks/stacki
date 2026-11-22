// The bounds of on-device dictation (AGENTS.md §10), beside the code that enforces them. Audio is
// 16 kHz mono float samples from the microphone; Whisper reads at most 30 seconds at a time, so
// every audio number here caps one decode window, one partial pass or one session's buffer.
// The download numbers cap what the main process will fetch and write for the model.
import { assert } from '../../core/assert';

export const DICTATION_LIMITS = {
  /** Samples per second of the audio Whisper reads: its feature extractor is fixed at 16 kHz. */
  sampleRateHz: 16_000,
  /** The longest window one decode reads; Whisper's encoder is built for exactly 30 seconds. */
  windowMsMax: 30_000,
  /** The shortest gap between two interim decodes of the words being spoken. Whisper is not a streaming model:
   *  each interim is a whole decode, so the real cadence is this or the last decode's cost, whichever is longer. */
  interimIntervalMsMin: 800,
  /** Between interim decodes the worker rests at least this share of the last decode's time, so dictation takes
   *  at most about two thirds of one core while the person speaks. */
  interimRestShare: 0.5,
  /** The most recent speech an interim decode reads: the phrase being spoken, never a long monologue. */
  interimWindowMsMax: 12_000,
  /** Audio shorter than this is not decoded for a partial: too little for Whisper to say anything useful. */
  partialAudioMsMin: 600,
  /** A window this long is committed at its best pause even without a long one, so text keeps landing. */
  commitAudioMsMin: 8_000,
  /** Quiet this long after speech is a pause: the audio before it is a finished segment. */
  pauseMsMin: 550,
  /** One energy frame of the voice detector: 30 ms, the usual unit of speech activity detection. */
  frameMs: 30,
  /** Frames over this loudness (root mean square, full scale = 1) count as speech before adapting to the room. */
  speechRmsMin: 0.012,
  /** The threshold never rises above this, whatever the floor: a buffer of nothing but speech has no quiet frames to measure the room by. */
  speechRmsMax: 0.06,
  /** The detector's threshold is this multiple of the room's noise floor, so a noisy room does not read as speech. */
  noiseFloorFactor: 3,
  /** Speech shorter than this in a window is not decoded: Whisper invents words ("Thank you.") for clicks, breaths and silence. */
  speechMsMin: 300,
  /** Quiet kept on each side of the speech in a decoded window: enough for a first and last syllable, too little for Whisper to fill. */
  speechPaddingMs: 150,
  /** The start of each session, assumed to be the room before the first word, is where its noise floor is measured. */
  noiseMeasureMs: 300,
  /** Silero VAD probability at which speech starts, and the lower one it must stay above to continue (hysteresis). */
  vadStartProbability: 0.5,
  vadKeepProbability: 0.35,
  /** A short result (at most this many words) needs this share of speech in its window and this mean probability, whatever its words. */
  shortResultWordsMax: 4,
  shortResultSpeechRatioMin: 0.6,
  shortResultProbabilityMin: 0.7,
  /** Zero crossings per sample above which a frame is noise rather than voice (white noise is near 0.5, voiced speech under 0.15). */
  crossingRateMax: 0.35,
  /** Hysteresis: once speaking, frames stay speech down to this share of the threshold. */
  releaseFactor: 0.6,
  /** Hysteresis: frames of quiet tolerated inside speech before it ends (120 ms). */
  hangoverFrames: 4,
  /** Frames over the threshold in a row before speech starts (90 ms): a click is shorter. */
  onsetFrames: 3,
  /** Samples one capture message from the worklet carries: 100 ms, so the main thread is woken ten times a second. */
  captureChunkSamples: 1_600,
  /** Characters of one decoded segment; Whisper writes at most 448 tokens per window, far under this. */
  segmentCharsMax: 4_000,
  /** Decoded segments one session keeps for its history; the session bound ends the session long before. */
  segmentsMax: 400,
  /** How long the model stays in memory after the last session before the worker is ended. */
  workerIdleMs: 120_000,
  /** How long loading the model may take before it counts as failed (a 30 s window on a slow disk is far under). */
  modelLoadMsMax: 90_000,
  /** How long one decode may take before the worker is presumed stuck and ended. */
  decodeMsMax: 60_000,
  /** Threads the WASM backend may use; one core is always left for the interface. */
  threadsMax: 4,
  /** A real-time factor (decode time over audio time, audio counted as at least `rtfAudioMsMin`) above this is too slow. */
  realTimeFactorMax: 1.5,
  /** The audio length a real-time factor is measured against at least: Whisper's cost is nearly fixed per window. */
  rtfAudioMsMin: 4_000,
  /** Characters of a failure detail kept for the log; never shown as a whole sentence. */
  detailCharsMax: 240,
  /** Bytes the model download may write in total, whatever the manifest says: a fault upstream cannot fill the disk. */
  downloadBytesMax: 700 * 1024 * 1024,
  /** Redirects one model file may follow, each to a pinned host. */
  redirectsMax: 5,
  /** How long a model file request may wait for its headers. */
  connectMsMax: 20_000,
  /** How long a download may go without receiving a byte before it counts as stalled. */
  stallMsMax: 30_000,
  /** The most progress events per second sent to the renderer while downloading. */
  progressEventsPerSecondMax: 10,
} as const satisfies Record<string, number>;

/** Samples of `ms` milliseconds of audio, rounded down: a window never reads past what was asked for. */
export function samplesOf(ms: number): number {
  assert(Number.isFinite(ms), 'samplesOf: a finite duration');
  assert(ms >= 0, 'samplesOf: a duration is never negative');
  return Math.floor((ms * DICTATION_LIMITS.sampleRateHz) / 1000);
}

/** Milliseconds of `samples` of audio, rounded down. */
export function msOf(samples: number): number {
  assert(Number.isSafeInteger(samples), 'msOf: a whole number of samples');
  assert(samples >= 0, 'msOf: a sample count is never negative');
  return Math.floor((samples * 1000) / DICTATION_LIMITS.sampleRateHz);
}
