// Goal: the binding picker knows the values a file imports. `import { LINKS, APP_VERSION } from
// "@/consts.ts"` makes APP_VERSION a pickable row with its value as the preview, and LINKS an
// object whose fields are rows of their own, so a chip bound to either never shows up as a
// field "not in this entry". An import whose module cannot be read (a package, a computed
// value) is still listed, as "imported" with no preview. "not in this entry" stays reserved
// for a field a collection entry left unset.
// Method: module sources are read by the pure core (importedValues.ts) exactly as the hosts
// hand them over, through a fake readModule keyed by specifier; the resulting values go into
// the data tree the way App.tsx and Studio's bindContext pass them, and the tree's rows,
// kinds and previews are read. The negative space is covered too: computed exports, re-exports,
// type-only and markup imports, oversized modules and the module bound. The missing-row label
// is pinned through dataPickerModel's missingLabel and the rendered DataPicker.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule');
const { dataTree } = loadRenderer('src/editor/dataSuggest.ts');
const { importedModuleRequests, importedValuesFrom, readImportedValues, scriptExport, IMPORTED_VALUE_LIMITS } = loadRenderer('src/editor/importedValues.ts');
const { missingLabel } = loadRenderer('src/features/props/dataPickerModel.ts');

const CONSTS = `/** Site name. */
export const SITE_NAME = "Stacki";
export const APP_VERSION = "1.0.12";
export const NOINDEX_ROUTES: string[] = ["/404"];
export const BUILT_AT = new Date().toISOString();
/** Everywhere the project lives. */
export const LINKS = {
  github: "https://github.com/flowtricks/stacki",
  issues: "https://github.com/flowtricks/stacki/issues",
} as const;
const limits = { pageSize: 20 } satisfies Record<string, number>;
export { limits as LIMITS };
export { other } from './other';
`;

const PAGE_IMPORTS = [
  { name: 'Layout', path: '@/layouts/BaseLayout.astro' },
  { name: 'LINKS', path: '@/consts.ts', named: true, imported: 'LINKS' },
  { name: 'APP_VERSION', path: '@/consts.ts', named: true, imported: 'APP_VERSION' },
  { name: 'VERSION_TAG', path: 'some-package', named: true },
  { name: 'Props', path: '@/types.ts', named: true, typeOnly: true },
];

const MODULES = { '@/consts.ts': { file: 'src/consts.ts', text: CONSTS } };
const readModule = async (spec) => MODULES[spec];

async function pageTree(imports = PAGE_IMPORTS) {
  const importedValues = await readImportedValues(imports, readModule);
  return dataTree({ frontmatter: 'const promises = [{ title: "Fast" }];', imports, importedValues });
}

test('an imported literal is a pickable row with its value as the preview', async () => {
  const tree = await pageTree();
  const version = tree.find((node) => node.path === 'APP_VERSION');
  assert.ok(version, 'APP_VERSION is in the tree, so a chip bound to it is found');
  assert.equal(version.kind, 'text');
  assert.equal(version.preview, '"1.0.12"');
  assert.equal(version.section, 'frontmatter');
  assert.equal(tree.find((node) => node.path === 'promises')?.kind, 'list', 'the frontmatter’s own values are still there');
});

test('an imported object shows its fields as rows', async () => {
  const links = (await pageTree()).find((node) => node.path === 'LINKS');
  assert.equal(links?.kind, 'object');
  assert.deepEqual(
    links.children.map((child) => [child.path, child.kind, child.preview]),
    [
      ['LINKS.github', 'text', '"https://github.com/flowtricks/stacki"'],
      // Clipped as any frontmatter literal's preview is.
      ['LINKS.issues', 'text', '"https://github.com/flowtricks/stacki/issu…'],
    ],
  );
});

test('an unresolved package import is listed as imported, with no preview', async () => {
  const tree = await pageTree();
  const tag = tree.find((node) => node.path === 'VERSION_TAG');
  assert.deepEqual([tag?.kind, tag?.preview, tag?.children], ['imported', '', undefined]);
  assert.equal(
    tree.find((node) => node.path === 'Layout'),
    undefined,
    'a component is not data',
  );
  assert.equal(
    tree.find((node) => node.path === 'Props'),
    undefined,
    'a type-only import is not data',
  );
  const computed = await pageTree([{ name: 'BUILT_AT', path: '@/consts.ts', named: true }]);
  assert.deepEqual(
    computed.map((node) => [node.path, node.kind, node.preview]).filter(([path]) => path === 'BUILT_AT'),
    [['BUILT_AT', 'imported', '']],
    'a computed export is imported, never previewed as code',
  );
});

test('a module is read without running it: literals, export lists, defaults and JSON', () => {
  assert.deepEqual(scriptExport(CONSTS, 'NOINDEX_ROUTES'), { kind: 'literal', text: '["/404"]' }, 'a type annotation is skipped');
  assert.deepEqual(scriptExport(CONSTS, 'LIMITS'), { kind: 'literal', text: '{ pageSize: 20 }' }, 'an export list names a local declaration');
  assert.equal(scriptExport(CONSTS, 'BUILT_AT'), undefined, 'a call is computed');
  assert.equal(scriptExport(CONSTS, 'other'), undefined, 'a re-export is another module’s');
  assert.equal(scriptExport(CONSTS, 'MISSING'), undefined);
  assert.equal(scriptExport('export const A = `v${B}`;', 'A'), undefined, 'an interpolated template is computed');
  assert.equal(scriptExport('export const A = "a" + b;', 'A'), undefined, 'an expression is computed');
  assert.deepEqual(scriptExport('const site = { name: "x" };\nexport default site;', 'default'), { kind: 'literal', text: '{ name: "x" }' });
  assert.deepEqual(scriptExport('export const COUNT = 3 as const;', 'COUNT'), { kind: 'literal', text: '3' });
  assert.throws(() => scriptExport(CONSTS, 'not a name'), /an export name is an identifier/);

  const team = {
    spec: '../data/team.json',
    bindings: [
      { local: 'team', exported: 'default' },
      { local: 'lead', exported: 'lead' },
    ],
  };
  const json = importedValuesFrom(team, { file: 'src/data/team.json', text: '{ "lead": "Ada", "members": [] }' });
  assert.deepEqual(json, { team: { kind: 'data', value: { lead: 'Ada', members: [] } }, lead: { kind: 'data', value: 'Ada' } });
  assert.deepEqual(importedValuesFrom(team, { file: 'src/data/team.json', text: '{ broken' }), {}, 'malformed JSON resolves nothing');
  const huge = 'export const A = 1;' + ' '.repeat(IMPORTED_VALUE_LIMITS.moduleCharsMax);
  assert.deepEqual(
    importedValuesFrom({ spec: 'x', bindings: [{ local: 'A', exported: 'A' }] }, { file: 'src/x.ts', text: huge }),
    {},
    'an oversized module is not read',
  );
});

test('module requests skip what holds no values and stay bounded', async () => {
  const requests = importedModuleRequests(PAGE_IMPORTS);
  assert.deepEqual(
    requests.map((request) => request.spec),
    ['@/consts.ts', 'some-package'],
    'markup and type-only imports are not read; one request per module',
  );
  assert.equal(requests[0].bindings.length, 2);
  const many = Array.from({ length: IMPORTED_VALUE_LIMITS.modulesMax + 5 }, (_, index) => ({ name: `value${index}`, path: `./m${index}.ts`, named: true }));
  assert.equal(importedModuleRequests(many).length, IMPORTED_VALUE_LIMITS.modulesMax);
  const failing = await readImportedValues(PAGE_IMPORTS, async () => {
    throw new Error('offline');
  });
  assert.deepEqual(failing, {}, 'a module that fails to read leaves its imports unresolved');
});

test('only a field missing from a collection entry is "not in this entry"', () => {
  const field = (key) => ({ key });
  const entry = { key: 'post', preview: '', children: [field('id'), field('collection'), field('data')] };
  const data = { key: 'data', preview: '2 fields', children: [field('title'), field('pubDate')] };
  assert.equal(missingLabel([entry, data]), 'not in this entry');
  assert.equal(missingLabel([{ key: 'blog', preview: 'blog entries', children: [field('0')] }]), 'not in this entry');
  assert.equal(missingLabel([{ key: 'stats', preview: '4 entries', query: { collection: 'stats', name: 'stats' }, children: undefined }]), 'not in this entry');
  assert.equal(missingLabel([{ key: 'LINKS', preview: '', children: [field('github')] }]), 'no such field');
  assert.equal(missingLabel([{ key: 'site', preview: '', children: undefined }]), 'fields not known');
  assert.equal(missingLabel([]), 'not in scope');
});
