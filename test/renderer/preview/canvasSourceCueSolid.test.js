// Goal: the purple chip shown while editing text printed from data is opaque. It sits over the
// page, and a translucent fill let the button and words under it show through.
// Method: read the stylesheet's rules for the chip and its parts and check that every colour is
// a solid hex value and that no opacity, alpha colour or mix with transparent is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { repoPath } = require('../../helpers/sources.js');

const css = fs.readFileSync(repoPath('src/app/styles.css'), 'utf8');

function rule(selector) {
  const start = css.indexOf(`\n${selector} {`);
  assert.ok(start >= 0, `${selector} has a rule`);
  return css.slice(start, css.indexOf('\n}', start));
}

test('the source cue and its parts use solid colours only', () => {
  for (const selector of ['.canvas-source-cue', '.canvas-source-cue-path', '.canvas-source-cue-uses']) {
    const body = rule(selector).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(body, /opacity\s*:/, `${selector}: no opacity`);
    assert.doesNotMatch(body, /rgba?\(|hsla?\(|color-mix|transparent/, `${selector}: no alpha colour`);
  }
  assert.match(rule('.canvas-source-cue'), /background:\s*#[0-9a-f]{6};/i, 'the chip fill is a solid hex colour');
});

test('the chip sits above the page content', () => {
  assert.match(rule('.canvas-source-cue'), /z-index:\s*2147483000;/);
  assert.match(rule('.canvas-source-cue'), /position:\s*fixed;/);
});
