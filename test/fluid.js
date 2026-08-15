// Fluid type, and what it costs a reader who zooms.
//
//   node test/fluid.js
//
// The rule comes from WCAG 1.4.4: at 500% zoom the viewport is a fifth as wide,
// so a fluid value locks to its floor and is then magnified five times — which
// only reaches twice its desktop size if the max is no more than 2.5× the min.
// The second check is about rem: the part of the linear term that answers to
// the reader's own font size. Zero or less, and they cannot enlarge it at all.
//
// The numbers are read out of the expression rather than from input fields, so
// this covers the ways a clamp() can be written as well as the maths.

const path = require('path');
const { pathToFileURL } = require('url');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

(async () => {
  const { fluidCheck, resolveValue } = await import(
    pathToFileURL(path.join(__dirname, '..', 'src', 'fluid.js')).href
  );

  // The shape the framework writes: sizes in px, divided by 16 into rem, scaled
  // between two viewport widths.
  const fluid = (min, max, vpMin = 320, vpMax = 1440) =>
    `clamp(${min} / 16 * 1rem, ((${min} - ((${max} - ${min}) / (${vpMax} - ${vpMin}) * ${vpMin})) / 16 * 1rem + ((${max} - ${min}) / (${vpMax} - ${vpMin})) * 100vw), ${max} / 16 * 1rem)`;

  check('a gentle scale is fine', fluidCheck(fluid(64, 112)).status === 'ok');
  check('exactly 2.5x is still fine', fluidCheck(fluid(16, 40)).status === 'ok');
  check('a hair over is an error', fluidCheck(fluid(16, 41)).status === 'error', JSON.stringify(fluidCheck(fluid(16, 41))));
  check('a 4x scale is an error', fluidCheck(fluid(16, 64)).status === 'error');
  check('the site margin in the framework is one', fluidCheck(fluid(16, 48)).status === 'error');
  check('its gutter is not', fluidCheck(fluid(16, 32)).status === 'ok');

  // No rem in the linear term: pure vw, which ignores the reader's font size.
  check('a value with no rem part is a warning', fluidCheck('clamp(1rem, 0rem + 2vw, 2rem)').status === 'warning');
  check('one that shrinks as the root grows is too', fluidCheck('clamp(1rem, -0.5rem + 3vw, 2rem)').status === 'warning');
  check('the error wins over the warning', fluidCheck('clamp(1rem, -1rem + 8vw, 4rem)').status === 'error');

  // Reading, not guessing.
  check('px and rem measure the same thing', fluidCheck('clamp(16px, 0.5rem + 2vw, 48px)').status === 'error');
  check(
    'an inverted pair is judged on its real ratio',
    fluidCheck('clamp(4rem, 1rem + 2vw, 1rem)').status === 'error',
    JSON.stringify(fluidCheck('clamp(4rem, 1rem + 2vw, 1rem)'))
  );
  check('a clamp with no viewport term is not fluid', fluidCheck('clamp(1rem, 1.5rem, 2rem)') === null);
  check('a plain value is not fluid', fluidCheck('2rem') === null);
  check('an unreadable expression is left alone', fluidCheck('clamp(1rem, min(2rem, 3vw), 4rem)') === null);
  check('a viewport range of zero is left alone', fluidCheck(fluid(16, 24, 320, 320)) === null);

  // Resolution: the same value, built out of variables, and then edited.
  {
    const values = {
      '--site-margin-min': '16',
      '--site-margin-max': '48',
      '--viewport-min': '320',
      '--viewport-max': '1440',
    };
    const value = fluid('var(--site-margin-min)', 'var(--site-margin-max)', 'var(--viewport-min)', 'var(--viewport-max)');
    check(
      'a clamp built out of variables reads the same as one written out',
      fluidCheck(resolveValue(value, values)).status === 'error'
    );
    check(
      'and raising the minimum fixes it, without touching the clamp',
      fluidCheck(resolveValue(value, values, { '--site-margin-min': '20' })).status === 'ok',
      JSON.stringify(fluidCheck(resolveValue(value, values, { '--site-margin-min': '20' })))
    );
    check(
      'as does lowering the maximum',
      fluidCheck(resolveValue(value, values, { '--site-margin-max': '40' })).status === 'ok'
    );
    check(
      'a half-typed number is not a value yet',
      fluidCheck(resolveValue(value, values, { '--site-margin-min': '' })) === null,
      JSON.stringify(fluidCheck(resolveValue(value, values, { '--site-margin-min': '' })))
    );
  }

  if (failures.length) {
    console.error(`\nfluid: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`fluid: ${checked} passed`);
})();
