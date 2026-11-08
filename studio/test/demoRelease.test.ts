// Goal: the demo can never reach someone who installs Studio, and installing or running
// Studio stays as it was. The demo lives in `demo/` and leaves only as release assets.
// Method: hold every list that decides what ships, then read the real tree and bundles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_ASSETS, DEMO_MANIFEST_ASSET, demoAssetName } from '../scripts/demoAssets';
import { RELEASE_DIRECTORIES, RELEASE_FILES } from '../scripts/releaseFiles';
import { record } from '../src/shared/validation';

const studio = fileURLToPath(new URL('../', import.meta.url));

async function walk(directory: string): Promise<readonly string[]> {
  const queue = [directory];
  const files: string[] = [];
  for (let index = 0; index < queue.length && index < 5_000; index++) {
    const current = queue[index] ?? '';
    for (const entry of await readdir(path.join(studio, current), { withFileTypes: true })) {
      const file = path.posix.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(file);
      } else {
        files.push(file);
      }
    }
  }
  return files;
}

function isDemoPath(file: string): boolean {
  return file.split('/').includes('demo');
}

test('demo release assets can never be taken for an installer', () => {
  const names = [DEMO_MANIFEST_ASSET, ...DEMO_ASSETS.map(demoAssetName)];
  assert.ok(names.length <= 12, 'A release stays far under the 100-asset limit');
  for (const name of names) {
    assert.match(name, /^stacki-demo-/);
    assert.doesNotMatch(name, /\.(dmg|exe|zip|deb|AppImage|yml|blockmap)$/, 'The site and the updater select installers by suffix');
  }
});

test('a release does not wait for the demo', async () => {
  const workflow = await readFile(path.join(studio, '../.github/workflows/release.yml'), 'utf8');
  const required = /for required in([\s\S]*?); do/.exec(workflow)?.[1] ?? '';
  assert.ok(required.includes('latest-mac.yml'), 'The required list was found');
  assert.doesNotMatch(required, /stacki-demo/);
});

test('no release folder or file is the demo', () => {
  assert.equal(RELEASE_DIRECTORIES.some(isDemoPath), false);
  assert.equal(RELEASE_FILES.some(isDemoPath), false);
});

test('no path a release collects has a demo segment', async () => {
  for (const directory of RELEASE_DIRECTORIES) {
    const files = await walk(directory);
    assert.deepEqual(files.filter(isDemoPath), [], `${directory} holds no demo path`);
  }
});

test('the demo is not in the package or in a Cloudflare deployment', async () => {
  const manifest = record(JSON.parse(await readFile(path.join(studio, 'package.json'), 'utf8')));
  const files = manifest['files'];
  assert.ok(Array.isArray(files));
  assert.equal(
    files.some((file) => String(file).split('/').includes('demo')),
    false,
  );
  const cli = await readFile(path.join(studio, 'scripts/cli.ts'), 'utf8');
  const list = /for \(const file of \[([\s\S]*?)\]\)/.exec(cli)?.[1] ?? '';
  assert.ok(list.includes("'src'"), 'The list was found');
  assert.doesNotMatch(list, /'demo/);
});

test('nothing an install runs imports the demo', async () => {
  for (const directory of RELEASE_DIRECTORIES) {
    for (const file of await walk(directory)) {
      if (/\.tsx?$/.test(file) && file !== 'scripts/buildDemoAssets.ts') {
        const text = await readFile(path.join(studio, file), 'utf8');
        assert.doesNotMatch(text, /from ['"](\.\.?\/)+demo\//, `${file} stays clear of demo/`);
      }
    }
  }
});

test('the editor bundles carry no demo code, when they are built', async () => {
  const built = await lstat(path.join(studio, 'dist/studio.js')).then(
    () => true,
    () => false,
  );
  if (!built) {
    return; // `npm test` runs before the build; the release's own build reaches this.
  }
  for (const bundle of ['studio.js', 'preview.js', 'morph.js', 'integration.mjs']) {
    const text = await readFile(path.join(studio, 'dist', bundle), 'utf8');
    assert.doesNotMatch(text, /stacki-demo|__stackiBakeRendering|studio:bake-render/, `${bundle} is what it always was`);
  }
});

test('normal Studio keeps its server and its dev client', async () => {
  const integration = await readFile(path.join(studio, 'src/server/integration.ts'), 'utf8');
  assert.doesNotMatch(integration, /features\/bake/, 'The dev integration never loads the bake');
  assert.match(integration, /apply: 'serve'/, 'The dev markers still run only in the dev server');
  const build = await readFile(path.join(studio, 'scripts/build.ts'), 'utf8');
  assert.match(build, /external: \['\/@vite\/client'\]/, 'The dev preview client still uses the real Vite client');
});
