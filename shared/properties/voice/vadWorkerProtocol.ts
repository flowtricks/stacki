// The messages between the composer and the voice-detector worker (src/features/ai/voice/vadWorker.ts),
// parsed on both sides like any boundary (docs/contracts.md). The worker runs Silero VAD over 512-sample
// windows (32 ms at 16 kHz) and answers one speech probability per window, keeping the model's state and
// any leftover samples between messages of one session.
import { assert } from '../../core/assert';
import { count, record, text } from '../../core/boundary';
import { DICTATION_LIMITS } from './dictationLimits';

/** Samples per Silero window at 16 kHz: the only size the v5 model accepts. */
export const VAD_WINDOW_SAMPLES = 512;
/** Samples one `frames` message may carry: a second of audio, ten capture chunks. */
const VAD_MESSAGE_SAMPLES_MAX = DICTATION_LIMITS.sampleRateHz;
const VAD_MODEL_URL = /^stacki-model:\/\/whisper\/(turbo|small|base)\/[0-9a-f]{40}\/vad\/silero_vad\.onnx$/u;

export type ToVad =
  | { readonly kind: 'load'; readonly modelURL: string }
  /** A new session: the model's state and the leftover samples start over. */
  | { readonly kind: 'reset' }
  | { readonly kind: 'frames'; readonly id: number; readonly audio: Float32Array };

export type FromVad =
  | { readonly kind: 'loaded' }
  | { readonly kind: 'loadFailed'; readonly detail: string }
  /** One probability per whole window completed by message `id`, in order; `windowIndex` is the first one's index in the session. */
  | { readonly kind: 'probabilities'; readonly id: number; readonly windowIndex: number; readonly values: Float32Array };

function probabilities(input: unknown): Float32Array {
  if (!(input instanceof Float32Array)) {
    throw new Error('Expected probabilities');
  }
  if (input.length > Math.ceil(VAD_MESSAGE_SAMPLES_MAX / VAD_WINDOW_SAMPLES) + 1) {
    throw new Error('Expected probabilities within the bound');
  }
  for (const value of input) {
    if (!(value >= 0 && value <= 1)) {
      throw new Error('Expected probabilities between 0 and 1');
    }
  }
  return input;
}

export function parseToVad(input: unknown): ToVad {
  const source = record(input);
  switch (source['kind']) {
    case 'load': {
      const modelURL = text(source['modelURL']);
      if (!VAD_MODEL_URL.test(modelURL)) {
        throw new Error('Expected the pinned voice detector address');
      }
      return { kind: 'load', modelURL };
    }
    case 'reset':
      return { kind: 'reset' };
    case 'frames': {
      const audio = source['audio'];
      if (!(audio instanceof Float32Array)) {
        throw new Error('Expected audio samples');
      }
      if (audio.length === 0 || audio.length > VAD_MESSAGE_SAMPLES_MAX) {
        throw new Error('Expected audio within the bound');
      }
      return { kind: 'frames', id: count(source['id']), audio };
    }
    default:
      throw new Error('Expected a voice detector request');
  }
}

export function parseFromVad(input: unknown): FromVad {
  const source = record(input);
  switch (source['kind']) {
    case 'loaded':
      return { kind: 'loaded' };
    case 'loadFailed':
      return { kind: 'loadFailed', detail: text(source['detail']).slice(0, DICTATION_LIMITS.detailCharsMax) };
    case 'probabilities': {
      const values = probabilities(source['values']);
      const windowIndex = count(source['windowIndex']);
      assert(Number.isSafeInteger(windowIndex), 'parseFromVad: a whole window index');
      return { kind: 'probabilities', id: count(source['id']), windowIndex, values };
    }
    default:
      throw new Error('Expected a voice detector reply');
  }
}
