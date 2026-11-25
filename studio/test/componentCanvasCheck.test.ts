// Goal: `astro-studio check-project` holds `.stacki/component-canvas.json` to the parser Desktop and the CLI use, and names a
// key whose component was renamed, moved or deleted outside the app, so an external refactor is not done until it follows.
// Method: build a disposable project on disk, run the real check with a valid file, a file naming a missing component and a
// file the parser refuses, and list the metadata inventory Studio syncs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { checkProject } from '../scripts/checkProject';
import { metadataFiles } from '../src/features/settings/projectMetadata';

const SITE: Readonly<Record<string, string>> = {
  'package.json': '{"dependencies":{"astro":"*"}}',
  'src/pages/index.astro': '<h1>Home</h1>',
  'src/components/Button.astro': '---\nconst { variant = "main" } = Astro.props;\n---\n<button class={variant} />',
};

async function fixture(canvas: unknown) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-canvas-check-'));
  for (const [relative, text] of Object.entries(SITE)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
  await mkdir(path.join(root, '.stacki'), { recursive: true });
  await writeFile(path.join(root, '.stacki/component-canvas.json'), typeof canvas === 'string' ? canvas : JSON.stringify(canvas));
  return root;
}

test('check-project accepts canvas settings for the project components and lists the file Studio syncs', async (context) => {
  const root = await fixture({ version: 1, components: { 'src/components/Button.astro': { split: ['variant'] } } });
  context.after(() => rm(root, { recursive: true, force: true }));
  context.mock.method(console, 'log', () => undefined);
  await checkProject(root);
  assert.deepEqual(await metadataFiles(root), ['.stacki/component-canvas.json']);
});

test('check-project names a canvas key whose component is gone, and refuses a file the parser refuses', async (context) => {
  context.mock.method(console, 'log', () => undefined);
  const stale = await fixture({ version: 1, components: { 'src/components/Gone.astro': { split: [] } } });
  context.after(() => rm(stale, { recursive: true, force: true }));
  await assert.rejects(checkProject(stale), /component-canvas\.json names src\/components\/Gone\.astro/);
  const broken = await fixture({ version: 1, components: { 'src/components/Button.astro': { split: 'variant' } } });
  context.after(() => rm(broken, { recursive: true, force: true }));
  await assert.rejects(checkProject(broken), /splits by a list/);
});
