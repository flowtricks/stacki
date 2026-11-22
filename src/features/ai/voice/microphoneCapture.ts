// One open microphone for dictation, shared by the words and the waveform. The first listener opens
// it (getUserMedia, a 16 kHz AudioContext and the capture worklet, pcmCaptureWorklet.ts); the last
// one to leave closes every track and the context, so the system's microphone indicator goes out
// the moment a session ends. Nothing is recorded: each chunk goes to the listeners and is gone.
//
// Chromium resamples the microphone to the context's rate, so a 16 kHz context hands Whisper its own
// rate directly. A platform that refuses that rate gets the device's own, resampled here.
import { assert } from '../../../../shared/core/assert';
import { err, ok, type Result } from '../../../../shared/core/result';
import { DICTATION_LIMITS } from '../../../../shared/properties/voice/dictationLimits';
import { resampleLinear } from '../../../../shared/properties/voice/speechChunker';
import type { AudioLevelProblem } from './audioLevels';
import workletURL from './pcmCaptureWorklet.ts?worker&url';
import { PCM_CAPTURE_PROCESSOR } from './pcmCaptureWorklet';

/** Hears every chunk: 16 kHz mono samples and their loudness. */
export type CaptureListener = (samples: Float32Array, rms: number) => void;

/** Listeners at once: the session's words and its waveform. */
const LISTENERS_MAX = 4;

interface OpenCapture {
  readonly stream: MediaStream;
  readonly context: AudioContext;
  readonly node: AudioWorkletNode;
  readonly onChunk: (event: MessageEvent) => void;
}

const listeners = new Set<CaptureListener>();
let opening: Promise<Result<OpenCapture, AudioLevelProblem>> | undefined;

/** Adds a listener, opening the microphone if it is the first; the result closes it for this listener. */
export async function listenToMicrophone(listener: CaptureListener): Promise<Result<() => void, AudioLevelProblem>> {
  assert(listeners.size < LISTENERS_MAX, 'listenToMicrophone: listeners are removed when sessions end');
  listeners.add(listener);
  opening ??= openCapture();
  const opened = await opening;
  if (!opened.ok) {
    listeners.delete(listener);
    opening = undefined;
    return err(opened.error);
  }
  return ok(() => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      closeCapture(opened.value);
    }
  });
}

async function openCapture(): Promise<Result<OpenCapture, AudioLevelProblem>> {
  if (typeof navigator.mediaDevices?.getUserMedia !== 'function' || typeof AudioWorkletNode !== 'function') {
    return err('unsupported');
  }
  let stream: MediaStream;
  try {
    // Echo cancellation and noise suppression help Whisper the way they help a call; gain control keeps quiet speakers audible.
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (error: unknown) {
    return err(error instanceof DOMException && error.name === 'NotAllowedError' ? 'denied' : 'failed');
  }
  try {
    const context = createContext();
    await context.audioWorklet.addModule(workletURL);
    const node = new AudioWorkletNode(context, PCM_CAPTURE_PROCESSOR, { numberOfInputs: 1, numberOfOutputs: 0 });
    const rate = context.sampleRate;
    const onChunk = (event: MessageEvent): void => {
      const data: unknown = event.data;
      const chunk = parseChunk(data);
      if (chunk === undefined) {
        return;
      }
      const samples = rate === DICTATION_LIMITS.sampleRateHz ? chunk.samples : resampleLinear(chunk.samples, rate, DICTATION_LIMITS.sampleRateHz);
      for (const listener of listeners) {
        listener(samples, chunk.rms);
      }
    };
    node.port.addEventListener('message', onChunk);
    node.port.start();
    context.createMediaStreamSource(stream).connect(node);
    return ok({ stream, context, node, onChunk });
  } catch {
    stopTracks(stream);
    return err('failed');
  }
}

function createContext(): AudioContext {
  try {
    return new AudioContext({ sampleRate: DICTATION_LIMITS.sampleRateHz });
  } catch {
    return new AudioContext(); // The device's own rate; chunks are resampled on arrival.
  }
}

// A worklet message: its samples and their loudness. Anything else is dropped (never words).
function parseChunk(data: unknown): { readonly samples: Float32Array; readonly rms: number } | undefined {
  if (typeof data !== 'object' || data === null || !('samples' in data) || !('rms' in data)) {
    return undefined;
  }
  const { samples, rms } = data;
  if (!(samples instanceof Float32Array) || typeof rms !== 'number' || !Number.isFinite(rms)) {
    return undefined;
  }
  return samples.length > 0 && samples.length <= DICTATION_LIMITS.captureChunkSamples * 4 ? { samples, rms } : undefined;
}

function closeCapture(capture: OpenCapture): void {
  opening = undefined;
  capture.node.port.removeEventListener('message', capture.onChunk);
  capture.node.port.close();
  capture.node.disconnect();
  stopTracks(capture.stream);
  void capture.context.close().catch(() => undefined);
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}
