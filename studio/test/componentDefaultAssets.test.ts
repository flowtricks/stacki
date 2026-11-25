// Goal: Studio shares `.stacki/components.json` with Desktop, so an insert made in
// Studio writes an image default the same way (an import and its name), goes
// without a deleted file, follows a moved one, and check-project names a missing
// one. Method: a real temporary project, Studio's own loader, insertion edits and
// project check; the relink that an asset move runs is driven over a room store
// that writes to the same files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { loadInsertionDefaults } from '../src/features/settings/loadDefaults';
import { componentInsertionEdits } from '../src/features/source/componentInsertion';
import { leftOutAssets } from '../src/features/source/instanceDefaults';
import { applyEdits, nodesOf } from '../src/features/source/source';
import { relinkMovedDefaults } from '../src/features/settings/projectMetadata';
import { checkProject } from '../scripts/checkProject';

const RECIPE = {
  version: 1,
  components: {
    'src/components/Img.astro': {
      assets: { src: { file: 'src/assets/photo.png' } },
      literals: { list: { source: '[{ image: shot }]', imports: { shot: 'src/assets/shot.png' } } },
    },
  },
};
const FILES: Readonly<Record<string, string>> = {
  'src/components/Img.astro': '---\ninterface Props { src?: ImageMetadata; list?: unknown[] }\n---\n<img />\n',
  'src/assets/photo.png': 'png',
  'src/assets/shot.png': 'png',
  '.stacki/components.json': `${JSON.stringify(RECIPE, undefined, 2)}\n`,
};

async function project(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-default-assets-'));
  try {
    for (const [file, text] of Object.entries(FILES)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), text);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const PAGE = "---\nimport photo from '../assets/other.png';\n---\n<main></main>\n";

async function insert(root: string) {
  const settings = await loadInsertionDefaults(root);
  const [main] = nodesOf(PAGE);
  const action = {
    kind: 'insert' as const,
    name: 'Img',
    importPath: '../components/Img.astro',
    paired: false,
    target: main?.id ?? '',
    placement: 'inside' as const,
  };
  const edits = componentInsertionEdits(PAGE, action, 'src/pages/index.astro', settings);
  return { source: applyEdits(PAGE, edits), settings };
}

test('an insert imports each default file under a free name', async () => {
  await project(async (root) => {
    const { source } = await insert(root);
    assert.match(source, /import photo2 from "\.\.\/assets\/photo\.png";/);
    assert.match(source, /import shot from "\.\.\/assets\/shot\.png";/);
    assert.match(source, /<Img src=\{photo2\} list=\{\[\{ image: shot \}\]\} \/>/);
    await checkProject(root);
  });
});

test('a deleted file is left out, named, and failed by check-project', async () => {
  await project(async (root) => {
    await rm(path.join(root, 'src/assets/photo.png'));
    const { source, settings } = await insert(root);
    assert.doesNotMatch(source, /assets\/photo\.png|src=/);
    assert.match(source, /assets\/shot\.png/);
    assert.deepEqual(leftOutAssets('src/components/Img.astro', settings), ['src/assets/photo.png']);
    await assert.rejects(() => checkProject(root), /default src imports src\/assets\/photo\.png, which is not in the project/);
  });
});

test('moved assets carry the defaults', async () => {
  await project(async (root) => {
    const file = path.join(root, '.stacki/components.json');
    const room = {
      setSource: (text: string) => writeFile(file, text),
      persist: async () => undefined,
      text: { toString: () => FILES['.stacki/components.json'] },
    };
    const rooms = { changed: async () => undefined, coordinator: { run: <T>(work: () => Promise<T>) => work() }, get: async () => room };
    await relinkMovedDefaults(root, rooms as unknown as Parameters<typeof relinkMovedDefaults>[1], { from: 'src/assets', to: 'src/media' });
    const saved = await readFile(file, 'utf8');
    assert.match(saved, /src\/media\/photo\.png/);
    assert.match(saved, /src\/media\/shot\.png/);
  });
});
