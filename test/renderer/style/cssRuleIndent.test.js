// Goal: a rule the style panel adds to a page's <style> block is formatted like
// the rules already there. PostCSS indents a closing brace by nesting depth,
// and a top-level rule has none, so in an indented block a new rule's `}` used
// to land at column 0.
// Method: the real css.ts (bundled as the app bundles it) splits a page into
// its <style> regions, adds a rule at the root through the same function the
// panel uses, and renders the page back; the output is compared byte for byte.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule.js');

const css = loadRenderer('src/features/style/model/css.ts');

const render = (page, selector, prop, value) => {
  const { segments, regions } = css.splitEmbed(page);
  assert.equal(regions.length, 1, 'the page has one <style> region');
  const region = css.parseRegion(regions[0]);
  assert.equal(css.createRuleAtRoot(region, selector, prop, { value, important: false }), true);
  return css.renderEmbed(segments, [region]);
};

test('a new rule in an indented <style> block closes at the block indent', () => {
  const page = ['<style>', '  .hero {', '    color: red;', '  }', '</style>', ''].join('\n');
  const expected = ['<style>', '  .hero {', '    color: red;', '  }', '  .is-big {', '    font-size: 22px;', '  }', '</style>', ''].join('\n');
  assert.equal(render(page, '.is-big', 'font-size', '22px'), expected);
});

test('a block written flush left keeps its flush-left rules', () => {
  const page = ['<style>', '.hero {', '  color: red;', '}', '</style>', ''].join('\n');
  const expected = ['<style>', '.hero {', '  color: red;', '}', '.is-big {', '  font-size: 22px;', '}', '</style>', ''].join('\n');
  assert.equal(render(page, '.is-big', 'font-size', '22px'), expected);
});

test('an existing rule for the selector is extended, not duplicated', () => {
  const page = ['<style>', '  .hero {', '    color: red;', '  }', '</style>', ''].join('\n');
  const output = render(page, '.hero', 'font-size', '22px');
  assert.equal(output.match(/\.hero \{/g)?.length, 1);
  assert.match(output, / {4}font-size: 22px;/);
});
