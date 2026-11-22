// A code editor's colour swatches: a variable painted as the page computes it on `:root`.
//
//   node test/renderer/style/rootColors.test.js
//
// Goal: a stylesheet's swatches show the colour the page really has for a variable (a var() chain, a
// color-mix(), a value from another stylesheet), asked of the canvas's root element in bounded
// batches; the answer is parsed into a colour a swatch can paint and anything else is refused; and
// until the page answers, or with no canvas at all, the swatch paints the declared text, following
// var() chains through the project's declarations.
// Method: the pure halves (rootColors.ts) are called directly: the batching query with a recording
// stand-in for the canvas, the parse over each notation getComputedStyle writes and over what it must
// refuse, and the declared-text reading over chains, fallbacks, cycles and missing names. Then the
// imperative read the code chips use (rootColorNow) is checked with no canvas, where it never asks.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

let colors;
before(async () => {
  const output = repoPath('node_modules/.stacki-test/root-colors.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await build({
    stdin: {
      contents: `
        export * from './src/features/style/model/rootColors';
        export { rootColorNow, rootSwatchScope } from './src/features/style/model/computedColor';
      `,
      resolveDir: ROOT,
      loader: 'ts',
    },
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react'],
    logLevel: 'silent',
  });
  colors = require(output);
});

const variable = (name, value) => ({ name: name.slice(2), collection: 'Colors', group: '', value, binding: `var(${name})`, type: 'Color' });

test('the page is asked in bounded batches, the replies merged, an overlong value never asked', async () => {
  const asked = [];
  const query = colors.rootColorQuery(async (values) => {
    asked.push(values.length);
    return Object.fromEntries(values.map((value) => [value, 'rgb(1, 2, 3)']));
  });
  const values = Array.from({ length: colors.ROOT_COLOR_BATCH_MAX * 2 + 3 }, (_, index) => `var(--c${index})`);
  const long = `var(--${'x'.repeat(colors.ROOT_COLOR_CHARS_MAX)})`;
  const reply = await query('', [...values, long]);
  assert.deepEqual(asked, [colors.ROOT_COLOR_BATCH_MAX, colors.ROOT_COLOR_BATCH_MAX, 3], 'three batches, none past the bound');
  assert.equal(reply['var(--c0)'], 'rgb(1, 2, 3)');
  assert.equal(reply[`var(--c${values.length - 1})`], 'rgb(1, 2, 3)', 'the last batch is merged too');
  assert.equal(reply[long], undefined, 'an overlong value has no answer');
  const silent = colors.rootColorQuery(async () => undefined);
  assert.equal((await silent('', ['var(--a)']))['var(--a)'], undefined, 'an unanswered batch leaves its values unanswered');
});

test('a computed answer is a swatch colour in every notation the browser writes, and nothing else', () => {
  for (const answer of [
    'rgb(255, 255, 255)',
    'rgba(0, 0, 0, 0)',
    'color(srgb 0.2 0.4 0.6 / 0.5)',
    'oklch(0.7 0.1 200)',
    'lab(50% 20 30)',
    '#ffcc00',
    'transparent',
  ]) {
    assert.equal(colors.parseComputedColor(answer), answer, answer);
  }
  assert.equal(colors.parseComputedColor('  rgb(1, 2, 3) '), 'rgb(1, 2, 3)', 'trimmed');
  for (const answer of [
    undefined,
    JSON.parse('null'), // The bridge reports a missing value as null.
    3,
    '',
    '   ',
    '16px',
    'Inter, sans-serif',
    'rgb(1, 2, 3); background: red',
    'url(x)',
    `rgb(${'1,'.repeat(400)})`,
    '#ggg',
  ]) {
    assert.equal(colors.parseComputedColor(answer), undefined, String(answer));
  }
});

test('until the page answers, a swatch paints the declared text, through var() chains and fallbacks', () => {
  const declared = colors.declaredValues([
    variable('--light-100', 'white'),
    variable('--brand-1-text', 'var(--light-100)'),
    variable('--deep', 'var(--brand-1-text)'),
    variable('--loop-a', 'var(--loop-b)'),
    variable('--loop-b', 'var(--loop-a)'),
    variable('--light-100', 'black'),
  ]);
  assert.equal(declared.get('--light-100'), 'white', 'the first declaration wins');
  assert.equal(colors.literalColorOf('var(--brand-1-text)', declared), 'white');
  assert.equal(colors.literalColorOf('var(--deep)', declared), 'white', 'a chain is followed');
  assert.equal(colors.literalColorOf('--light-100', declared), 'white', 'a bare name is a reference');
  assert.equal(colors.literalColorOf('var(--missing, #f00)', declared), '#f00', 'a missing name takes its fallback');
  assert.equal(colors.literalColorOf('var(--missing)', declared), undefined, 'and with none, nothing');
  assert.equal(colors.literalColorOf('var(--loop-a)', declared), undefined, 'a cycle stops at the bound');
  assert.equal(colors.literalColorOf('color-mix(in srgb, red, blue)', declared), 'color-mix(in srgb, red, blue)', 'a value that is no reference stays');
  assert.equal(colors.literalColorOf('', declared), undefined);
  const scope = colors.rootSwatchScope([variable('--light-100', 'white')]);
  assert.equal(scope.on, 'root');
  assert.equal(scope.literal('var(--light-100)'), 'white', 'a code editor’s scope reads the project’s declarations');
});

test('with no canvas, the code chips’ read never asks and falls back to the declared text', () => {
  assert.equal(colors.rootColorNow('var(--light-100)'), undefined, 'no frame: no answer, the chip paints its own value');
  assert.equal(colors.rootColorNow('#fff'), undefined, 'a literal is never asked about');
});
