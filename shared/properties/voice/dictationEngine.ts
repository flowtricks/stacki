// The on-device dictation engine as one visible state machine (AGENTS.md §1), so the microphone
// button, the setup dialog and Settings cannot disagree about what the engine is doing:
//
//   notInstalled ──download──▶ downloading ──installed──▶ ready
//   ready ──listen (cold)──▶ loadingModel ──loaded──▶ listening
//   ready ──listen (warm)────────────────────────────▶ listening ──stop──▶ transcribing ──done──▶ ready
//   any ──failed──▶ error ──reset──▶ ready | notInstalled
//
// `reduceEngine` is pure: it takes a state and an event and returns the next state. The listening
// session itself (hold or latch, silence, restarts) stays in voiceSession.ts; this machine only says
// what the engine underneath is doing, for the person to see.
import { assert } from '../../core/assert';
import { DICTATION_LIMITS } from './dictationLimits';
import type { DownloadFailure, DownloadOutcome, ModelInstall } from './dictationModel';

/** Why the engine stopped working. Each has its own sentence (speechEngine.ts, classifyRecognitionError). */
export const ENGINE_FAILURES = [
  /** Neither WebGPU nor WebAssembly could run the model. */
  'backendUnavailable',
  /** The model's files are not on this computer (removed while the app ran, or never downloaded). */
  'modelMissing',
  /** The files are there but the runtime could not read them. */
  'modelCorrupt',
  /** Loading or one decode took longer than its bound: the worker was ended. */
  'engineStuck',
  /** The worker ended by itself (out of memory, a crash in the runtime). */
  'engineCrashed',
  /** This computer decodes slower than speech arrives: the smaller model is offered. */
  'tooSlow',
] as const;
export type EngineFailure = (typeof ENGINE_FAILURES)[number];

export type DictationEngineState =
  | { readonly kind: 'notInstalled' }
  | { readonly kind: 'downloading'; readonly receivedBytes: number; readonly totalBytes: number }
  | { readonly kind: 'ready' }
  | { readonly kind: 'loadingModel' }
  | { readonly kind: 'listening' }
  | { readonly kind: 'transcribing' }
  | { readonly kind: 'error'; readonly failure: EngineFailure | { readonly download: DownloadFailure } };

export type DictationEngineEvent =
  /** What the main process says is on disk. */
  | { readonly kind: 'install'; readonly install: ModelInstall }
  | { readonly kind: 'downloadProgress'; readonly receivedBytes: number; readonly totalBytes: number }
  | { readonly kind: 'downloadEnded'; readonly outcome: DownloadOutcome }
  /** A session starts; `model` says whether the worker already holds the model. */
  | { readonly kind: 'listen'; readonly model: 'loaded' | 'cold' }
  | { readonly kind: 'loaded' }
  /** The microphone closed; the last words are being decoded. */
  | { readonly kind: 'stop' }
  /** The final words landed, or the session was cancelled. */
  | { readonly kind: 'done' }
  | { readonly kind: 'failed'; readonly failure: EngineFailure }
  /** The person dismissed an error: back to what the disk says. */
  | { readonly kind: 'reset'; readonly install: ModelInstall };

export const ENGINE_NOT_INSTALLED: DictationEngineState = { kind: 'notInstalled' };

/** Whether the engine can start a session now (the model is installed and nothing else runs). */
export function canListen(state: DictationEngineState): boolean {
  return state.kind === 'ready';
}

/** Whether a session is running: the microphone is open or its last words are being decoded. */
export function isEngineBusy(state: DictationEngineState): boolean {
  return state.kind === 'loadingModel' || state.kind === 'listening' || state.kind === 'transcribing';
}

export function reduceEngine(state: DictationEngineState, event: DictationEngineEvent): DictationEngineState {
  const next = transition(state, event);
  if (next.kind === 'downloading') {
    assert(next.receivedBytes <= next.totalBytes, 'reduceEngine: a download never passes its total');
    assert(next.totalBytes <= DICTATION_LIMITS.downloadBytesMax, 'reduceEngine: a download stays within the bound');
  }
  assert(event.kind !== 'failed' || next.kind === 'error', 'reduceEngine: a failure always shows');
  return next;
}

function transition(state: DictationEngineState, event: DictationEngineEvent): DictationEngineState {
  switch (event.kind) {
    case 'install':
      // A session in progress keeps its state: the disk report does not interrupt it.
      return isEngineBusy(state) ? state : stateOfInstall(event.install, state);
    case 'downloadProgress':
      return isEngineBusy(state)
        ? state
        : { kind: 'downloading', receivedBytes: Math.min(event.receivedBytes, event.totalBytes), totalBytes: event.totalBytes };
    case 'downloadEnded':
      if (event.outcome.kind === 'installed') {
        return isEngineBusy(state) ? state : { kind: 'ready' };
      }
      // A cancel is the person's own choice, not an error to explain.
      return event.outcome.failure === 'cancelled' ? ENGINE_NOT_INSTALLED : { kind: 'error', failure: { download: event.outcome.failure } };
    case 'listen':
      if (state.kind !== 'ready') {
        return state;
      }
      return event.model === 'loaded' ? { kind: 'listening' } : { kind: 'loadingModel' };
    case 'loaded':
      return state.kind === 'loadingModel' ? { kind: 'listening' } : state;
    case 'stop':
      // Stopped while the model was still loading: nothing was heard, so nothing is left to decode.
      if (state.kind === 'loadingModel') {
        return { kind: 'ready' };
      }
      return state.kind === 'listening' ? { kind: 'transcribing' } : state;
    case 'done':
      return isEngineBusy(state) ? { kind: 'ready' } : state;
    case 'failed':
      return { kind: 'error', failure: event.failure };
    case 'reset':
      return state.kind === 'error' ? stateOfInstall(event.install, ENGINE_NOT_INSTALLED) : state;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

// What the disk report means when nothing runs. A download the main process reports is shown as one.
function stateOfInstall(install: ModelInstall, state: DictationEngineState): DictationEngineState {
  switch (install.kind) {
    case 'installed':
      return { kind: 'ready' };
    case 'downloading':
      return { kind: 'downloading', receivedBytes: install.receivedBytes, totalBytes: install.totalBytes };
    case 'notInstalled':
    case 'partial':
      // An error the person has not dismissed stays on screen until they do.
      return state.kind === 'error' ? state : ENGINE_NOT_INSTALLED;
    default: {
      const exhaustive: never = install;
      return exhaustive;
    }
  }
}

/**
 * Decode time over audio time. Whisper's cost is nearly fixed per window (its encoder always reads
 * 30 seconds), so a short window would read as slow on any machine: the audio counts as at least
 * `rtfAudioMsMin`.
 */
export function realTimeFactor(decodeMs: number, audioMs: number): number {
  assert(decodeMs >= 0, 'realTimeFactor: a decode takes no negative time');
  assert(audioMs >= 0, 'realTimeFactor: audio has no negative length');
  return decodeMs / Math.max(audioMs, DICTATION_LIMITS.rtfAudioMsMin);
}

/** Whether a measured decode says this computer cannot keep up with speech on this model. */
export function isTooSlow(decodeMs: number, audioMs: number): boolean {
  const factor = realTimeFactor(decodeMs, audioMs);
  assert(Number.isFinite(factor), 'isTooSlow: the factor is finite');
  return factor > DICTATION_LIMITS.realTimeFactorMax;
}

/** The worker's threads: at most `threadsMax`, one core always left for the interface, at least one. */
export function workerThreads(cores: number, crossOriginIsolated: 'isolated' | 'shared'): number {
  assert(Number.isSafeInteger(cores), 'workerThreads: a whole number of cores');
  // Threads need SharedArrayBuffer, which a window that is not cross-origin isolated does not have.
  if (crossOriginIsolated === 'shared') {
    return 1;
  }
  const threads = Math.max(1, Math.min(DICTATION_LIMITS.threadsMax, cores - 1));
  assert(threads <= DICTATION_LIMITS.threadsMax, 'workerThreads: within the bound');
  return threads;
}

/** Whole percent of a download, 0 to 100, for the progress bar and its label. */
export function downloadPercent(receivedBytes: number, totalBytes: number): number {
  assert(receivedBytes >= 0, 'downloadPercent: received bytes are never negative');
  assert(totalBytes > 0, 'downloadPercent: a download has a size');
  return Math.min(100, Math.floor((receivedBytes * 100) / totalBytes));
}
