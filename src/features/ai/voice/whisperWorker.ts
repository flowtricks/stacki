// The Whisper worker: speech to text on this computer, off the interface thread. The page sends a
// `load` (where the model and the ONNX Runtime files are) and then one `transcribe` per window of
// audio; every message in and out is parsed (shared/properties/voice/whisperWorkerProtocol.ts).
//
// Why a worker: one decode of the base model holds a CPU core for about two seconds; on the page's
// own thread the composer would freeze while you speak. Why nothing remote: `allowRemoteModels` is
// off and the model is read from `stacki-model://` (served from the app data folder by the main
// process), and the runtime's WebAssembly comes from Stacki's own bundle (`wasmPaths`), so the worker
// never fetches from the network.
//
// Language: Transformers.js falls back to English when no language is given, which translates other
// speech instead of transcribing it. For auto-detect the worker asks the decoder for the one token
// after "start of transcript", which Whisper trains to be the language, then transcribes in it.
import { assert } from '../../../../shared/core/assert';
import { DICTATION_LIMITS } from '../../../../shared/properties/voice/dictationLimits';
import {
  classifyWorkerError,
  parseToWorker,
  tidyWhisperText,
  type FromWorker,
  type ToWorker,
  type WhisperDevice,
} from '../../../../shared/properties/voice/whisperWorkerProtocol';
import { parseWhisperLanguage, parseWhisperModelId, WHISPER_MODELS, type WhisperLanguage } from '../../../../shared/properties/voice/whisperModels';
// The ONNX Runtime build Transformers.js uses (WebAssembly with WebGPU), shipped in Stacki's bundle. Without
// these, Transformers.js would fetch the same files from a CDN.
import ortModuleURL from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import ortBinaryURL from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';

type Transformers = typeof import('@huggingface/transformers');
type Recognizer = Awaited<ReturnType<typeof loadRecognizer>>;

let recognizer: Recognizer | undefined;
// One request at a time, in the order they came: a second decode would only compete for the same core.
let queue: Promise<void> = Promise.resolve();

self.addEventListener('message', (event: MessageEvent) => {
  const data: unknown = event.data;
  const request = parseToWorker(data);
  queue = queue.then(() => handle(request));
});

function reply(message: FromWorker): void {
  self.postMessage(message);
}

async function handle(request: ToWorker): Promise<void> {
  switch (request.kind) {
    case 'load':
      await load(request);
      return;
    case 'transcribe':
      await transcribe(request);
      return;
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}

async function load(request: Extract<ToWorker, { kind: 'load' }>): Promise<void> {
  if (recognizer !== undefined) {
    reply({ kind: 'loaded', device: recognizer.device, loadMs: 0 });
    return;
  }
  const startedMs = performance.now();
  let lastError = 'no device tried';
  const transformers = await import('@huggingface/transformers');
  configure(transformers, request);
  for (const device of request.devices) {
    try {
      recognizer = await loadRecognizer(transformers, request.modelBase, device);
      reply({ kind: 'loaded', device, loadMs: Math.round(performance.now() - startedMs) });
      return;
    } catch (error: unknown) {
      lastError = String(error);
    }
  }
  reply({ kind: 'loadFailed', failure: classifyWorkerError(lastError), detail: lastError.slice(0, DICTATION_LIMITS.detailCharsMax) });
}

function configure(transformers: Transformers, request: Extract<ToWorker, { kind: 'load' }>): void {
  const { env } = transformers;
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.useBrowserCache = false;
  env.useWasmCache = false;
  // The model id below is `<model>/<revision>`, so the files resolve under `stacki-model://whisper/`.
  env.localModelPath = 'stacki-model://whisper/';
  const wasm = env.backends.onnx.wasm;
  assert(wasm !== undefined, 'configure: the ONNX backend has WebAssembly settings');
  wasm.wasmPaths = { mjs: new URL(ortModuleURL, self.location.href).href, wasm: new URL(ortBinaryURL, self.location.href).href };
  wasm.numThreads = request.threads;
  wasm.proxy = false;
}

async function loadRecognizer(transformers: Transformers, modelBase: string, device: WhisperDevice) {
  const modelId = modelBase.replace('stacki-model://whisper/', '').replace(/\/$/u, '');
  assert(/^(turbo|small|base)\/[0-9a-f]{40}$/u.test(modelId), 'loadRecognizer: a pinned model id');
  const pipeline = await transformers.pipeline('automatic-speech-recognition', modelId, {
    device,
    // The precisions the manifest pins (whisperModels.ts); any other is not on disk.
    dtype: {
      encoder_model: WHISPER_MODELS[parseWhisperModelId(modelId.split('/')[0])].encoder,
      decoder_model_merged: WHISPER_MODELS[parseWhisperModelId(modelId.split('/')[0])].decoder,
    },
  });
  return { pipeline, device, Tensor: transformers.Tensor };
}

async function transcribe(request: Extract<ToWorker, { kind: 'transcribe' }>): Promise<void> {
  const loaded = recognizer;
  if (loaded === undefined) {
    reply({ kind: 'transcribeFailed', requestId: request.requestId, failure: 'modelMissing', detail: 'transcribe before load' });
    return;
  }
  const startedMs = performance.now();
  try {
    const language = request.language === 'auto' ? await detectLanguage(loaded, request.audio) : request.language;
    const output: unknown = await loaded.pipeline(request.audio, { language, task: 'transcribe' });
    const text = tidyWhisperText(textOf(output)).slice(0, DICTATION_LIMITS.segmentCharsMax);
    reply({ kind: 'transcribed', requestId: request.requestId, text, language, decodeMs: Math.round(performance.now() - startedMs) });
  } catch (error: unknown) {
    const detail = String(error);
    reply({
      kind: 'transcribeFailed',
      requestId: request.requestId,
      failure: classifyWorkerError(detail),
      detail: detail.slice(0, DICTATION_LIMITS.detailCharsMax),
    });
  }
}

// The pipeline answers `{ text }` for one input.
function textOf(output: unknown): string {
  if (typeof output === 'object' && output !== null && 'text' in output && typeof output.text === 'string') {
    return output.text;
  }
  throw new Error('transcribe: the pipeline answered without text');
}

// The language token Whisper predicts right after "start of transcript"; English when it says nothing known.
async function detectLanguage(loaded: Recognizer, audio: Float32Array): Promise<WhisperLanguage> {
  const { pipeline } = loaded;
  const features: unknown = await pipeline.processor(audio);
  if (typeof features !== 'object' || features === null || !('input_features' in features)) {
    throw new Error('detectLanguage: the processor gave no features');
  }
  const config: unknown = pipeline.model.generation_config;
  const start = numberField(config, 'decoder_start_token_id');
  const languages = recordField(config, 'lang_to_id');
  const inputs = features.input_features;
  if (!(inputs instanceof loaded.Tensor)) {
    throw new Error('detectLanguage: the features are not a tensor');
  }
  const generated: unknown = await pipeline.model.generate({ inputs, decoder_input_ids: [start], max_new_tokens: 1 });
  const token = lastToken(generated);
  for (const [name, id] of Object.entries(languages)) {
    if (id === token) {
      const code = parseWhisperLanguage(name.replace(/^<\|/u, '').replace(/\|>$/u, ''));
      if (code !== undefined) {
        return code;
      }
    }
  }
  return 'en';
}

function numberField(source: unknown, key: string): number {
  const value: unknown = typeof source === 'object' && source !== null ? Reflect.get(source, key) : undefined;
  if (typeof value !== 'number') {
    throw new Error(`detectLanguage: the model config has no ${key}`);
  }
  return value;
}

function recordField(source: unknown, key: string): Record<string, unknown> {
  const value: unknown = typeof source === 'object' && source !== null ? Reflect.get(source, key) : undefined;
  if (typeof value !== 'object' || value === null) {
    throw new Error(`detectLanguage: the model config has no ${key}`);
  }
  return Object.fromEntries(Object.entries(value));
}

// `generate` answers a tensor of token ids, [batch][tokens]; the last id of the first row is the new one.
function lastToken(generated: unknown): number {
  const tolist: unknown = typeof generated === 'object' && generated !== null ? Reflect.get(generated, 'tolist') : undefined;
  if (typeof tolist !== 'function') {
    throw new Error('detectLanguage: generate answered no tensor');
  }
  const rows: unknown = Reflect.apply(tolist, generated, []);
  const first: unknown = Array.isArray(rows) ? rows[0] : undefined;
  const last: unknown = Array.isArray(first) ? first.at(-1) : undefined;
  // Token ids may come back as bigint from an int64 tensor.
  const token = typeof last === 'bigint' ? Number(last) : last;
  if (typeof token !== 'number') {
    throw new Error('detectLanguage: no generated token');
  }
  return token;
}
