// Goal: pin the registration of icons extracted from the Central v1.35 Figma file.
//
//   node test/renderer/style/centralIconRegistration.test.js
//
// Each icon must export both drawings (1.5px compact for 12 and 16, 1px standard for 20 and
// above) and render under its registered name, which the renderer tests assert by.
// Method: bundle the real centralIcon and geometry with esbuild, render static markup per size.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, repoPath } = require('../../helpers/sources.js');

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test/central-icon-registration');
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

  const registered = [
    ['arrowRotateCounterClockwise', 'arrow-rotate-counter-clockwise'],
    ['pieChartOne', 'pie-chart-1'],
    ['homeRoundDoor', 'homeRoundDoor'],
  ];
  for (const [exportName, name] of registered) {
    const icon = geometry[exportName];
    assert.ok(icon, `${exportName} is exported`);
    assert.equal(icon.name, name, `${exportName} name`);
    assert.ok(icon.compact && icon.standard, `${exportName} has both drawings`);
    for (const [size, strokeWidth] of [
      [12, '1.5'],
      [16, '1.5'],
      [20, '1'],
      [24, '1'],
    ]) {
      const markup = renderToStaticMarkup(React.createElement(centralIcon(icon), { size }));
      assert.ok(markup.includes(`data-central-icon="${name}"`), `${exportName} at ${size}px carries its name`);
      assert.ok(markup.includes('stroke-width="' + strokeWidth + '"'), `${exportName} at ${size}px uses the ${strokeWidth} stroke`);
      assert.ok(markup.includes('<path'), `${exportName} at ${size}px draws a path`);
    }
  }
  console.log('centralIconRegistration: ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
