// Goal: an image or video from src/ put into rich text works in the built site as well as in development. A build
// serves such a file only under a hashed name, so the content must import it and print what the import names; the rich
// text editors keep reading it as the file's path; a `/src/` address the author wrote stays as written.
// Method: the pure translation both directions (src/editor/richAssetImports.ts), and the whole write through the real
// parser, the page gestures and main's printer path, read back with the same projection. That Astro builds the written
// form and not the path was checked against a real build of a Lumos fixture; this test holds the written form.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { parsePage } = require('#dist/electron/parse/astroParser.js');

const assets = load('src/editor/richAssetImports.ts');
const scope = (imports) => ({ imports, directory: 'src/pages' });
const element = (name, props, children) => ({ kind: 'element', name, props, children });
const text = (value) => ({ type: 'string', value });
const NONE = { taken: new Set(), authored: new Set() };

test('a src/ image or video is written as its import, a new one added once; other addresses stay', () => {
  const written = assets.withAssetImports(
    [
      element('img', { src: text('/src/assets/graphics/lumos-background.svg'), alt: text('') }),
      element('p', {}, [element('img', { src: text('/src/assets/graphics/lumos-background.svg?origWidth=10') })]),
      element('video', { src: text('/@fs/home/me/site/src/assets/a-clip.mp4') }, []),
      element('img', { src: text('/favicon.svg') }),
      element('img', { src: text('https://x.test/a.png') }),
    ],
    scope([{ name: 'Layout', path: '@/layouts/BaseLayout.astro', quote: '"' }]),
    NONE,
  );
  assert.deepEqual(written.added, [
    { name: 'lumosBackground', path: '@/assets/graphics/lumos-background.svg', quote: '"' },
    { name: 'aClip', path: '@/assets/a-clip.mp4', quote: '"' },
  ]);
  const [first, paragraph, video, inPublic, remote] = written.content;
  assert.deepEqual(first.props.src, { type: 'expr', value: 'lumosBackground.src' });
  assert.deepEqual(paragraph.children[0].props.src, { type: 'expr', value: 'lumosBackground.src' });
  assert.deepEqual(video.props.src, { type: 'expr', value: 'aClip' });
  assert.deepEqual(inPublic.props.src, text('/favicon.svg'));
  assert.deepEqual(remote.props.src, text('https://x.test/a.png'));
});

test('an import the file has is reused, a taken name is not, and without the alias the path is relative', () => {
  const image = [element('img', { src: text('/src/assets/hero.png') })];
  const reused = assets.withAssetImports(image, scope([{ name: 'banner', path: '../assets/hero.png' }]), NONE);
  assert.deepEqual(reused.added, []);
  assert.equal(reused.content[0].props.src.value, 'banner.src');
  const taken = assets.withAssetImports(image, scope([]), { taken: new Set(['hero']), authored: new Set() });
  assert.deepEqual(taken.added, [{ name: 'hero2', path: '../assets/hero.png', quote: "'" }]);
});

test('a /src/ address the author wrote stays as written', () => {
  const kept = assets.withAssetImports([element('img', { src: text('/src/assets/hero.png') })], scope([]), {
    taken: new Set(),
    authored: new Set(['/src/assets/hero.png']),
  });
  assert.deepEqual(kept.added, []);
  assert.deepEqual(kept.content[0].props.src, text('/src/assets/hero.png'));
});

test('the editors read the import as the file’s path, in the source and in the nodes; anything else is untouched', () => {
  const source =
    '---\nimport hero from "@/assets/hero.png";\nimport clip from "../assets/clip.mp4";\nimport { data } from "../data";\n---\n' +
    '<RichText><img src={hero.src} alt="" /><video src={clip} controls></video><img src={data.src} /></RichText>\n';
  const { model } = parsePage(source, { locs: true });
  const shown = assets.shownAssetNodes(model.nodes, scope(model.imports));
  const [image, video, other] = shown[0].children;
  assert.deepEqual(image.props.src, text('/src/assets/hero.png'));
  assert.deepEqual(video.props.src, text('/src/assets/clip.mp4'));
  assert.equal(other.props.src.type, 'expr', 'a data expression is code, not an asset');
  assert.equal(image.id, model.nodes[0].children[0].id, 'handles are kept');
  assert.equal(
    assets.shownAssetSource('<p>{hero.src}</p><img src={hero.src} alt="">', scope(model.imports)),
    '<p>{hero.src}</p><img src="/src/assets/hero.png" alt="">',
  );
});
