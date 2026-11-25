// Stacki's own dictation engine on the page's side: the Whisper worker's lifecycle, the live loop that
// turns the microphone into words, and the adapter that makes it look like the platform recognizer
// useDictation already drives (`Recognition`, voiceEnvironment.ts). So hold-to-talk, hands-free, the
// cleanup and the spoken commands work the same whichever engine hears the words.
//
// The live feel, within Whisper's limits (it decodes whole windows, it does not stream):
//   - while the person speaks, the phrase so far (its last 12 s at most) is decoded again and again and
//     shown as a draft; the next interim starts `interimIntervalMsMin` after the last one started, or after
//     the last decode plus a rest of half its time, whichever is later, so the cadence follows the
//     measured decode cost and the worker never takes more than about two thirds of a core;
//   - at a pause (speechChunker.ts) the audio before it is decoded once more and committed as final;
//   - on stop the rest is decoded and committed, then the session ends.
// Decodes run one at a time; a partial is skipped while one is in flight, so a slow computer shows
// fewer updates rather than a growing queue.
//
// Memory and CPU: the worker loads the model on the first session and is ended `workerIdleMs` after the
// last one, which frees the model (about 300 MB with the runtime). Threads are bounded by workerThreads.
import { assert } from '../../../../shared/core/assert';
import { err, ok, type Result } from '../../../../shared/core/result';
import { isTooSlow, workerThreads, type EngineFailure } from '../../../../shared/properties/voice/dictationEngine';
import { DICTATION_LIMITS, msOf, samplesOf } from '../../../../shared/properties/voice/dictationLimits';
import { engineErrorCode } from '../../../../shared/properties/voice/speechEngine';
import { filterHallucinations, withoutOverlap } from '../../../../shared/properties/voice/hallucinations';
import {
  noiseFloorOf,
  planChunk,
  planPartial,
  SpeechBuffer,
  withProbabilities,
  type DecodeWindow,
  type Frames,
} from '../../../../shared/properties/voice/speechChunker';
import { parseFromVad, VAD_WINDOW_SAMPLES, type ToVad } from '../../../../shared/properties/voice/vadWorkerProtocol';
import { barsFromSamples, silentBars, smoothBars } from '../../../../shared/properties/voice/waveform';
import { REQUEST_ID_MAX, parseFromWorker, type FromWorker, type ToWorker, type WorkerFailure } from '../../../../shared/properties/voice/whisperWorkerProtocol';
import {
  VAD_FILE_PATH,
  WHISPER_MODEL_FAST,
  WHISPER_MODELS,
  type DictationLanguage,
  type WhisperLanguage,
  type WhisperModelId,
} from '../../../../shared/properties/voice/whisperModels';
import type { AudioLevelSource } from './audioLevels';
import type { DictationStore } from './dictationStore';
import type { CaptureListener } from './microphoneCapture';
import type { Recognition } from './voiceEnvironment';

/** How often the live loop looks at the buffer. */
const TICK_MS = 200;

export interface Transcript {
  readonly text: string;
  readonly language: WhisperLanguage;
  readonly decodeMs: number;
}

/** The worker as the live loop sees it; the composer test passes a fake. */
export interface WhisperHost {
  /** Whether the model is loaded and the next session starts without loading. */
  readonly isWarm: (model: WhisperModelId) => boolean;
  readonly load: (model: WhisperModelId) => Promise<Result<void, EngineFailure>>;
  readonly transcribe: (audio: Float32Array, language: DictationLanguage) => Promise<Result<Transcript, EngineFailure>>;
  /** A session ended: the worker is ended after the idle bound unless another starts. */
  readonly release: () => void;
}

const FAILURE_OF_WORKER: { readonly [Failure in WorkerFailure]: EngineFailure } = {
  backendUnavailable: 'backendUnavailable',
  modelMissing: 'modelMissing',
  modelCorrupt: 'modelCorrupt',
  outOfMemory: 'engineCrashed',
  failed: 'engineCrashed',
};

/** The real worker host: one worker for the app, created on the first session. */
export function createWorkerHost(createWorker: () => Worker): WhisperHost {
  let worker: Worker | undefined;
  let loaded: WhisperModelId | undefined;
  let loading: { readonly model: WhisperModelId; readonly done: Promise<Result<void, EngineFailure>> } | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let nextId = 0;
  const pending = new Map<number, (result: Result<Transcript, EngineFailure>) => void>();
  let onLoad: ((message: FromWorker) => void) | undefined;

  const end = (failure: EngineFailure): void => {
    worker?.terminate();
    worker = undefined;
    loaded = undefined;
    loading = undefined;
    for (const settle of pending.values()) {
      settle(err(failure));
    }
    pending.clear();
    onLoad?.({ kind: 'loadFailed', failure: 'failed', detail: failure });
  };
  const send = (message: ToWorker): void => {
    assert(worker !== undefined, 'createWorkerHost: a message goes to a running worker');
    worker.postMessage(message, message.kind === 'transcribe' ? [message.audio.buffer] : []);
  };
  const start = (): Worker => {
    const created = createWorker();
    created.addEventListener('message', (event: MessageEvent) => {
      const data: unknown = event.data;
      const message = parseFromWorker(data);
      if (message.kind === 'loaded' || message.kind === 'loadFailed') {
        onLoad?.(message);
        return;
      }
      const settle = pending.get(message.requestId);
      pending.delete(message.requestId);
      if (message.kind === 'transcribed') {
        settle?.(ok({ text: message.text, language: message.language, decodeMs: message.decodeMs }));
      } else {
        settle?.(err(FAILURE_OF_WORKER[message.failure]));
      }
    });
    // An error event is the worker dying (out of memory, a fault in the runtime): everything waiting fails.
    created.addEventListener('error', () => end('engineCrashed'));
    return created;
  };

  const load = (model: WhisperModelId): Promise<Result<void, EngineFailure>> => {
    if (loaded === model) {
      return Promise.resolve(ok(undefined));
    }
    if (loading?.model === model) {
      return loading.done;
    }
    if (worker !== undefined) {
      end('engineCrashed'); // Another model is loaded: a fresh worker frees it.
    }
    worker = start();
    const entry = WHISPER_MODELS[model];
    const done = new Promise<Result<void, EngineFailure>>((resolve) => {
      const timer = setTimeout(() => {
        onLoad = undefined;
        end('engineStuck');
        resolve(err('engineStuck'));
      }, DICTATION_LIMITS.modelLoadMsMax);
      onLoad = (message) => {
        clearTimeout(timer);
        onLoad = undefined;
        loading = undefined;
        if (message.kind === 'loaded') {
          loaded = model;
          resolve(ok(undefined));
        } else {
          resolve(err(message.kind === 'loadFailed' ? FAILURE_OF_WORKER[message.failure] : 'engineCrashed'));
        }
      };
    });
    loading = { model, done };
    const isolated = globalThis.crossOriginIsolated ? 'isolated' : 'shared';
    send({
      kind: 'load',
      modelBase: `stacki-model://whisper/${entry.id}/${entry.revision}/`,
      // The model's own order (whisperModels.ts): WebGPU first for the standard model's half-precision encoder.
      devices: entry.devices,
      threads: workerThreads(navigator.hardwareConcurrency, isolated),
    });
    return done;
  };

  return {
    isWarm: (model) => loaded === model,
    load: (model) => {
      clearTimeout(idleTimer);
      return load(model);
    },
    transcribe: (audio, language) => {
      if (worker === undefined || loaded === undefined) {
        return Promise.resolve(err('modelMissing'));
      }
      nextId = nextId >= REQUEST_ID_MAX ? 0 : nextId + 1;
      const requestId = nextId;
      assert(pending.size < 8, 'createWorkerHost: decodes run one at a time');
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          end('engineStuck');
          resolve(err('engineStuck'));
        }, DICTATION_LIMITS.decodeMsMax);
        pending.set(requestId, (result) => {
          clearTimeout(timer);
          resolve(result);
        });
        send({ kind: 'transcribe', requestId, audio, language });
      });
    },
    release: () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (pending.size === 0 && loading === undefined) {
          worker?.terminate();
          worker = undefined;
          loaded = undefined;
        }
      }, DICTATION_LIMITS.workerIdleMs);
    },
  };
}

/** The neural voice detector's worker as a session sees it (vadWorker.ts); the composer test passes none. */
export interface VadHost {
  /** Loads Silero for the model's folder; `unavailable` falls back to the energy detector. */
  readonly load: (model: WhisperModelId) => Promise<'ready' | 'unavailable'>;
  /** A new session: the detector's state and the probabilities heard so far start over. */
  readonly reset: () => void;
  readonly push: (samples: Float32Array) => void;
  /** The probabilities from session window `windowBase` on. */
  readonly windows: () => { readonly values: readonly number[]; readonly windowBase: number };
  /** Forgets the windows before `windowIndex` (the audio before them has left the buffer). */
  readonly forget: (windowIndex: number) => void;
}

/** Windows kept at most: the 30 s decode window and a second of margin. */
const VAD_WINDOWS_MAX = Math.ceil((DICTATION_LIMITS.windowMsMax + 1_000) / ((VAD_WINDOW_SAMPLES * 1000) / DICTATION_LIMITS.sampleRateHz));

/** The real detector host: one worker for the app, loaded with the first session. */
export function createVadHost(createWorker: () => Worker): VadHost {
  let worker: Worker | undefined;
  let state: 'idle' | 'ready' | 'unavailable' = 'idle';
  let loading: Promise<'ready' | 'unavailable'> | undefined;
  let values: number[] = [];
  let windowBase = 0;
  let nextId = 0;
  let generation = 0;
  const send = (message: ToVad, transfer: Transferable[] = []): void => worker?.postMessage(message, transfer);
  return {
    load: (model) => {
      if (state !== 'idle') {
        return Promise.resolve(state);
      }
      if (loading !== undefined) {
        return loading;
      }
      const entry = WHISPER_MODELS[model];
      loading = new Promise((resolve) => {
        const created = createWorker();
        worker = created;
        const settle = (result: 'ready' | 'unavailable'): void => {
          state = result;
          loading = undefined;
          resolve(result);
        };
        created.addEventListener('error', () => settle('unavailable'));
        created.addEventListener('message', (event: MessageEvent) => {
          const data: unknown = event.data;
          const message = parseFromVad(data);
          if (message.kind === 'loaded') {
            settle('ready');
          } else if (message.kind === 'loadFailed') {
            settle('unavailable');
          } else if (message.id >>> 16 === generation) {
            // Probabilities arrive in order; one from a previous session is dropped by its generation.
            const at = message.windowIndex - windowBase;
            for (let index = 0; index < message.values.length; index += 1) {
              values[at + index] = message.values[index] ?? 0;
            }
            if (values.length > VAD_WINDOWS_MAX) {
              const extra = values.length - VAD_WINDOWS_MAX;
              values = values.slice(extra);
              windowBase += extra;
            }
          }
        });
        send({ kind: 'load', modelURL: `stacki-model://whisper/${entry.id}/${entry.revision}/${VAD_FILE_PATH}` });
      });
      return loading;
    },
    reset: () => {
      generation = (generation + 1) & 0xff;
      values = [];
      windowBase = 0;
      send({ kind: 'reset' });
    },
    push: (samples) => {
      if (state !== 'ready') {
        return;
      }
      // A message carries at most a second (vadWorkerProtocol.ts); the audio heard while the models loaded is
      // longer, and every sample must reach the detector in order, or its windows stop lining up with the buffer.
      for (let at = 0; at < samples.length; at += DICTATION_LIMITS.sampleRateHz) {
        nextId = (nextId + 1) & 0xffff;
        const copy = samples.slice(at, at + DICTATION_LIMITS.sampleRateHz);
        send({ kind: 'frames', id: generation * 0x10000 + nextId, audio: copy }, [copy.buffer]);
      }
    },
    windows: () => ({ values, windowBase }),
    forget: (windowIndex) => {
      const drop = windowIndex - windowBase;
      if (drop > 0) {
        values = values.slice(drop);
        windowBase = windowIndex;
      }
    },
  };
}

export interface WhisperSessionDeps {
  readonly host: WhisperHost;
  /** The neural voice detector; without it (or when it cannot load) the energy detector gates alone. */
  readonly vad?: VadHost;
  readonly store: DictationStore;
  /** The microphone; the composer test passes a fake that pushes chosen samples. */
  readonly listen: (listener: CaptureListener) => Promise<Result<() => void, 'unsupported' | 'denied' | 'failed'>>;
  readonly nowMs: () => number;
}

/** A recognizer backed by Whisper: one per session, as the platform's would be. */
export function createWhisperRecognition(deps: WhisperSessionDeps): Recognition {
  const buffer = new SpeechBuffer();
  let closeMicrophone: (() => void) | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;
  let decoding = false;
  let lastPartialMs = 0;
  let phase: 'idle' | 'live' | 'stopping' | 'ended' = 'idle';
  let sessionLanguage: DictationLanguage = 'auto';
  let measured = false;
  let slow = false;
  let lostSamples = 0;
  let noiseFloor: number | undefined;
  // The session sample the buffer starts at, so the detector's windows line up with the buffer's frames.
  let bufferStart = 0;
  let vadReady = false;
  // The buffer's start is inside speech after a forced cut: that speech's onset was heard before it.
  let continuing = false;
  // The last decode's cost and end, for the interim cadence.
  let lastDecodeMs = 0;
  let lastDecodeEndMs = 0;
  // The last words written, so a window decoded across a boundary does not write them twice.
  let lastFinal = '';

  const recognition: Recognition = {
    continuous: true,
    interimResults: true,
    lang: '',
    processLocally: true,
    onresult: () => undefined,
    onerror: () => undefined,
    onend: () => undefined,
    ondecoding: () => undefined,
    start: () => void begin(),
    stop: () => void finish(),
    abort: () => {
      teardown();
      if (phase !== 'ended') {
        phase = 'ended';
        deps.store.dispatch({ kind: 'done' });
        deps.host.release();
      }
    },
  };
  const model = (): WhisperModelId => deps.store.snapshot().model;
  // Read through a function: a failure inside an awaited decode ends the session behind the caller's back.
  const ended = (): boolean => phase === 'ended';
  const emit = (text: string, kind: 'partial' | 'final'): void => {
    recognition.onresult({ resultIndex: 0, results: [{ isFinal: kind === 'final', 0: { transcript: text } }] });
  };
  const fail = (failure: EngineFailure): void => {
    teardown();
    phase = 'ended';
    deps.store.dispatch({ kind: 'failed', failure });
    deps.host.release();
    recognition.onerror({ error: engineErrorCode(failure) });
    recognition.onend();
  };
  const teardown = (): void => {
    clearInterval(tick);
    tick = undefined;
    closeMicrophone?.();
    closeMicrophone = undefined;
  };

  async function begin(): Promise<void> {
    assert(phase === 'idle', 'createWhisperRecognition: a recognizer starts once');
    phase = 'live';
    sessionLanguage = deps.store.snapshot().language;
    const id = model();
    deps.store.dispatch({ kind: 'listen', model: deps.host.isWarm(id) ? 'loaded' : 'cold' });
    // The microphone opens at once, so words spoken while the model loads are kept in the buffer.
    const opened = await deps.listen(onChunk);
    if (!opened.ok) {
      teardown();
      phase = 'ended';
      deps.store.dispatch({ kind: 'done' });
      recognition.onerror({ error: opened.error === 'denied' ? 'not-allowed' : 'audio-capture' });
      recognition.onend();
      return;
    }
    if (phase !== 'live') {
      opened.value(); // Stopped while the microphone was opening.
      return;
    }
    closeMicrophone = opened.value;
    deps.vad?.reset();
    const [loaded, vad] = await Promise.all([deps.host.load(id), deps.vad?.load(id) ?? Promise.resolve('unavailable' as const)]);
    vadReady = vad === 'ready';
    if (vadReady) {
      // What was heard while the models loaded goes to the detector too, so the first word is not missed.
      deps.vad?.push(buffer.copy(buffer.length));
    }
    if (!loaded.ok) {
      fail(loaded.error);
      return;
    }
    deps.store.dispatch({ kind: 'loaded' });
    lastPartialMs = deps.nowMs();
    if (phase === 'live') {
      tick = setInterval(() => void step(), TICK_MS);
    }
  }

  function onChunk(samples: Float32Array): void {
    if (phase !== 'live') {
      return;
    }
    const taken = buffer.append(samples);
    if (vadReady) {
      deps.vad?.push(samples.subarray(0, taken));
    }
    // The buffer is cut near its bound (planChunk), so this happens only while a slow decode holds the cut back.
    lostSamples += samples.length - taken;
  }

  function currentFrames(): Frames {
    const frames = buffer.frames();
    return vadReady && deps.vad !== undefined ? withProbabilities(frames, deps.vad.windows(), bufferStart) : frames;
  }

  function dropFromBuffer(samples: number): void {
    buffer.drop(samples);
    bufferStart += samples;
    deps.vad?.forget(Math.floor(bufferStart / VAD_WINDOW_SAMPLES));
  }

  async function step(): Promise<void> {
    if (decoding || phase !== 'live') {
      return;
    }
    const frames = currentFrames();
    // The session's first 300 ms are the room before the first word: its noise floor, measured once.
    noiseFloor ??= noiseFloorOf(frames);
    const plan = planChunk(frames, buffer.length, 'live', noiseFloor);
    if (plan.kind === 'drop') {
      dropFromBuffer(plan.samples);
      continuing = false;
      return;
    }
    if (plan.kind === 'commit') {
      await decode(plan.window, { kind: 'final', drop: plan.samples });
      continuing = plan.forced;
      return;
    }
    const nowMs = deps.nowMs();
    const restMs = lastDecodeMs * DICTATION_LIMITS.interimRestShare;
    if (
      nowMs - lastPartialMs < DICTATION_LIMITS.interimIntervalMsMin ||
      nowMs - lastDecodeEndMs < restMs ||
      buffer.length < samplesOf(DICTATION_LIMITS.partialAudioMsMin)
    ) {
      return;
    }
    lastPartialMs = nowMs;
    // Only speech is decoded: no window, no words (a quiet room never shows any).
    const window = planPartial(frames, buffer.length, noiseFloor);
    if (window !== undefined) {
      await decode(window, { kind: 'partial' });
    }
  }

  // Decodes one window of speech. A final writes its words and then drops `drop` samples (the speech and
  // the pause after it); a partial only shows them. Words the detector's evidence does not support, and
  // words that repeat the end of the last final, are left out (hallucinations.ts).
  async function decode(window: DecodeWindow, kind: { readonly kind: 'partial' } | { readonly kind: 'final'; readonly drop: number }): Promise<void> {
    assert(window.to > window.from, 'decode: a window has audio');
    assert(!decoding, 'decode: one decode at a time');
    decoding = true;
    recognition.ondecoding?.(true);
    const audio = buffer.copy(window.to, window.from);
    const startedMs = deps.nowMs();
    const result = await deps.host.transcribe(audio, sessionLanguage);
    decoding = false;
    lastDecodeEndMs = deps.nowMs();
    lastDecodeMs = lastDecodeEndMs - startedMs;
    recognition.ondecoding?.(false);
    if (phase === 'ended') {
      return;
    }
    if (!result.ok) {
      fail(result.error);
      return;
    }
    // Auto-detect decides once per session, from the first words: later windows keep that language.
    if (sessionLanguage === 'auto') {
      sessionLanguage = result.value.language;
    }
    if (!measured) {
      measured = true;
      slow = model() !== WHISPER_MODEL_FAST && isTooSlow(result.value.decodeMs, msOf(audio.length));
    }
    const filtered = filterHallucinations(result.value.text, window.evidence, { language: result.value.language, continuing: continuing || bufferStart === 0 });
    // The first words of a session count as an onset: listening started there, so speech at sample 0 is the person, not a hum that was already going.
    logDropped(filtered.dropped);
    const said = filtered.text;
    if (kind.kind === 'final') {
      dropFromBuffer(kind.drop);
      const added = withoutOverlap(lastFinal, said);
      if (added !== '') {
        lastFinal = added;
        emit(added, 'final');
      }
    } else if (said !== '') {
      emit(said, 'partial');
    }
  }

  async function finish(): Promise<void> {
    if (phase !== 'live') {
      return;
    }
    phase = 'stopping';
    teardown();
    deps.store.dispatch({ kind: 'stop' });
    // A decode in flight lands first; its words are part of what was said. Bounded by decodeMsMax in the host.
    for (let waits = 0; decoding && waits < DICTATION_LIMITS.decodeMsMax / TICK_MS; waits += 1) {
      await new Promise((resolve) => setTimeout(resolve, TICK_MS / 4));
    }
    if (deps.host.isWarm(model())) {
      const plan = planChunk(currentFrames(), buffer.length, 'final', noiseFloor);
      if (plan.kind === 'commit') {
        await decode(plan.window, { kind: 'final', drop: plan.samples });
      }
    }
    if (ended()) {
      return; // The last decode failed and already said so.
    }
    phase = 'ended';
    buffer.clear();
    deps.store.dispatch({ kind: 'done' });
    deps.host.release();
    if (lostSamples > 0) {
      console.warn(`[dictation] ${msOf(lostSamples)} ms of audio did not fit the decode window`);
    }
    if (slow) {
      recognition.onerror({ error: engineErrorCode('tooSlow') });
    }
    recognition.onend();
  }

  return recognition;
}

/** Words the filter left out and why, in the console of a debug session only (`localStorage['stacki.debug.dictation'] = '1'`); never stored. */
function logDropped(dropped: readonly { readonly text: string; readonly reason: string }[]): void {
  if (dropped.length === 0) {
    return;
  }
  let enabled = false;
  try {
    enabled = localStorage.getItem('stacki.debug.dictation') === '1';
  } catch {
    enabled = false;
  }
  if (enabled) {
    console.debug('[dictation] left out', dropped);
  }
}

/** The waveform from the dictation capture's own chunks (one microphone, not a second analyser). */
export function captureAudioLevels(listen: WhisperSessionDeps['listen']): AudioLevelSource {
  return {
    start: async (barCount, onBars) => {
      let bars = silentBars(barCount);
      const bytes = new Uint8Array(DICTATION_LIMITS.captureChunkSamples);
      const opened = await listen((samples) => {
        const length = Math.min(samples.length, bytes.length);
        for (let index = 0; index < length; index += 1) {
          // The waveform's maths reads analyser bytes: 128 is silence, 0 and 255 full scale.
          bytes[index] = Math.max(0, Math.min(255, Math.round(128 + (samples[index] ?? 0) * 128)));
        }
        bars = smoothBars(bars, barsFromSamples(bytes.subarray(0, length), barCount));
        onBars(bars);
      });
      return opened;
    },
  };
}
