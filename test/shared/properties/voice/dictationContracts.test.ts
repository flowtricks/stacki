// Goal: every value that crosses into or out of dictation is checked at the edge. The model manifest
// is pinned (full commit, SHA-256 per file, safe paths, a total within the download bound); only HTTPS
// Hugging Face hosts pass, never a look-alike; the IPC replies (status, outcome, progress) refuse
// bytes past the model size, unknown models and duplicate entries; the worker's messages refuse audio
// past the window, unknown devices, unpinned model addresses and oversized text; Whisper's text loses
// its non-speech tags; and every engine failure has its own sentence, never "check your connection".
// Methodology: known-good values from the real manifest, then each known-bad shape alone (negative
// space), against the compiled parsers in dist/shared.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ENGINE_FAILURES } from '#dist/shared/properties/voice/dictationEngine.js';
import {
  installOf,
  parseDictationStatus,
  parseDownloadOutcome,
  parseDownloadProgress,
  parseModelRequest,
} from '#dist/shared/properties/voice/dictationModel.js';
import { chooseSpeechEngine, classifyRecognitionError, engineErrorCode } from '#dist/shared/properties/voice/speechEngine.js';
import {
  WHISPER_MODELS,
  isModelHost,
  isSafeModelPath,
  modelFileURL,
  modelTotalBytes,
  parseDictationLanguage,
  parseWhisperModelId,
} from '#dist/shared/properties/voice/whisperModels.js';
import { classifyWorkerError, parseFromWorker, parseToWorker, tidyWhisperText } from '#dist/shared/properties/voice/whisperWorkerProtocol.js';
import { parseFromVad, parseToVad } from '#dist/shared/properties/voice/vadWorkerProtocol.js';
import { VAD_FILE } from '#dist/shared/properties/voice/whisperModels.js';

const base = WHISPER_MODELS.base;
const BASE_TOTAL = 100_038_511;

test('the manifest is pinned: the base model is 100.0 MB at a full commit, the small and best ones larger', () => {
  assert.equal(modelTotalBytes(base), BASE_TOTAL);
  assert.equal(modelTotalBytes(WHISPER_MODELS.small), 338_371_231);
  assert.equal(modelTotalBytes(WHISPER_MODELS.turbo), 568_491_146);
  assert.match(base.revision, /^[0-9a-f]{40}$/);
  const encoder = base.files.find((file) => file.path === 'onnx/encoder_model_fp16.onnx');
  assert.ok(encoder !== undefined);
  assert.equal(
    modelFileURL(base, encoder),
    'https://huggingface.co/onnx-community/whisper-base/resolve/27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c/onnx/encoder_model_fp16.onnx',
  );
  assert.throws(() => modelFileURL(base, { path: 'config.json', sizeBytes: 1, sha256: 'a'.repeat(64) }), /belongs to the model/);
});

test('only HTTPS Hugging Face hosts pass, never a look-alike, a port or credentials', () => {
  for (const good of ['https://huggingface.co/x', 'https://us.aws.cdn.hf.co/x', 'https://cas-bridge.xethub.hf.co/x']) {
    assert.equal(isModelHost(new URL(good)), true, good);
  }
  for (const bad of [
    'http://huggingface.co/x',
    'https://evilhf.co/x',
    'https://hf.co.evil.com/x',
    'https://huggingface.co.evil.com/x',
    'https://huggingface.co:8443/x',
    'https://user:pass@huggingface.co/x',
    'https://.hf.co/x',
    'file:///etc/passwd',
  ]) {
    assert.equal(isModelHost(new URL(bad)), false, bad);
  }
});

test('model paths are relative and plain', () => {
  assert.equal(isSafeModelPath('onnx/encoder_model_quantized.onnx'), true);
  for (const bad of ['', '../x', 'a/../b', '/etc', 'a//b', 'a/./b', 'C:\\x', 'a b']) {
    assert.equal(isSafeModelPath(bad), false, bad);
  }
});

test('model ids and languages from storage or the wire', () => {
  assert.equal(parseWhisperModelId('small'), 'small');
  assert.throws(() => parseWhisperModelId('large'), /known model id/);
  assert.throws(() => parseWhisperModelId(1), /model id/);
  assert.deepEqual(parseModelRequest({ modelId: 'base' }), { modelId: 'base' });
  assert.throws(() => parseModelRequest({ modelId: '../base' }), /known model id/);
  assert.equal(parseDictationLanguage('de'), 'de');
  assert.equal(parseDictationLanguage('auto'), 'auto');
  assert.equal(parseDictationLanguage('klingon'), 'auto', 'unknown storage means auto-detect');
  assert.equal(parseDictationLanguage(undefined), 'auto');
  assert.equal(parseDictationLanguage(JSON.parse('null')), 'auto', 'localStorage answers null for a missing key');
});

test('the status reply: known models once each, bytes within the model size', () => {
  const good = {
    directory: '/Users/me/Library/Application Support/Stacki/models/whisper',
    models: [
      { id: 'base', install: { kind: 'partial', receivedBytes: 10, totalBytes: BASE_TOTAL } },
      { id: 'small', install: { kind: 'notInstalled' } },
    ],
  };
  const status = parseDictationStatus(good);
  assert.deepEqual(installOf(status, 'base'), { kind: 'partial', receivedBytes: 10, totalBytes: BASE_TOTAL });
  assert.deepEqual(installOf(undefined, 'small'), { kind: 'notInstalled' });
  const bad = [
    { ...good, models: [{ id: 'base', install: { kind: 'installed', sizeBytes: BASE_TOTAL + 1 } }] },
    { ...good, models: [{ id: 'base', install: { kind: 'partial', receivedBytes: 20, totalBytes: 10 } }] },
    { ...good, models: [good.models[1], good.models[1]] },
    { ...good, models: [{ id: 'large', install: { kind: 'notInstalled' } }] },
    { ...good, models: [{ id: 'base', install: { kind: 'maybe' } }] },
    { ...good, models: 'base' },
    { models: good.models },
  ];
  for (const shape of bad) {
    assert.throws(() => parseDictationStatus(shape), /Expected/, JSON.stringify(shape));
  }
});

test('download outcomes and progress', () => {
  assert.deepEqual(parseDownloadOutcome({ kind: 'installed', sizeBytes: BASE_TOTAL }, 'base'), { kind: 'installed', sizeBytes: BASE_TOTAL });
  assert.deepEqual(parseDownloadOutcome({ kind: 'failed', failure: 'hashMismatch' }, 'base'), { kind: 'failed', failure: 'hashMismatch' });
  assert.throws(() => parseDownloadOutcome({ kind: 'failed', failure: 'oops' }, 'base'), /download failure/);
  assert.throws(() => parseDownloadOutcome({ kind: 'installed', sizeBytes: -1 }, 'base'), /nonnegative/);
  assert.deepEqual(parseDownloadProgress({ id: 'small', receivedBytes: 5, totalBytes: 10 }), { id: 'small', receivedBytes: 5, totalBytes: 10 });
  assert.throws(() => parseDownloadProgress({ id: 'small', receivedBytes: 11, totalBytes: 10 }), /within the total/);
  assert.throws(() => parseDownloadProgress({ id: 'small', receivedBytes: 1, totalBytes: 1e12 }), /model size/);
});

const load = { kind: 'load', modelBase: `stacki-model://whisper/base/${base.revision}/`, devices: ['wasm', 'webgpu'], threads: 1 };

test('the worker accepts a pinned load and bounded audio, nothing else', () => {
  assert.deepEqual(parseToWorker(load), load);
  const audio = new Float32Array(16_000);
  assert.equal(parseToWorker({ kind: 'transcribe', requestId: 1, audio, language: 'auto' }).kind, 'transcribe');
  const bad = [
    { ...load, modelBase: 'https://example.com/model/' },
    { ...load, modelBase: 'stacki-model://whisper/base/main/' },
    { ...load, devices: ['cuda'] },
    { ...load, devices: [] },
    { ...load, threads: 0 },
    { ...load, threads: 64 },
    { kind: 'transcribe', requestId: 1, audio: new Float32Array(0), language: 'en' },
    { kind: 'transcribe', requestId: 1, audio: new Float32Array(30 * 16_000 + 1), language: 'en' },
    { kind: 'transcribe', requestId: 1, audio: [0.1, 0.2], language: 'en' },
    { kind: 'transcribe', requestId: 1, audio, language: 'xx' },
    { kind: 'transcribe', requestId: -1, audio, language: 'en' },
    { kind: 'eval', code: '1' },
  ];
  for (const shape of bad) {
    assert.throws(() => parseToWorker(shape), /Expected/);
  }
});

test('the page accepts the worker replies it knows, with bounded text and detail', () => {
  assert.deepEqual(parseFromWorker({ kind: 'loaded', device: 'wasm', loadMs: 750 }), { kind: 'loaded', device: 'wasm', loadMs: 750 });
  assert.deepEqual(parseFromWorker({ kind: 'transcribed', requestId: 2, text: ' Hello.', language: 'de', decodeMs: 2300 }), {
    kind: 'transcribed',
    requestId: 2,
    text: ' Hello.',
    language: 'de',
    decodeMs: 2300,
  });
  assert.equal(parseFromWorker({ kind: 'loadFailed', failure: 'outOfMemory', detail: 'x'.repeat(1_000) }).kind, 'loadFailed');
  const detail = parseFromWorker({ kind: 'transcribeFailed', requestId: 3, failure: 'failed', detail: 'y'.repeat(1_000) });
  assert.ok(detail.kind === 'transcribeFailed' && detail.detail.length === 240, 'detail is cut to its bound');
  for (const shape of [
    { kind: 'transcribed', requestId: 2, text: 'x'.repeat(4_001), language: 'en', decodeMs: 1 },
    { kind: 'transcribed', requestId: 2, text: 'ok', language: 'auto', decodeMs: 1 },
    { kind: 'loaded', device: 'gpu', loadMs: 1 },
    { kind: 'loadFailed', failure: 'boom', detail: '' },
    { kind: 'transcribed', requestId: 2, text: 'ok', language: 'en' },
  ]) {
    assert.throws(() => parseFromWorker(shape), /Expected/);
  }
});

test('runtime errors become the failure the person can act on', () => {
  assert.equal(classifyWorkerError('RangeError: Array buffer allocation failed'), 'outOfMemory');
  assert.equal(classifyWorkerError('Error: no available backend found. ERR: [wasm] RuntimeError'), 'backendUnavailable');
  assert.equal(classifyWorkerError('Error: Could not locate file: "stacki-model://whisper/base/x/config.json".'), 'modelMissing');
  assert.equal(classifyWorkerError('Error: failed to load model because protobuf parsing failed'), 'modelCorrupt');
  assert.equal(classifyWorkerError('Error: something else'), 'failed');
});

test("Whisper's text loses its leading space and its non-speech tags", () => {
  assert.equal(tidyWhisperText(' Please make the heading larger.'), 'Please make the heading larger.');
  assert.equal(tidyWhisperText(' [BLANK_AUDIO]'), '');
  assert.equal(tidyWhisperText('(music) Hello  [Music] there'), 'Hello there');
});

test('every engine failure travels as its own code and reads back as itself, never as the connection', () => {
  const context = { connection: 'online', microphone: 'allowed' } as const;
  const kinds = new Set<string>();
  for (const failure of ENGINE_FAILURES) {
    const code = engineErrorCode(failure);
    const kind = classifyRecognitionError(code, context).kind;
    assert.notEqual(kind, 'unknown', failure);
    assert.notEqual(kind, 'offline', failure);
    assert.notEqual(kind, 'serviceMissing', failure);
    kinds.add(kind);
  }
  assert.ok(kinds.has('tooSlow'));
  assert.ok(kinds.has('modelMissing'));
});

test('Whisper is chosen wherever it runs, whatever the platform recognizer says', () => {
  const ua = 'Mozilla/5.0 Chrome/152.0.0.0 Electron/44.9.0 Safari/537.36';
  assert.deepEqual(chooseSpeechEngine({ recognizer: 'present', onDevice: 'unavailable', userAgent: ua, whisper: 'available' }), { kind: 'whisper' });
  assert.deepEqual(chooseSpeechEngine({ recognizer: 'absent', onDevice: 'unavailable', userAgent: ua, whisper: 'available' }), { kind: 'whisper' });
  assert.deepEqual(chooseSpeechEngine({ recognizer: 'present', onDevice: 'unavailable', userAgent: ua, whisper: 'unavailable' }), {
    kind: 'none',
    reason: 'serviceMissing',
  });
});

test('the voice detector ships with each model, pinned to its own repository', () => {
  assert.ok(WHISPER_MODELS.base.files.includes(VAD_FILE));
  assert.ok(WHISPER_MODELS.turbo.files.includes(VAD_FILE));
  assert.equal(
    modelFileURL(base, VAD_FILE),
    'https://huggingface.co/onnx-community/silero-vad/resolve/e71cae966052b992a7eca6b17738916ce0eca4ec/onnx/model.onnx',
  );
});

test('the voice detector worker accepts the pinned model and bounded audio; the page accepts probabilities in range', () => {
  const modelURL = `stacki-model://whisper/base/${base.revision}/vad/silero_vad.onnx`;
  assert.deepEqual(parseToVad({ kind: 'load', modelURL }), { kind: 'load', modelURL });
  assert.equal(parseToVad({ kind: 'frames', id: 1, audio: new Float32Array(1_600) }).kind, 'frames');
  for (const bad of [
    { kind: 'load', modelURL: 'https://example.com/vad.onnx' },
    { kind: 'frames', id: 1, audio: new Float32Array(0) },
    { kind: 'frames', id: 1, audio: new Float32Array(16_001) },
    { kind: 'frames', id: -1, audio: new Float32Array(10) },
    { kind: 'run' },
  ]) {
    assert.throws(() => parseToVad(bad), /Expected/);
  }
  assert.equal(parseFromVad({ kind: 'probabilities', id: 1, windowIndex: 3, values: Float32Array.from([0, 0.5, 1]) }).kind, 'probabilities');
  assert.throws(() => parseFromVad({ kind: 'probabilities', id: 1, windowIndex: 3, values: Float32Array.from([1.5]) }), /between 0 and 1/);
  assert.throws(() => parseFromVad({ kind: 'probabilities', id: 1, windowIndex: 0, values: new Float32Array(100) }), /within the bound/);
  assert.throws(() => parseFromVad({ kind: 'probabilities', id: 1, windowIndex: 0, values: [0.1] }), /Expected probabilities/);
});
