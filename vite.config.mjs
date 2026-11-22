import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { withContentSecurityPolicy } from './scripts/build/rendererCsp.mts';

// The main window's Content Security Policy, in the built page only (scripts/build/rendererCsp.mts says what it allows
// and why): `npm run dev` serves Vite's own inline scripts, which it would refuse.
const rendererContentSecurityPolicy = {
  name: 'stacki-renderer-csp',
  apply: 'build',
  transformIndexHtml: { order: 'post', handler: (html) => withContentSecurityPolicy(html) },
};

export default defineConfig({
  plugins: [react(), rendererContentSecurityPolicy],
  base: './',
  server: {
    port: 5173,
    strictPort: true,
  },
  // Dictation's Whisper worker (src/features/ai/voice/whisperWorker.ts) imports Transformers.js lazily, which
  // needs an ES module worker; the capture worklet is bundled the same way (`?worker&url`).
  worker: {
    format: 'es',
  },
  // Transformers.js and ONNX Runtime locate their WebAssembly next to their own files; pre-bundling them
  // into .vite/deps would move those files away. They load only when dictation starts, so skipping the
  // pre-bundle costs the development server nothing at startup.
  optimizeDeps: {
    exclude: ['@huggingface/transformers', 'onnxruntime-web'],
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    commonjsOptions: {
      include: [/node_modules/, /dist[\\/]shared/],
    },
  },
});
