import { contentWorkersDefine } from './contentWorkers';
import { studioClientOptions } from './studioClientBuild';
import { prepareCloudflareAssets } from './cloudflareAssets';
import { build, type Plugin } from 'esbuild';
import path from 'node:path';
import { stackiFavicon } from '../src/shared/stackiBrand';
import { prepareSiteCache } from './siteCache';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { LIMITS } from '../vendor/stacki/shared/core/limits';

// esbuild's `alias` refuses a key that looks like an absolute path.
const staticHot: Plugin = {
  name: 'static-hot',
  setup(context) {
    context.onResolve({ filter: /^\/@vite\/client$/ }, () => ({ path: path.resolve('src/features/bake/staticHot.ts') }));
  },
};

await prepareSiteCache();
await mkdir('dist', { recursive: true });
await prepareCloudflareAssets('dist');
await build({ ...studioClientOptions, outfile: 'dist/studio.js', sourcemap: true });
await build({
  entryPoints: ['src/features/preview/previewClient.ts'],
  bundle: true,
  outfile: 'dist/preview.js',
  external: ['/@vite/client'],
  platform: 'browser',
  minify: true,
  format: 'esm',
});
// A baked page has no dev server, so `/@vite/client` resolves to a silent stand-in.
await build({
  entryPoints: ['src/features/preview/previewClient.ts'],
  bundle: true,
  outfile: 'dist/preview-static.js',
  plugins: [staticHot],
  platform: 'browser',
  minify: true,
  format: 'esm',
});
await build({
  entryPoints: ['vendor/stacki/electron/previewClient/morphClient.ts'],
  bundle: true,
  outfile: 'dist/morph.js',
  platform: 'browser',
  minify: true,
  format: 'esm',
  define: {
    AVB_PREVIEW_LIMITS: JSON.stringify({
      previewMarkersMax: LIMITS.previewMarkersMax,
      previewMorphWorkMax: LIMITS.previewMorphWorkMax,
    }),
  },
});
await build({
  entryPoints: ['src/server/integration.ts'],
  bundle: true,
  outfile: 'dist/integration.mjs',
  platform: 'node',
  format: 'esm',
  packages: 'external',
});
await writeFile(
  'dist/index.html',
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover"><title>Stacki</title><link rel="icon" type="image/svg+xml" href="${stackiFavicon}"><link rel="stylesheet" href="/studio/studio.css"></head><body><div id="root"></div><script type="module" src="/studio/studio.js"></script></body></html>`,
);
await copyFile('vendor/stacki/LICENSE', 'dist/STACKI-LICENSE');
await copyFile('vendor/phosphor/LICENSE', 'dist/PHOSPHOR-LICENSE');
await build({
  entryPoints: ['scripts/cli.ts'],
  bundle: true,
  outfile: 'dist/cli.mjs',
  platform: 'node',
  format: 'esm',
  packages: 'external',
  banner: { js: '#!/usr/bin/env node' },
});
await build({
  entryPoints: ['scripts/container.ts'],
  bundle: true,
  outfile: 'dist/container.mjs',
  platform: 'node',
  format: 'esm',
  packages: 'external',
});
console.log('Studio, integration, and preview clients built.');

await build({
  entryPoints: ['src/features/bake/bakeDemo.ts'],
  bundle: true,
  outfile: 'dist/bake.mjs',
  // The content reader's workers travel inside the bake tool, which ships alone.
  define: { __STACKI_CONTENT_WORKERS__: await contentWorkersDefine() },
  platform: 'node',
  format: 'esm',
  packages: 'external',
});

await build({
  entryPoints: ['src/features/preview/previewMiddleware.ts'],
  bundle: true,
  outfile: 'dist/previewMiddleware.mjs',
  platform: 'node',
  format: 'esm',
  packages: 'external',
});

await build({
  entryPoints: ['src/features/preview/variantRuntime.ts'],
  bundle: true,
  outfile: 'dist/variantRuntime.mjs',
  platform: 'node',
  format: 'esm',
  packages: 'external',
});
