// Goal: the demo page holds one Yjs. The demo's rooms load it, and the demo's build of
// the Studio client reads that same module instead of bundling a second copy, which
// would log "Yjs was already imported" and break Yjs's `instanceof` checks.
// Method: bundle a small client through the demo's plugin and run it against a shared
// module, check the stand-in module's text for bad input, and read the built release
// bundles when they exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as Y from 'yjs';
import { SHARED_YJS_GLOBAL, shareYjs } from '../demo/sharedYjs';
import { demoSharedYjs, sharedYjsModule } from '../demo/sharedYjsPlugin';

const studio = fileURLToPath(new URL('../', import.meta.url));
const YJS_FLAG = '__ $YJS$ __';

test('a client built with the plugin carries no Yjs and uses the shared one', async () => {
  const result = await build({
    stdin: { contents: "import * as Y from 'yjs'; export const doc = new Y.Doc(); export const same = Y;", loader: 'js', resolveDir: studio },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    plugins: [demoSharedYjs],
  });
  const text = result.outputFiles[0]?.text ?? '';
  assert.doesNotMatch(text, /\$YJS\$/, 'The bundle has no copy of Yjs');
  shareYjs();
  const client: unknown = await import(`data:text/javascript,${encodeURIComponent(text)}`);
  assert.ok(typeof client === 'object' && client !== null);
  assert.ok('doc' in client);
  assert.ok('same' in client);
  assert.ok(client.doc instanceof Y.Doc, "A document made by the client passes the rooms' instanceof check");
  const same: unknown = client.same;
  assert.ok(typeof same === 'object' && same !== null);
  assert.equal(Reflect.get(same, 'Doc'), Y.Doc, 'The client reads the page Yjs');
});

test('sharing is idempotent and cannot be replaced', () => {
  shareYjs();
  shareYjs();
  assert.equal(Reflect.get(globalThis, SHARED_YJS_GLOBAL), Y);
  assert.equal(Reflect.set(globalThis, SHARED_YJS_GLOBAL, {}), false, 'The shared module is read-only');
});

test('the stand-in module refuses exports it cannot re-export', () => {
  assert.match(sharedYjsModule(['Doc', 'applyUpdate']), /export const \{ Doc, applyUpdate \} = shared;/);
  assert.throws(() => sharedYjsModule([]), /no exports/);
  assert.throws(() => sharedYjsModule(['default']), /cannot be re-exported: default/);
  assert.throws(() => sharedYjsModule(['a-b']), /cannot be re-exported: a-b/);
});

test('the stand-in module fails loudly when the demo did not share first', async () => {
  const text = sharedYjsModule(['Doc']).replace(JSON.stringify(SHARED_YJS_GLOBAL), JSON.stringify('__unsharedYjs'));
  await assert.rejects(import(`data:text/javascript,${encodeURIComponent(text)}`), /did not share its Yjs/);
});

test('the demo release holds exactly one Yjs, in demo.js, when it is built', async () => {
  const release = path.join(studio, '.studio/demo-release');
  const built = await lstat(path.join(release, 'studio.js')).then(
    () => true,
    () => false,
  );
  if (!built) {
    return; // `npm run release:demo` writes these; unit runs before it skip this.
  }
  const client = await readFile(path.join(release, 'studio.js'), 'utf8');
  const demo = await readFile(path.join(release, 'demo.js'), 'utf8');
  assert.equal(client.split(YJS_FLAG).length - 1, 0, 'studio.js reads Yjs from the page');
  assert.equal(demo.split(YJS_FLAG).length - 1, 1, 'demo.js loads Yjs once');
});
