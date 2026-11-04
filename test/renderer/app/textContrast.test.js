// Goal: every text colour token stays readable on the surfaces it is drawn on.
// Grey text on a dark fill drifted below WCAG AA once (#666 on a popover's
// section fill was 2.4:1), so the ratios are pinned rather than eyeballed.
// Method: the `:root` blocks of src/app/styles.css (the app's tokens) and
// src/features/style/tokens.css (the style editor's) are read as text, `var()`
// aliases resolved, and translucent fills composited over the surface they sit
// on. WCAG 2 relative luminance gives each pair's contrast, which must meet the
// floor set per token: 4.5:1 for body text, 3:1 for disabled text. The
// hierarchy is pinned too, so lightening one step cannot collapse it into the
// next. The helpers are checked against known ratios and reject what they
// cannot read, so a renamed token fails loudly instead of passing vacuously.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { repoPath } = require('../../helpers/sources.js');

const AA_NORMAL = 4.5;
const DISABLED_MIN = 3;
// Adjacent emphasis steps must differ by at least this contrast between them.
const HIERARCHY_STEP_MIN = 1.25;

/** The custom properties declared in a file's first `:root` block. */
function rootTokens(relative) {
  const css = fs.readFileSync(repoPath(relative), 'utf8');
  const block = /:root\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(block, `${relative}: no :root block`);
  const tokens = new Map();
  for (const match of block[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    tokens.set(match[1], match[2].trim());
  }
  return { css, tokens };
}

/** A token's value with `var()` aliases followed, to a fixed depth. */
function resolve(tokens, name) {
  let value = tokens.get(name);
  for (let depth = 0; depth < 8; depth += 1) {
    assert.ok(value !== undefined, `token ${name} is not defined`);
    const alias = /^var\((--[a-z0-9-]+)\)$/.exec(value);
    if (alias === null) {
      return value;
    }
    value = tokens.get(alias[1]);
  }
  throw new Error(`token ${name}: alias chain too deep`);
}

/** `#rgb`, `#rrggbb` or `rgba(r, g, b, a)` as `{ rgb, alpha }`. */
function parseColor(text) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex !== null) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((digit) => digit + digit).join('') : hex[1];
    return { rgb: [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)), alpha: 1 };
  }
  const rgba = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/.exec(text);
  if (rgba !== null) {
    return { rgb: [rgba[1], rgba[2], rgba[3]].map(Number), alpha: Number(rgba[4]) };
  }
  throw new Error(`unreadable colour: ${text}`);
}

/** A colour composited over an opaque base, as opaque RGB. */
function over(text, base) {
  const { rgb, alpha } = parseColor(text);
  assert.equal(base.length, 3);
  return rgb.map((channel, i) => base[i] + (channel - base[i]) * alpha);
}

function opaque(text) {
  const { rgb, alpha } = parseColor(text);
  assert.equal(alpha, 1, `${text} is translucent: composite it over its surface`);
  return rgb;
}

function luminance(rgb) {
  const linear = rgb.map((channel) => {
    const unit = channel / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(first, second) {
  const [light, dark] = [luminance(first), luminance(second)].sort((left, right) => right - left);
  return (light + 0.05) / (dark + 0.05);
}

/** Asserts `text` meets `floor` on every named surface. */
function assertReadable(label, text, surfaces, floor) {
  assert.ok(surfaces.size > 0);
  for (const [surface, rgb] of surfaces) {
    const ratio = contrast(text, rgb);
    assert.ok(ratio >= floor, `${label} on ${surface}: ${ratio.toFixed(2)}:1, needs ${floor}:1`);
  }
}

function assertHierarchy(label, steps) {
  for (let i = 1; i < steps.length; i += 1) {
    const [higherName, higher] = steps[i - 1];
    const [lowerName, lower] = steps[i];
    assert.ok(luminance(higher) > luminance(lower), `${label}: ${higherName} must be lighter than ${lowerName}`);
    const ratio = contrast(higher, lower);
    assert.ok(ratio >= HIERARCHY_STEP_MIN, `${label}: ${higherName} vs ${lowerName} only ${ratio.toFixed(2)}:1 apart`);
  }
}

test('the contrast helpers match known WCAG ratios and refuse what they cannot read', () => {
  assert.equal(contrast([255, 255, 255], [0, 0, 0]), 21);
  assert.equal(contrast([17, 17, 17], [17, 17, 17]), 1);
  assert.equal(contrast([0, 0, 0], [255, 255, 255]), contrast([255, 255, 255], [0, 0, 0]));
  assert.deepEqual(over('rgba(255, 255, 255, 0.5)', [0, 0, 0]), [127.5, 127.5, 127.5]);
  assert.deepEqual(opaque('#fff'), [255, 255, 255]);
  assert.throws(() => parseColor('hsl(0 0% 50%)'), /unreadable colour/);
  assert.throws(() => opaque('rgba(0, 0, 0, 0.5)'), /translucent/);
  assert.throws(() => resolve(new Map(), '--missing'), /not defined/);
  // The regression this file exists for: the old faint grey on a popover's section fill.
  assert.ok(contrast(opaque('#666666'), over('rgba(255, 255, 255, 0.05)', opaque('#232323'))) < AA_NORMAL);
});

test('app text tokens are readable on panels, popovers and their fills', () => {
  const { css, tokens } = rootTokens('src/app/styles.css');
  const color = (name) => opaque(resolve(tokens, name));
  const popover = /\n\.dd-popup \{[^}]*?background: (#[0-9a-f]{3,6});/i.exec(css);
  assert.ok(popover, '.dd-popup background not found');
  const popoverRGB = opaque(popover[1]);
  const panel = color('--bg-panel');
  const base = new Map([
    ['--bg-panel', panel],
    ['--bg', color('--bg')],
    ['--bg-panel-2', color('--bg-panel-2')],
    ['popover', popoverRGB],
    ['--bg-input on panel', over(resolve(tokens, '--bg-input'), panel)],
    ['--bg-hover on panel', over(resolve(tokens, '--bg-hover'), panel)],
    ['--bg-active on panel', over(resolve(tokens, '--bg-active'), panel)],
    ['--bg-hover on popover', over(resolve(tokens, '--bg-hover'), popoverRGB)],
    ['--bg-input on popover', over(resolve(tokens, '--bg-input'), popoverRGB)],
  ]);
  const withActivePopover = new Map([...base, ['--bg-active on popover', over(resolve(tokens, '--bg-active'), popoverRGB)]]);

  assertReadable('--text', color('--text'), withActivePopover, AA_NORMAL);
  assertReadable('--text-dim', color('--text-dim'), withActivePopover, AA_NORMAL);
  assertReadable('--text-faint', color('--text-faint'), base, AA_NORMAL);
  assertHierarchy('app text', [
    ['--text', color('--text')],
    ['--text-dim', color('--text-dim')],
    ['--text-faint', color('--text-faint')],
  ]);
});

test('style editor text tokens are readable up to the overlay surface', () => {
  const { tokens } = rootTokens('src/features/style/tokens.css');
  const color = (name) => opaque(resolve(tokens, name));
  const throughOverlay = new Map(
    ['--color-bg-inset', '--color-bg-page', '--color-bg-surface', '--color-bg-surface-raised', '--color-bg-surface-overlay'].map((name) => [name, color(name)]),
  );
  const throughHigh = new Map([...throughOverlay, ['--color-bg-surface-high', color('--color-bg-surface-high')]]);
  const recessed = new Map(['--color-bg-inset', '--color-bg-page'].map((name) => [name, color(name)]));

  assertReadable('--color-text-primary', color('--color-text-primary'), throughHigh, AA_NORMAL);
  assertReadable('--color-text-secondary', color('--color-text-secondary'), throughHigh, AA_NORMAL);
  assertReadable('--color-text-tertiary', color('--color-text-tertiary'), throughOverlay, AA_NORMAL);
  assertReadable('--color-text-disabled', color('--color-text-disabled'), recessed, DISABLED_MIN);
  assertHierarchy('style text', [
    ['--color-text-primary', color('--color-text-primary')],
    ['--color-text-secondary', color('--color-text-secondary')],
    ['--color-text-tertiary', color('--color-text-tertiary')],
    ['--color-text-disabled', color('--color-text-disabled')],
  ]);
});
