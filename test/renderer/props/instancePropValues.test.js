// Goal: inside a component opened from an instance on a page, the data picker
// shows each prop's value for that instance rather than its type: the value the
// instance passes (`maxWidth  40`), else the prop's default, else a muted "not
// set". The type word stays only where there is no instance and no default, or
// where the instance passes something the app cannot work out.
// Method: dataTree is built for a component whose frontmatter destructures its
// props with and without defaults, with a declared schema, under four contexts:
// an instance that passes a resolved value, one that passes a value that could
// not be resolved, no instance at all, and a schema default. Each row's kind,
// preview and note are read. The real DataPicker is rendered to static markup to
// pin how "not set" is drawn: muted, in the value column, beside the prop's icon.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const loadRenderer = require('../../helpers/rendererModule');
const { dataTree } = loadRenderer('src/editor/dataSuggest.ts');

const FRONTMATTER = "const { Tag = 'h2', maxWidth, className, ...rest } = Astro.props;";
const SCHEMA = [
  { name: 'Tag', type: 'string' },
  { name: 'maxWidth', type: 'number' },
  { name: 'className', type: 'string' },
];
const rows = (context) =>
  Object.fromEntries(
    dataTree({ frontmatter: FRONTMATTER, propsSchema: SCHEMA, ...context })
      .filter((node) => node.section === 'props')
      .map((node) => [node.path, { kind: node.kind, preview: node.preview, note: node.note }]),
  );

test('a value the instance passes is shown; one it leaves out shows its default, or "not set"', () => {
  const props = rows({ propsSample: { maxWidth: 40 }, propsInstance: { passed: ['maxWidth'] } });
  assert.deepEqual(props.maxWidth, { kind: 'number', preview: '40', note: undefined });
  assert.deepEqual(props.Tag, { kind: 'string', preview: '"h2"', note: undefined }, 'the pattern’s default');
  assert.deepEqual(props.className, { kind: 'string', preview: '', note: 'not set' });
  assert.equal(props.rest.note, undefined, 'rest props are whatever else is passed, never "not set"');
});

test('an instance with nothing resolved still says which props it leaves unset', () => {
  const props = rows({ propsSample: undefined, propsInstance: { passed: [] } });
  assert.equal(props.maxWidth.note, 'not set');
  assert.equal(props.className.note, 'not set');
  assert.equal(props.Tag.preview, '"h2"');
});

test('a renamed prop reads the instance’s value by its public name: class as className', () => {
  const frontmatter = 'const { class: className, tags: tagList = [], meta } = Astro.props;';
  const props = Object.fromEntries(
    dataTree({
      frontmatter,
      propsSample: { class: 'margin-block-8', tags: ['a', 'b'], meta: { id: 1 } },
      propsInstance: { passed: ['class', 'tags', 'meta'] },
    })
      .filter((node) => node.section === 'props')
      .map((node) => [node.path, node]),
  );
  assert.equal(props.className.preview, '"margin-block-8"', 'the class string, never "other"');
  assert.equal(props.className.kind, 'text');
  assert.equal(props.tagList.preview, '2 items', 'a list says how much it holds');
  assert.deepEqual(
    props.tagList.children.map((child) => child.preview),
    ['"a"', '"b"'],
  );
  assert.deepEqual(
    props.meta.children.map((child) => [child.path, child.preview]),
    [['meta.id', '1']],
  );
  // Default with an alias, not passed: its default shows.
  const defaulted = dataTree({ frontmatter: "const { class: className = 'base' } = Astro.props;", propsInstance: { passed: [] } }).find(
    (node) => node.path === 'className',
  );
  assert.equal(defaulted.preview, '"base"');
});

test('a value the instance passes but the app cannot work out keeps the type word', () => {
  const props = rows({ propsSample: {}, propsInstance: { passed: ['className'] } });
  assert.deepEqual(props.className, { kind: 'string', preview: '', note: undefined });
  assert.equal(props.maxWidth.note, 'not set');
});

test('with no instance, a prop shows its default, else its type', () => {
  const props = rows({});
  assert.deepEqual(props.maxWidth, { kind: 'number', preview: '', note: undefined }, 'the type word, nothing invented');
  assert.equal(props.Tag.preview, '"h2"');
  const declared = rows({ propsSchema: [{ name: 'maxWidth', type: 'number', default: 24 }] });
  assert.equal(declared.maxWidth.preview, '24', 'the schema’s default');
});

test('"not set" is drawn muted in the value column', () => {
  const directory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(directory, { recursive: true });
  const output = path.join(directory, 'instance-prop-values.bundle.cjs');
  buildSync({
    stdin: { contents: "export { default as DataPicker } from './src/features/props/DataPicker.tsx';", resolveDir: ROOT },
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
  });
  const { DataPicker } = require(output);
  const tree = dataTree({ frontmatter: FRONTMATTER, propsSchema: SCHEMA, propsSample: { maxWidth: 40 }, propsInstance: { passed: ['maxWidth'] } });
  const markup = renderToStaticMarkup(
    React.createElement(DataPicker, { tree, current: undefined, origin: { file: 'src/components/Heading.astro', page: 'src/pages/index.astro' }, onPick() {} }),
  );
  assert.match(markup, /<span class="dp-key">className<\/span><span class="dp-val kind">not set<\/span>/);
  assert.match(markup, /<span class="dp-key">maxWidth<\/span><span class="dp-val">40<\/span>/);
});
