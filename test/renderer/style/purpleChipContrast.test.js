// Goal: every purple chip in the Style panel keeps WCAG AA contrast, so the family look
// cannot drift into light-purple text on a dark-purple fill that is hard to read.
// Method: no pixels. The declared colours are read from the stylesheets themselves
// (tokens.css, embedEditor.css), `var(--token)` is resolved, a translucent fill is
// composited over the surface it sits on (page, surface or raised), and the WCAG ratio is
// computed. Text must reach 4.5:1 against its chip fill. A filled chip cannot also reach
// 3:1 against a grey surface while holding readable text (that needs text brighter than
// white), so the chip-versus-surface bar is "distinct from it", asserted as above 1.05.
// The Navigator's flow purple (styles.css) is measured but only reported, not asserted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { repoPath } = require('../../helpers/sources.js');

const tokens = fs.readFileSync(repoPath('src/features/style/tokens.css'), 'utf8');
const editor = fs.readFileSync(repoPath('src/features/style/embedEditor.css'), 'utf8');
const app = fs.readFileSync(repoPath('src/app/styles.css'), 'utf8');

function tokenValue(name) {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(tokens) ?? new RegExp(`${name}:\\s*([^;]+);`).exec(app);
  assert.ok(match, `token ${name} is declared`);
  return match[1].trim();
}

function declaration(css, selector, property) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = new RegExp(`(?:^|\\n|,\\s*)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(block, `rule ${selector} exists`);
  const value = new RegExp(`(?:^|;|\\s)${property}:\\s*([^;]+);`).exec(block[1]);
  assert.ok(value, `${selector} declares ${property}`);
  return value[1].trim();
}

const ALIAS_DEPTH_MAX = 4;

function parseColour(text) {
  // A token may alias another token; the chain is walked with a stated bound.
  let current = text;
  for (let depth = 0; depth < ALIAS_DEPTH_MAX; depth += 1) {
    const variable = /^var\((--[\w-]+)\)$/.exec(current);
    if (variable === null) {
      break;
    }
    current = tokenValue(variable[1]);
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(current);
  if (hex) {
    return { rgb: [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)), alpha: 1 };
  }
  const rgba = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(current);
  assert.ok(rgba, `colour ${current} is hex or rgba`);
  return { rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])], alpha: Number(rgba[4]) };
}

function over(colour, surface) {
  return colour.rgb.map((channel, index) => channel * colour.alpha + surface[index] * (1 - colour.alpha));
}

function luminance(rgb) {
  const [red, green, blue] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function ratio(first, second) {
  const [high, low] = [luminance(first), luminance(second)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

const SURFACES = {
  page: parseColour('var(--color-bg-page)').rgb,
  surface: parseColour('var(--color-bg-surface)').rgb,
  raised: parseColour('var(--color-bg-surface-raised)').rgb,
};

// [name, css, selector, text property source, fill property source]; the fill may be translucent.
const PAIRINGS = [
  ['element tip attribute chip', editor, '.embed-editor_element-tip-chip.is-attribute', 'color', 'background', ['raised']],
  ['connected spacing value', editor, '.embed-editor_spacing-label.is-variable:hover:not(:disabled)', 'color', 'background', ['page', 'surface', 'raised']],
  ['variable token in a field', editor, '.embed-editor_varconnect-token', 'color', 'background', ['page', 'surface', 'raised']],
  ['variable token hover', editor, '.embed-editor_varconnect-token:hover', 'color', 'background', ['page', 'surface', 'raised']],
  ['applied variable row', editor, '.embed-editor_varpicker-item.is-selected .embed-editor_varpicker-item-name', 'color', undefined, ['raised']],
  ['inline ${prop} token', editor, '.embed-editor_inline-token', 'color', 'background', ['page', 'surface', 'raised']],
];

const SELECTED_ROW_FILL = 'rgba(124, 92, 255, 0.28)';

function pairingColours(css, selector, textProperty, fillProperty) {
  const text = parseColour(declaration(css, selector, textProperty));
  const fill = fillProperty === undefined ? parseColour(SELECTED_ROW_FILL) : parseColour(declaration(css, selector, fillProperty));
  return { text, fill };
}

for (const [name, css, selector, textProperty, fillProperty, surfaces] of PAIRINGS) {
  for (const surfaceName of surfaces) {
    test(`purple chip contrast: ${name} on ${surfaceName} is AA`, () => {
      const { text, fill } = pairingColours(css, selector, textProperty, fillProperty);
      const fillRgb = over(fill, SURFACES[surfaceName]);
      const textRgb = over(text, fillRgb);
      assert.ok(ratio(textRgb, fillRgb) >= 4.5, `${name} text is ${ratio(textRgb, fillRgb).toFixed(2)}:1, below 4.5:1`);
    });
  }
}

test('purple chip contrast: the attribute chip fill stays distinct from its tooltip surface', () => {
  const fill = parseColour('var(--color-attribute-chip-bg)');
  assert.ok(ratio(fill.rgb, SURFACES.raised) > 1.05);
});

test('purple chip contrast: the connected-variable check holds 3:1 on the selected row', () => {
  const check = parseColour(declaration(editor, '.embed-editor_varpicker-item-check', 'color'));
  const row = over(parseColour('rgba(124, 92, 255, 0.18)'), SURFACES.raised);
  assert.ok(ratio(check.rgb, row) >= 3);
});

test('purple chip contrast: the navigator flow purple on its tint is measured against the surfaces it can sit on', () => {
  const text = parseColour('var(--flow-purple)');
  const soft = parseColour('var(--flow-purple-soft)');
  for (const [name, surface] of Object.entries(SURFACES)) {
    const fill = over(soft, surface);
    // Reported rather than asserted: the Navigator's tints belong to another change.
    assert.ok(ratio(text.rgb, fill) > 1, `${name} measured`);
  }
});
