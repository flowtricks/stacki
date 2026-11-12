// Goal: the loop's Source menu lists the data the project keeps outside the page
// (the arrays exported from src/consts.ts, other data modules, JSON data files)
// as a "Project data" group between the file's own lists and the content
// collections; picking one loops over it and writes the import it needs in the
// same change; and a loop that already reads an imported list shows it checked
// in that group, with the filters and sort its fields allow.
//
// Method: the pure parts are driven directly. The CMS catalog (the discovery the
// CMS panel uses, never a second scan) becomes exports, picker roots and the group's
// rows, for one module and for two that export the same name, with a very large
// list, a computed list, a computed value and a value that is no list. The apply
// path runs the real planner and the real frontmatter writer: a new import, a
// merge into the module's own `import { … }`, an alias on collision, no import at
// all for a list already imported, the old source's import taken back, and the
// original text written back byte for byte (what an undo restores). The Source
// tree is then drawn by the real DataPicker for a component and a page: group
// order and headings, the muted file under a name, a disabled computed list, no
// heading when there is no data, and search by name.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { installPopupDOM } = require('../../helpers/popupDom.js');
const load = require('../../helpers/rendererModule');

const { dataFileExports, projectSourceNodes, importedProjectData, importSpecFor, PROJECT_LIST_ITEMS_MAX } = load('src/features/props/projectDataSources.ts');
const { projectDataRows, projectDataNames, treeListFields } = load('src/features/props/loopProjectData.ts');
const { readLoop } = load('src/editor/loopQueryRead.ts');
const { planLoop } = load('src/editor/loopQueryPlan.ts');
const { dataTree } = load('src/editor/dataSuggest.ts');
const { readFrontmatter, writeFrontmatter } = load('shared/page/frontmatterSource.ts');
const { sectionHeading } = load('src/features/props/dataPickerModel.ts');
const { projectRelativePath } = load('src/lib/projectPath.ts');

const directory = repoPath('node_modules/.stacki-test/loop-project-data');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'loop-project-data.cjs');
buildSync({
  stdin: {
    contents: [
      "export { default as DataPicker, searchMatches } from './src/features/props/DataPicker';",
      "export { sourceTree } from './src/features/props/LoopSourcePicker';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

// The CMS catalog as cms:list answers it for a site with constants, a second module and a JSON file.
const BIG = Array.from({ length: 400 }, (_, index) => ({ title: `Row ${index}`, order: index }));
const CATALOG = [
  {
    rel: 'consts.ts#*general',
    data: {
      SITE: { name: 'Acme', links: [{ label: 'Docs', href: '/docs' }] },
      TAGS: ['new', 'sale'],
      COUNT: 3,
      MIXED: { __expr: '[...TAGS, "extra"]' },
      YEAR: { __expr: 'new Date().getFullYear()' },
    },
  },
  {
    rel: 'consts.ts#NAV_LINKS',
    data: [
      { label: 'Home', href: '/', featured: true, rank: 1 },
      { label: 'About', href: '/about', featured: false, rank: 2 },
    ],
  },
  { rel: 'consts.ts#BIG', data: BIG },
  { rel: 'data/team.json', data: [{ name: 'Ada', role: 'Engineer' }] },
  { rel: 'data/broken.json', error: 'Unexpected token' },
  { rel: 'pages/index.astro#*general', data: { title: 'Home' } },
];
const EXPORTS = dataFileExports(CATALOG);
const PAGE = 'src/pages/index.astro';
const COMPONENT = 'src/components/PricingCard.astro';
const RELATIVE = { kind: 'relative' };
const nodesFor = (file, frontmatter = '', imports = []) =>
  projectSourceNodes({ exports: EXPORTS, config: undefined, style: RELATIVE, file, frontmatter, imports });
const rowsFor = (file, imports = [], frontmatter = '') => {
  const roots = nodesFor(file, frontmatter, imports);
  const modules = importedProjectData({ exports: EXPORTS, file, imports });
  return projectDataRows(roots, modules);
};

test('the group lists each list the CMS read, by file, and leaves out what is no list', () => {
  const rows = rowsFor(PAGE);
  assert.deepEqual(
    rows.map((row) => [row.path, row.kind, row.pickable, row.section]),
    [
      ['SITE', 'object', false, 'loop-project'],
      ['TAGS', 'list', true, 'loop-project'],
      ['MIXED', 'list', false, 'loop-project'],
      ['NAV_LINKS', 'list', true, 'loop-project'],
      ['BIG', 'list', true, 'loop-project'],
      ['team', 'list', true, 'loop-project'],
    ],
    'ordered by file, then as each file declares them',
  );
});

test('a list computed in code is shown disabled, a computed value or a number is left out', () => {
  const rows = rowsFor(PAGE);
  const mixed = rows.find((row) => row.path === 'MIXED');
  assert.equal(mixed.note, 'Set in code');
  assert.equal(mixed.pickable, false);
  assert.match(mixed.unbindable, /computed in code/);
  assert.equal(
    rows.some((row) => row.path === 'YEAR'),
    false,
    'new Date() is not known to be a list',
  );
  assert.equal(
    rows.some((row) => row.path === 'COUNT'),
    false,
    'a number is no list',
  );
  assert.equal(
    rows.some((row) => row.path === 'title'),
    false,
    'a page is not a module',
  );
});

test('an object that holds a list opens to it, and the list carries the object’s import', () => {
  const site = rowsFor(PAGE).find((row) => row.path === 'SITE');
  assert.equal(site.pickable, false);
  assert.deepEqual(
    site.children.map((child) => [child.path, child.pickable]),
    [['SITE.links', true]],
  );
  assert.equal(site.importNeed.exported, 'SITE', 'picking SITE.links imports SITE');
});

test('a list of records opens to the fields of its first item, shown and never chosen', () => {
  const nav = rowsFor(PAGE).find((row) => row.path === 'NAV_LINKS');
  assert.deepEqual(
    nav.children.map((child) => [child.key, child.kind, child.pickable]),
    [
      ['label', 'text', false],
      ['href', 'text', false],
      ['featured', 'boolean', false],
      ['rank', 'number', false],
    ],
  );
  assert.equal(nav.preview, '2 items');
  assert.deepEqual(nav.importNeed, { spec: '../consts', exported: 'NAV_LINKS', name: 'NAV_LINKS' });
  const tags = rowsFor(PAGE).find((row) => row.path === 'TAGS');
  assert.equal(tags.children, undefined, 'words have no fields to open');
});

test('a very large list is cut for the picker and still says how many it holds', () => {
  const big = rowsFor(PAGE).find((row) => row.path === 'BIG');
  assert.equal(big.preview, '400 items');
  assert.ok(PROJECT_LIST_ITEMS_MAX < 400);
  const root = nodesFor(PAGE).find((node) => node.path === 'BIG');
  assert.ok(root.children.length <= PROJECT_LIST_ITEMS_MAX, `${root.children.length} items kept`);
  assert.equal(treeListFields(nodesFor(PAGE), 'BIG').length, 2);
});

test('two modules exporting the same name are told apart by their file; one module says nothing', () => {
  const twin = dataFileExports([
    { rel: 'consts.ts#LINKS', data: [{ label: 'A' }] },
    { rel: 'lib/other.ts#LINKS', data: [{ label: 'B' }] },
  ]);
  const roots = projectSourceNodes({ exports: twin, config: undefined, style: RELATIVE, file: PAGE, frontmatter: '', imports: [] });
  const rows = projectDataRows(roots, {});
  assert.deepEqual(
    rows.map((row) => [row.path, row.detail]),
    [
      ['LINKS', 'src/consts.ts'],
      ['LINKS2', 'src/lib/other.ts'],
    ],
    'the second is read as LINKS2 and says where it lives',
  );
  const single = projectDataRows(roots.slice(0, 1), {});
  assert.equal(single[0].detail, undefined, 'one file: the heading is enough');
});

test('a project with no data modules has no group, and a file known to no one has no rows', () => {
  assert.deepEqual(projectDataRows([], {}), []);
  const none = projectSourceNodes({ exports: [], config: undefined, style: RELATIVE, file: PAGE, frontmatter: '', imports: [] });
  assert.deepEqual(projectDataRows(none, {}), []);
  assert.deepEqual(projectSourceNodes({ exports: EXPORTS, config: undefined, style: RELATIVE, file: undefined, frontmatter: '', imports: [] }), []);
});

test('an unreadable file and a page add no export', () => {
  assert.equal(
    EXPORTS.some((item) => item.file.endsWith('broken.json')),
    false,
  );
  assert.equal(
    EXPORTS.some((item) => item.file.endsWith('.astro')),
    false,
  );
});

test('the import specifier follows the importing file, with Windows paths made project-relative first', () => {
  assert.equal(importSpecFor('src/consts.ts', 'src/pages/index.astro', RELATIVE), '../consts');
  assert.equal(importSpecFor('src/consts.ts', 'src/components/ui/Card.astro', RELATIVE), '../../consts');
  assert.equal(importSpecFor('src/consts.ts', 'src/layouts/Layout.astro', { kind: 'alias' }), '@/consts');
  assert.equal(importSpecFor('src/data/team.json', 'src/pages/about/index.astro', RELATIVE), '../../data/team.json');
  const windows = projectRelativePath('C:\\site', 'C:\\site\\src\\components\\Card.astro', 'win32');
  assert.equal(windows, 'src/components/Card.astro');
  assert.equal(importSpecFor('src/consts.ts', windows, RELATIVE), '../consts');
});

// ---------------------------------------------------------------------------
// Reading what a loop goes over.
// ---------------------------------------------------------------------------

const IMPORTS = [{ name: 'NAV_LINKS', imported: 'NAV_LINKS', path: '../consts', quote: "'", named: true }];

test('a loop over an imported list reads as that list, with list settings, not as custom code', () => {
  for (const data of ['NAV_LINKS', 'NAV_LINKS.slice(0, 3)', 'NAV_LINKS.filter((link) => link.featured)']) {
    const reading = readLoop({ frontmatter: '', imports: IMPORTS, data });
    assert.equal(reading.kind, 'query', data);
    assert.deepEqual(reading.query.source, { kind: 'list', collection: 'NAV_LINKS' }, data);
  }
  const package_ = [{ name: 'items', imported: 'items', path: 'some-package', quote: "'", named: true }];
  assert.equal(readLoop({ frontmatter: '', imports: package_, data: 'items' }).kind, 'value', 'a package’s export is not the project’s data');
  const called = readLoop({ frontmatter: '', imports: IMPORTS, data: 'NAV_LINKS()' });
  assert.notEqual(called.kind, 'query', 'a call is not a list');
});

test('an imported list is in the group, checked by its own name, wherever it was picked', () => {
  const imports = [{ name: 'NAV_LINKS', imported: 'NAV_LINKS', path: '../consts', quote: "'", named: true }];
  const modules = importedProjectData({ exports: EXPORTS, file: PAGE, imports });
  assert.deepEqual(modules, { NAV_LINKS: 'src/consts.ts' });
  const tree = dataTree({
    frontmatter: '',
    imports,
    projectSources: nodesFor(PAGE, '', imports),
    projectModules: modules,
    importedValues: { NAV_LINKS: { kind: 'data', value: CATALOG[1].data } },
  });
  const rows = projectDataRows(tree, modules);
  assert.ok(
    rows.some((row) => row.path === 'NAV_LINKS' && row.importNeed === undefined),
    'in scope: nothing to import',
  );
  assert.equal(rows.filter((row) => row.path === 'NAV_LINKS').length, 1, 'listed once');
  assert.ok(projectDataNames(tree, modules).has('NAV_LINKS'), 'so the page’s own lists leave it out');
  assert.deepEqual(
    treeListFields(tree, 'NAV_LINKS').map((field) => [field.path, field.kind]),
    [
      ['label', 'text'],
      ['href', 'text'],
      ['featured', 'boolean'],
      ['rank', 'number'],
    ],
    'the filters and sort offer the item’s fields',
  );
});

test('fields of a list of words are the item itself; a tree without the list gives none', () => {
  assert.deepEqual(treeListFields(nodesFor(PAGE), 'TAGS'), [{ path: '$item', kind: 'text' }]);
  assert.equal(treeListFields(nodesFor(PAGE), 'nothing'), undefined);
  assert.equal(treeListFields(undefined, 'TAGS'), undefined);
});

// ---------------------------------------------------------------------------
// Writing what a loop goes over.
// ---------------------------------------------------------------------------

function loopNode(head) {
  return { id: 'loop', kind: 'map', head, children: [{ id: 'row', kind: 'element', tag: 'div', props: {}, children: [] }] };
}

function apply(frontmatterText, target, head = 'items.map((item) => (') {
  const model = { ...readFrontmatter(frontmatterText), nodes: [loopNode(head)] };
  const planned = planLoop({ model, loop: model.nodes[0], target, sanityClient: 'unavailable' });
  assert.equal(planned.ok, true, JSON.stringify(planned));
  const plan = planned.plan;
  return { model, plan, text: writeFrontmatter({ ...model, extraFrontmatter: plan.extraFrontmatter, imports: plan.imports }) };
}

const NEED = { spec: '../consts', exported: 'NAV_LINKS', name: 'NAV_LINKS' };

test('picking an export the file does not import adds one import and loops over it', () => {
  const before = "import Layout from '../layouts/Layout.astro';\n\nconst items = ['a'];";
  const { plan, text } = apply(before, { kind: 'value', data: 'NAV_LINKS', import: NEED });
  assert.equal(plan.loop.head, 'NAV_LINKS.map((item) => (');
  assert.equal(text, "import Layout from '../layouts/Layout.astro';\nimport { NAV_LINKS } from '../consts';\n\n");
  assert.equal(plan.imports.filter((entry) => entry.name === 'NAV_LINKS').length, 1, 'imported once');
});

test('an import of the same module is extended, never duplicated, and its quotes are kept', () => {
  const before = 'import { SITE } from "../consts";\n\nconst items = ["a"];';
  const { text } = apply(before, { kind: 'value', data: 'NAV_LINKS', import: NEED });
  assert.match(text, /^import \{ SITE, NAV_LINKS \} from "\.\.\/consts";/);
  assert.equal((text.match(/consts/g) ?? []).length, 1, 'one import line for the module');
});

test('a list already imported is looped over with no second import', () => {
  const before = "import { NAV_LINKS } from '../consts';\n\nconst items = ['a'];";
  const { plan, text } = apply(before, { kind: 'value', data: 'NAV_LINKS', import: NEED });
  assert.equal(plan.loop.head, 'NAV_LINKS.map((item) => (');
  assert.equal((text.match(/import /g) ?? []).length, 1);
});

test('a name the file already uses is read under an alias, and the loop reads the alias', () => {
  const before = "import { SITE } from '../consts';\n\nconst NAV_LINKS = ['mine'];\nconst first = NAV_LINKS[0];\nconst items = [first];";
  const { plan, text } = apply(before, { kind: 'value', data: 'NAV_LINKS', import: NEED });
  assert.equal(plan.loop.head, 'NAV_LINKS2.map((item) => (');
  assert.match(text, /import \{ SITE, NAV_LINKS as NAV_LINKS2 \} from '\.\.\/consts';/);
});

test('a list inside an exported object imports the object and loops over the path', () => {
  const need = { spec: '../consts', exported: 'SITE', name: 'SITE' };
  const { plan, text } = apply('const items = [];', { kind: 'value', data: 'SITE.links', import: need });
  assert.equal(plan.loop.head, 'SITE.links.map((item) => (');
  assert.match(text, /import \{ SITE \} from '\.\.\/consts';/);
});

test('a JSON file’s data is imported as its default export', () => {
  const need = { spec: '../data/team.json', exported: 'default', name: 'team' };
  const { plan, text } = apply('const items = [];', { kind: 'value', data: 'team', import: need });
  assert.equal(plan.loop.head, 'team.map((item) => (');
  assert.match(text, /import team from '\.\.\/data\/team\.json';/);
});

test('switching to another list of the module extends its import and leaves the old name where the file wrote it', () => {
  const before = "import { NAV_LINKS } from '../consts';\n\n";
  const need = { spec: '../consts', exported: 'TAGS', name: 'TAGS' };
  const { plan, text } = apply(before, { kind: 'value', data: 'TAGS', import: need }, 'NAV_LINKS.map((item) => (');
  assert.equal(plan.loop.head, 'TAGS.map((item) => (');
  assert.equal(text, "import { NAV_LINKS, TAGS } from '../consts';\n\n", 'no line but the import changes; an unused import is the person’s to remove');
});

test('undoing the change restores the frontmatter byte for byte', () => {
  const before = "---\nimport Layout from '../layouts/Layout.astro';\n\nconst title = 'Home';\n---";
  const model = readFrontmatter("import Layout from '../layouts/Layout.astro';\n\nconst title = 'Home';");
  const original = writeFrontmatter(model);
  const { plan, text } = apply(original, { kind: 'value', data: 'NAV_LINKS', import: NEED });
  assert.notEqual(text, original);
  // An undo step puts the model it was made from back; printing it gives the file it came from.
  assert.equal(writeFrontmatter(model), original);
  assert.equal(`---\n${original}\n---`, before);
  assert.ok(plan.imports.length === model.imports.length + 1);
});

test('a pick whose path is not the import’s name is refused loudly', () => {
  const model = { ...readFrontmatter(''), nodes: [loopNode('items.map((item) => (')] };
  assert.throws(
    () => planLoop({ model, loop: model.nodes[0], target: { kind: 'value', data: 'OTHER', import: NEED }, sanityClient: 'unavailable' }),
    /looped by the name it is imported as/,
  );
});

// ---------------------------------------------------------------------------
// The Source tree.
// ---------------------------------------------------------------------------

let React;
let modules;
function installDom() {
  if (modules !== undefined) {
    return;
  }
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  for (const name of ['Node', 'Element', 'HTMLElement', 'MutationObserver', 'DOMRect', 'Window', 'KeyboardEvent', 'MouseEvent', 'PointerEvent']) {
    global[name] = dom.window[name];
  }
  global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.ResizeObserver = dom.window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  installPopupDOM(dom.window);
  React = require('react');
  modules = require(output);
}

const catalog = { collections: [{ source: { kind: 'astro', collection: 'stats' }, title: 'Stats', count: 3 }], sanity: { kind: 'none' } };
const FRONTMATTER = 'interface Props {\n  features?: string[];\n}\nconst { features = [] } = Astro.props;\n';

function treeFor(file, exportsList = EXPORTS, imports = []) {
  const roots = projectSourceNodes({ exports: exportsList, config: undefined, style: RELATIVE, file, frontmatter: FRONTMATTER, imports });
  const modulesIn = importedProjectData({ exports: exportsList, file, imports });
  const tree = dataTree({ frontmatter: FRONTMATTER, imports, projectSources: roots, projectModules: modulesIn, origin: { file } });
  return { tree, projectModules: modulesIn };
}

function drawn(file, exportsList, imports) {
  installDom();
  const { renderToStaticMarkup } = require('react-dom/server');
  const { tree, projectModules } = treeFor(file, exportsList, imports);
  const nodes = modules.sourceTree(catalog, { tree, samples: {}, frontmatter: FRONTMATTER, file, projectModules }, {});
  const markup = renderToStaticMarkup(
    React.createElement(modules.DataPicker, { tree: nodes, origin: { file, page: undefined }, footer: false, sources: 'open', onPick() {} }),
  );
  const holder = document.createElement('div');
  holder.innerHTML = markup;
  return { nodes, holder };
}

test('in a component the group sits between its own lists and the collections', () => {
  const { holder } = drawn(COMPONENT);
  const headings = [...holder.querySelectorAll('.dp-section')].map((section) => section.textContent);
  assert.deepEqual(headings, ['PricingCard', 'Project data', 'Content Collections']);
  const project = [...holder.querySelectorAll('.dp-section')][1];
  assert.ok(project.querySelector('svg.dp-section-icon'), 'marked with the file icon the CMS uses');
  assert.ok(!project.classList.contains('component'), 'not the component’s own');
});

test('on a page the group sits between the collections and the page’s own lists', () => {
  const { holder } = drawn(PAGE);
  const headings = [...holder.querySelectorAll('.dp-section')].map((section) => section.textContent);
  assert.deepEqual(headings, ['Content Collections', 'Project data', 'On this page']);
});

test('rows say what they hold, a computed list is disabled with its reason, and a name is not listed twice', () => {
  const { holder, nodes } = drawn(COMPONENT);
  const row = (name) => [...holder.querySelectorAll('.dp-row')].find((element) => element.querySelector('.dp-key')?.textContent === name);
  assert.match(row('NAV_LINKS').textContent, /2 items/);
  assert.equal(row('MIXED').getAttribute('aria-disabled'), 'true');
  assert.match(row('MIXED').textContent, /Set in code/);
  assert.equal(nodes.filter((node) => node.path === 'NAV_LINKS').length, 1);
  assert.equal(
    nodes.some((node) => node.path === 'YEAR' || node.path === 'COUNT'),
    false,
    'a module’s computed value is not the component’s own list either',
  );
  assert.equal(nodes.find((node) => node.path === 'features').section, 'loop-component', 'the component’s own list stays its own');
});

test('files are named under rows only when the group draws from more than one', () => {
  const { holder } = drawn(PAGE);
  const notes = [...holder.querySelectorAll('.dp-note')].map((element) => element.textContent);
  assert.ok(notes.includes('src/consts.ts'));
  assert.ok(notes.includes('src/data/team.json'));
  const onlyConsts = dataFileExports(CATALOG.slice(0, 3));
  const { holder: single } = drawn(PAGE, onlyConsts);
  assert.equal(single.querySelectorAll('.dp-note').length, 0);
});

test('with no data module there is no Project data heading', () => {
  const { holder } = drawn(COMPONENT, []);
  const headings = [...holder.querySelectorAll('.dp-section')].map((section) => section.textContent);
  assert.deepEqual(headings, ['PricingCard', 'Content Collections']);
  assert.equal(sectionHeading('loop-project', undefined), 'Project data');
});

test('search finds a list by its name and a field by its name', () => {
  installDom();
  const { nodes } = drawn(COMPONENT);
  assert.deepEqual(
    modules.searchMatches(nodes, 'nav_l').map((match) => match.node.path),
    ['NAV_LINKS', 'NAV_LINKS[0].label', 'NAV_LINKS[0].href', 'NAV_LINKS[0].featured', 'NAV_LINKS[0].rank'],
    'the list, and its fields shown under their full path',
  );
  assert.ok(
    modules.searchMatches(nodes, 'featured').some((match) => match.root.path === 'NAV_LINKS'),
    'a field is found under its list',
  );
});

test('a picked row hands back the import it needs, and an imported one hands back none', () => {
  installDom();
  const { renderToStaticMarkup } = require('react-dom/server');
  const { tree, projectModules } = treeFor(COMPONENT);
  const nodes = modules.sourceTree(catalog, { tree, samples: {}, frontmatter: FRONTMATTER, file: COMPONENT, projectModules }, {});
  renderToStaticMarkup(React.createElement(modules.DataPicker, { tree: nodes, footer: false, onPick() {} }));
  const nav = nodes.find((node) => node.path === 'NAV_LINKS');
  assert.deepEqual(nav.importNeed, NEED);
  const imported = treeFor(COMPONENT, EXPORTS, IMPORTS);
  const after = modules.sourceTree(
    catalog,
    { tree: imported.tree, samples: {}, frontmatter: FRONTMATTER, file: COMPONENT, projectModules: imported.projectModules },
    {},
  );
  assert.equal(after.find((node) => node.path === 'NAV_LINKS').importNeed, undefined);
});
