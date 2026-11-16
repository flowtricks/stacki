// Goal: the attribute-selector chips in the element tooltip ([data-x], [style="…"]) are a
// saturated purple with white text, as the blue class chip beside them is a saturated blue
// with white text, and hold WCAG AA. Every OTHER purple chip (the box-model's connected
// spacing value, variable tokens, the inline ${prop} token) keeps its original colours:
// an earlier change restyled them too, which the owner did not ask for, so they are pinned
// to their original values here and cannot drift again.
// Method: no pixels. The declared colours are read from the stylesheets themselves
// (tokens.css, embedEditor.css), `var(--token)` is resolved, and the WCAG ratio is computed.
// White on the attribute fill must reach 4.5:1 (it is about 5.5). The fill must stand off the
// tooltip's grey at least as far as the blue chip does (about 2.1:1). It cannot reach 3:1 as
// well: 3:1 against that grey needs a fill so bright that white text falls to about 3.7:1,
// so the two bars are mutually exclusive for any grey surface and the blue chip makes the
// same trade.
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

const WHITE = [255, 255, 255];

test('attribute chip: white text on a bright purple fill, AA, as far off the tooltip as the blue chip', () => {
  const selector = '.embed-editor_element-tip-chip.is-attribute';
  const text = parseColour(declaration(editor, selector, 'color'));
  const fill = parseColour(declaration(editor, selector, 'background'));
  assert.equal(fill.alpha, 1, 'the fill is solid');
  assert.deepEqual(text.rgb, WHITE, 'the text is white');
  assert.ok(ratio(text.rgb, fill.rgb) >= 4.5, `white on the fill is ${ratio(text.rgb, fill.rgb).toFixed(2)}:1`);
  assert.ok(ratio(text.rgb, fill.rgb) >= 5.4, 'and at least 5.4:1');
  const blue = parseColour('var(--color-class-tag-bg)').rgb;
  assert.ok(ratio(fill.rgb, SURFACES.raised) >= ratio(blue, SURFACES.raised) - 0.2, 'as far off the tooltip as the blue class chip');
  assert.ok(luminance(fill.rgb) > luminance([0x45, 0x3b, 0x63]) * 2, 'much brighter than the old dark purple');
  assert.ok(fill.rgb[2] > fill.rgb[0] && fill.rgb[2] > fill.rgb[1], 'a purple: blue is its strongest channel');
});

test('attribute chip: its tokens are used only by the tooltip chip', () => {
  for (const [name, css] of [
    ['embedEditor.css', editor],
    ['styles.css', app],
  ]) {
    const uses = css.split('\n').filter((line) => line.includes('--color-attribute-chip'));
    assert.ok(name === 'styles.css' ? uses.length === 0 : uses.length === 2, `${name}: ${uses.length} uses`);
  }
});

// The pairings every other purple chip had before: (selector, property) -> declared text.
const ORIGINAL = [
  ['.embed-editor_spacing-label.is-variable,\n.embed-editor_spacing-label.is-variable:hover:not(:disabled)', 'color', '#c4afff'],
  ['.embed-editor_spacing-label.is-variable,\n.embed-editor_spacing-label.is-variable:hover:not(:disabled)', 'background', '#453b63'],
  ['.embed-editor_varconnect-token', 'color', '#cbbcff'],
  ['.embed-editor_varconnect-token', 'background', 'rgba(124, 92, 255, 0.28)'],
  ['.embed-editor_varconnect-token:hover', 'background', 'rgba(124, 92, 255, 0.42)'],
  ['.embed-editor_inline-token', 'color', '#d8b4fe'],
  ['.embed-editor_inline-token', 'background', 'rgba(168, 85, 247, 0.22)'],
  ['.embed-editor_varpicker-item.is-selected', 'background', 'rgba(124, 92, 255, 0.18)'],
  ['.embed-editor_varpicker-item-check', 'color', '#9980ff'],
];

for (const [selector, property, value] of ORIGINAL) {
  test(`other purple chips keep their original ${property}: ${selector.split('\n')[0]}`, () => {
    const block = editor.indexOf(`${selector} {`);
    assert.ok(block >= 0, `rule ${selector} exists`);
    const body = editor.slice(block, editor.indexOf('}', block));
    assert.ok(new RegExp(`(?:^|[;{\\s])${property}:\\s*${value.replace(/[()., ]/g, (character) => `\\${character}`)};`).test(body), `${property} is ${value}`);
  });
}
