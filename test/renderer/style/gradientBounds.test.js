// Goal: every number the gradient editor computes is written as plain CSS the page reads
// back the same: a stop dragged far past either end of the bar sits at that end, a dial
// turned past a full turn either way wraps, and no write ever spells `NaN%`, `-0%`,
// `Infinity`, `NaNdeg` or exponent notation such as `1e-8%`.
// Method: the real model (src/features/style/model/gradient.ts), bundled with esbuild,
// driven with values on both sides of each bound and with the negative space (NaN,
// Infinity, huge numbers, half-typed text); assertion messages are pinned.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const buildDirectory = repoPath('node_modules/.stacki-test/gradient-bounds');
fs.mkdirSync(buildDirectory, { recursive: true });
esbuild.buildSync({
  entryPoints: { gradient: repoPath('src/features/style/model/gradient.ts') },
  outdir: buildDirectory,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'silent',
});
const model = require(path.join(buildDirectory, 'gradient.js'));

const PLAIN_PERCENT = /^\d{1,3}(\.\d{1,2})?%$/;
const base = () => {
  const parsed = model.parseGradient('linear-gradient(180deg, #e30e0e 0%, #9ef4ff 100%)');
  assert.ok(parsed !== undefined);
  return parsed;
};

test('a position dragged far past either end is that end, in plain notation', () => {
  const cases = [
    [-1e6, '0%'],
    [-0.0000001, '0%'],
    [-0, '0%'],
    [0, '0%'],
    [0.004, '0%'],
    [1e-8, '0%'],
    [33.333333, '33.33%'],
    [99.999, '100%'],
    [100, '100%'],
    [100.0000001, '100%'],
    [Number.MAX_SAFE_INTEGER, '100%'],
    [Number.MAX_VALUE, '100%'],
    [-Number.MAX_VALUE, '0%'],
  ];
  for (const [value, expected] of cases) {
    const written = model.formatPercent(value);
    assert.equal(written, expected, String(value));
    assert.match(written, PLAIN_PERCENT);
  }
  // A reversed stop: 100 minus a position just short of 100 is a tiny float.
  assert.equal(model.formatPercent(100 - 99.99999999), '0%');
});

test('a position that is not a number is a broken computation and crashes loudly', () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => model.clampedPercent(value), { message: 'Assertion failed: clampedPercent: a position is a finite number' });
    assert.throws(() => model.formatPercent(value), { message: 'Assertion failed: clampedPercent: a position is a finite number' });
  }
});

test('a moved stop reads back where it was put', () => {
  for (const percent of [-50, 0, 12.345, 50, 100, 250]) {
    const moved = model.withStopAt(base(), 1, percent);
    const reread = model.parseGradient(model.serializeGradient(moved));
    assert.ok(reread !== undefined);
    assert.equal(reread.stops[1].pos, model.formatPercent(percent));
    assert.equal(model.serializeGradient(reread), model.serializeGradient(moved), 'serialize ∘ parse is the identity on what the editor writes');
  }
  assert.throws(() => model.withStopAt(base(), 2, 50), { message: 'Assertion failed: withStopAt: the stop exists' });
  assert.throws(() => model.withStopAt(base(), -1, 50), { message: 'Assertion failed: withStopAt: a stop index is at least 0' });
  assert.throws(() => model.withStopAt(base(), 0.5, 50), { message: 'Assertion failed: withStopAt: a stop index is an integer' });
});

test('the dial wraps past a full turn either way; a non-number angle crashes loudly', () => {
  const cases = [
    [0, '0deg'],
    [-0, '0deg'],
    [-360, '0deg'],
    [359.6, '0deg'],
    [360, '0deg'],
    [361, '1deg'],
    [-1, '359deg'],
    [-725, '355deg'],
    [7200045, '45deg'],
    [Number.MAX_SAFE_INTEGER, `${Number.MAX_SAFE_INTEGER % 360}deg`],
    [1e300, '180deg'],
    [-1e300, '180deg'],
  ];
  for (const [degrees, expected] of cases) {
    assert.equal(model.degreesToAngle(degrees), expected, String(degrees));
  }
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => model.degreesToAngle(value), { message: 'Assertion failed: degreesToAngle: an angle is a finite number' });
  }
});

test('an angle that does not read as a number is the CSS default, never NaN', () => {
  assert.equal(model.angleToDegrees('.deg'), 180);
  assert.equal(model.angleToDegrees('-deg'), 180);
  assert.equal(model.angleToDegrees(`${'9'.repeat(400)}turn`), 180);
  assert.equal(model.angleToDegrees('1e5deg'), 180);
  assert.equal(model.angleToDegrees('90deg'), 90);
  assert.equal(model.angleToDegrees('0.5turn'), 180);
  // What the angle field writes for a half-typed number stays a direction.
  assert.equal(model.degreesToAngle(model.angleToDegrees('.deg')), '180deg');
});

test('a stop position that does not read is placed as unset, never NaN', () => {
  const stops = [
    { color: 'red', pos: '.%' },
    { color: 'blue', pos: '-%' },
    { color: 'green', pos: '1.2.3%' },
  ];
  assert.equal(model.stopPercent(stops, 0), 0);
  assert.equal(model.stopPercent(stops, 1), 50);
  assert.equal(model.stopPercent(stops, 2), 1.2, 'parseFloat reads the leading number, as before');
});

test('only a stop position the page can read is written from the field', () => {
  for (const text of ['', ' ', '0%', '42%', '-10%', '12.5%', '.5%', '20px', '3rem', 'var(--stop)', 'calc(10% + 2px)']) {
    assert.equal(model.stopPositionWritable(text), true, JSON.stringify(text));
  }
  for (const text of ['.', '-', '-%', '.%', '1e-7%', '1e999%', 'NaN%', 'Infinity%', '1.2.3%', '%', 'abc', '10%%']) {
    assert.equal(model.stopPositionWritable(text), false, JSON.stringify(text));
  }
});
