// Goal: every purple chip in the Style panel is a saturated purple fill with white text, as
// the blue class chip is a saturated blue fill with white text, and keeps WCAG AA contrast in
// every state. The owner found a dark-purple fill with light-purple text too faint, whatever
// its ratio, so the direction is a bright fill, not a lighter text on a dark one.
// Method: no pixels. The declared colours are read from the stylesheets themselves
// (tokens.css, embedEditor.css), `var(--token)` is resolved, and the WCAG ratio is computed.
// White text must reach 4.5:1 on the fill at rest and on hover (the tokens sit at about 5.4
// and 5.0). The fill must stand off the tooltip's grey at least as far as the blue chip
// does (about 2.1:1). It cannot reach 3:1 as well: 3:1 against that grey needs a fill so
// bright that white text on it falls to about 3.7:1, so the two bars are mutually exclusive
// for any grey surface, and the blue chip makes the same trade. The Navigator's flow purple
// (styles.css) is not part of this.
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

// [name, selector whose rule paints the chip, property holding its fill].
const CHIPS = [
  ['element tip attribute chip', '.embed-editor_element-tip-chip.is-attribute'],
  ['connected spacing value', '.embed-editor_spacing-label.is-variable'],
  ['connected spacing value, hover', '.embed-editor_spacing-label.is-variable:hover:not(:disabled)'],
  ['variable token in a field', '.embed-editor_varconnect-token'],
  ['variable token, hover and focus', '.embed-editor_varconnect-token:hover'],
  ['inline ${prop} token', '.embed-editor_inline-token'],
];

const WHITE = [255, 255, 255];

for (const [name, selector] of CHIPS) {
  test(`purple chip contrast: ${name} is white on a bright purple, AA`, () => {
    const text = parseColour(declaration(editor, selector, 'color'));
    const fill = parseColour(declaration(editor, selector, 'background'));
    assert.equal(fill.alpha, 1, 'the fill is solid');
    assert.deepEqual(text.rgb, WHITE, 'the text is white');
    const value = ratio(text.rgb, fill.rgb);
    assert.ok(value >= 4.5, `${name} is ${value.toFixed(2)}:1, below 4.5:1`);
    assert.ok(value >= 4.9, `${name} is ${value.toFixed(2)}:1, below the 4.9:1 this design keeps in every state`);
  });
}

test('purple chip contrast: the rest fill is as bright a purple as the app asks for, and clearly off the tooltip', () => {
  const fill = parseColour('var(--color-attribute-chip-bg)').rgb;
  const tooltip = SURFACES.raised;
  const blue = parseColour('var(--color-class-tag-bg)').rgb;
  assert.ok(ratio(WHITE, fill) >= 5.4, 'white on the rest fill is at least 5.4:1');
  assert.ok(ratio(fill, tooltip) >= ratio(blue, tooltip) - 0.2, 'the fill stands off the tooltip as far as the blue class chip does');
  assert.ok(ratio(fill, tooltip) >= 2, 'at least 2:1 against the tooltip');
  assert.ok(luminance(fill) > luminance([0x3a, 0x2f, 0x66]) * 2, 'much brighter than the old dark purple');
  assert.ok(fill[2] > fill[0] && fill[2] > fill[1], 'a purple: blue is its strongest channel');
});
