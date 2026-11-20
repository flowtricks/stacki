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
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    commonjsOptions: {
      include: [/node_modules/, /dist[\\/]shared/],
    },
  },
});
