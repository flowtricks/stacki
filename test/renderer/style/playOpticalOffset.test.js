// Goal: pin the optical placement of the Play icon so a right-pointing triangle never drifts back
// to a lopsided position inside its button.
//
//   node test/renderer/style/playOpticalOffset.test.js
//
// Method: bundle the real geometry, read the triangle's path, sample its outline (the rounded
// corners included), and compute the area centroid and bounding box. Then add the icon's optical
// offset and assert, in 24-unit viewBox space: vertical centre is exact, the horizontal centroid
// lies a little left of centre, and the bounding box centre lies between one eighth and one twelfth
// of the triangle's width right of centre. Resetting the offset breaks the vertical assertion
// (the authored path is 0.5 unit high), and the rendered markup must carry the same translate.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, repoPath } = require('../../helpers/sources.js');

function outline(pathData) {
  const tokens = pathData.match(/[MCLVZ]|-?\d+(?:\.\d+)?/g);
  const points = [];
  let index = 0;
  let current = [0, 0];
  let start = [0, 0];
  let command = '';
  const number = () => Number(tokens[index++]);
  for (let guard = 0; index < tokens.length && guard < 1000; guard += 1) {
    if (/[MCLVZ]/.test(tokens[index])) {
      command = tokens[index++];
    }
    if (command === 'M') {
      current = [number(), number()];
      start = current;
      points.push(current);
      command = 'L';
    } else if (command === 'L' || command === 'V') {
      const target = command === 'L' ? [number(), number()] : [current[0], number()];
      for (let step = 1; step <= 100; step += 1) {
        const parameter = step / 100;
        points.push([current[0] + (target[0] - current[0]) * parameter, current[1] + (target[1] - current[1]) * parameter]);
      }
      current = target;
    } else if (command === 'C') {
      const [controlPointStart, controlPointEnd, target] = [
        [number(), number()],
        [number(), number()],
        [number(), number()],
      ];
      for (let step = 1; step <= 100; step += 1) {
        const parameter = step / 100;
        const complement = 1 - parameter;
        const at = (axis) =>
          complement ** 3 * current[axis] +
          3 * complement * complement * parameter * controlPointStart[axis] +
          3 * complement * parameter * parameter * controlPointEnd[axis] +
          parameter ** 3 * target[axis];
        points.push([at(0), at(1)]);
      }
      current = target;
    } else {
      assert.equal(command, 'Z', `unexpected path command ${command}`);
      current = start;
    }
  }
  return points;
}

function measure(points) {
  let area = 0;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    sumX += (x0 + x1) * cross;
    sumY += (y0 + y1) * cross;
  }
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return {
    centroidX: sumX / (3 * area),
    centroidY: sumY / (3 * area),
    boxCentreX: (Math.min(...xs) + Math.max(...xs)) / 2,
    boxCentreY: (Math.min(...ys) + Math.max(...ys)) / 2,
    width: Math.max(...xs) - Math.min(...xs),
  };
}

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test/play-optical-offset');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'bundle.js');
  await esbuild.build({
    stdin: {
      contents: `export * as geometry from './src/ui/central/centralGeometry'
export { centralIcon } from './src/ui/central/CentralIcon'`,
      resolveDir: ROOT,
      loader: 'tsx',
    },
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { geometry, centralIcon } = require(bundlePath);

  const offset = geometry.PLAY_OPTICAL_OFFSET;
  assert.deepEqual(geometry.play.opticalOffset, offset, 'play registers the optical offset');
  const markup = renderToStaticMarkup(React.createElement(centralIcon(geometry.play), { size: 16 }));
  const pathData = markup.match(/ d="([^"]+)"/)[1];
  const shape = measure(outline(pathData));
  const tolerance = 0.05;

  assert.ok(Math.abs(shape.centroidY + offset.y - 12) <= tolerance, `vertical centre exact (${shape.centroidY + offset.y})`);
  assert.ok(Math.abs(shape.boxCentreY + offset.y - 12) <= tolerance, 'bounding box vertical centre exact');
  const boxShift = shape.boxCentreX + offset.x - 12;
  assert.ok(
    boxShift >= shape.width / 12 - tolerance && boxShift <= shape.width / 8 + tolerance,
    `box sits one twelfth to one eighth of the width right of centre (${boxShift})`,
  );
  const centroidShift = shape.centroidX + offset.x - 12;
  assert.ok(centroidShift <= 0 && centroidShift >= -0.75, `centroid within 0.75 unit left of centre (${centroidShift})`);
  assert.ok(markup.includes(`transform="translate(${offset.x} ${offset.y})"`), 'rendered icon carries the translate');
  console.log('playOpticalOffset: ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
