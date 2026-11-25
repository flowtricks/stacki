// Goal: the Style panel honours the project's new-style locations (src/features/style/model/
// newStyleTagSettings.ts, newStyleTarget.ts): a scope that chose an existing stylesheet gets the new
// rule appended in THAT file at the place its own layers or marker name, a scope that chose a style
// tag creates the tag from its own default content (page and component apart), a chosen file that is
// gone falls back to the tag and is never written, and a stylesheet that was NOT chosen is written
// exactly as before the setting existed.
// Method: real postcss regions written through css.ts createRuleAtRoot with the wrappers the panel
// asks the store for (newRuleWrappers), over a table of files (no layer, last layer, layer then a rule,
// marker, empty, media last, CRLF) comparing the exact text; the default-target decision as a table;
// and the store with a real host (setHost) holding the project's stylesheets and the open file's kind,
// so the scope follows the open file. Each case is written twice to show a repeated write changes nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

// The store and the host in ONE bundle, so setHost reaches the store's getHost.
const bundlePath = path.join(repoPath('node_modules/.stacki-test'), 'new-style-locations.bundle.cjs');
fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
buildSync({
  stdin: {
    contents: [
      "export * from './src/features/style/model/newStyleTagSettings';",
      "export { setHost } from './src/features/style/model/host';",
      "export * from './src/features/style/model/newStyleTarget';",
      "export { createRuleAtRoot, parseRegion } from './src/features/style/model/css';",
      "export * from './shared/properties/newStyleLocations';",
      "export { templateFrame } from './shared/properties/newStyleTag';",
    ].join('\n'),
    resolveDir: repoPath('.'),
    loader: 'ts',
  },
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const lib = require(bundlePath);

const region = (code) => lib.parseRegion({ start: 0, end: code.length, css: code, root: undefined });
const declared = (value) => ({ value, important: false });
const file = (rel) => ({ rel, name: rel.split('/').pop(), path: `/p/${rel}`, size: 1 });

// A stylesheet's text after the panel writes `.a { color: red }` into it as the chosen file of the open scope.
function writeChosen(code, writes = [['.a', 'color', 'red']]) {
  const source = { origin: { kind: 'file' }, label: 'src/styles/site.css' };
  const target = region(code);
  for (const [selector, prop, value] of writes) {
    assert.equal(lib.createRuleAtRoot(target, selector, prop, declared(value), lib.newRuleWrappers(source, target.root.toString())), true);
  }
  return target.root.toString();
}

// The open project: its stylesheets, the open file's kind, and what each scope chose.
function open({ kind, page, component, files = ['src/styles/site.css', 'src/styles/other.css'] }) {
  lib.setHost({ files: files.map(file), openFileKind: kind, openFilePath: '/p/src/pages/index.astro' });
  const tag = { attributes: [{ name: 'is:global', value: undefined }], content: '' };
  lib.publishNewStyleLocations({
    page: page === undefined ? { kind: 'tag', tag } : { kind: 'file', path: page, tag },
    component: component === undefined ? { kind: 'tag', tag } : { kind: 'file', path: component, tag },
  });
}

test('a chosen file takes the rule inside its last top-level @layer, after what is there', () => {
  open({ kind: 'page', page: 'src/styles/site.css' });
  assert.equal(
    writeChosen('.x {\n\tcolor: blue;\n}\n@layer components {\n\t.b {\n\t\tgap: 1rem;\n\t}\n}\n'),
    '.x {\n\tcolor: blue;\n}\n@layer components {\n\t.b {\n\t\tgap: 1rem;\n\t}\n\t.a {\n\t\tcolor: red;\n\t}\n}\n',
  );
  // A second write to the same class merges into the rule just made.
  const twice = writeChosen('@layer components {\n\t.b {\n\t\tgap: 1rem;\n\t}\n}\n', [
    ['.a', 'color', 'red'],
    ['.a', 'gap', '2rem'],
  ]);
  assert.equal(twice, '@layer components {\n\t.b {\n\t\tgap: 1rem;\n\t}\n\t.a {\n\t\tcolor: red;\n\t\tgap: 2rem;\n\t}\n}\n');
});

test('a chosen file without a layer, with a layer that is not last, or ending in @media gets the rule at the top level', () => {
  open({ kind: 'page', page: 'src/styles/site.css' });
  assert.equal(writeChosen('.x {\n\tcolor: blue;\n}\n'), '.x {\n\tcolor: blue;\n}\n.a {\n\tcolor: red;\n}\n');
  const afterLayer = writeChosen('@layer c {\n\t.b {}\n}\n.x {}\n');
  assert.ok(afterLayer.endsWith('.x {}\n.a {\n\tcolor: red;\n}\n'), afterLayer);
  const media = writeChosen('.x {}\n@media (width < 48rem) {\n\t.x {\n\t\tcolor: red;\n\t}\n}\n');
  assert.ok(media.endsWith('}\n.a {\n\tcolor: red;\n}\n'), media);
  assert.ok(media.includes('@media (width < 48rem) {\n\t.x {\n\t\tcolor: red;\n\t}\n}'), 'the media block is untouched');
});

test('a chosen file with a marker takes the rule where the marker says; an empty file just gets it', () => {
  open({ kind: 'page', page: 'src/styles/site.css' });
  const marked = writeChosen('@layer base {\n\t/* stacki:rules */\n}\n@layer other {\n\t.o {}\n}\n');
  assert.ok(marked.includes('@layer base {\n\t/* stacki:rules */\n\t.a {\n\t\tcolor: red;\n\t}\n}'), marked);
  assert.ok(marked.endsWith('@layer other {\n\t.o {}\n}\n'), 'the other layer is untouched');
  // The writer's own spacing for the first rule of an empty region (the same as a new tag's): one blank line, then the rule.
  assert.equal(writeChosen(''), '\n.a {\n\tcolor: red;\n}');
  assert.ok(writeChosen('\n\n').includes('.a {\n\tcolor: red;\n}'));
});

test('rules the person wrote are never rewritten: everything before the new rule is byte for byte what it was', () => {
  open({ kind: 'page', page: 'src/styles/site.css' });
  const original = ':global(.x), .y > .z {\n  color : blue ;\n}\r\n/* note */\n@layer  components  {\n  .b{gap:1rem}\n}\n';
  const written = writeChosen(original);
  const cut = written.lastIndexOf('}\n') > 0 ? written.indexOf('.a {') : -1;
  assert.ok(cut > 0, written);
  assert.ok(written.startsWith(original.slice(0, original.lastIndexOf('}\n'))), written);
});

test('a stylesheet that was not chosen is written as ever, at the top level, even with a layer', () => {
  open({ kind: 'page', page: 'src/styles/other.css' });
  assert.equal(writeChosen('@layer components {\n\t.b {}\n}\n'), '@layer components {\n\t.b {}\n}\n.a {\n\tcolor: red;\n}\n');
  open({ kind: 'page' });
  assert.equal(writeChosen('@layer components {\n\t.b {}\n}\n'), '@layer components {\n\t.b {}\n}\n.a {\n\tcolor: red;\n}\n', 'no file chosen at all');
});

test('the scope follows the open file: a page and a component choose apart', () => {
  open({ kind: 'page', page: 'src/styles/site.css', component: undefined });
  assert.equal(lib.openStyleScope(), 'page');
  assert.equal(lib.newStyleFileOf(lib.openStyleScope(), ['src/styles/site.css']), 'src/styles/site.css');
  open({ kind: 'component', page: 'src/styles/site.css', component: undefined });
  assert.equal(lib.openStyleScope(), 'component');
  assert.equal(lib.newStyleFileOf(lib.openStyleScope(), ['src/styles/site.css']), undefined, 'the component writes a tag');
  open({ kind: 'component', page: undefined, component: 'src/styles/other.css' });
  assert.equal(lib.newStyleFileOf('component', ['src/styles/other.css']), 'src/styles/other.css');
  assert.equal(lib.newStyleFileOf('page', ['src/styles/other.css']), undefined);
  open({ kind: undefined });
  assert.equal(lib.openStyleScope(), 'page', 'nothing open reads as a page');
});

test('a chosen file that is gone is never targeted: the panel writes the tag', () => {
  open({ kind: 'page', page: 'src/styles/gone.css' });
  assert.equal(lib.newStyleFileOf('page', ['src/styles/site.css']), undefined);
  assert.deepEqual(lib.newRuleWrappers({ origin: { kind: 'file' }, label: 'src/styles/gone.css' }, '@layer a {}'), []);
  const input = (chosenPath) => ({
    tags: [],
    preferredScope: 'global',
    fileCanHoldTag: 'yes',
    ...(chosenPath === undefined
      ? {}
      : { chosenFileKey: lib.chosenFileSourceKey([{ key: 'file:/p/s.css', label: 'src/styles/s.css', originKind: 'file' }], chosenPath) }),
  });
  assert.deepEqual(lib.defaultStyleTarget(input('src/styles/s.css')), { kind: 'file', key: 'file:/p/s.css' });
  assert.equal(lib.defaultTargetKey(lib.defaultStyleTarget(input('src/styles/s.css'))), 'file:/p/s.css');
  assert.deepEqual(lib.defaultStyleTarget(input('src/styles/gone.css')), { kind: 'create' }, 'no such source: the tag, as before');
  assert.deepEqual(lib.defaultStyleTarget(input(undefined)), { kind: 'create' });
});

test('a chosen file wins over the tags the page already has; only a file source counts', () => {
  const sources = [
    { key: 'node:1', label: 'src/styles/s.css', originKind: 'node' },
    { key: 'astro:1', label: 'src/styles/s.css', originKind: 'astro' },
    { key: 'file:1', label: 'src/styles/s.css', originKind: 'file' },
  ];
  assert.equal(lib.chosenFileSourceKey(sources, 'src/styles/s.css'), 'file:1');
  assert.equal(lib.chosenFileSourceKey(sources, undefined), undefined);
  assert.equal(lib.chosenFileSourceKey(sources, 'S.css'), undefined);
  const target = lib.defaultStyleTarget({
    tags: [{ key: 't', scope: 'global', variables: 'none', order: 0 }],
    preferredScope: 'global',
    fileCanHoldTag: 'yes',
    chosenFileKey: 'file:1',
  });
  assert.deepEqual(target, { kind: 'file', key: 'file:1' });
});

// A new tag's body as the panel writes a first rule: the scope's skeleton, then the rule inside its wrapper chain.
function newTag(template, writes) {
  const frame = lib.templateFrame(template);
  assert.equal(frame.ok, true, JSON.stringify(template));
  const tag = region(frame.frame.skeleton);
  for (const [selector, prop, value] of writes) {
    assert.equal(lib.createRuleAtRoot(tag, selector, prop, declared(value), frame.frame.wrappers), true);
  }
  return tag.root.toString();
}

test('a style tag starts from its own scope default: page and component differ', () => {
  const tags = {
    page: { attributes: [], content: '@layer pages {\n}' },
    component: { attributes: [{ name: 'is:global', value: undefined }], content: '@layer components {\n  /* stacki:rules */\n}' },
  };
  lib.setHost({ files: [file('src/styles/site.css')], openFileKind: 'page' });
  lib.publishNewStyleLocations({ page: { kind: 'tag', tag: tags.page }, component: { kind: 'tag', tag: tags.component } });
  assert.equal(lib.getNewStyleTagSettings(), tags.page);
  assert.equal(newTag(lib.getNewStyleTagSettings().content, [['.a', 'color', 'red']]), '@layer pages {\n\t.a {\n\t\tcolor: red;\n\t}\n}');
  lib.setHost({ openFileKind: 'component' });
  assert.equal(lib.getNewStyleTagSettings(), tags.component);
  assert.equal(newTag(lib.getNewStyleTagSettings().content, [['.a', 'color', 'red']]), '@layer components {\n\t.a {\n\t\tcolor: red;\n\t}\n}');
  assert.deepEqual(lib.newStyleTagFrame().wrappers, [{ name: 'layer', params: 'components' }]);
  // A tag source still follows its scope's template through the same entry as a file does.
  assert.deepEqual(lib.newRuleWrappers({ origin: { kind: 'node' }, label: '<style>' }, ''), [{ name: 'layer', params: 'components' }]);
  // The panel's scope tag is the file's tag default while a file is chosen: it is what a fallback or a switch back uses.
  lib.publishNewStyleLocations({ page: { kind: 'file', path: 'src/styles/site.css', tag: tags.page }, component: { kind: 'tag', tag: tags.component } });
  lib.setHost({ openFileKind: 'page' });
  assert.equal(lib.getNewStyleTagSettings(), tags.page);
});

test('nothing changes for a project that never chose: both scopes are the default tag, written as before', () => {
  lib.setHost({ files: [file('src/styles/site.css')], openFileKind: 'component' });
  lib.publishNewStyleLocations(lib.DEFAULT_NEW_STYLE_LOCATIONS);
  assert.equal(lib.newStyleFileOf('component', ['src/styles/site.css']), undefined);
  assert.equal(newTag(lib.getNewStyleTagSettings().content, [['.a', 'color', 'red']]), '\n.a {\n\tcolor: red;\n}');
  assert.deepEqual(lib.newRuleWrappers({ origin: { kind: 'file' }, label: 'src/styles/site.css' }, '@layer a {}'), []);
});
