// Goal: a Feedback pin draws at its node's first box, scaled like the outlines,
// and draws nothing when the frame reported no box for it.
// Methodology: render the overlay layer to static markup with one measured pin
// and one unmeasured pin, then read the pins back out of the markup.
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
      rects: { 0.2: [{ x: 10, y: 20, w: 100, h: 40 }] },
      spacing: {},
      scale: 0.5,
      selPath: undefined,
      selOcc: undefined,
      hoverPath: undefined,
      hoverOcc: undefined,
      focusPath: undefined,
      focusWhole: false,
      pins: [
        { id: 'a', path: '0.2', index: 1, note: 'Measured' },
        { id: 'b', path: '0.9', index: 2, note: 'Not rendered' },
      ],
    }),
  );
  const pins = [...markup.matchAll(/<button class="feedback-pin"[^>]*>(\d+)<\/button>/g)];
  assert.equal(pins.length, 1, markup);
  assert.equal(pins[0][1], '1');
  assert.match(pins[0][0], /title="Measured"/);
  assert.match(pins[0][0], /left:5px;top:10px/);
});
