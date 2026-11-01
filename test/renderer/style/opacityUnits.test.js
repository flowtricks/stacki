// Opacity uses CSS's normalized number form unless the author explicitly chose `%`.
// This test exercises the parser/formatter boundary and the scaled numeric stepping,
// then pins the control wiring so slider, field, and CSS writes share that model.

const fs = require('node:fs');
const path = require('node:path');
const { repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked += 1;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'opacity-units.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `
        export { parseOpacity, opacityText } from './OpacityRow';
        export { findScrubTarget, scrubNumber, stepNumberAtCaret } from './model/numberStep';
      `,
      resolveDir: repoPath('src/features/style'),
      loader: 'tsx',
    },
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const { parseOpacity, opacityText, findScrubTarget, scrubNumber, stepNumberAtCaret } = require(bundlePath);

  const number = parseOpacity('0.42');
  check(
    'a unitless opacity stays a normalized number',
    number?.unit === 'number' && number.value === 0.42 && opacityText(number) === '0.42',
    JSON.stringify(number),
  );
  const percent = parseOpacity('42%');
  check(
    'an authored percent retains its percent unit',
    percent?.unit === 'percent' && percent.value === 0.42 && opacityText(percent) === '42%',
    JSON.stringify(percent),
  );
  check('the default opaque value renders as one without a percent', opacityText({ value: 1, unit: 'number' }) === '1');
  check('the same value uses percent only in explicit percent mode', opacityText({ value: 1, unit: 'percent' }) === '100%');
  check('CSS expressions are not mistaken for numeric opacity', parseOpacity('var(--fade)') === undefined);
  check('numeric opacity is clamped to the CSS rendering range', opacityText(parseOpacity('1.4')) === '1' && opacityText(parseOpacity('-0.2')) === '0');

  const stepped = stepNumberAtCaret('0.50', 2, 1, 'whole', 0, 0.01);
  check('unitless arrow stepping advances by one hundredth', stepped?.text === '0.51', stepped?.text);
  const run = findScrubTarget('0.50', 2);
  check('unitless opacity scrubbing advances in hundredths', run !== undefined && scrubNumber('0.50', run, 10, 'whole', 0.01) === '0.6');

  const source = fs.readFileSync(repoPath('src/features/style/OpacityRow.tsx'), 'utf8');
  check('the opacity slider exposes the normalized zero-to-one range', /<DragSlider\s+[\s\S]*?min=\{0\}[\s\S]*?max=\{1\}[\s\S]*?step=\{0\.01\}/.test(source));
  check(
    'slider writes reuse the authored unit instead of forcing percent',
    /onInput=\{\(value\) => live\(\{ value, unit \}\)\}/.test(source) && /commit\(\{ value, unit \}\)/.test(source),
  );

  if (failures.length) {
    console.error(`\nopacity-units: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(`${failures.join('\n')}\n`);
    process.exit(1);
  }
  console.log(`opacity-units: ${checked} passed  [number default, percent preservation, steps]`);
})();
