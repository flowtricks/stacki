// The src card for media the project does not hold.
//
//   node test/renderer/ui/remoteAssetCard.test.js
//
// A media field pointed at a URL shows that URL's media in its card, the same
// way a project file does: an image as an <img>, a video as a still <video>
// that never plays and fetches only its metadata, and anything that fails or
// may not load as the generic icon. This bundles src/ui/AssetField.tsx,
// renders it in jsdom with the asset bridge stubbed to an empty project, and
// reads the card's thumbnail. jsdom loads no media, so a failed load is
// simulated by dispatching the element's own error event.

const fs = require('fs');
const path = require('path');
const { repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'remote-asset-card.bundle.js');
  await esbuild.build({
    entryPoints: [repoPath('src/ui/AssetField.tsx')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.Node = dom.window.Node;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  // An empty project: the card under test is the remote one, which never
  // consults the catalog, but the field still reads and watches it.
  dom.window.avb = {
    listAssets: async () => ({ entries: [] }),
    onAssetsChanged: () => () => {},
  };

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = require('react');
  const AssetField = require(bundlePath).default;

  const container = dom.window.document.getElementById('root');
  const root = createRoot(container);
  const render = async (props) => {
    await act(async () => {
      root.render(React.createElement(AssetField, { projectPath: '/project', onChange: () => {}, ...props }));
      await settle(10);
    });
  };
  const thumb = () => container.querySelector('.af-thumb');
  const icon = () => thumb()?.querySelector('svg');

  // --- An external image -----------------------------------------------------------
  await render({ value: 'https://cdn.example.com/hero.png', mediaKind: 'image' });
  const image = thumb()?.querySelector('img');
  check('an external image renders an <img>', Boolean(image), thumb()?.innerHTML);
  check('the <img> loads the URL', image?.getAttribute('src') === 'https://cdn.example.com/hero.png');
  check('no video for an image', !thumb()?.querySelector('video'));
  check('the card names the file', container.querySelector('.af-name')?.textContent === 'hero.png');
  check('the card names the host', container.querySelector('.af-sub')?.textContent === 'cdn.example.com');

  // --- An external video ------------------------------------------------------------
  // An <img> media kind, as a <source> or a generic src field would pass: the
  // extension still decides it is a video.
  await render({ value: 'https://pidgin-36m.pages.dev/hero-pigeon-v3.webm', mediaKind: 'image' });
  const video = thumb()?.querySelector('video');
  check('an external video renders a <video>', Boolean(video), thumb()?.innerHTML);
  check('no <img> for a video', !thumb()?.querySelector('img'));
  check('the video seeks to a frame', video?.getAttribute('src') === 'https://pidgin-36m.pages.dev/hero-pigeon-v3.webm#t=0.1', video?.getAttribute('src'));
  check('the video is muted', video?.muted === true);
  check('the video fetches metadata only', video?.getAttribute('preload') === 'metadata');
  check('the video does not autoplay', video?.autoplay === false);
  check('the video does not loop', video?.loop === false);
  check('the video has no controls', !video?.hasAttribute('controls'));
  check('the video has no poster when none is set', !video?.hasAttribute('poster'));
  check('one preview per field', thumb()?.querySelectorAll('img, video').length === 1);

  await render({
    value: '//cdn.example.com/clip.mp4',
    mediaKind: 'video',
    posterValue: 'https://cdn.example.com/poster.jpg',
  });
  const posterVideo = thumb()?.querySelector('video');
  check('a protocol-relative video loads over https', posterVideo?.getAttribute('src') === 'https://cdn.example.com/clip.mp4#t=0.1');
  check('a set poster is shown', posterVideo?.getAttribute('poster') === 'https://cdn.example.com/poster.jpg');
  await render({ value: 'https://cdn.example.com/clip.mp4', mediaKind: 'video', posterValue: 'javascript:alert(1)' });
  check('a disallowed poster is dropped', !thumb()?.querySelector('video')?.hasAttribute('poster'));

  // --- Failing and disallowed URLs ------------------------------------------------------
  await render({ value: 'https://cdn.example.com/missing.png', mediaKind: 'image' });
  await act(async () => {
    thumb()?.querySelector('img')?.dispatchEvent(new dom.window.Event('error'));
    await settle(10);
  });
  check('a failed image falls back to the icon', Boolean(icon()), thumb()?.innerHTML);
  check('and leaves no broken <img>', !thumb()?.querySelector('img'));

  await render({ value: 'https://cdn.example.com/again.png', mediaKind: 'image' });
  check('a new URL after a failure tries again', Boolean(thumb()?.querySelector('img')), thumb()?.innerHTML);

  await render({ value: 'https://cdn.example.com/missing.webm', mediaKind: 'video' });
  await act(async () => {
    thumb()?.querySelector('video')?.dispatchEvent(new dom.window.Event('error'));
    await settle(10);
  });
  check('a failed video falls back to the icon', Boolean(icon()), thumb()?.innerHTML);
  check('and leaves no <video>', !thumb()?.querySelector('video'));

  await render({ value: 'data:text/html,<script>alert(1)</script>', mediaKind: 'image' });
  check('a non-image data: URL loads nothing', !thumb()?.querySelector('img, video'), thumb()?.innerHTML);
  check('and shows the icon', Boolean(icon()));

  await render({ value: 'data:image/png;base64,iVBORw0KGgo=', mediaKind: 'image' });
  check('a data:image URL previews', thumb()?.querySelector('img')?.getAttribute('src') === 'data:image/png;base64,iVBORw0KGgo=');

  await act(async () => root.unmount());

  if (failures.length) {
    console.error(`\nremoteAssetCard: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`remoteAssetCard: ${checked} passed`);
})();
