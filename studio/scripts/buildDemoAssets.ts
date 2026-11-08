// Builds the browser side of the static demo into .studio/demo-release/, which lint,
// format and git all skip. Nothing here goes
// through `dist/` or the release bundle: the demo only ever leaves this repository
// as separate release assets, so an install of Studio cannot pick it up.
import { contentWorkersDefine } from './contentWorkers';
import { build, type Plugin } from 'esbuild';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserBoundary } from './browserBoundary';
import { DEMO_ASSETS, DEMO_MANIFEST_ASSET, demoAssetName } from './demoAssets';
import { demoSharedYjs } from '../demo/sharedYjsPlugin';
import { demoSharedTypeScript } from '../demo/sharedTypeScriptPlugin';
import { studioClientOptions } from './studioClientBuild';
import { assert } from '../vendor/stacki/shared/core/assert';
import { BAKE_PROTOCOL } from '../src/features/bake/bakeProtocol';
import { record, string } from '../src/shared/validation';

const studio = fileURLToPath(new URL('../', import.meta.url));
const target = path.join(studio, '.studio/demo-release');
const release = record(JSON.parse(await readFile(path.join(studio, 'src/shared/release.json'), 'utf8')));

// The planner hashes source with `node:crypto`. Bundling it in a page needs a
// synchronous stand-in; Web Crypto has only an asynchronous digest.
const browserCrypto: Plugin = {
  name: 'demo-crypto',
  setup(context) {
    context.onResolve({ filter: /^node:crypto$/ }, () => ({ path: path.join(studio, 'demo/nodeCrypto.ts') }));
  },
};

// The CSS variable engine runs in the page against an in-memory project, which needs
// POSIX paths and a synchronous stand-in for AsyncLocalStorage, nothing more.
const VARIABLE_ENGINE = /[\\/](cssVar[A-Za-z]*|variableWorkspace|variableRestore)\.ts$/;
const browserVariables: Plugin = {
  name: 'demo-variables',
  setup(context) {
    // Only the engine's own files; every other import keeps the server-only boundary.
    context.onResolve({ filter: /^(node:)?path$/ }, (args) =>
      VARIABLE_ENGINE.test(args.importer) ? { path: path.join(studio, 'demo/posixPath.ts') } : undefined,
    );
    context.onResolve({ filter: /^node:async_hooks$/ }, () => ({ path: path.join(studio, 'demo/asyncLocalStorage.ts') }));
  },
};

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await build({
  entryPoints: [path.join(studio, 'demo/main.ts')],
  bundle: true,
  outfile: path.join(target, 'demo.js'),
  platform: 'browser',
  minify: true,
  format: 'esm',
  define: { 'process.env.NODE_ENV': '"production"' },
  inject: [path.join(studio, 'demo/bufferShim.ts')],
  plugins: [browserCrypto, browserVariables, browserBoundary],
});
// The client is Studio's own build, with one difference: Yjs and TypeScript come from
// demo.js, which loaded them first for the rooms and the page engine. Two copies of Yjs
// on one page log an error and break Yjs's `instanceof` checks; a second TypeScript is
// 3.6 MB the visitor would download and compile twice. Writes studio.js and the
// studio.css its imports produce.
await build({
  ...studioClientOptions,
  absWorkingDir: studio,
  outfile: path.join(target, 'studio.js'),
  sourcemap: false,
  plugins: [demoSharedYjs, demoSharedTypeScript, ...(studioClientOptions.plugins ?? [])],
});
await build({
  entryPoints: [path.join(studio, 'src/features/bake/bakeDemo.ts')],
  bundle: true,
  outfile: path.join(target, 'bake.mjs'),
  // The content reader's workers travel inside the bake tool, which ships alone.
  define: { __STACKI_CONTENT_WORKERS__: await contentWorkersDefine() },
  platform: 'node',
  format: 'esm',
  // Astro comes from the project being baked; everything else travels in this file.
  external: ['astro', 'vite'],
  banner: {
    // TypeScript and other CommonJS code in this bundle reach for these three names.
    js: "import { createRequire as __bakeRequire } from 'node:module'; import { fileURLToPath as __bakePath } from 'node:url'; const require = __bakeRequire(import.meta.url); const __filename = __bakePath(import.meta.url); const __dirname = __filename.slice(0, __filename.lastIndexOf('/'));",
  },
});
for (const [source, name] of [
  ['dist/morph.js', 'morph.js'],
  ['dist/preview-static.js', 'preview-static.js'],
  ['demo/demo.css', 'demo.css'],
  ['demo/index.html', 'index.html'],
] as const) {
  await copyFile(path.join(studio, source), path.join(target, name));
}

// The release's copy: flat, prefixed names, one manifest with a checksum per file. A
// browser or Worker can trust a file only by this list, so nothing is uploaded without it.
const upload = path.join(target, 'upload');
await mkdir(upload);
const files = [];
for (const name of DEMO_ASSETS) {
  const bytes = await readFile(path.join(target, name));
  const released = demoAssetName(name);
  await writeFile(path.join(upload, released), bytes);
  files.push({ name, asset: released, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
assert(files.length === DEMO_ASSETS.length, 'Every demo asset is listed');
const version = string(release['version'], 50);
await writeFile(path.join(upload, DEMO_MANIFEST_ASSET), JSON.stringify({ format: 1, protocol: BAKE_PROTOCOL, version, files }, null, 2));
console.log(`Demo assets written to ${target}`);
