// The messages between the composer and the Whisper worker (src/features/ai/voice/whisperWorker.ts).
// A worker message is a boundary like IPC (docs/contracts.md): each side parses what it receives,
// so a worker built from a different version, or a fault in the runtime, fails loudly at the edge
// instead of reaching the box as words.
import { assert } from '../../core/assert';
import { count, record, text } from '../../core/boundary';
import { DICTATION_LIMITS, samplesOf } from './dictationLimits';
import { parseWhisperLanguage, type DictationLanguage, type WhisperLanguage } from './whisperModels';

/** The runtimes the worker may run the model on, in the order it tries them. */
export const WHISPER_DEVICES = ['wasm', 'webgpu'] as const;
export type WhisperDevice = (typeof WHISPER_DEVICES)[number];

/** Why loading or a decode failed, as the worker can tell (dictationEngine.ts turns it into a failure). */
export const WORKER_FAILURES = ['backendUnavailable', 'modelMissing', 'modelCorrupt', 'outOfMemory', 'failed'] as const;
export type WorkerFailure = (typeof WORKER_FAILURES)[number];

export type ToWorker =
  | {
      readonly kind: 'load';
      /** `stacki-model://whisper/<id>/<revision>/`: where the model's files are served. */
      readonly modelBase: string;
      readonly devices: readonly WhisperDevice[];
      readonly threads: number;
    }
  | { readonly kind: 'transcribe'; readonly requestId: number; readonly audio: Float32Array; readonly language: DictationLanguage };

export type FromWorker =
  | { readonly kind: 'loaded'; readonly device: WhisperDevice; readonly loadMs: number }
  | { readonly kind: 'loadFailed'; readonly failure: WorkerFailure; readonly detail: string }
  | { readonly kind: 'transcribed'; readonly requestId: number; readonly text: string; readonly language: WhisperLanguage; readonly decodeMs: number }
  | { readonly kind: 'transcribeFailed'; readonly requestId: number; readonly failure: WorkerFailure; readonly detail: string };

/** The requests one session can number: a decode every partial interval for the session bound fits easily. */
export const REQUEST_ID_MAX = 1_000_000;

const MODEL_BASE = /^stacki-model:\/\/whisper\/(turbo|small|base)\/[0-9a-f]{40}\/$/u;

function device(input: unknown): WhisperDevice {
  const found = WHISPER_DEVICES.find((candidate) => candidate === input);
  if (found === undefined) {
    throw new Error('Expected a Whisper device');
  }
  return found;
}

function failure(input: unknown): WorkerFailure {
  const found = WORKER_FAILURES.find((candidate) => candidate === input);
  if (found === undefined) {
    throw new Error('Expected a worker failure');
  }
  return found;
}

function requestId(input: unknown): number {
  const value = count(input);
  if (value > REQUEST_ID_MAX) {
    throw new Error('Expected a request id within the bound');
  }
  return value;
}

// A failure's detail is for the log: bounded, never markup.
function detail(input: unknown): string {
  const value = text(input).slice(0, DICTATION_LIMITS.detailCharsMax);
  assert(value.length <= DICTATION_LIMITS.detailCharsMax, 'detail: bounded');
  return value;
}

function language(input: unknown): DictationLanguage {
  if (input === 'auto') {
    return 'auto';
  }
  const parsed = parseWhisperLanguage(input);
  if (parsed === undefined) {
    throw new Error('Expected a dictation language');
  }
  return parsed;
}

/** What the worker accepts. Audio is bounded by the decode window. */
export function parseToWorker(input: unknown): ToWorker {
  const source = record(input);
  switch (source['kind']) {
    case 'load': {
      const modelBase = text(source['modelBase']);
      if (!MODEL_BASE.test(modelBase)) {
        throw new Error('Expected a model address');
      }
      const devices = source['devices'];
      if (!Array.isArray(devices) || devices.length === 0 || devices.length > WHISPER_DEVICES.length) {
        throw new Error('Expected devices');
      }
      const threads = count(source['threads']);
      if (threads < 1 || threads > DICTATION_LIMITS.threadsMax) {
        throw new Error('Expected threads within the bound');
      }
      return {
        kind: 'load',
        modelBase,
        devices: devices.map(device),
        threads,
      };
    }
    case 'transcribe': {
      const audio = source['audio'];
      if (!(audio instanceof Float32Array)) {
        throw new Error('Expected audio samples');
      }
      if (audio.length === 0 || audio.length > samplesOf(DICTATION_LIMITS.windowMsMax)) {
        throw new Error('Expected audio within the window');
      }
      return { kind: 'transcribe', requestId: requestId(source['requestId']), audio, language: language(source['language']) };
    }
    default:
      throw new Error('Expected a worker request');
  }
}

/** What the page accepts from the worker. Text is bounded per segment. */
export function parseFromWorker(input: unknown): FromWorker {
  const source = record(input);
  switch (source['kind']) {
    case 'loaded':
      return { kind: 'loaded', device: device(source['device']), loadMs: count(source['loadMs']) };
    case 'loadFailed':
      return { kind: 'loadFailed', failure: failure(source['failure']), detail: detail(source['detail']) };
    case 'transcribed': {
      const words = text(source['text']);
      if (words.length > DICTATION_LIMITS.segmentCharsMax) {
        throw new Error('Expected a segment within the bound');
      }
      const spoken = parseWhisperLanguage(source['language']);
      if (spoken === undefined) {
        throw new Error('Expected the spoken language');
      }
      return { kind: 'transcribed', requestId: requestId(source['requestId']), text: words, language: spoken, decodeMs: count(source['decodeMs']) };
    }
    case 'transcribeFailed':
      return { kind: 'transcribeFailed', requestId: requestId(source['requestId']), failure: failure(source['failure']), detail: detail(source['detail']) };
    default:
      throw new Error('Expected a worker reply');
  }
}

/** The worker's failure for a runtime error: its message names what went wrong, in the runtime's words. */
export function classifyWorkerError(message: string): WorkerFailure {
  const lower = message.toLowerCase();
  assert(lower.length === message.length || lower.length > 0, 'classifyWorkerError: lowercasing keeps the text');
  if (/out of memory|memory access out of bounds|array buffer allocation|rangeerror: (array|invalid typed array length)/u.test(lower)) {
    return 'outOfMemory';
  }
  if (/no available backend|webassembly|wasm|webgpu|backend/u.test(lower)) {
    return 'backendUnavailable';
  }
  if (/404|not found|failed to fetch|could not locate/u.test(lower)) {
    return 'modelMissing';
  }
  if (/protobuf|invalid model|failed to load model|onnx|parse/u.test(lower)) {
    return 'modelCorrupt';
  }
  return 'failed';
}

/** Whisper text as the box wants it: no leading space Whisper always writes, no bracketed non-speech tags. */
export function tidyWhisperText(raw: string): string {
  const tidy = raw
    .replace(/\[(?:[A-Z _]+|blank_audio|music|silence)\]|\((?:music|silence|applause|laughs?)\)/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  assert(tidy.length <= raw.length, 'tidyWhisperText: tidying never adds text');
  return tidy;
}
