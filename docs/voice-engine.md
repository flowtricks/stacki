# On-device dictation (Whisper)

Dictation in the AI composer runs OpenAI's Whisper on this computer, in a Web Worker, through
Transformers.js and ONNX Runtime Web. Audio never leaves the machine; the only network traffic is the
one-time model download from Hugging Face.

## Why not the platform's speech recognition

Chromium's Web Speech API needs Google's online service (keys Google builds into Chrome) or an
on-device model Chrome downloads through its component updater. Electron ships neither, so in Desktop
the recognizer opens the microphone and ends with `error: "network"` while the computer is online
(`shared/properties/voice/speechEngine.ts`). A native helper (macOS `SFSpeechRecognizer`, Windows
speech) would mean three platform implementations, signing and entitlements; Whisper in the renderer
works the same on macOS, Windows and Linux, in development and packaged builds.

## Dependency: `@huggingface/transformers` 4.3.2 (pinned)

- **What it does:** loads Whisper's ONNX encoder and decoder, the tokenizer and the feature extractor,
  and runs greedy decoding (`automatic-speech-recognition` pipeline). It depends on `onnxruntime-web`
  (MIT) for inference.
- **Why the platform cannot:** no browser or Electron API turns audio into text offline. Writing the
  mel feature extractor, the BPE tokenizer, the decoder loop with its KV cache and the ONNX graph
  runtime by hand is far larger and riskier than this dependency.
- **License:** Apache-2.0 (Transformers.js), MIT (ONNX Runtime Web). Model weights: Whisper by OpenAI,
  MIT; the ONNX conversion repository (`onnx-community/whisper-*`) is tagged Apache-2.0.
- **Cost, shipped:** a 599 kB lazy chunk (`transformers.web-*.js`) and the 26.9 MB ONNX Runtime
  WebAssembly (`ort-wasm-simd-threaded.asyncify-*.wasm`, 6.7 MB gzipped) plus its 53 kB loader, all in
  the renderer bundle and fetched only by the worker when a dictation session starts. The initial
  bundle does not change: the worker is created on the first press and imports Transformers.js lazily.
- **Cost, install:** it is a devDependency (Vite bundles it, like React and CodeMirror), so
  electron-builder does not package its Node dependencies. `npm install` does fetch `onnxruntime-node`
  (about 300 MB unpacked, its native binaries) because Transformers.js lists it; Stacki never loads it.
- **Cost, download:** the model, once, into the app data folder: 97.8 MB (standard, `whisper-base`) or
  43.6 MB (small, `whisper-tiny`), 8-bit weights.
- **Cost, CPU and memory:** one decode of the standard model holds one core for about 2.5 s; the worker
  holds roughly 300 MB while loaded and is ended two minutes after the last session.

## The model

| | Standard (`base`, default) | Small (`tiny`) |
|---|---|---|
| Repository | `onnx-community/whisper-base` | `onnx-community/whisper-tiny` |
| Commit | `27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c` | `ff4177021cc41f7db950912b73ea4fdf7d01d8e7` |
| Download (with the 2.2 MB voice detector) | 100,038,511 bytes | 45,856,756 bytes |
| Encoder | half precision, WebGPU first | 8-bit, WebAssembly first |
| One decode, warm | 0.55 s (WebGPU), 2.4 s (WebAssembly) | 1.1 s (WebAssembly) |
| German | correct | more mistakes |

Measured in a hidden Electron 44 window on an Apple M5 Pro, WebAssembly, one thread, through the
production Vite build and the `stacki-model://` scheme. WebGPU on the 8-bit weights was no faster
(2.4 s) and slower to start, so the worker tries WebAssembly first and WebGPU second. The first decode
after loading takes about twice as long (4.8 s) while the runtime warms up.

Every file, size and SHA-256 is pinned in `shared/properties/voice/whisperModels.ts`. The hashes were
computed from the downloaded files and equal the Git LFS object ids Hugging Face publishes.

Threads: ONNX Runtime's threads need SharedArrayBuffer, which a window that is not cross-origin
isolated does not have; Stacki's window is not (isolating it would need COOP/COEP headers on a
`file://` page). The worker therefore runs one thread; `workerThreads` allows `min(4, cores - 1)` if
the window ever becomes isolated.

## Flow

1. The first press of the microphone without the model downloads the chosen model in the main
   process (`electron/app/dictationDownload.ts`) and draws the bytes as a ring on the button; a press
   during the download cancels it. When it is verified, the same press becomes a hands-free session.
2. The download follows redirects by hand to `huggingface.co` and `*.hf.co` over HTTPS only, writes
   each file to `<file>.part`, never past its pinned size (and never past 160 MB in all), checks its
   SHA-256, renames it into place, and writes `verified.json` last. An interrupted download resumes with
   a Range request. Failures are values (`DownloadFailure`) shown under the composer with Retry.
3. The model lives in `<userData>/models/whisper/<model>/<revision>/`, never in a project. The worker
   reads it through `stacki-model://` (`electron/app/dictationProtocol.ts`), which serves only the
   manifest's files of an installed model.
4. The microphone is captured at 16 kHz by an AudioWorklet (`pcmCaptureWorklet.ts`) into a 30 s buffer.
   An energy detector cuts at pauses (`speechChunker.ts`); the audio before a pause is decoded once and
   written to the box, and every 1.75 s the uncommitted audio is decoded and shown as the phrase being
   spoken. On stop the rest is decoded. The waveform reads the same chunks.
   Whisper invents words for silence and noise ("you", "Thank you."; raw Whisper wrote "you" for
   every one of five 30 s windows of silence, pink room noise and brown hum). So nothing is decoded
   that the voice detector has not heard as speech: loudness over the room's floor (measured from the
   session's first 300 ms) and voice-like zero crossings, with onset, release hysteresis and a 120 ms
   hangover, at least 300 ms of it per window, trimmed to the speech plus 150 ms. Over those same
   90 s the detector passed zero windows to Whisper. What is decoded then goes through
   `hallucinations.ts`: usual hallucinated phrases are dropped from short or quiet windows (a loud,
   clear "thank you" is kept) and from the ends of outputs with more words than the speech could
   hold; repeats and words already written are not written again. Transformers.js 4.3 exposes no
   no-speech, log-probability or compression-ratio thresholds; decoding is greedy (temperature 0)
   and never conditioned on earlier text.
5. Auto-detect asks the decoder for the language token on the first window, then keeps that language
   for the session (Transformers.js would otherwise assume English and translate).
6. If the first decode's real-time factor is over 1.5 (audio counted as at least 4 s), the session ends
   with a notice offering the small model.

Settings → AI → Dictation shows the model's status, size, source, license and folder, downloads or
removes it (after a confirmation), picks the model and the language.

## Content Security Policy

The built page's `script-src` adds `'wasm-unsafe-eval'` (`scripts/build/rendererCsp.mts`), which lets the
page and its workers compile WebAssembly. It does not allow JavaScript `eval`, and the wasm still comes
from the app's own files.

## Not verified

- A real microphone in the dev app (the hidden-window check fed synthesized speech to the worker).
- A packaged build: the WebAssembly is fetched from inside `app.asar` over `file://`, which Electron
  supports; it has not been run from a signed package.

## Live text, the voice detector and the person's words

- **Live text.** Whisper decodes whole windows; it is not a streaming model. While the person speaks the
  phrase so far (its last 12 s at most) is decoded again and again and drawn after the composer's text as
  a dim, italic draft (`dictationDraft.ts`), a CodeMirror widget that is not text: it never enters the
  message or the undo history, and the final words replace it when the phrase ends. The next interim
  starts 0.8 s after the last one started or after the last decode plus a rest of half its time,
  whichever is later, so decodes never overlap. Measured on an 8 s TTS sample through the production build
  with Silero and auto-detect: first words 1.9 s after speech starts (0.8 s without the language pass),
  then an update about every 1.1 s, about 2 to 8 % CPU on the renderer process.
- **Voice detector.** Silero VAD v5 (MIT, `onnx-community/silero-vad` at `e71cae96…`, 2.2 MB, verified like
  the Whisper files) runs in its own worker on every 32 ms of audio. Speech needs Silero's probability of
  0.5 or more and a frame louder than the room, and lasts while the probability stays at 0.35 or more;
  without Silero the energy and zero-crossing detector gates alone.
- **Guards.** Windows under 300 ms of speech are never decoded; short results (four words or fewer) need
  60 % speech and a mean probability of 0.7; a result needs an onset inside its window; known invented
  phrases are dropped unless clearly spoken. With debug logging on (`localStorage['stacki.debug.dictation']
  = '1'`) every left-out text and its reason reaches the console, never storage. Measured: 0 words written
  over 30 s each of silence, pink room noise, brown hum, white fan noise, keyboard clicks, quiet music and
  background talk at -30 dB, while "This is a test." and the 8 s sample transcribe correctly.
- **Vocabulary and snippets** (`dictationVocabulary.ts`, Settings → AI → Dictation) apply to final words
  only. The Transformers.js Whisper pipeline takes no prompt ids, so the vocabulary corrects after
  decoding: explicit "heard as" pairs, then conservative near misses (five letters or more, one edit, two
  from nine letters, same first and last letter). A word the person fixes in what they just dictated is
  offered for the vocabulary in a toast. Snippets expand a spoken trigger (after an optional "insert" or
  "paste"), longest first, in one pass. Both are kept in this computer's local storage, parsed with bounds.

## Accuracy benchmark and the quality tiers (November 2026)

The person's verdict on whisper-base was that it wrote words they never said and lost to Apple's dictation.
The benchmark below decides the default. Test set: 8 sentences with web and Stacki vocabulary (Astro,
Stacki, Lumos, flex gap, navbar, semibold), each spoken by 3 macOS voices (Samantha, Daniel, Eddy), in three
versions: clean, mixed with pink room noise, and followed by 2.5 s of room noise (the tail where "Top menu
here." came from): 72 clips. One whole-utterance decode each, English, greedy, WebGPU, Apple M5 Pro, in a
hidden Electron 44 window. "Words not said" counts every output word absent from the reference (misheard
names included; no clip produced extra sentences).

| Tier | Model and precision | Download | WER clean | WER noisy | WER tail | Words not said (72 clips) | Decode, median |
|---|---|---|---|---|---|---|---|
| Fast | whisper-base, fp16 encoder, 8-bit decoder | 100.0 MB | 6.7 % | 10.1 % | 8.6 % | 61 | 0.59 s |
| Balanced | whisper-small, fp16 encoder, 8-bit decoder | 338.4 MB | 4.9 % | 3.7 % | 5.2 % | 37 | 1.66 s |
| **Best (default)** | **whisper-large-v3-turbo, 4-bit/fp16 encoder and decoder** | **568.5 MB** | **2.6 %** | **3.4 %** | **3.0 %** | **24** | **0.57 s** |
| (not shipped) | large-v3-turbo, fp16 encoder, 4-bit decoder | 1.6 GB | 2.6 % | 3.4 % | 2.6 % | 22 | 0.58 s |

Turbo's remaining errors are the names "Stacki" ("Stacky") and "Lumos" ("Loomis"), which the built-in
vocabulary corrects (`BUILT_IN_VOCABULARY`). The 1.6 GB variant gains nothing that justifies three times the
download. Turbo needs WebGPU to be this fast; without it the worker falls back to WebAssembly, and the first
slow decode offers the Fast tier. Apple's on-device dictation (SFSpeechRecognizer) was not benchmarked: it
needs a native helper, and this build ships none.

End to end with the Best tier (the production build, Silero gating, live interim decodes, auto-detect,
the person stopping 1.2 s after the last word): the 24 noisy clips came out at 5.6 % WER and the 24
clips with a noisy 2.5 s tail at 3.0 %, and **no clip gained a word that was not said**, tail included;
every remaining error is a misheard name ("Stacky", "Loomis", "Semibole"), before the built-in
vocabulary. The 7 non-speech clips (30 s each of silence, room noise, hum, fan, keyboard, quiet music,
background talk at -30 dB) produced no text. First words appeared 2.6 s after speech began (median; the
first decode also detects the language).
