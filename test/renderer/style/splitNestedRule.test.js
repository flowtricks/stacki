// Goal: splitting one selector out of a grouped rule keeps each of the rule's
// declarations paired with its own copy, also when a nested rule comes first.
// The pairing counted nested declarations, so an edit of `.a`'s colour changed
// the colour inside `&:hover` instead.
// Method: the panel's own split hook runs under a server render (it holds only
// callbacks) on a parsed region; the copy it returns is edited by declaration and
// the whole stylesheet compared, so the nested rules are checked unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const esbuild = require('esbuild');
const React = require('react');
const { renderToString } = require('react-dom/server');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const bundle = repoPath('node_modules/.stacki-test/split-nested-rule.bundle.js');
esbuild.buildSync({
  stdin: {
    contents: [
      "export { parseRegion, regionText } from './src/features/style/model/cssRegions';",
      "export { collectRules } from './src/features/style/model/css';",
      "export { useSplitForEdit } from './src/features/style/embed/useEditorRuleEdits';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});
const model = require(bundle);

function splitHook(activeSelector) {
  let hook;
  const Probe = () => {
    hook = model.useSplitForEdit({ activeSelectorRef: { current: activeSelector } });
    return undefined;
  };
  renderToString(React.createElement(Probe));
  return hook;
}

test('an edit after a nested rule changes the split copy, not the nested rule', () => {
  const css = '.a, .b {\n  &:hover {\n    color: blue;\n  }\n  color: red;\n}\n';
  const region = model.parseRegion({ start: 0, end: css.length, css, root: undefined });
  const [rule] = model.collectRules(region, {
    embedKey: 'file:/site.css',
    embedLabel: 'site.css',
    fromComponent: false,
    componentName: undefined,
    regionIndex: 0,
    idSeed: 'site',
    order: { n: 0 },
  });
  const original = rule.declarations[0];
  const split = splitHook('.a').splitForEdit(rule);
  assert.equal(split.rule.selectorText, '.a');
  split.rule.declarations[0].node.value = 'green';
  assert.equal(split.remap(original), split.rule.declarations[0]);
  assert.equal(
    model.regionText(region),
    '.b {\n  &:hover {\n    color: blue;\n  }\n  color: red;\n}\n.a {\n  &:hover {\n    color: blue;\n  }\n  color: green;\n}\n',
  );
});
