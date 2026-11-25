// Typing a custom property into the Add property row.
//
//   node test/renderer/style/customProperty.test.js
//
// Two things were missing from a row that exists to set one.
//
// The suggestions knew every property CSS has and none of the ones this project
// wrote. Typing `-` — which is how every custom property starts — opened a list
// of `-webkit-align-content` and its two hundred relatives, and `--light-300`,
// which is declared in this project and used all over it, was not in there
// anywhere.
//
// And Enter did nothing. A property name with no value is not a declaration, so
// the submit behind that key had nothing to write and quietly declined —
// leaving the caret in the field it was already in, next to the empty one that
// was the whole reason the key was pressed.

const fs = require('fs');
const path = require('path');
const { containsCode, readSourceFolder } = require('../../helpers/sourceText.js');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const out = path.join(buildDirectory, 'custom-property.cjs');
  await esbuild.build({
    stdin: {
      contents: 'export { filterCssProperties, CSS_PROPERTIES } from ' + "'./src/features/style/model/cssProperties'",
      resolveDir: ROOT,
      loader: 'tsx',
    },
    outfile: out,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const { filterCssProperties, CSS_PROPERTIES } = require(out);

  const VARS = ['--brand-500', '--light-300', '--space-4'];
  const first = (query, count = 4) => filterCssProperties(query, VARS).slice(0, count);

  // --- the project's own properties are properties ---------------------------------
  check('typing a dash offers this project first', first('-', 3).join() === '--brand-500,--light-300,--space-4', first('-', 6).join());
  check('and the vendor-prefixed ones after it', first('-', 4)[3].startsWith('-webkit-'), first('-', 4)[3]);
  check('a name narrows to the one', filterCssProperties('--l', VARS).join() === '--light-300', filterCssProperties('--l', VARS).join());
  check('and the middle of a name finds it too', filterCssProperties('brand', VARS).join() === '--brand-500', filterCssProperties('brand', VARS).join());
  check(
    'a standard property is still what a standard query offers',
    first('align', 3).join() === 'align-content,align-items,align-self',
    first('align', 3).join(),
  );
  check(
    '-webkit- is still reachable by name',
    filterCssProperties('-webkit-align', VARS)[0] === '-webkit-align-content',
    filterCssProperties('-webkit-align', VARS)[0],
  );
  check(
    'an empty field opens on everything, this project included',
    filterCssProperties('', VARS)[0] === '--brand-500' && filterCssProperties('', VARS).length === VARS.length + CSS_PROPERTIES.length,
    `${filterCssProperties('', VARS).length}`,
  );
  check(
    'a project with no variables is the list as it was',
    filterCssProperties('align').join() === filterCssProperties('align', []).join(),
    'the two disagree',
  );
  check('and nothing is offered twice', new Set(filterCssProperties('-', VARS)).size === filterCssProperties('-', VARS).length, 'a duplicate');

  // --- Enter goes where the rest of the answer is ------------------------------------
  // The style editor and the modules it was split into (src/features/style/embed).
  const source = readSourceFolder('src/features/style/EmbedEditor.tsx', 'src/features/style/embed');
  check(
    'Enter on a named property with no value moves to the value field',
    containsCode(source, 'const enterName = () => { if (prop.trim() && !value.trim()) ' + '{ valueRef.current?.focus(); return } submit() }') &&
      containsCode(source, 'onEnter={row.enterName}'),
    'Enter still calls a submit that has nothing to write',
  );
  check(
    'picking one from the list goes there too',
    containsCode(source, 'onPick={(picked) => { setProp(picked); valueRef.current?.focus() }}'),
    'picking leaves the caret where it was',
  );
  check(
    'and the row asks for the project’s variables while it is open',
    /useSharedVars\((?:expanded|\{ active: expanded \})\)/.test(source),
    'either nothing is asked for, or it is asked for always',
  );
  check(
    'which reach the list as property names',
    /vars\.map\(\(variable\) => `--\$\{variable\.name\}`\)/.test(source),
    'the names would be offered without their dashes',
  );

  if (failures.length) {
    console.error(`\ncustom-property: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`custom-property: ${checked} passed  [a project's own properties, and a key that moves on]`);
  process.exit(0);
})();
