// Goal: every Desktop scanner reads its folders from `.stacki/folders.json`
// and, with no file, reads exactly what it read before; the asset write
// protections hold under custom folders (a folder outside the list is not
// written, and code under src/ is never replaced or renamed as an asset); the
// folder picker answers only folders inside the project.
// Method: build temporary projects on disk, drive the real main-process
// handlers through the windowless harness, and call the scanners and helpers
// the handlers delegate to, once with no settings and once with custom ones.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mainHarness } from '../../helpers/mainHarness.ts';
import { readProjectFolders } from '#dist/electron/lib/projectFolders.js';
import { assetAbs, assetWriteRefusal, listAssetEntries } from '#dist/electron/project/assetFiles.js';
import { listCssFiles } from '#dist/electron/project/styleFiles.js';
import { findStylesheets } from '#dist/electron/project/cssVarRead.js';
import { readSelectorUsageInput } from '#dist/electron/properties/selectorUsageFiles.js';
import { componentFile } from '#dist/electron/documents/componentFile.js';
import { projectFolderOf } from '#dist/electron/handlers/projectMetadataHandlers.js';
import { renderComponentPreviewPage } from '#dist/electron/previewServer/componentPreview.js';
import { parseProjectFolders } from '#dist/shared/properties/projectFolders.js';
import { EMPTY_KEEP_LIST } from '#dist/shared/properties/styleKeepList.js';
import { toRecord, toArray } from '#dist/shared/core/record.js';

function project(files: Readonly<Record<string, string>>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-folders-')));
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return root;
}

const SITE = {
  'package.json': '{"dependencies":{"astro":"*"}}',
  'src/pages/index.astro': '<h1>Home</h1>',
  'src/components/Card.astro': '<div class="card" />',
  'src/layouts/Base.astro': '<slot />',
  'src/ui/Button.astro': '<button class="button" />',
  'src/ui/forms/Field.astro': '<input class="field" />',
  'src/shells/Shell.astro': '<slot />',
  'src/assets/hero.png': 'png',
  'src/media/logo.svg': '<svg />',
  'src/styles/global.css': ':root { --brand: blue; } .global {}',
  'src/components/card.css': ':root { --card: red; } .lonely {}',
  'public/favicon.ico': 'ico',
  'public/robots.txt': 'User-agent: *',
  'styles/extra.css': ':root { --extra: 1; }',
};

const writeFolders = (root: string, folders: unknown) => {
  fs.mkdirSync(path.join(root, '.stacki'), { recursive: true });
  fs.writeFileSync(path.join(root, '.stacki/folders.json'), JSON.stringify({ version: 1, folders }));
};

function harnessFor(root: string) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-folders-user-'));
  const harness = mainHarness(userData);
  return {
    ...harness,
    dispose: () => {
      harness.dispose();
      fs.rmSync(userData, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const relOf = (root: string, input: unknown): string => path.relative(root, String(input)).split(path.sep).join('/');

async function scan(harness: ReturnType<typeof harnessFor>, root: string) {
  const result = toRecord(await harness.invoke('project:scan', root));
  assert.ok(result);
  const names = (key: string) => toArray(result[key])?.map((entry) => relOf(root, toRecord(entry)?.['path'])) ?? [];
  return { components: names('components'), layouts: names('layouts'), raw: result };
}

test('the settings file reads absent, ready or invalid, and never follows a link', () => {
  const root = project(SITE);
  try {
    assert.deepEqual(readProjectFolders(root), { kind: 'absent' });
    writeFolders(root, { components: ['src/ui'] });
    const ready = readProjectFolders(root);
    assert.equal(ready.kind, 'ready');
    fs.writeFileSync(path.join(root, '.stacki/folders.json'), '{"version":1,"folders":{"assets":["../outside"]}}');
    const invalid = readProjectFolders(root);
    assert.equal(invalid.kind, 'invalid');
    fs.rmSync(path.join(root, '.stacki/folders.json'));
    fs.writeFileSync(path.join(root, 'elsewhere.json'), '{"version":1}');
    fs.symlinkSync(path.join(root, 'elsewhere.json'), path.join(root, '.stacki/folders.json'));
    assert.deepEqual(readProjectFolders(root), { kind: 'invalid', message: 'Folder settings cannot be a symbolic link' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the project scan lists src/components and src/layouts by default, and the chosen folders when set', async (context) => {
  const root = project(SITE);
  const harness = harnessFor(root);
  context.after(harness.dispose);
  const before = await scan(harness, root);
  assert.deepEqual(before.components, ['src/components/Card.astro']);
  assert.deepEqual(before.layouts, ['src/layouts/Base.astro']);
  const card = toRecord(toArray(before.raw['components'])?.[0]);
  assert.equal(card?.['folder'], '', 'a top-level component is ungrouped, as before');
  assert.equal(card?.['file'], 'src/components/Card.astro');

  writeFolders(root, { components: ['src/components', 'src/ui'], layouts: ['src/shells'] });
  const after = await scan(harness, root);
  assert.deepEqual(after.components.sort(), ['src/components/Card.astro', 'src/ui/Button.astro', 'src/ui/forms/Field.astro']);
  assert.deepEqual(after.layouts, ['src/shells/Shell.astro']);
  const groups = Object.fromEntries(
    (toArray(after.raw['components']) ?? []).map((entry): [string, string] => [String(toRecord(entry)?.['name']), String(toRecord(entry)?.['folder'])]),
  );
  assert.deepEqual(groups, { Card: 'components', Button: 'ui', Field: 'ui/forms' }, 'two folders keep their own groups');
  assert.equal(toRecord(toArray(after.raw['layouts'])?.[0])?.['folder'], 'shells');

  // A layout folder wins over a component folder that also covers it.
  writeFolders(root, { components: ['src/ui'], layouts: ['src/ui/forms'] });
  const overlap = await scan(harness, root);
  assert.deepEqual(overlap.components, ['src/ui/Button.astro']);
  assert.deepEqual(overlap.layouts, ['src/ui/forms/Field.astro']);
});

test('assets list both roots by default, only the chosen folders when set, and writes stay inside them', async (context) => {
  const root = project(SITE);
  const harness = harnessFor(root);
  context.after(harness.dispose);
  await harness.invoke('project:scan', root);
  const listed = async () => (toArray(toRecord(await harness.invoke('assets:list', root))?.['entries']) ?? []).map((entry) => String(toRecord(entry)?.['rel']));
  assert.deepEqual((await listed()).sort(), [
    'public',
    'public/favicon.ico',
    'public/robots.txt',
    'src',
    'src/assets',
    'src/assets/hero.png',
    'src/media',
    'src/media/logo.svg',
  ]);

  writeFolders(root, { assets: ['public', 'src/assets'] });
  assert.deepEqual((await listed()).sort(), ['public', 'public/favicon.ico', 'public/robots.txt', 'src', 'src/assets', 'src/assets/hero.png']);
  assert.equal(listAssetEntries(root).hasPublic, true);
  assert.throws(() => assetAbs(root, 'src/media/logo.svg'), /not in one of the project's asset folders/);
  assert.throws(() => assetAbs(root, 'src/assets/../media/logo.svg'), /src\/media\/logo.svg is not in one/, 'the resolved path decides, not the text');
  await assert.rejects(harness.invoke('assets:mkdir', { projectPath: root, parentRel: 'src', name: 'new' }), /not in one of the project's asset folders/);
  await assert.rejects(harness.invoke('assets:delete', { projectPath: root, rel: 'src/media/logo.svg' }), /not in one/);
  assert.ok(fs.existsSync(path.join(root, 'src/media/logo.svg')), 'nothing outside the folders was touched');

  // Even a project that lists src/ itself cannot reach code through the panel.
  writeFolders(root, { assets: ['src'] });
  assert.equal(listAssetEntries(root).hasPublic, false);
  assert.match(assetWriteRefusal('src/pages/index.astro') ?? '', /index.astro is source code, not an asset/);
  assert.match(assetWriteRefusal('src/styles/global.css') ?? '', /source code/);
  assert.equal(assetWriteRefusal('src/assets/hero.png'), undefined);
  assert.equal(assetWriteRefusal('public/robots.txt'), undefined, 'public/ is served as-is: every file is an asset');
  const replaced = toRecord(await harness.invoke('assets:replace', { projectPath: root, rel: 'src/pages/index.astro' }));
  assert.deepEqual(replaced, { ok: false, message: 'index.astro is source code, not an asset; edit it in the project instead.' });
  await assert.rejects(harness.invoke('assets:rename', { projectPath: root, rel: 'src/assets/hero.png', newName: 'hero.astro' }), /hero.astro is source code/);
  await assert.rejects(harness.invoke('assets:rename', { projectPath: root, rel: 'src/styles/global.css', newName: 'old.css' }), /global.css is source code/);
  assert.equal(fs.readFileSync(path.join(root, 'src/pages/index.astro'), 'utf8'), '<h1>Home</h1>');
  assert.ok(fs.existsSync(path.join(root, 'src/styles/global.css')));
  assert.ok(fs.existsSync(path.join(root, 'src/assets/hero.png')));
});

test('stylesheets come from src, public and styles by default, and from the chosen folders when set', async () => {
  const root = project(SITE);
  try {
    const css = () => listCssFiles(root).map((file) => file.rel);
    const variables = () => findStylesheets(root).map((file: string) => path.relative(root, file).split(path.sep).join('/'));
    assert.deepEqual(css(), ['styles/extra.css', 'src/components/card.css', 'src/styles/global.css']);
    assert.deepEqual(variables(), ['src/components/card.css', 'src/styles/global.css', 'styles/extra.css']);
    const before = await readSelectorUsageInput(root, EMPTY_KEEP_LIST);
    assert.deepEqual(before.stylesheets.map((sheet) => sheet.rel).sort(), ['src/components/card.css', 'src/styles/global.css', 'styles/extra.css']);

    writeFolders(root, { styles: ['src/styles'] });
    assert.deepEqual(css(), ['src/styles/global.css']);
    assert.deepEqual(variables(), ['src/styles/global.css'], 'a file with only `styles` sets the variables folders too');
    // Each panel reads its own key once both are written.
    writeFolders(root, { styles: ['src/styles'], variables: ['styles'] });
    assert.deepEqual(css(), ['src/styles/global.css'], 'the style panel reads `styles`');
    assert.deepEqual(variables(), ['styles/extra.css'], 'the variables panel reads `variables`');
    writeFolders(root, { variables: ['styles'] });
    assert.deepEqual(css(), ['styles/extra.css', 'src/components/card.css', 'src/styles/global.css'], '`variables` alone leaves stylesheets at their defaults');
    writeFolders(root, { styles: ['src/styles'] });
    const folders = parseProjectFolders({ version: 1, folders: { styles: ['src/styles'] } }).folders.styles;
    const after = await readSelectorUsageInput(root, EMPTY_KEEP_LIST, folders);
    assert.deepEqual(
      after.stylesheets.map((sheet) => sheet.rel),
      ['src/styles/global.css'],
      'a stylesheet outside the style folders is not offered for clean-up',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a new component goes in the first component folder, and the preview route globs follow the folders', () => {
  const root = project(SITE);
  try {
    const nodes = [{ kind: 'element', id: 'n1', name: 'div', attrs: [], children: [] }];
    const made = componentFile({ projectPath: root, pagePath: path.join(root, 'src/pages/index.astro'), name: 'Promo', nodes, componentFolders: ['src/ui'] });
    assert.equal(made.path, path.join(root, 'src', 'ui', 'Promo.astro'));
    assert.throws(
      () => componentFile({ projectPath: root, pagePath: path.join(root, 'src/pages/index.astro'), name: 'Promo', nodes, componentFolders: [] }),
      /lists no component folders/,
    );

    // The page's own text, compared as written: the globs are literals in generated code.
    const defaultGlobs =
      "import.meta.glob(['" + ['', 'src', 'components', '**', '*.astro'].join('/') + "', '" + ['', 'src', 'layouts', '**', '*.astro'].join('/') + "']";
    assert.equal(renderComponentPreviewPage().split(defaultGlobs).length - 1, 2, 'unchanged by default');
    const custom = renderComponentPreviewPage(parseProjectFolders({ version: 1, folders: { components: ['src/ui', 'src/blocks'], layouts: ['src/shells'] } }));
    const customGlobs = ['ui', 'blocks', 'shells'].map((folder) => "'" + ['', 'src', folder, '**', '*.astro'].join('/') + "'").join(', ');
    assert.ok(custom.includes('import.meta.glob([' + customGlobs + ']'));
    const none = renderComponentPreviewPage(parseProjectFolders({ version: 1, folders: { components: [], layouts: [] } }));
    assert.match(none, /__stacki_no_components__/, 'no folders previews nothing instead of failing to compile');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the folder picker answers only folders inside the project', () => {
  const root = project(SITE);
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-folders-outside-')));
  try {
    assert.deepEqual(projectFolderOf(root, path.join(root, 'src/ui')), { kind: 'picked', path: 'src/ui' });
    assert.deepEqual(projectFolderOf(root, root), { kind: 'outside', message: 'Choose something inside the project, not the project itself.' });
    assert.deepEqual(projectFolderOf(root, outside), { kind: 'outside', message: 'That is outside the project.' });
    fs.symlinkSync(outside, path.join(root, 'src/link'));
    assert.deepEqual(
      projectFolderOf(root, path.join(root, 'src/link')),
      { kind: 'outside', message: 'That is outside the project.' },
      'a link is followed first',
    );
    assert.deepEqual(projectFolderOf(root, path.join(root, 'src/missing')), { kind: 'outside', message: 'That is no longer there.' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('the CMS panel detects its data files by default, and lists exactly the chosen ones when set', async (context) => {
  const root = project({
    'package.json': '{"dependencies":{"astro":"*"}}',
    'src/pages/index.astro': '<h1>Home</h1>',
    'src/consts.ts': "export const SITE_TITLE = 'Site';\nexport const LINKS = [{ label: 'Home', href: '/' }];\n",
    'src/lib/settings.ts': "export const THEME = 'dark';\n",
    'src/data/team.json': '[{"name":"Ada"}]',
  });
  const harness = harnessFor(root);
  context.after(harness.dispose);
  await harness.invoke('project:scan', root);
  const listed = async () =>
    [
      ...new Set((toArray(toRecord(await harness.invoke('cms:list', root))?.['files']) ?? []).map((file) => String(toRecord(file)?.['rel']).split('#')[0])),
    ].sort();
  assert.deepEqual(await listed(), ['consts.ts', 'data/team.json'], 'default: unchanged automatic detection');
  writeFolders(root, {});
  fs.writeFileSync(path.join(root, '.stacki/folders.json'), JSON.stringify({ version: 1, cms: { files: ['src/consts.ts', 'src/lib/settings.ts'] } }));
  assert.deepEqual(await listed(), ['consts.ts', 'lib/settings.ts'], 'an added file is present, a removed one absent');
  // Astro files are sources whatever the list says (a page's, a layout's and a component's
  // frontmatter data), and one the list names is read once.
  fs.mkdirSync(path.join(root, 'src/components'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/components/Hero.astro'), "---\nconst slides = [{ title: 'One' }];\n---\n<div />\n");
  fs.writeFileSync(path.join(root, 'src/pages/example-components.astro'), "---\nconst items = [{ name: 'A' }];\n---\n<div />\n");
  assert.deepEqual(await listed(), ['components/Hero.astro', 'consts.ts', 'lib/settings.ts', 'pages/example-components.astro']);
  fs.writeFileSync(
    path.join(root, '.stacki/folders.json'),
    JSON.stringify({ version: 1, cms: { files: ['src/components/Hero.astro', 'src/lib/settings.ts'] } }),
  );
  const rels = (toArray(toRecord(await harness.invoke('cms:list', root))?.['files']) ?? []).map((file) => String(toRecord(file)?.['rel']));
  assert.equal(rels.filter((rel) => rel.startsWith('components/Hero.astro')).length, 1, 'listed once');
  assert.deepEqual(await listed(), ['components/Hero.astro', 'lib/settings.ts', 'pages/example-components.astro']);
});

test('the scan reports the pages folder from a literal srcDir, and src/pages without one', async (context) => {
  const root = project({ ...SITE, 'astro.config.mjs': "export default { srcDir: './app' };" });
  const harness = harnessFor(root);
  context.after(harness.dispose);
  const withConfig = toRecord(await harness.invoke('project:scan', root));
  assert.equal(withConfig?.['pagesFolder'], 'app/pages');
  assert.equal(withConfig?.['astroConfig'], 'astro.config.mjs');
  fs.rmSync(path.join(root, 'astro.config.mjs'));
  const without = toRecord(await harness.invoke('project:scan', root));
  assert.equal(without?.['pagesFolder'], 'src/pages');
  assert.equal(without?.['astroConfig'], undefined);
});
