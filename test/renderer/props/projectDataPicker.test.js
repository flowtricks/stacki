// Goal: the binding picker lists the project's data that the file does not read
// yet, below what is in scope — each data file's exports with their values, and
// the content collections — and picking one writes what the file needs (the
// import, or the `getCollection` query) in the same gesture as the binding. The
// project can leave any of it out of the picker; by default everything shows.
// Method: the pure parts are driven directly. dataFileExports reads a CMS
// catalog as cms:list answers it; projectSourceNodes turns it into picker roots
// for a page, for a component in a subfolder, with and without the `@/` alias,
// beside an existing import of the module, beside a name the file already uses,
// and with exclusions; dataTree places them after the collections; search
// keeps each match's root. The frontmatter additions are applied to a model
// read by the shared frontmatter reader and printed by the shared writer, so
// the import text is the text a save writes (new import, merged import, alias
// on collision, collection query). One undo step is the gesture sequence
// Desktop's held edit makes: the frontmatter gesture and the field's gesture
// as one, with both changes. Finally the real DataPicker renders the sections,
// the hint, and passes the need to onPick.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const loadRenderer = require('../../helpers/rendererModule');
const { dataFileExports, projectSourceNodes, importSpecFor, moduleFileOf, aliasProbeFor } = loadRenderer('src/features/props/projectDataSources.ts');
const { withDataImport, withCollectionQuery, freeName } = loadRenderer('src/editor/frontmatterAdditions.ts');
const { dataTree } = loadRenderer('src/editor/dataSuggest.ts');
const { resolvePick } = loadRenderer('src/editor/bindings.ts');
const { frontmatterGesture, sequence } = loadRenderer('src/editor/editGestures.ts');
const { readFrontmatter, writeFrontmatter } = loadRenderer('shared/page/frontmatterSource.ts');
const { sectionHeading, dataFileOfSection } = loadRenderer('src/features/props/dataPickerModel.ts');
const { parseProjectFolders } = loadRenderer('shared/properties/projectFolders.ts');

// The CMS catalog for a site: consts.ts's single values, one list export, a JSON file, a page and a broken file.
const CATALOG = [
  {
    rel: 'consts.ts#*general',
    name: 'consts.ts',
    dir: 'consts.ts',
    data: {
      SITE: { name: 'Acme', description: 'We make things', url: 'https://acme.test', locale: 'en' },
      NOINDEX_ROUTES: ['/draft'],
      BUILT: { __expr: 'new Date().getFullYear()' },
    },
  },
  { rel: 'consts.ts#NAV', name: 'NAV', dir: 'consts.ts', data: [{ label: 'Home', href: '/' }] },
  { rel: 'data/site-settings.json', name: 'site-settings.json', dir: 'data', data: { phone: '555' } },
  { rel: 'pages/index.astro#*general', name: 'index.astro', dir: 'pages/index.astro', data: { title: 'Home' } },
  { rel: 'data/broken.json', name: 'broken.json', dir: 'data', error: 'Unexpected token' },
];
const EXPORTS = dataFileExports(CATALOG);
const PAGE = 'src/pages/index.astro';
const RELATIVE = { kind: 'relative' };
const ALIAS = { kind: 'alias' };
const nodes = (input) => projectSourceNodes({ exports: EXPORTS, config: undefined, style: RELATIVE, file: PAGE, frontmatter: '', imports: [], ...input });

test('the catalog becomes one export per value, a list or a JSON file; pages and unreadable files add none', () => {
  assert.deepEqual(
    EXPORTS.map((item) => `${item.file}#${item.exported}`),
    ['src/consts.ts#SITE', 'src/consts.ts#NOINDEX_ROUTES', 'src/consts.ts#BUILT', 'src/consts.ts#NAV', 'src/data/site-settings.json#default'],
  );
});

test('out-of-scope exports are listed by file, with values, and carry the import a pick writes', () => {
  const roots = nodes({});
  assert.deepEqual(
    roots.map((node) => [node.path, node.section, node.importNeed.spec, node.importNeed.exported]),
    [
      ['SITE', 'data-file:src/consts.ts', '../consts', 'SITE'],
      ['NOINDEX_ROUTES', 'data-file:src/consts.ts', '../consts', 'NOINDEX_ROUTES'],
      ['BUILT', 'data-file:src/consts.ts', '../consts', 'BUILT'],
      ['NAV', 'data-file:src/consts.ts', '../consts', 'NAV'],
      ['siteSettings', 'data-file:src/data/site-settings.json', '../data/site-settings.json', 'default'],
    ],
  );
  const site = roots[0];
  assert.deepEqual(
    site.children.map((child) => [child.path, child.preview]),
    [
      ['SITE.name', '"Acme"'],
      ['SITE.description', '"We make things"'],
      ['SITE.url', '"https://acme.test"'],
      ['SITE.locale', '"en"'],
    ],
  );
  const built = roots.find((node) => node.path === 'BUILT');
  assert.equal(built.kind, 'value', 'a computed value is bindable');
  assert.equal(built.preview, '', 'and shows no code');
  assert.equal(sectionHeading(site.section, { file: PAGE, page: undefined }), 'consts.ts');
  assert.equal(sectionHeading('data-file:src/data/site-settings.json', undefined), 'data/site-settings.json');
  assert.equal(dataFileOfSection('frontmatter'), undefined);
  assert.equal(nodes({ file: undefined }).length, 0, 'no file to write into lists nothing');
});

test('imports follow the alias when it reaches the file, else a path relative to the file', () => {
  assert.equal(importSpecFor('src/consts.ts', PAGE, ALIAS), '@/consts');
  assert.equal(importSpecFor('src/consts.ts', 'src/components/cards/Card.astro', RELATIVE), '../../consts');
  assert.equal(importSpecFor('src/consts.ts', 'src/Root.astro', RELATIVE), './consts');
  assert.equal(importSpecFor('src/data/site.json', PAGE, ALIAS), '@/data/site.json', 'JSON keeps its extension');
  assert.equal(aliasProbeFor('src/consts.ts'), '@/consts');
  assert.equal(aliasProbeFor('public/site.json'), undefined);
  const aliased = nodes({ style: ALIAS });
  assert.equal(aliased[0].importNeed.spec, '@/consts');
  const files = new Set(['src/consts.ts', 'src/data/index.ts']);
  assert.equal(moduleFileOf('../consts', PAGE, files), 'src/consts.ts');
  assert.equal(moduleFileOf('@/consts.ts', PAGE, files), 'src/consts.ts');
  assert.equal(moduleFileOf('../data', PAGE, files), 'src/data/index.ts');
  assert.equal(moduleFileOf('../../../../consts', PAGE, files), undefined, 'never above the project');
  assert.equal(moduleFileOf('astro:content', PAGE, files), undefined);
});

test('an imported export is in scope, not listed again; a sibling import is reused, and a taken name is aliased', () => {
  const imports = [{ name: 'NAV', imported: 'NAV', path: '@/consts.ts', named: true }];
  const roots = nodes({ imports, frontmatter: "const SITE = 'mine';", style: RELATIVE });
  assert.equal(
    roots.find((node) => node.path === 'NAV'),
    undefined,
    'NAV is already imported',
  );
  const site = roots.find((node) => node.importNeed?.exported === 'SITE');
  assert.equal(site.path, 'SITE2', 'the file already has a SITE');
  assert.equal(site.importNeed.spec, '@/consts.ts', 'joins the module’s existing import, as it is written');
  assert.equal(site.children[0].path, 'SITE2.name');
  assert.equal(freeName('SITE', new Set(['SITE', 'SITE2'])), 'SITE3');
  assert.throws(() => freeName('x-y', new Set()), /the name is an identifier/);
});

test('exclusions hide files, exports and collections; the default shows everything', () => {
  const all = nodes({ config: parseProjectFolders({ version: 1 }) });
  assert.equal(all.length, 5);
  const config = parseProjectFolders({ version: 1, cms: { pickerExcluded: ['src/consts.ts#NAV', 'src/data/site-settings.json', 'stats'] } });
  assert.deepEqual(
    nodes({ config }).map((node) => node.path),
    ['SITE', 'NOINDEX_ROUTES', 'BUILT'],
  );
  const fileOut = parseProjectFolders({ version: 1, cms: { pickerExcluded: ['src/consts.ts'] } });
  assert.deepEqual(
    nodes({ config: fileOut }).map((node) => node.path),
    ['siteSettings'],
  );
});

test('data files follow the collections in the tree, and search reaches into them keeping their roots', () => {
  const projectSources = nodes({});
  const tree = dataTree({ frontmatter: "const title = 'Home';", collections: [{ name: 'stats', count: 2 }], projectSources });
  assert.deepEqual(
    tree.map((node) => [node.path, node.section]),
    [
      ['title', 'frontmatter'],
      ['statsEntries', 'collections'],
      ['SITE', 'data-file:src/consts.ts'],
      ['NOINDEX_ROUTES', 'data-file:src/consts.ts'],
      ['BUILT', 'data-file:src/consts.ts'],
      ['NAV', 'data-file:src/consts.ts'],
      ['siteSettings', 'data-file:src/data/site-settings.json'],
    ],
  );
  const { searchMatches } = loadPicker();
  const matches = searchMatches(tree, 'acme');
  assert.deepEqual(
    matches.map((match) => [match.node.path, match.root.path]),
    [
      ['SITE.name', 'SITE'],
      ['SITE.url', 'SITE'],
    ],
  );
  assert.deepEqual(
    searchMatches(tree, 'description').map((match) => match.node.path),
    ['SITE.description'],
  );
});

test('picking writes the import first and binds the name it ended up under', () => {
  const asked = [];
  const bindContext = {
    ensureImport: (need) => {
      asked.push(need);
      return 'SITE2';
    },
    ensureQuery: () => 'stats',
  };
  const need = { kind: 'import', import: { spec: '@/consts', exported: 'SITE', name: 'SITE' }, name: 'SITE' };
  assert.equal(resolvePick('SITE.name', need, bindContext), 'SITE2.name');
  assert.deepEqual(asked, [need.import]);
  assert.equal(
    resolvePick('statsEntries[0].data.Header', { kind: 'collection', collection: 'stats', name: 'statsEntries' }, bindContext),
    'stats[0].data.Header',
  );
  assert.equal(resolvePick('title', undefined, bindContext), 'title', 'data in scope writes nothing');
  assert.throws(() => resolvePick('other.name', need, bindContext), /the path starts with the name its need reads/);
});

test('a new import, a merge into the module’s import, and an alias on collision print as the project writes them', () => {
  const fresh = readFrontmatter("import Layout from '../layouts/Layout.astro';\n\nconst title = 'Home';");
  const added = withDataImport(fresh, { spec: '@/consts', exported: 'SITE', name: 'SITE' });
  assert.equal(added.name, 'SITE');
  assert.equal(writeFrontmatter(added.model), "import Layout from '../layouts/Layout.astro';\nimport { SITE } from '@/consts';\n\nconst title = 'Home';");

  const existing = readFrontmatter('import { NAV } from "@/consts";\nimport Layout from "../layouts/Layout.astro";\n\nconst title = "Home";');
  const merged = withDataImport(existing, { spec: '@/consts', exported: 'SITE', name: 'SITE' });
  assert.equal(
    writeFrontmatter(merged.model),
    'import { NAV, SITE } from "@/consts";\nimport Layout from "../layouts/Layout.astro";\n\nconst title = "Home";',
    'joined to the existing import, quotes kept, every other line as written',
  );
  assert.equal(withDataImport(merged.model, { spec: '@/consts', exported: 'SITE', name: 'SITE' }).model, merged.model, 'an import already there is reused');

  const taken = readFrontmatter("import { NAV } from '@/consts';\n\nconst SITE = 'mine';");
  const aliased = withDataImport(taken, { spec: '@/consts', exported: 'SITE', name: 'SITE' });
  assert.equal(aliased.name, 'SITE2');
  assert.match(writeFrontmatter(aliased.model), /^import \{ NAV, SITE as SITE2 \} from '@\/consts';/);

  const json = withDataImport(readFrontmatter(''), { spec: '../data/site-settings.json', exported: 'default', name: 'siteSettings' });
  assert.equal(writeFrontmatter(json.model), "import siteSettings from '../data/site-settings.json';");
});

test('a collection pick writes the getCollection query once, and reuses it', () => {
  const page = readFrontmatter("const title = 'Home';");
  const added = withCollectionQuery(page, 'stats');
  assert.equal(added.name, 'statsEntries');
  assert.equal(
    writeFrontmatter(added.model),
    "import { getCollection } from 'astro:content';\nconst title = 'Home';\nconst statsEntries = await getCollection('stats'); // stacki:query",
  );
  const again = withCollectionQuery(added.model, 'stats');
  assert.equal(again.model, added.model, 'the same collection is the same query');
  assert.equal(again.name, 'statsEntries');
  assert.throws(() => withCollectionQuery(page, 'a b'), /a collection name/);
});

test('the import and the binding are one gesture: one undo step with both changes', () => {
  const model = { ...readFrontmatter("const title = 'Home';"), nodes: [] };
  const addition = frontmatterGesture(
    model,
    { coalesceKey: undefined, urgency: false },
    (shown) => withDataImport(shown, { spec: '@/consts', exported: 'SITE', name: 'SITE' }).model,
  );
  const bind = {
    coalesceKey: undefined,
    urgency: true,
    stream: undefined,
    request: () => [{ tag: 'bound' }],
    apply: (shown) => ({ ...shown, bound: 'SITE.name' }),
  };
  // What appHistory's commitEdit does with a held gesture and the field's edit.
  const step = sequence(addition, bind);
  const after = step.apply(model);
  assert.equal(after.bound, 'SITE.name');
  assert.deepEqual(
    after.imports.map((entry) => entry.name),
    ['SITE'],
  );
  const requests = step.request(() => undefined, undefined);
  assert.equal(requests.length, 2, 'both edits go to disk as one step');
  assert.equal(requests[0].tag, 'set-frontmatter');
  assert.equal(requests[1].tag, 'bound');
});

test('the picker heads each data file, shows no per-row frontmatter hint, and says what each pick needs', () => {
  const { DataPicker, needOf } = loadPicker();
  const tree = dataTree({ frontmatter: "const title = 'Home';", collections: [{ name: 'stats', count: 2 }], projectSources: nodes({}) });
  const markup = renderToStaticMarkup(React.createElement(DataPicker, { tree, current: undefined, origin: { file: PAGE, page: undefined }, onPick() {} }));
  assert.match(markup, /dp-section-heading">consts\.ts</);
  assert.match(markup, /dp-section-heading">data\/site-settings\.json</);
  assert.match(markup, /dp-section-heading">Content Collections</);
  // Picking from a source the file does not read yet still writes it into the frontmatter, silently: the rows stay one line.
  assert.doesNotMatch(markup, /Adds to frontmatter/, 'no row carries the frontmatter hint');
  assert.match(markup, /title="title/, 'the in-scope rows are still there');
  const site = tree.find((node) => node.path === 'SITE');
  assert.deepEqual(needOf(site), { kind: 'import', import: site.importNeed, name: 'SITE' });
  assert.deepEqual(needOf(tree.find((node) => node.path === 'statsEntries')), { kind: 'collection', collection: 'stats', name: 'statsEntries' });
  assert.equal(needOf(tree.find((node) => node.path === 'title')), undefined);
});

// The real component, bundled with React left to the test's own copy.
function loadPicker() {
  const directory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(directory, { recursive: true });
  const output = path.join(directory, 'project-data-picker.bundle.cjs');
  buildSync({
    stdin: { contents: "export { default as DataPicker, needOf, searchMatches } from './src/features/props/DataPicker.tsx';", resolveDir: ROOT },
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
  });
  delete require.cache[output];
  return require(output);
}
