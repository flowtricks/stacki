// Goal: local Studio shares website source without overwriting project configuration.
// Method: use temporary projects to check installation detection, generated paths,
// session storage boundaries, startup failures, and the browser entry's loopback restriction;
// and that Studio's own folders move into the self-ignored `.stacki/studio/` once, whole.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { studioEntryHTML } from '#dist/electron/previewServer/studioEntry.js';
import { prepareStudioLocal } from '#dist/electron/previewServer/studioLocalMove.js';
import { isStudioLocalPath } from '#dist/shared/properties/studioLocal.js';
import {
  createLocalStudio,
  hasLocalStudio,
  writeLocalStudioConfig,
} from '#dist/electron/previewServer/studioLocal.js';

test('local configuration uses website source and leaves its Astro config intact', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stacki-studio-local-'));
  try {
    const config = 'export default { site: "https://example.com" };\n';
    await writeFile(path.join(root, 'astro.config.mjs'), config);
    const generated = writeLocalStudioConfig(root, path.join(root, 'studio/dist'), 4399);
    assert.equal(generated, path.join(root, 'node_modules/.avb/astro.studio.config.mjs'));
    const source = await readFile(generated, 'utf8');
    assert.ok(
      source.includes(
        JSON.stringify({
          root,
          assets: path.join(root, 'studio/dist'),
          port: 4399,
          editing: 'source',
        }),
      ),
    );
    assert.ok(source.includes('astro.config.mjs'));
    assert.doesNotMatch(source, /\.studio\/workspace/);
    assert.equal(await readFile(path.join(root, 'astro.config.mjs'), 'utf8'), config);
    // Session storage sits inside `.stacki/studio/`, which ignores its own contents.
    assert.equal(await readFile(path.join(root, '.stacki/studio/.gitignore'), 'utf8'), '*\n');
    assert.throws(() => writeLocalStudioConfig(root, root, 80), /nonprivileged/);
    assert.throws(() => writeLocalStudioConfig(root, root, 1.5), /integer/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing, malformed and symlinked Studio installations are not started', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stacki-studio-detection-'));
  try {
    assert.equal(hasLocalStudio(root), false);
    const metadata = path.join(root, 'studio/src/shared');
    await mkdir(metadata, { recursive: true });
    await writeFile(path.join(metadata, 'release.json'), '{"version":"0.1.48"}');
    assert.equal(hasLocalStudio(root), true);
    const studio = createLocalStudio(root, () => {});
    const result = await studio.open();
    assert.equal(result.ok, false);
    studio.close();
    assert.deepEqual(await studio.open(), { ok: false, error: 'The website preview has closed.' });
    await writeFile(path.join(metadata, 'release.json'), '{"version":4}');
    assert.equal(hasLocalStudio(root), false);
    await writeFile(path.join(metadata, 'release.json'), 'x'.repeat(4097));
    assert.equal(hasLocalStudio(root), false);
    const other = path.join(root, 'other');
    await mkdir(other);
    await symlink(path.join(root, 'studio'), path.join(other, 'studio'), 'dir');
    assert.equal(hasLocalStudio(other), false);
    await mkdir(path.join(root, '.stacki/studio'), { recursive: true });
    await symlink(other, path.join(root, '.stacki/studio/state'), 'dir');
    assert.throws(() => writeLocalStudioConfig(root, root, 4399), /real directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the website entry embeds only a local Studio origin', () => {
  const html = studioEntryHTML('http://127.0.0.1:4399');
  assert.match(html, /title="Stacki Studio" src="http:\/\/127.0.0.1:4399\/studio"/);
  for (const origin of ['https://example.com', 'javascript:alert(1)', 'http://127.0.0.1']) {
    assert.throws(() => studioEntryHTML(origin), /local HTTP origin/);
  }
});

test("an older Studio's folders move into .stacki/studio once, whole", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stacki-studio-move-'));
  try {
    await mkdir(path.join(root, '.studio-state/drafts'), { recursive: true });
    await writeFile(path.join(root, '.studio-state/drafts/a.bin'), 'draft');
    await mkdir(path.join(root, '.stacki-studio'));
    await writeFile(path.join(root, '.stacki-studio/update.lock'), 'lock');
    prepareStudioLocal(root);
    assert.equal(await readFile(path.join(root, '.stacki/studio/.gitignore'), 'utf8'), '*\n');
    assert.equal(
      await readFile(path.join(root, '.stacki/studio/state/drafts/a.bin'), 'utf8'),
      'draft',
    );
    assert.equal(
      await readFile(path.join(root, '.stacki/studio/updates/update.lock'), 'utf8'),
      'lock',
    );
    await mkdir(path.join(root, '.studio-state'));
    prepareStudioLocal(root);
    assert.equal(
      await readFile(path.join(root, '.stacki/studio/state/drafts/a.bin'), 'utf8'),
      'draft',
      'a second old folder never replaces or merges into the moved one',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('only Studio-owned paths read as Studio state', () => {
  for (const owned of [
    '.stacki/studio',
    '.stacki/studio/state/a.bin',
    '.studio-state',
    'x/.stacki-studio/y',
  ]) {
    assert.equal(isStudioLocalPath(owned), true, owned);
  }
  for (const site of [
    '.stacki/components.json',
    '.stacki/studios.json',
    'studio/src/app.ts',
    'src/studio-state.ts',
  ]) {
    assert.equal(isStudioLocalPath(site), false, site);
  }
  assert.throws(() => isStudioLocalPath('.stacki\\studio'), /POSIX paths/);
});
