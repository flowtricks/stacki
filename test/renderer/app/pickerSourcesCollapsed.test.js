// Goal: pin that Settings -> Folders -> data picker lists each data file collapsed by default, with the
// file's own switch and a "shown of total" count, while a collection stays a plain row.
// Method: bundle the real CmsSourceSettings module with esbuild, render PickerSources on the server
// (the initial state is what a first paint shows) and read the markup: the exports must be absent, the
// disclosure must report aria-expanded="false", the count must read "5 of 5", and a switched-off file
// must read "0 of 5". Opening a group needs a click, so the open branch is pinned in the source instead.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

async function loadPickerSources() {
  const { outputFiles } = await esbuild.build({
    entryPoints: [repoPath('src/app/settings/CmsSourceSettings.tsx')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom/server'],
    loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
    write: false,
  });
  const bundled = outputFiles[0];
  assert.ok(bundled);
  const filename = repoPath('node_modules/.stacki-test/picker-sources-collapsed.cjs');
  const bundleModule = { exports: {} };
  new Function('require', 'module', 'exports', bundled.text)(createRequire(filename), bundleModule, bundleModule.exports);
  const nodeRequire = createRequire(filename);
  return { PickerSources: bundleModule.exports.PickerSources, React: nodeRequire('react'), render: nodeRequire('react-dom/server').renderToStaticMarkup };
}

const NAMES = ['SITE_NAME', 'SITE_DESCRIPTION', 'SITE_URL', 'SITE_LOCALE', 'NOINDEX_ROUTES'];
const EXPORTS = NAMES.map((exported) => ({ file: 'src/consts.ts', exported }));

async function markup(config) {
  const { PickerSources, React, render } = await loadPickerSources();
  return render(React.createElement(PickerSources, { collections: ['team'], exports: EXPORTS, config, busy: false, onSave: () => {}, onNotice: () => {} }));
}

test('a data file is collapsed by default and its exports stay out of the markup', async () => {
  const html = await markup(undefined);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /5 of 5/);
  for (const name of NAMES) {
    assert.doesNotMatch(html, new RegExp(name), `${name} is hidden until the group opens`);
  }
});

test('a collection without children stays a plain row', async () => {
  const html = await markup(undefined);
  assert.match(html, /team/);
  assert.equal((html.match(/aria-expanded/g) ?? []).length, 1, 'only the data file is a disclosure');
});

test('a file switched off counts none of its exports', async () => {
  const html = await markup({ cms: { pickerExcluded: ['src/consts.ts'] } });
  assert.match(html, /0 of 5/);
});

test('the group opens through local session state, not a persisted setting', () => {
  const source = fs.readFileSync(repoPath('src/app/settings/CmsSourceSettings.tsx'), 'utf8');
  assert.match(source, /useState\(false\)/);
  assert.match(source, /\{open && \(/);
});

test('every top-level row carries an icon in the shared icon column: a file icon and a collection icon', async () => {
  const html = await markup(undefined);
  // One icon for the file's header and one for the collection row, both in the 16px icon column.
  assert.equal((html.match(/class="app-folder-row-icon"/g) ?? []).length, 2, 'the data file and the collection each have an icon');
  assert.match(html, /class="app-folder-toggle is-top-level"/, 'the collection is a top-level row');
});

test('the file header does not borrow the Roles group header, whose side padding shifted its switch', async () => {
  const html = await markup(undefined);
  assert.match(html, /class="app-folder-group-heading"/);
  assert.doesNotMatch(html, /app-role-group-heading/);
});
