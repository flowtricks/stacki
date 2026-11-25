// Goal: text that fills the selected component instance (an Eyebrow that is only its words)
// draws one tag, not two. The text mark's tag sat on the instance's tag, and their two labels
// and icons overlapped into an unreadable chip.
// Method: render the real overlays to static markup with a selected instance and a text mark,
// then count the tags drawn — the mark's tag must stay away when the corners meet and come
// back when the text sits elsewhere in the instance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/text-mark-tags.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  stdin: {
    contents: `export { PreviewOverlays } from './src/features/preview/PreviewOverlays';`,
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { PreviewOverlays } = require(output);

const INSTANCE = { x: 100, y: 100, w: 400, h: 30 };
const INFO = {
  label: 'Eyebrow',
  kind: 'component',
  tag: undefined,
  astroAsset: false,
  dynamicTag: false,
  nodeKind: 'component',
  isLayout: false,
  bound: false,
};

function render(marks) {
  return renderToStaticMarkup(
    React.createElement(PreviewOverlays, {
      rects: { 0.2: [INSTANCE] },
      spacing: {},
      scale: 1,
      selPath: '0.2',
      selOcc: 0,
      hoverPath: undefined,
      hoverOcc: undefined,
      focusPath: undefined,
      focusWhole: false,
      textMarks: marks,
      overlayInfo: () => INFO,
    }),
  );
}

const tagCount = (markup) => markup.split('class="node-outline-tag').length - 1;
const mark = (box) => ({ ...box, kind: 'component', label: 'Eyebrow' });

test('text filling its instance leaves the instance tag alone', () => {
  assert.equal(tagCount(render({ hover: mark(INSTANCE), picked: undefined })), 1);
  assert.equal(tagCount(render({ hover: undefined, picked: mark(INSTANCE) })), 1);
});

test('text a few pixels inside the corner still shares the tag', () => {
  const inset = { x: 102, y: 101, w: 396, h: 28 };
  assert.equal(tagCount(render({ hover: mark(inset), picked: undefined })), 1);
});

test('text lower in the instance keeps its own tag', () => {
  const lower = { x: 100, y: 160, w: 300, h: 30 };
  const markup = render({ hover: undefined, picked: mark(lower) });
  assert.equal(tagCount(markup), 2);
});

test('with nothing selected the mark keeps its tag', () => {
  const markup = renderToStaticMarkup(
    React.createElement(PreviewOverlays, {
      rects: {},
      spacing: {},
      scale: 1,
      selPath: undefined,
      selOcc: undefined,
      hoverPath: undefined,
      hoverOcc: undefined,
      focusPath: undefined,
      focusWhole: false,
      textMarks: { hover: mark(INSTANCE), picked: undefined },
    }),
  );
  assert.equal(tagCount(markup), 1);
});
