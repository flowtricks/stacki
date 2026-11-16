// Goal: the inactive selector chips (blue class, grey plain, green component) keep the same
// full-strength text as the green chip, and every state of all three holds WCAG AA. A chip
// styled only in another query (`is-dimmed`) used to be drawn at half opacity, which washed
// its text out (white at 50% is #808080: about 4:1 on blue and 2:1 on grey) while the green
// chip beside it, not dimmed, kept its text. "Not here" now shows in the fill.
// Method: no pixels. The declared colours are read from tokens.css and embedEditor.css;
// `var()` and the one `color-mix(in srgb, X p%, #000)` the resting blue fill uses are
// resolved; translucent fills are composited over the well's black. Text on fill must reach
// 4.5:1 at rest, hover, active and dimmed for each family. The dimmed rules must not set a
// colour or leave opacity below 1. The purple chips are pinned in purpleChipContrast.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { repoPath } = require('../../helpers/sources.js');

const tokens = fs.readFileSync(repoPath('src/features/style/tokens.css'), 'utf8');
const editor = fs.readFileSync(repoPath('src/features/style/embedEditor.css'), 'utf8');
const WELL = [0, 0, 0];
const ALIAS_DEPTH_MAX = 4;

function tokenValue(name) {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(tokens);
  assert.ok(match, `token ${name} is declared`);
  return match[1].trim();
}

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(editor);
  assert.ok(block, `rule ${selector} exists`);
  return block[1];
}

function declared(selector, property) {
  const value = new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+);`).exec(rule(selector));
  assert.ok(value, `${selector} declares ${property}`);
  return value[1].trim();
}

function alias(text) {
  let current = text;
  for (let depth = 0; depth < ALIAS_DEPTH_MAX; depth += 1) {
    const variable = /^var\((--[\w-]+)\)$/.exec(current);
    if (variable === null) {
      break;
    }
    current = tokenValue(variable[1]);
  }
  return current;
}

function plain(text) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const full = hex[1].length === 3 ? [...hex[1]].map((digit) => digit + digit).join('') : hex[1];
    return { rgb: [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)), alpha: 1 };
  }
  const rgba = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(text);
  assert.ok(rgba, `colour ${text} is hex or rgba`);
  return { rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])], alpha: Number(rgba[4]) };
}

function parse(text) {
  const current = alias(text);
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+(\d+)%,\s*#000\)$/.exec(current);
  if (mix === null) {
    return plain(current);
  }
  const base = plain(alias(mix[1]));
  return { rgb: base.rgb.map((channel) => (channel * Number(mix[2])) / 100), alpha: 1 };
}

const over = (colour) => colour.rgb.map((channel) => channel * colour.alpha + WELL[0] * (1 - colour.alpha));

function luminance(rgb) {
  const [red, green, blue] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function ratio(first, second) {
  const [high, low] = [luminance(first), luminance(second)].sort((left, right) => right - left);
  return (high + 0.05) / (low + 0.05);
}

const CHIP = '.embed-editor_selector-chip';
// [family, state, text source, fill source]; a source is a [selector, property] or a literal.
const STATES = [
  ['blue', 'inactive', [CHIP, 'color'], [`${CHIP}:not(.is-active):not(.is-pending)`, 'background']],
  ['blue', 'hover', [CHIP, 'color'], [`${CHIP}:not(.is-active):not(.is-pending):hover:not(:disabled)`, 'background']],
  ['blue', 'active', [CHIP, 'color'], [`${CHIP}.is-active`, 'background']],
  ['blue', 'dimmed', [CHIP, 'color'], 'var(--color-class-tag-bg-dimmed)'],
  ['grey', 'inactive', [`${CHIP}.is-plain:not(.is-pending)`, 'color'], [`${CHIP}.is-plain:not(.is-pending)`, 'background']],
  [
    'grey',
    'hover',
    [`${CHIP}.is-plain:not(.is-pending):not(.is-active):hover:not(:disabled)`, 'color'],
    [`${CHIP}.is-plain:not(.is-pending):not(.is-active):hover:not(:disabled)`, 'background'],
  ],
  ['grey', 'active', [`${CHIP}.is-plain.is-active:not(.is-pending)`, 'color'], [`${CHIP}.is-plain.is-active:not(.is-pending)`, 'background']],
  ['grey', 'dimmed', [`${CHIP}.is-plain:not(.is-pending)`, 'color'], 'var(--color-selector-context-bg-dimmed)'],
  ['green', 'inactive', [`${CHIP}.is-component:not(.is-pending)`, 'color'], [`${CHIP}.is-component:not(.is-pending)`, 'background']],
  [
    'green',
    'hover',
    [`${CHIP}.is-component:not(.is-pending):not(.is-active):hover:not(:disabled)`, 'color'],
    [`${CHIP}.is-component:not(.is-pending):not(.is-active):hover:not(:disabled)`, 'background'],
  ],
  ['green', 'active', [`${CHIP}.is-component.is-active:not(.is-pending)`, 'color'], [`${CHIP}.is-component.is-active:not(.is-pending)`, 'background']],
  ['green', 'dimmed', [`${CHIP}.is-component:not(.is-pending)`, 'color'], 'var(--color-component-tag-bg-dimmed)'],
];

const sourceValue = (source) => (typeof source === 'string' ? source : declared(source[0], source[1]));

for (const [family, state, textSource, fillSource] of STATES) {
  test(`selector chip contrast: ${family} ${state} text holds AA`, () => {
    const fill = over(parse(sourceValue(fillSource)));
    const text = parse(sourceValue(textSource));
    assert.equal(text.alpha, 1, 'the text is opaque');
    const value = ratio(text.rgb, fill);
    assert.ok(value >= 4.5, `${family} ${state}: ${value.toFixed(2)}:1, below 4.5:1`);
  });
}

test('selector chip contrast: a dimmed chip keeps its text at full strength, in all three families', () => {
  const selectors = [
    `${CHIP}.is-dimmed:not(.is-inline):not(.is-pending)`,
    `${CHIP}.is-dimmed:not(.is-inline):not(.is-pending):not(.is-active):not(.is-plain):not(.is-component):not(:hover)`,
    `${CHIP}.is-dimmed.is-plain:not(.is-inline):not(.is-pending):not(.is-active):not(:hover)`,
    `${CHIP}.is-dimmed.is-component:not(.is-inline):not(.is-pending):not(.is-active):not(:hover)`,
  ];
  assert.equal(declared(selectors[0], 'opacity'), '1');
  for (const selector of selectors) {
    assert.doesNotMatch(rule(selector), /(?:^|[;\s])color:/, `${selector} leaves the text colour alone`);
    assert.doesNotMatch(rule(selector), /opacity:\s*0?\.\d/, `${selector} does not fade the chip`);
  }
});

test('selector chip contrast: a dimmed fill is darker than the resting one, so the state still shows', () => {
  const rest = (selector) => luminance(over(parse(declared(selector, 'background'))));
  assert.ok(luminance(over(parse('var(--color-class-tag-bg-dimmed)'))) < rest(`${CHIP}:not(.is-active):not(.is-pending)`));
  assert.ok(luminance(over(parse('var(--color-selector-context-bg-dimmed)'))) < rest(`${CHIP}.is-plain:not(.is-pending)`));
  assert.ok(luminance(over(parse('var(--color-component-tag-bg-dimmed)'))) < rest(`${CHIP}.is-component:not(.is-pending)`));
});
