// What a name typed in the selector box means.
//
//   node test/class-input.js
//
// Webflow's field is a class field: `hero` is `.hero`. This box also takes real
// selectors, so only a bare word that is not an HTML tag is promoted to a class;
// `section` stays the tag, and anything with a dot, colon, combinator or bracket is
// left exactly as typed.

const fs = require('fs');
const path = require('path');

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const out = path.join(buildDir, 'class-input.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'style-panel', 'lib', 'class-input.ts')],
    outfile: out, bundle: true, format: 'cjs', platform: 'node', logLevel: 'silent',
  });
  const { selectorFromTyped, isTagSelector, HTML_TAG_NAMES } = require(out);
  const cases = [
    ['u-section', '.u-section'], ['  hero ', '.hero'], ['card_wrap', '.card_wrap'],
    ['section', 'section'], ['DIV', 'DIV'], ['p', 'p'],
    ['.card', '.card'], ['.card:hover', '.card:hover'], ['ul > li', 'ul > li'],
    ['a[href]', 'a[href]'], ['#main', '#main'], ['', ''],
  ];
  const failures = cases.filter(([input, want]) => selectorFromTyped(input) !== want)
    .map(([input, want]) => `  ${JSON.stringify(input)} → ${JSON.stringify(selectorFromTyped(input))}, wanted ${JSON.stringify(want)}`);
  const tags = [['h2', true], ['P', true], ['section', true], ['.h2', false], ['hero', false], ['h2:hover', false], ['ul li', false]];
  for (const [input, want] of tags) {
    if (isTagSelector(input) !== want) {failures.push(`  isTagSelector(${JSON.stringify(input)}) should be ${want}`);}
  }
  for (const tag of ['h1', 'h2', 'p', 'a', 'section', 'li']) {
    if (!HTML_TAG_NAMES.includes(tag)) {failures.push(`  ${tag} is missing from the tag list`);}
  }
  if (failures.length) {
    console.error(`class-input: ${failures.length} of ${cases.length} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`class-input: ${cases.length + tags.length + 6} checks passed`);
})();
