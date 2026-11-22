// The audio worklet that hands the microphone's samples to dictation. It runs on the audio thread,
// gathers the 128-sample quanta Web Audio delivers into chunks of `captureChunkSamples` (100 ms at
// 16 kHz), and posts each chunk with its loudness, transferring the buffer so nothing is copied.
// It records nothing and keeps nothing: a chunk exists only until the page has read it.
//
// The worklet scope is not a window: `AudioWorkletProcessor` and `registerProcessor` are its own
// globals, absent from the DOM types, so they are read off `globalThis` and checked before use.
import { DICTATION_LIMITS } from '../../../../shared/properties/voice/dictationLimits';

export const PCM_CAPTURE_PROCESSOR = 'stacki-pcm-capture';

interface ProcessorInstance {
  readonly port: MessagePort;
}
type ProcessorBase = new () => ProcessorInstance;

function isProcessorBase(value: unknown): value is ProcessorBase {
  return typeof value === 'function';
}

const base: unknown = Reflect.get(globalThis, 'AudioWorkletProcessor');
const register: unknown = Reflect.get(globalThis, 'registerProcessor');

if (isProcessorBase(base) && typeof register === 'function') {
  class PcmCapture extends base {
    private chunk = new Float32Array(DICTATION_LIMITS.captureChunkSamples);
    private filled = 0;

    process(inputs: readonly (readonly Float32Array[])[]): boolean {
      // The first channel of the first input: dictation is mono, and a stereo microphone's left is enough.
      const samples = inputs[0]?.[0];
      if (samples === undefined) {
        return true;
      }
      let read = 0;
      // Each pass copies at least one sample or flushes a full chunk, so it ends within the quantum.
      while (read < samples.length) {
        const taken = Math.min(samples.length - read, this.chunk.length - this.filled);
        this.chunk.set(samples.subarray(read, read + taken), this.filled);
        this.filled += taken;
        read += taken;
        if (this.filled === this.chunk.length) {
          this.flush();
        }
      }
      return true;
    }

    private flush(): void {
      let sum = 0;
      for (const sample of this.chunk) {
        sum += sample * sample;
      }
      const rms = Math.sqrt(sum / this.chunk.length);
      const full = this.chunk;
      this.port.postMessage({ samples: full, rms }, [full.buffer]);
      this.chunk = new Float32Array(DICTATION_LIMITS.captureChunkSamples);
      this.filled = 0;
    }
  }
  Reflect.apply(register, undefined, [PCM_CAPTURE_PROCESSOR, PcmCapture]);
}

// Vite replaces this module's default with its bundled address (`?worker&url`, microphoneCapture.ts). A
// bundler without that suffix (the composer test's esbuild) reads this default instead: an empty address
// the test never loads, since its microphone is a fake.
const unbundledAddress = '';
export default unbundledAddress;
