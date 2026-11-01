// Goal: a build is self-contained under dist and leaves authored directories clean.
// Methodology: inspect real build artifacts, sandboxed preload imports, copied
// worker/icon bytes, and package entry paths after the normal gate builds them.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { test } from 'node:test';
import { record, text } from '#dist/shared/core/boundary.js';

// The runner starts every suite at the repository root.
const root = process.cwd();
const filesMax = 1000;
// Folders esbuild bundles into one file the runtime loads whole
// (scripts/build/bundleClients.ts): only each one's entry has an output.
const BUNDLED_ENTRIES: ReadonlyMap<string, string> = new Map([
  ['electron/preload/', 'electron/preload/preload.ts'],
  ['electron/previewClient/', 'electron/previewClient/morphClient.ts'],
]);
const bundledAway = (file: string): boolean => [...BUNDLED_ENTRIES].some(([folder, entry]) => file.startsWith(folder) && file !== entry);

test('all compiler output lives under dist', () => {
  for (const directory of ['electron', 'shared']) {
    const files = readdirSync(resolve(root, directory), { recursive: true, encoding: 'utf8' });
    assert.ok(files.length < filesMax, 'Source inventory stays bounded');
    for (const file of files) {
      assert.doesNotMatch(file, /\.jsx?$/, `${directory}/${file} is generated output`);
      const source = `${directory}/${file.split(sep).join('/')}`;
      if (file.endsWith('.ts') && !file.endsWith('.d.ts') && !bundledAway(source)) {
        const output = resolve(root, 'dist', directory, file.replace(/\.ts$/, '.js'));
        assert.ok(existsSync(output), `Missing compiler output for ${directory}/${file}`);
      }
    }
  }
  assert.ok(existsSync(resolve(root, 'dist/renderer/index.html')));
  assert.equal(existsSync(resolve(root, 'dist/index.html')), false, 'No obsolete renderer entry');
});

test('package entry and sandboxed preload use the built runtime', () => {
  const input: unknown = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const manifest = record(input);
  const main = text(manifest['main']);
  assert.equal(main, 'dist/electron/main.js');
  assert.ok(existsSync(resolve(root, main)));
  const exports = record(manifest['exports']);
  // The renderer reads the frontmatter source from shared/ directly; the package exports
  // only its entry.
  assert.deepEqual(Object.keys(exports), ['.']);
  const preload = readFileSync(resolve(root, 'dist/electron/preload/preload.js'), 'utf8');
  const imports = [...preload.matchAll(/require\(["']([^"']+)["']\)/g)];
  assert.ok(imports.length > 0);
  assert.ok(imports.length < 10);
  for (const match of imports) {
    assert.equal(match[1], 'electron', 'Sandboxed preload must not load shared modules');
  }
});

test('runtime workers and icons are copied without changing their contents', () => {
  for (const directory of ['electron/content/workers', 'resources']) {
    const files = readdirSync(resolve(root, directory));
    assert.ok(files.length < filesMax);
    for (const file of files) {
      if (/\.(mjs|png|ico|icns)$/.test(file)) {
        assert.deepEqual(
          readFileSync(resolve(root, 'dist', directory, file)),
          readFileSync(resolve(root, directory, file)),
          `${directory}/${file} is available to the packaged runtime`,
        );
      }
    }
  }
});
