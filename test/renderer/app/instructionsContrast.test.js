// Goal: the text on Settings → Instructions' add bar, quick-add chips and empty-state icon stays readable:
// every text/fill pair is at least 4.5:1 (WCAG AA for small text).
// Method: read the solid colours from the stylesheets (tokens in styles.css, the bar's own custom
// properties and the chip fill in instructionsSettings.css), composite translucent fills over the card the
// way the browser does, and compute the WCAG contrast ratio of each pair. Pure arithmetic, no browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { repoPath } = require('../../helpers/sources.js');

const tokens = fs.readFileSync(repoPath('src/app/styles.css'), 'utf8');
const sheet = fs.readFileSync(repoPath('src/app/settings/instructionsSettings.css'), 'utf8');
const hexOf = (source, name) => {
  const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(source);
  assert.ok(match, `${name} is a six-digit hex`);
  return match[1];
};
const rgb = (hex) => [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
const over = (base, white) => base.map((channel) => channel + (255 - channel) * white);
const luminance = (color) => {
  const [red, green, blue] = color.map((channel) => {
    const unit = channel / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
};
const ratio = (first, second) => {
  const [high, low] = [luminance(first), luminance(second)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
};

const dialog = rgb(hexOf(tokens, '--bg-panel-2'));
const card = over(dialog, 0.05);
const dim = rgb(hexOf(tokens, '--text-dim'));
const text = rgb(hexOf(tokens, '--text'));
const pairs = {
  'placeholder on the field': [dim, rgb(hexOf(sheet, '--instructions-field'))],
  'typed text on the field': [text, rgb(hexOf(sheet, '--instructions-field'))],
  'disabled Hide label on its fill': [dim, rgb(hexOf(sheet, '--instructions-button-off'))],
  'enabled Hide label on the accent fill': [rgb('#ffffff'), rgb(hexOf(sheet, '--instructions-button-on'))],
  'hovered Hide label on the hover fill': [rgb('#ffffff'), rgb(hexOf(sheet, '--instructions-button-hover'))],
  'chip text on the chip fill': [dim, rgb(hexOf(sheet, '--instructions-chip'))],
  'empty-state icon on its disc': [dim, over(card, 0.06)],
  'empty-state title on the card': [text, card],
  'empty-state hint on the card': [dim, card],
};

test('every text/fill pair on the Instructions settings card keeps 4.5:1', () => {
  for (const [name, [foreground, background]] of Object.entries(pairs)) {
    assert.ok(ratio(foreground, background) >= 4.5, `${name}: ${ratio(foreground, background).toFixed(2)}:1`);
  }
});
