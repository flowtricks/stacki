// A class beats a tag beats what the parent hands down — the Webflow order.
//
//   node test/class-inheritance.js
//
// In Webflow a paragraph inside a styled section is that section's colour until
// something targets the paragraph, and once it is given a class `.text`, the
// class's colour is the one that counts — over the tag rule and over the parent.
// This mounts real CSS on a small tree (`.section > .box > p.text`) and asks the
// resolved model what the paragraph ends up with, for the three cases:
//
//   1. nothing targets the <p>: the nearest ancestor's inheritable value shows,
//      flagged as inherited, and a non-inheritable one (padding) never does;
//   2. a tag rule `p { color }` targets it: that beats the parent, however
//      specific the parent's selector, and even against the parent's !important;
//   3. the class rule `.text { color }` targets it: that beats the tag rule.
// Also that an ancestor's :hover never leaks into the child's resting view.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);}
};

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const bundlePath = path.join(buildDir, 'class-inheritance.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `
        import postcss from 'postcss'
        import { computeRuleModel } from './lib/cascade'
        import { resolveStyle } from './lib/resolved'
        import { collectRules } from './lib/css'
        export { computeRuleModel, resolveStyle, collectRules, postcss }
      `,
      resolveDir: path.join(__dirname, '..', 'src', 'style-panel'),
      loader: 'ts',
    },
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  const m = require(bundlePath);

  const rulesFor = (css) => m.collectRules(
    { start: 0, end: css.length, css, root: m.postcss.parse(css), openTag: '<style>' },
    { embedKey: 'e', embedLabel: 'e', fromComponent: false, componentName: null, regionIndex: 0, idSeed: 'e', order: { n: 0 } },
  );

  // section(0) > box(1) > p(2)
  const nodes = {
    section: { tag: 'div', classes: ['section'], parent: null, children: ['box'] },
    box: { tag: 'div', classes: ['box'], parent: 'section', children: ['p'] },
    p: { tag: 'p', classes: ['text'], parent: 'box', children: [] },
  };
  const view = {
    truncated: false,
    parentKey: (key) => nodes[key].parent,
    childKeys: (key) => nodes[key].children,
    snapshot: async (key) => ({ tag: nodes[key].tag, webflowType: '', id: null, classes: nodes[key].classes, classList: nodes[key].classes, attributes: {} }),
  };

  const resolve = async (css) => {
    const model = await m.computeRuleModel(rulesFor(css), { rootKey: 'p', view });
    return m.resolveStyle(model, '', '.text');
  };

  // 1. Nothing on the paragraph.
  let r = await resolve('.section { color: red; padding: 10px } .box { font-size: 20px }');
  check('parent colour reaches the paragraph', r.props.get('color')?.winner.value === 'red');
  check('and reads as inherited', r.props.get('color')?.winner.inheritedDepth === 2);
  check('nearest ancestor wins for its property', r.props.get('font-size')?.winner.inheritedDepth === 1);
  check('it is not the selected selector\'s value', r.props.get('color')?.source === 'other');
  check('padding does not inherit', !r.props.has('padding'));

  r = await resolve('.section { color: red } .box { color: green }');
  check('the nearer ancestor beats the farther one', r.props.get('color')?.winner.value === 'green');

  // 2. A tag rule beats the parent.
  r = await resolve('#x, .section { color: red !important } p { color: blue }');
  check('tag rule beats a parent\'s !important', r.props.get('color')?.winner.value === 'blue', r.props.get('color')?.winner.value);
  check('and is not inherited', r.props.get('color')?.winner.inheritedDepth === undefined);

  // 3. The class beats the tag.
  r = await resolve('.section { color: red } p { color: blue } .text { color: hotpink }');
  check('class rule beats tag rule', r.props.get('color')?.winner.value === 'hotpink', r.props.get('color')?.winner.value);
  check('the class is the selected selector', r.props.get('color')?.source === 'selected');
  const list = r.props.get('color')?.contributors.map((c) => c.value).join(',');
  check('cascade order is class, tag, parent', list === 'hotpink,blue,red', list);

  // Ancestor states stay with the ancestor.
  r = await resolve('.section:hover { color: red } .box::before { color: blue }');
  check('ancestor :hover does not leak', !r.props.has('color'), [...r.props.keys()].join(','));

  if (failures.length) {
    console.error(`class-inheritance: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`class-inheritance: ${checked} checks passed`);
})();
