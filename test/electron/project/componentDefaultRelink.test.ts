// Goal: renaming or moving an asset (the Assets panel, the Files panel, image
// conversion) keeps component defaults pointing at it, so the next insert does
// not lose it. Method: the real relink over a real temporary project's
// `.stacki/components.json`, through the app's witnessed metadata writes. The
// negative space: a move nothing names writes nothing, and a settings file that
// does not read is left byte for byte.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { relinkMovedDefaultAssets } from '#dist/electron/project/componentDefaultRelink.js';

function project(context: { readonly after: (callback: () => void) => void }, source: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-default-relink-')));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.stacki'));
  const file = path.join(root, '.stacki/components.json');
  fs.writeFileSync(file, source);
  return { root, read: () => fs.readFileSync(file, 'utf8') };
}

const SETTINGS = JSON.stringify({
  version: 1,
  components: {
    'src/components/Img.astro': {
      assets: { src: { file: 'src/assets/art/photo.png' } },
      literals: { list: { source: '[a]', imports: { a: 'src/assets/art/photo.png' } } },
    },
  },
});

test('a renamed file, then its moved folder, are what the defaults import', (context) => {
  const { root, read } = project(context, SETTINGS);
  relinkMovedDefaultAssets(root, [{ from: 'src/assets/art/photo.png', to: 'src/assets/art/hero.png' }]);
  assert.equal(read().match(/src\/assets\/art\/hero\.png/g)?.length, 2);
  relinkMovedDefaultAssets(root, [{ from: 'src/assets/art', to: 'src/media' }]);
  assert.equal(read().match(/src\/media\/hero\.png/g)?.length, 2);
  assert.doesNotMatch(read(), /src\/assets/);
});

test('a move nothing names writes nothing, and a broken file is left as it is', (context) => {
  const { root, read } = project(context, SETTINGS);
  relinkMovedDefaultAssets(root, [{ from: 'src/assets/other.png', to: 'src/assets/moved.png' }]);
  assert.equal(read(), SETTINGS);
  const broken = project(context, '{broken');
  relinkMovedDefaultAssets(broken.root, [{ from: 'src/a.png', to: 'src/b.png' }]);
  assert.equal(broken.read(), '{broken');
});
