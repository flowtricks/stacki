// The speech models Stacki can download for dictation, pinned to the byte. Each entry names the
// Hugging Face repository, the commit it is read at, and every file with its size and SHA-256;
// the main process refuses any file whose bytes differ (electron/app/dictationDownload.ts), and
// the renderer loads only these files (stacki-model://, electron/app/dictationProtocol.ts).
//
// Why these files: Transformers.js runs Whisper from an ONNX encoder and a merged decoder plus
// the tokenizer and the three configs it reads. The decoders are 8-bit (`quantized`): a quarter of
// full precision with no audible loss for dictation. The standard model's encoder is half precision
// (`fp16`) because Whisper's cost is its encoder, which always reads 30 seconds: on WebGPU the fp16
// encoder decodes a short phrase in 0.55 s where the 8-bit one takes 2.4 s (8-bit matrix products
// fall back to the CPU), and on WebAssembly both take 2.4 s. It costs 18 MB more to download.
//
// Why base by default and tiny as the fallback (measured on an Apple M5 Pro in a hidden Electron 44
// window, docs/voice-engine.md): base transcribes English and German correctly; tiny makes more
// mistakes but decodes in 1.1 s on WebAssembly. A machine where base cannot keep up
// (dictationEngine.ts: real-time factor over 1.5) is offered tiny.
//
// The hashes were computed from the downloaded files (shasum -a 256) and match the Git LFS object
// ids the repository publishes for the large files.
import { assert } from '../../core/assert';
import { DICTATION_LIMITS } from './dictationLimits';

/** The dictation quality tiers, best first: Best (large-v3 turbo), Balanced (small), Fast (base). */
export const WHISPER_MODEL_IDS = ['turbo', 'small', 'base'] as const;
export type WhisperModelId = (typeof WHISPER_MODEL_IDS)[number];
export const WHISPER_MODEL_DEFAULT: WhisperModelId = 'turbo';
/** The tier a computer too slow for the others is offered: it runs on WebAssembly at about real time. */
export const WHISPER_MODEL_FAST: WhisperModelId = 'base';

export interface ModelFile {
  /** Path inside the repository, forward slashes, no `..`: also the path under the model's folder on disk. */
  readonly path: string;
  readonly sizeBytes: number;
  /** Lowercase hex SHA-256 of the file's bytes. */
  readonly sha256: string;
  /** Another repository the file comes from, pinned the same way (the voice detector ships with each model). */
  readonly source?: { readonly repository: string; readonly revision: string };
}

/**
 * Silero VAD v5 (MIT), the neural voice detector every session gates Whisper with (speechChunker.ts): 2.2 MB,
 * downloaded and verified with the model so one press sets up everything. Whisper invents words for anything
 * that is not speech; an energy detector alone let a fan, a keyboard or a quiet room through now and then.
 */
export const VAD_FILE: ModelFile = {
  path: 'vad/silero_vad.onnx',
  sizeBytes: 2_243_022,
  sha256: 'a4a068cd6cf1ea8355b84327595838ca748ec29a25bc91fc82e6c299ccdc5808',
  source: { repository: 'onnx-community/silero-vad', revision: 'e71cae966052b992a7eca6b17738916ce0eca4ec' },
};
/** The path the voice detector's file is read from: `stacki-model://whisper/<model>/<revision>/<path>`. */
export const VAD_FILE_PATH = VAD_FILE.path;

export interface WhisperModel {
  readonly id: WhisperModelId;
  /** The Hugging Face repository, `owner/name`. */
  readonly repository: string;
  /** The repository commit every file is read at: 40 lowercase hex characters. */
  readonly revision: string;
  /** The license of the weights (OpenAI's Whisper is MIT; the ONNX conversion repository is tagged Apache-2.0). */
  readonly license: string;
  readonly files: readonly ModelFile[];
  /** The precision of the encoder file the manifest pins, as Transformers.js names it. */
  readonly encoder: 'fp16' | 'q8' | 'q4f16';
  /** The precision of the merged decoder file. */
  readonly decoder: 'q8' | 'q4f16';
  /** The runtimes the worker tries, in order: the first that loads is used. */
  readonly devices: readonly ('webgpu' | 'wasm')[];
}

/** Hosts a model file may come from: Hugging Face, and the content network its file links redirect to. */
export const MODEL_HOSTS = ['huggingface.co'] as const;
/** A redirect may also land on a subdomain of Hugging Face's content domain (`us.aws.cdn.hf.co`, `cas-bridge.xethub.hf.co`). */
export const MODEL_HOST_SUFFIX = '.hf.co';

export const WHISPER_MODELS: { readonly [Id in WhisperModelId]: WhisperModel } = {
  turbo: {
    id: 'turbo',
    repository: 'onnx-community/whisper-large-v3-turbo',
    revision: '360ebcde2559d60bb474678be3c1de9ef347d01a',
    license: 'MIT',
    encoder: 'q4f16',
    decoder: 'q4f16',
    devices: ['webgpu', 'wasm'],
    files: [
      { path: 'config.json', sizeBytes: 1_332, sha256: '35cd83669f75bc2867f3b3a4461850392d5e308cd6ea951c3700539883c28df1' },
      { path: 'generation_config.json', sizeBytes: 3_897, sha256: '16f95291d2f47c944d3c2b19390bba7965666555c1ea2a0bdc850d1fab45612f' },
      { path: 'preprocessor_config.json', sizeBytes: 340, sha256: '7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711' },
      { path: 'tokenizer.json', sizeBytes: 2_480_617, sha256: '6d8cbd7cd0d8d5815e478dac67b85a26bbe77c1f5e0c6d76d1ce2abc0e5f21ca' },
      { path: 'tokenizer_config.json', sizeBytes: 282_843, sha256: '844b642c73a91359722f47b35705f7174686df33d252695d8572cf9ac03a6389' },
      { path: 'onnx/encoder_model_q4f16.onnx', sizeBytes: 369_974_078, sha256: 'aafd3383f1aa372db0825a885730ebbbae7e34871ec0460428663c69641a63d0' },
      { path: 'onnx/decoder_model_merged_q4f16.onnx', sizeBytes: 193_505_017, sha256: '45981cdd958a4c8e1447839850d2e6e27e30974ccbe31b4a1e5ebe9ad8965a5f' },
      VAD_FILE,
    ],
  },
  small: {
    id: 'small',
    repository: 'onnx-community/whisper-small',
    revision: '36050c46d777d46dc4b5f43f6d90574fc38f8732',
    license: 'MIT',
    encoder: 'fp16',
    decoder: 'q8',
    devices: ['webgpu', 'wasm'],
    files: [
      { path: 'config.json', sizeBytes: 2_227, sha256: '457854d452f17661e197d74aee12b8e74fb75ba30ebfaa7426d0d61ea1e08a18' },
      { path: 'generation_config.json', sizeBytes: 3_893, sha256: 'f538b28220c6a6d6f1af1458d4141cacb4ef4963df3de98a19490440c412ddf0' },
      { path: 'preprocessor_config.json', sizeBytes: 339, sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d' },
      { path: 'tokenizer.json', sizeBytes: 2_480_466, sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566' },
      { path: 'tokenizer_config.json', sizeBytes: 282_683, sha256: '2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce' },
      { path: 'onnx/encoder_model_fp16.onnx', sizeBytes: 176_607_756, sha256: '5549cd8666ff4b694ceb128bfa48b95bdcceec29075cf2c2212f90002cc058de' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', sizeBytes: 156_750_845, sha256: 'ec07c3cbb64172c39791e26ee870a65ac22b458c36722bfe2776b3dbf741e0c9' },
      VAD_FILE,
    ],
  },
  base: {
    id: 'base',
    repository: 'onnx-community/whisper-base',
    revision: '27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c',
    license: 'MIT',
    encoder: 'fp16',
    decoder: 'q8',
    devices: ['webgpu', 'wasm'],
    files: [
      { path: 'config.json', sizeBytes: 2_243, sha256: 'f4d0608f7d918166da7edb3e188de5ef1bfe70d9802e785d271fd88111e9cf4b' },
      { path: 'generation_config.json', sizeBytes: 3_832, sha256: '61070cf8de25b1e9256e8e102ded49d8d24a8369ed36ef84fdf21549e68125a0' },
      { path: 'preprocessor_config.json', sizeBytes: 339, sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d' },
      { path: 'tokenizer.json', sizeBytes: 2_480_466, sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566' },
      { path: 'tokenizer_config.json', sizeBytes: 282_682, sha256: '2e036e4dbacfdeb7242c7d4ec4149f4a16e86026048f94d1637e3a8ee9c6a573' },
      { path: 'onnx/encoder_model_fp16.onnx', sizeBytes: 41_332_612, sha256: 'ffba51b20185377c1b89362b1128148d0132de936a32b200af973da2a11a5369' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', sizeBytes: 53_693_315, sha256: 'fa3ef9902734ce5ae6f9ef2bdb2ba9a6c4b5785b09f4f420ce036573dc9d090b' },
      VAD_FILE,
    ],
  },
};

/** The bytes a model downloads: the sum of its files, checked against the download bound. */
export function modelTotalBytes(model: WhisperModel): number {
  const total = model.files.reduce((sum, file) => sum + file.sizeBytes, 0);
  assert(Number.isSafeInteger(total), 'modelTotalBytes: the total is a whole number of bytes');
  assert(total <= DICTATION_LIMITS.downloadBytesMax, 'modelTotalBytes: a model fits the download bound');
  return total;
}

/** The address of one pinned file: `resolve/<commit>` never moves, unlike a branch name. */
export function modelFileURL(model: WhisperModel, file: ModelFile): string {
  assert(model.files.includes(file), 'modelFileURL: the file belongs to the model');
  // A file from another repository keeps its own path there (`onnx/model.onnx`); its place on disk is `file.path`.
  const url =
    file.source === undefined
      ? `https://huggingface.co/${model.repository}/resolve/${model.revision}/${file.path}`
      : `https://huggingface.co/${file.source.repository}/resolve/${file.source.revision}/onnx/model.onnx`;
  assert(isModelHost(new URL(url)), 'modelFileURL: the address is on a pinned host');
  return url;
}

/** The repository's page, shown in the setup dialog as the model's source. */
export function modelSourceURL(model: WhisperModel): string {
  const url = `https://huggingface.co/${model.repository}/tree/${model.revision}`;
  assert(url.startsWith('https://huggingface.co/'), 'modelSourceURL: the source is Hugging Face');
  return url;
}

/** Whether a model file may be fetched from `url`: HTTPS on Hugging Face or its content domain, no credentials, no port. */
export function isModelHost(url: URL): boolean {
  if (url.protocol !== 'https:') {
    return false;
  }
  if (url.username !== '' || url.password !== '' || url.port !== '') {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (MODEL_HOSTS.some((allowed) => allowed === host)) {
    return true;
  }
  // `evilhf.co` does not end with `.hf.co`; `x.hf.co.evil.com` ends with `.com`.
  return host.endsWith(MODEL_HOST_SUFFIX) && host.length > MODEL_HOST_SUFFIX.length;
}

/** A model id from the wire or from storage. Throws on anything else (a programmer error at the boundary). */
export function parseWhisperModelId(input: unknown): WhisperModelId {
  if (typeof input !== 'string') {
    throw new Error('Expected a model id');
  }
  const found = WHISPER_MODEL_IDS.find((id) => id === input);
  if (found === undefined) {
    throw new Error('Expected a known model id');
  }
  return found;
}

/** Whether `path` is a safe relative file path: forward slashes, no empty, `.` or `..` segments, no drive or root. */
export function isSafeModelPath(path: string): boolean {
  if (path.length === 0 || path.length > 128) {
    return false;
  }
  if (!/^[A-Za-z0-9_.\-/]+$/u.test(path)) {
    return false;
  }
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

// The manifest is code, but a typo in it would download the wrong bytes or write outside the
// folder: its invariants are checked once, when the module loads.
for (const id of WHISPER_MODEL_IDS) {
  const model = WHISPER_MODELS[id];
  assert(model.id === id, 'whisperModels: every entry names itself');
  assert(/^[0-9a-f]{40}$/u.test(model.revision), 'whisperModels: the revision is a full commit hash');
  assert(model.files.length > 0, 'whisperModels: a model has files');
  for (const file of model.files) {
    assert(isSafeModelPath(file.path), 'whisperModels: every file path is safe');
    assert(/^[0-9a-f]{64}$/u.test(file.sha256), 'whisperModels: every hash is a SHA-256');
    assert(Number.isSafeInteger(file.sizeBytes), 'whisperModels: every size is whole');
    assert(file.sizeBytes > 0, 'whisperModels: no file is empty');
    assert(file.source === undefined || /^[0-9a-f]{40}$/u.test(file.source.revision), 'whisperModels: a borrowed file is pinned to a commit');
  }
  modelTotalBytes(model);
}

/**
 * The languages the picker offers: Whisper's codes for the most spoken languages it transcribes
 * well, plus every interface language Stacki ships. The names come from `Intl.DisplayNames` in
 * the person's language, so no string here needs translating.
 */
export const WHISPER_LANGUAGES = [
  'ar',
  'bg',
  'ca',
  'cs',
  'da',
  'de',
  'el',
  'en',
  'es',
  'fa',
  'fi',
  'fr',
  'he',
  'hi',
  'hr',
  'hu',
  'id',
  'it',
  'ja',
  'ko',
  'ms',
  'nl',
  'no',
  'pl',
  'pt',
  'ro',
  'ru',
  'sk',
  'sv',
  'ta',
  'th',
  'tr',
  'uk',
  'ur',
  'vi',
  'zh',
] as const;
export type WhisperLanguage = (typeof WHISPER_LANGUAGES)[number];
/** What the person chooses: a language, or `auto` (the model decides from the first words). */
export type DictationLanguage = WhisperLanguage | 'auto';
export const DICTATION_LANGUAGE_DEFAULT: DictationLanguage = 'auto';

/** A language from the wire or from storage, or undefined for anything else. */
export function parseWhisperLanguage(input: unknown): WhisperLanguage | undefined {
  if (typeof input !== 'string') {
    return undefined;
  }
  return WHISPER_LANGUAGES.find((code) => code === input);
}

/** The stored choice; anything absent or unknown is auto-detect. */
export function parseDictationLanguage(input: unknown): DictationLanguage {
  if (input === 'auto') {
    return 'auto';
  }
  return parseWhisperLanguage(input) ?? DICTATION_LANGUAGE_DEFAULT;
}
