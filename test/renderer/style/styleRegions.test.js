// Goal: the style panel finds a file's `<style>` blocks in its markup only. A component whose
// frontmatter mentions `<style is:global>` (a comment, a string) had that text read as a tag:
// the region ran from there to the real block's `</style>`, did not parse, and the block's
// rules were never offered (SP-14: the soak's SoakGlobalCard paragraph got no `.soak-gcard`
// chip and its edits never reached the component file). The same holds for a `<style` inside
// an HTML comment.
// Method: the real cssRegions.ts (bundled as the app bundles it) splits fixture texts; the
// regions found, their CSS, whether they parse, and the file rebuilt from them are compared.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule.js');

const css = loadRenderer('src/features/style/model/css.ts');
const regionsModule = loadRenderer('src/features/style/model/cssRegions.ts');

const BLOCK = ['<style is:global>', '  .card {', '    color: red;', '  }', '</style>', ''].join('\n');
const parsedRules = (code) => css.splitEmbed(code).regions.map((region) => css.parseRegion(region));

test('a <style> named in the frontmatter is not a block', () => {
  const code = ['---', '// The rule below lives in a <style is:global> block.', 'const tag = "<style>";', '---', '<p class="card">Hi</p>', '', BLOCK].join(
    '\n',
  );
  const regions = parsedRules(code);
  assert.equal(regions.length, 1, 'one block, the real one');
  assert.equal(regions[0].openTag, '<style is:global>');
  assert.equal(regions[0].parseError, undefined, 'the block parses');
  assert.match(regions[0].root.toString(), /\.card \{/);
  const { segments } = css.splitEmbed(code);
  assert.equal(css.renderEmbed(segments, regions), code, 'the file rebuilds byte for byte');
});

test('a <style> inside an HTML comment is not a block', () => {
  const code = ['<!-- an old <style> block was here -->', '<p class="card">Hi</p>', BLOCK].join('\n');
  const regions = parsedRules(code);
  assert.equal(regions.length, 1);
  assert.equal(regions[0].openTag, '<style is:global>', 'the block is the real one');
  assert.equal(regions[0].parseError, undefined);
});

test('files without frontmatter or comments read as before', () => {
  assert.equal(parsedRules(BLOCK).length, 1, 'a bare block');
  assert.equal(parsedRules(['<div>', BLOCK, BLOCK].join('\n')).length, 2, 'two blocks');
  assert.equal(parsedRules('.card { color: red; }').length, 0, 'a stylesheet has no tags');
});

test('the frontmatter fence is found only at the top and only when it closes', () => {
  assert.equal(regionsModule.frontmatterEnd('---\nconst a = 1;\n---\n<p/>'), '---\nconst a = 1;\n---'.length);
  assert.equal(regionsModule.frontmatterEnd('<p/>\n---\n'), 0, 'a later --- is markup');
  assert.equal(regionsModule.frontmatterEnd('---\nconst a = 1;\n'), 0, 'an unclosed fence hides nothing');
});
