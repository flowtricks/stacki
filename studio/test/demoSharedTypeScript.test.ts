// Goal: the demo page holds one TypeScript compiler. The demo's page engine loads it,
// and the demo's build of the Studio client reads that same module instead of bundling
// a second 3.6 MB copy that the visitor would download and compile again.
// Method: bundle a small client through the demo's plugin and run it against the shared
// module, check that a client the stand-in cannot serve fails its build or its load
// loudly, and read the built release bundles when they exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';
import { SHARED_TYPESCRIPT_GLOBAL, shareTypeScript } from '../demo/sharedTypeScript';
import { demoSharedTypeScript, sharedTypeScriptModule } from '../demo/sharedTypeScriptPlugin';

const studio = fileURLToPath(new URL('../', import.meta.url));
/** A message only the compiler's own source carries, so its presence marks a bundled copy. */
const TYPESCRIPT_MARK = 'Unterminated string literal.';

async function bundle(contents: string): Promise<string> {
  const result = await build({
    stdin: { contents, loader: 'js', resolveDir: studio },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
    plugins: [demoSharedTypeScript],
  });
  return result.outputFiles[0]?.text ?? '';
}

test('a client built with the plugin carries no TypeScript and uses the shared one', async () => {
  const text = await bundle(
    "import ts from 'typescript'; export const kind = ts.createSourceFile('a.ts', 'const a = 1;', ts.ScriptTarget.Latest).statements[0]?.kind; export const same = ts;",
  );
  assert.ok(!text.includes(TYPESCRIPT_MARK), 'The bundle has no copy of TypeScript');
  assert.ok(text.length < 2_000, 'The stand-in is a few lines, not the compiler');
  shareTypeScript();
  const client: unknown = await import(`data:text/javascript,${encodeURIComponent(text)}`);
  assert.ok(typeof client === 'object' && client !== null);
  assert.equal(Reflect.get(client, 'same'), ts, 'The client reads the page TypeScript');
  assert.equal(Reflect.get(client, 'kind'), ts.SyntaxKind.VariableStatement, 'The shared compiler parses for the client');
});

test('a named import fails the build instead of loading a second copy', async () => {
  await assert.rejects(bundle("import { createSourceFile } from 'typescript'; export const parse = createSourceFile;"), /No matching export/);
});

test('sharing TypeScript is idempotent and cannot be replaced', () => {
  shareTypeScript();
  shareTypeScript();
  assert.equal(Reflect.get(globalThis, SHARED_TYPESCRIPT_GLOBAL), ts);
  assert.equal(Reflect.set(globalThis, SHARED_TYPESCRIPT_GLOBAL, {}), false, 'The shared module is read-only');
});

test('the TypeScript stand-in fails loudly when the demo did not share first', async () => {
  const text = sharedTypeScriptModule().replace(JSON.stringify(SHARED_TYPESCRIPT_GLOBAL), JSON.stringify('__unsharedTypeScript'));
  await assert.rejects(import(`data:text/javascript,${encodeURIComponent(text)}`), /did not share its TypeScript/);
});

test('the demo release holds exactly one TypeScript, in demo.js, when it is built', async () => {
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
  assert.ok(!client.includes(TYPESCRIPT_MARK), 'studio.js reads TypeScript from the page');
  assert.ok(demo.includes(TYPESCRIPT_MARK), 'demo.js loads TypeScript');
});
