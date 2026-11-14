// Goal: the variable picker's text stays readable on the menu it is drawn on.
// Its secondary text (each row's value, the scope label, the type icon, the empty
// message) was the tertiary grey, dim on the overlay; the search field was a black well.
// Method: the style editor's `:root` tokens are read as text, `var()` aliases resolved,
// and WCAG 2 contrast measured for each text token against the overlay surface (the
// menu), the selected row's tint composited over it, and the search field's fill. The
// picker's rules are read from embedEditor.css to find which token each part uses, so a
// rule pointed back at a dimmer token fails here. The app has one theme (dark): there
// is no light token set to measure. Ratios are printed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { repoPath } = require('../../helpers/sources.js');

const AA_NORMAL = 4.5;

const tokens = new Map();
const css = fs.readFileSync(repoPath('src/features/style/tokens.css'), 'utf8');
for (const match of /:root\s*\{([\s\S]*?)\n\}/.exec(css)[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
  tokens.set(match[1], match[2].trim());
}
const resolve = (name) => {
  let value = tokens.get(name);
  for (let depth = 0; depth < 8 && /^var\(/.test(value ?? ''); depth += 1) {
    value = tokens.get(/^var\((--[a-z0-9-]+)\)$/.exec(value)[1]);
  }
  assert.ok(value !== undefined && !value.startsWith('var('), `token ${name} resolves`);
  return value;
};
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const luminance = ([red, green, blue]) => {
  const [redLinear, greenLinear, blueLinear] = [red, green, blue].map((channel) => {
    const unit = channel / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * redLinear + 0.7152 * greenLinear + 0.0722 * blueLinear;
};
const contrast = (first, second) => {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
};
const over = (tint, alpha, base) => base.map((channel, i) => channel + alpha * (tint[i] - channel));

const embed = fs.readFileSync(repoPath('src/features/style/embedEditor.css'), 'utf8');
const tokenUsedBy = (selector) => {
  const start = embed.indexOf(`\n${selector} {`);
  assert.ok(start >= 0, `${selector} is styled`);
  const block = embed.slice(start, embed.indexOf('}', start));
  return /(?:^|\s)color:\s*var\((--[a-z0-9-]+)\)/m.exec(block)?.[1];
};

// The picker's own surface: one step darker than the overlay other menus use.
const overlay = rgbOf(resolve('--color-bg-surface'));
const selectedRow = over([124, 92, 255], 0.18, overlay);
const selectedRowHover = over([124, 92, 255], 0.28, overlay);
const searchFill = rgbOf(resolve('--color-bg-surface-raised'));

test('the picker text parts use a token that clears AA on the menu and on the selected row', () => {
  const parts = [
    '.embed-editor_varpicker-item-value',
    '.embed-editor_varpicker-item-icon',
    '.embed-editor_varpicker-group-name',
    '.embed-editor_varpicker-empty',
    '.embed-editor_varpicker-collection-arrow',
    '.embed-editor_varpicker-collection-name',
  ];
  for (const part of parts) {
    const token = tokenUsedBy(part);
    assert.ok(token, `${part} has a text colour token`);
    const text = rgbOf(resolve(token));
    for (const [surfaceName, surface] of [
      ['menu', overlay],
      ['selected row', selectedRow],
      ['selected row hover', selectedRowHover],
    ]) {
      const ratio = contrast(text, surface);
      console.log(`  ${part} ${token} on ${surfaceName}: ${ratio.toFixed(2)}:1`);
      if (part !== '.embed-editor_varpicker-item-icon' || surfaceName === 'menu') {
        assert.ok(ratio >= AA_NORMAL, `${part} on ${surfaceName} is ${ratio.toFixed(2)}:1`);
      }
    }
  }
});

test('the value text is brighter than the tertiary grey it replaced', () => {
  const before = contrast(rgbOf(resolve('--color-text-tertiary')), overlay);
  const after = contrast(rgbOf(resolve(tokenUsedBy('.embed-editor_varpicker-item-value'))), overlay);
  console.log(`  value text on menu: ${before.toFixed(2)}:1 before, ${after.toFixed(2)}:1 after`);
  assert.ok(after > before + 1, `${after} vs ${before}`);
});

test('the selected row stays distinct from the menu and its name clears AA on it', () => {
  assert.ok(contrast(selectedRow, overlay) > 1.05, 'the tint differs from the menu');
  assert.ok(contrast(rgbOf('#cbbcff'), selectedRow) >= AA_NORMAL);
});

test('the search field is no longer the black well, and its text and placeholder clear AA', () => {
  assert.ok(/\.embed-editor_varpicker \.embed-editor_varpicker-search \{[^}]*background: var\(--color-bg-surface-raised\)/.test(embed));
  for (const token of ['--color-text-primary', '--color-text-tertiary']) {
    const ratio = contrast(rgbOf(resolve(token)), searchFill);
    console.log(`  search ${token}: ${ratio.toFixed(2)}:1 (black well was ${contrast(rgbOf(resolve(token)), [0, 0, 0]).toFixed(2)}:1)`);
    assert.ok(ratio >= AA_NORMAL);
  }
});
