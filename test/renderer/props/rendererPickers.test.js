// Render the real pickers with shared React. Valid data retains selected/missing
// rows and concise page labels, while oversized and cyclic inputs fail before
// unbounded traversal.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'renderer-pickers.bundle.cjs');
buildSync({
  stdin: {
    contents: `export { default as DataPicker } from './src/features/props/DataPicker.tsx';
    export { default as InsertSearch } from './src/features/palette/InsertSearch.tsx';
    export { default as LinkField } from './src/features/props/LinkField.tsx';`,
    resolveDir: ROOT,
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
});
const { DataPicker, InsertSearch, LinkField } = require(output);
const leaf = { path: 'post', key: 'post', kind: 'object', preview: '', children: undefined };
const renderData = (props) =>
  renderToStaticMarkup(
    React.createElement(DataPicker, {
      tree: [],
      onPick() {},
      ...props,
    }),
  );
assert.match(renderData({ tree: [leaf], current: 'post.title' }), /not in this entry/);
assert.match(renderData({ tree: [leaf], current: 'post' }), /dp-row selected/);
assert.throws(() => renderData({ tree: Array(20001).fill(leaf) }), /node limit exceeded/);
assert.throws(() => renderData({ current: 'x'.repeat(8193) }), /binding path limit exceeded/);
const cyclic = { ...leaf, children: [] };
cyclic.children.push(cyclic);
assert.throws(() => renderData({ tree: [cyclic] }), /depth limit exceeded/);
const renderLink = (page) =>
  renderToStaticMarkup(
    React.createElement(LinkField, {
      value: { type: 'string', value: page.route },
      context: { pages: [page], projectPath: '/project' },
      onChange() {},
    }),
  );
const repeatedRoute = renderLink({
  name: 'care/plan-a-visit.astro',
  route: '/care/plan-a-visit',
});
assert.match(repeatedRoute, />care\/plan-a-visit</);
assert.doesNotMatch(repeatedRoute, /care\/plan-a-visit.*care\/plan-a-visit/);
assert.match(renderLink({ name: 'index.astro', route: '/' }), />index  ·  \//);
assert.throws(
  () =>
    renderToStaticMarkup(
      React.createElement(InsertSearch, {
        components: Array(10001).fill({ name: 'Card' }),
        onInsert() {},
        onClose() {},
      }),
    ),
  /component limit exceeded/,
);
console.log('renderer-pickers: labels, selected/missing rows, and traversal bounds passed');
