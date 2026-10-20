// Goal: a Feedback pin draws on its own copy of its element, scaled like the
// outlines, and draws nothing when the frame reported no box for it; an open
// pin shows its note, and the note box sits under the element just clicked.
// Methodology: render the overlay layer to static markup with a measured pin
// on the second copy, an unmeasured pin, and a composer, then read them back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

test('pins draw where their node has a box', () => {
  const output = repoPath('node_modules/.stacki-test/pin-overlays.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  buildSync({
    entryPoints: [repoPath('src/features/preview/PreviewOverlays.tsx')],
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
  const markup = renderToStaticMarkup(
    React.createElement(PreviewOverlays, {
      rects: {
        0.2: [
          { x: 0, y: 0, w: 10, h: 10 },
          { x: 10, y: 20, w: 100, h: 40 },
        ],
      },
      spacing: {},
      scale: 0.5,
      selPath: undefined,
      selOcc: undefined,
      hoverPath: undefined,
      hoverOcc: undefined,
      focusPath: undefined,
      focusWhole: false,
      feedback: {
        pins: [
          { id: 'a', path: '0.2', occurrence: 1, index: 1, note: 'Measured' },
          { id: 'b', path: '0.9', occurrence: 0, index: 2, note: 'Not rendered' },
        ],
        openPinId: 'a',
        composer: { path: '0.2', occurrence: 1, target: 'div.hero' },
        onAnnotate: () => {},
        onAdd: () => {},
        onCancel: () => {},
        onOpenPin: () => {},
        onDone: () => {},
        onRemove: () => {},
      },
    }),
  );
  const pins = [
    ...markup.matchAll(/<div style="([^"]*)"><button class="feedback-pin[^"]*"[^>]*>(\d+)/g),
  ];
  assert.equal(pins.length, 1, markup);
  assert.equal(pins[0][2], '1');
  assert.match(pins[0][1], /left:5px;top:10px/);
  assert.match(markup, /<p class="feedback-card-note">Measured<\/p>/);
  assert.match(markup, /class="feedback-card feedback-composer" style="left:5px;top:36px"/);
  assert.match(markup, /placeholder="Note on div.hero"/);
});
