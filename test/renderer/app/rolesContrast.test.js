// Goal: the members card on a Settings → Roles card stays readable and keeps three clear surface steps:
// every text/fill pair is at least 4.5:1 (WCAG AA for small text), and the inset card is visibly darker than
// the role card while the add row sits a step lighter than the inset.
// Method: read the solid colours from the stylesheets (tokens in styles.css, the card's own custom properties in
// roles.css), composite the role card's and the row hover's translucent fills the way the browser does, and
// compute the WCAG contrast ratio of each pair. Pure arithmetic, no browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { repoPath } = require('../../helpers/sources.js');

const tokens = fs.readFileSync(repoPath('src/app/styles.css'), 'utf8');
const sheet = fs.readFileSync(repoPath('src/app/settings/roles.css'), 'utf8');
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
const roleCard = over(dialog, 0.05); // `.app-role` is var(--bg-hover) over the dialog.
const inset = rgb(hexOf(sheet, '--people-inset'));
const addRow = rgb(hexOf(sheet, '--people-add'));
const addRowFocus = rgb(hexOf(sheet, '--people-add-focus'));
const rowHover = over(inset, 0.05);
const dim = rgb(hexOf(tokens, '--text-dim'));
const text = rgb(hexOf(tokens, '--text'));
const white = rgb('#ffffff');
const pairs = {
  'login on the inset card': [text, inset],
  'login on a hovered row': [text, rowHover],
  'remove × on a hovered row': [dim, rowHover],
  'placeholder on the add row': [dim, addRow],
  'placeholder on the focused add row': [dim, addRowFocus],
  'typed text on the add row': [text, addRow],
  'person-plus icon on the add row': [dim, addRow],
  'disabled Add label on its fill': [dim, rgb(hexOf(sheet, '--people-button-off'))],
  'enabled Add label on the accent fill': [white, rgb(hexOf(sheet, '--people-button-on'))],
  'hovered Add label on the hover fill': [white, rgb(hexOf(sheet, '--people-button-hover'))],
  'You tag on its tinted pill': [text, rgb(hexOf(sheet, '--people-you'))],
  'No members yet on the inset card': [dim, inset],
};

test('every text/fill pair in the members card keeps 4.5:1', () => {
  for (const [name, [foreground, background]] of Object.entries(pairs)) {
    assert.ok(ratio(foreground, background) >= 4.5, `${name}: ${ratio(foreground, background).toFixed(2)}:1`);
  }
  if (process.env.STACKI_CONTRAST_REPORT) {
    for (const [name, [foreground, background]] of Object.entries(pairs)) {
      console.log(`${ratio(foreground, background).toFixed(2)}:1  ${name}`);
    }
  }
});

test('the surfaces step: role card, a darker inset, an add row a step lighter than the inset', () => {
  assert.ok(ratio(roleCard, inset) >= 1.2, `inset against the role card: ${ratio(roleCard, inset).toFixed(2)}:1`);
  assert.ok(luminance(inset) < luminance(roleCard), 'the inset is darker than the role card');
  assert.ok(luminance(addRow) > luminance(inset), 'the add row is lighter than the inset');
  assert.ok(ratio(addRow, inset) >= 1.1, `add row against the inset: ${ratio(addRow, inset).toFixed(2)}:1`);
  assert.ok(luminance(addRowFocus) > luminance(addRow), 'focus lifts the add row');
});
