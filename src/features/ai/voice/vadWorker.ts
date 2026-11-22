// The voice-detector worker: Silero VAD v5 on this computer, beside the Whisper worker so a two-second
// decode never delays it. Each 512-sample window (32 ms) gets a speech probability; the model's recurrent
// state and the samples left over from one message carry to the next within a session (`reset` starts
// over). It runs on ONNX Runtime's WebAssembly backend, the same build and files Whisper uses, so it
// ships nothing new: the runtime comes from Stacki's bundle and the model from `stacki-model://`.
import * as ort from 'onnxruntime-web/webgpu';
import ortModuleURL from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import ortBinaryURL from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import { assert } from '../../../../shared/core/assert';
import { DICTATION_LIMITS } from '../../../../shared/properties/voice/dictationLimits';
import { parseToVad, VAD_WINDOW_SAMPLES, type FromVad, type ToVad } from '../../../../shared/properties/voice/vadWorkerProtocol';

/** Silero v5's recurrent state: two layers of one batch of 128 values. */
const STATE_SIZE = 2 * 128;

let session: ort.InferenceSession | undefined;
let state = new Float32Array(STATE_SIZE);
let leftover = new Float32Array(0);
let windowIndex = 0;
let queue: Promise<void> = Promise.resolve();

self.addEventListener('message', (event: MessageEvent) => {
  const data: unknown = event.data;
  const request = parseToVad(data);
  queue = queue.then(() => handle(request));
});

function reply(message: FromVad, transfer: Transferable[] = []): void {
  self.postMessage(message, { transfer });
}

async function handle(request: ToVad): Promise<void> {
  switch (request.kind) {
    case 'load':
      await load(request.modelURL);
      return;
    case 'reset':
      state = new Float32Array(STATE_SIZE);
      leftover = new Float32Array(0);
      windowIndex = 0;
      return;
    case 'frames':
      await score(request.id, request.audio);
      return;
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}

async function load(modelURL: string): Promise<void> {
  if (session !== undefined) {
    reply({ kind: 'loaded' });
    return;
  }
  try {
    ort.env.wasm.wasmPaths = { mjs: new URL(ortModuleURL, self.location.href).href, wasm: new URL(ortBinaryURL, self.location.href).href };
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    const bytes = new Uint8Array(await (await fetch(modelURL)).arrayBuffer());
    session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
    reply({ kind: 'loaded' });
  } catch (error: unknown) {
    reply({ kind: 'loadFailed', detail: String(error).slice(0, DICTATION_LIMITS.detailCharsMax) });
  }
}

async function score(id: number, audio: Float32Array): Promise<void> {
  const loaded = session;
  assert(loaded !== undefined, 'score: the detector is loaded before it is fed');
  const samples = new Float32Array(leftover.length + audio.length);
  samples.set(leftover, 0);
  samples.set(audio, leftover.length);
  const windows = Math.floor(samples.length / VAD_WINDOW_SAMPLES);
  const values = new Float32Array(windows);
  const first = windowIndex;
  const rate = new ort.Tensor('int64', BigInt64Array.from([BigInt(DICTATION_LIMITS.sampleRateHz)]), []);
  for (let window = 0; window < windows; window += 1) {
    const input = new ort.Tensor('float32', samples.slice(window * VAD_WINDOW_SAMPLES, (window + 1) * VAD_WINDOW_SAMPLES), [1, VAD_WINDOW_SAMPLES]);
    const output = await loaded.run({ input, state: new ort.Tensor('float32', state, [2, 1, 128]), sr: rate });
    const probability = output['output']?.data[0];
    const next = output['stateN']?.data;
    values[window] = typeof probability === 'number' ? Math.min(1, Math.max(0, probability)) : 0;
    if (next instanceof Float32Array && next.length === STATE_SIZE) {
      state = Float32Array.from(next);
    }
  }
  leftover = samples.slice(windows * VAD_WINDOW_SAMPLES);
  windowIndex += windows;
  reply({ kind: 'probabilities', id, windowIndex: first, values }, [values.buffer]);
}
