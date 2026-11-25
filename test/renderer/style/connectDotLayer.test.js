// The variable-connect dot paints above the neighbouring fields and below open menus.
//
//   node test/renderer/style/connectDotLayer.test.js
//
// Goal: the purple dot sits on the corner of a field and overlaps the field above it
// (Weight over Size). A closed Select used to sit at --z-modal (1000) while the dot sat
// at 4, so the Weight trigger painted over the top of the dot and clipped it. The scale
// is now field < connect dot < popover, written once in tokens.css.
// Method: jsdom cannot compute stacking, so this reads the stylesheet text. It resolves
// the z-index of a closed select, the dot and an open select to numbers through the
// tokens (calc included) and asserts the order, and that the dot is not clipped by
// its own wrapper (no overflow, no stacking context on .embed-editor_varconnect).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { repoPath } = require('../../helpers/sources.js');

const read = (name) => fs.readFileSync(repoPath(`src/features/style/${name}`), 'utf8');
const tokens = read('tokens.css');
const utilities = read('utilities.css');
const embed = read('embedEditor.css');

const declaration = (css, selector, property) => {
  const start = css.indexOf(`\n${selector} {`);
  assert.notEqual(start, -1, `${selector} rule exists`);
  const body = css.slice(start, css.indexOf('\n}', start));
  return new RegExp(`^\\s*${property}:\\s*([^;]+);`, 'm').exec(body)?.[1].trim();
};

const tokenValue = (name) => {
  const value = new RegExp(`${name}:\\s*([^;]+);`).exec(tokens)?.[1].trim();
  assert.ok(value !== undefined, `${name} is defined in tokens.css`);
  return value;
};

// Tokens nest a few deep (popover -> modal); the pass count is the bound.
const TOKEN_DEPTH_MAX = 5;
const resolve = (expression) => {
  let text = expression;
  for (let pass = 0; pass < TOKEN_DEPTH_MAX && text.includes('var('); pass += 1) {
    text = text.replace(/var\((--[\w-]+)\)/g, (_all, name) => `(${tokenValue(name)})`);
  }
  text = text.replace(/calc/g, '');
  assert.match(text, /^[\d\s()+]+$/, `only numbers remain in ${expression}`);
  return Function(`"use strict"; return (${text});`)();
};

test('the layering scale is field < connect dot < popover < tooltip', () => {
  const field = resolve(tokenValue('--z-style-field'));
  const connect = resolve(tokenValue('--z-style-connect'));
  const popover = resolve(tokenValue('--z-style-popover'));
  assert.ok(field < connect, 'a closed field sits below the dot');
  assert.ok(connect < popover, 'an open menu covers the dot');
  assert.ok(popover < resolve('var(--z-tooltip)'), 'tooltips cover popovers');
});

test('the dot, closed selects and open selects use their tiers', () => {
  assert.equal(declaration(embed, '.embed-editor_varconnect-dot', 'z-index'), 'var(--z-style-connect)');
  assert.equal(declaration(utilities, '.u-select', 'z-index'), 'var(--z-style-field)');
  assert.equal(declaration(utilities, '.u-select.is-open', 'z-index'), 'var(--z-style-popover)');
});

test('the dot wrapper neither clips nor traps the dot in its own stacking context', () => {
  for (const property of ['overflow', 'z-index', 'transform', 'filter', 'isolation', 'contain', 'will-change']) {
    assert.equal(declaration(embed, '.embed-editor_varconnect', property), undefined, `${property} is not set on the wrapper`);
  }
});
