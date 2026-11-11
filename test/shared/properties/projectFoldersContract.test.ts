// Goal: `.stacki/folders.json` reads only project-relative, bounded,
// non-overlapping folders for each panel; a missing file or key reads exactly
// the folders every panel used before folders were configurable; and the
// Folders tab's add, remove and reset produce files that read back the same.
// Method: pin the defaults for each panel, parse known-good shapes, then each
// known-bad shape and each bound just past its limit (pinning the message),
// round-trip edits through the serializer, and query the path helpers with
// paths on both sides of every folder boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PROJECT_FOLDERS,
  EMPTY_PROJECT_FOLDERS,
  PROJECT_FOLDER_KINDS,
  PROJECT_FOLDER_LIMITS,
  addCmsFile,
  cmsDataFiles,
  isAstroSource,
  addFolder,
  cmsFilesFor,
  isCollectionHidden,
  removeCmsFile,
  shownCollections,
  withCmsFiles,
  withCollectionShown,
  componentGroup,
  configOf,
  folderChoiceProblem,
  folderHolding,
  foldersFor,
  isAboveFolder,
  differsFromDefaults,
  isCustomized,
  parseProjectFolder,
  parseProjectFolders,
  readProjectFoldersSource,
  removeFolder,
  serializeProjectFolders,
  withFolders,
} from '#dist/shared/properties/projectFolders.js';
import { METADATA_FILES, validateMetadata } from '#dist/shared/properties/projectMetadata.js';
import { pagesFolderOf, sourceDirectoryFromConfig } from '#dist/shared/properties/astroSourceDirectory.js';

test('without a file, or without a key, every panel reads what it always read', () => {
  // Pinned per panel: these are the folders each scanner hard-coded before.
  assert.deepEqual(foldersFor('components', undefined), ['src/components']);
  assert.deepEqual(foldersFor('layouts', undefined), ['src/layouts']);
  assert.deepEqual(foldersFor('assets', undefined), ['public', 'src']);
  assert.deepEqual(foldersFor('styles', undefined), ['src', 'public', 'styles']);
  assert.deepEqual(foldersFor('variables', undefined), ['src', 'public', 'styles'], 'the variables panel read the style folders before it had its own');
  assert.deepEqual(PROJECT_FOLDER_KINDS, ['components', 'layouts', 'assets', 'styles', 'variables']);
  for (const kind of PROJECT_FOLDER_KINDS) {
    assert.deepEqual(foldersFor(kind, EMPTY_PROJECT_FOLDERS), DEFAULT_PROJECT_FOLDERS[kind], `${kind}: an empty file is the defaults`);
    assert.equal(isCustomized(kind, undefined), false);
  }
  const onlyComponents = parseProjectFolders({ version: 1, folders: { components: ['src/ui'] } });
  assert.deepEqual(foldersFor('components', onlyComponents), ['src/ui']);
  assert.deepEqual(foldersFor('layouts', onlyComponents), ['src/layouts'], 'a missing key keeps its default');
  assert.deepEqual(readProjectFoldersSource(undefined), { kind: 'absent' });
  assert.equal(configOf({ kind: 'absent' }), undefined);
  assert.equal(configOf({ kind: 'invalid', message: 'x' }), undefined, 'an invalid file reads the defaults');
  assert.equal(METADATA_FILES.folders, '.stacki/folders.json');
});

test('good shapes parse', () => {
  assert.deepEqual(parseProjectFolders({ version: 1 }), { version: 1, folders: {} });
  const config = parseProjectFolders({
    version: 1,
    folders: { components: ['src/ui', 'src/blocks'], layouts: ['src/shells'], assets: ['public/images', 'src/assets'], styles: ['styles', 'src/css'] },
  });
  assert.deepEqual(config.folders.assets, ['public/images', 'src/assets']);
  assert.deepEqual(parseProjectFolders({ version: 1, folders: { components: [] } }).folders.components, [], 'an empty list is a choice');
  assert.equal(parseProjectFolder('src/My Folder/sub-dir_2.x'), 'src/My Folder/sub-dir_2.x');
  assert.doesNotThrow(() => validateMetadata('folders', JSON.stringify({ version: 1, folders: { layouts: ['src/layouts'] } })));
});

test('a file from before `variables` seeds it from `styles`, and the next save writes both', () => {
  const legacy = parseProjectFolders({ version: 1, folders: { styles: ['src/css'] } });
  assert.deepEqual(foldersFor('styles', legacy), ['src/css']);
  assert.deepEqual(foldersFor('variables', legacy), ['src/css'], 'the variables panel keeps reading what it read');
  assert.equal(isCustomized('variables', legacy), true);
  const written: unknown = JSON.parse(serializeProjectFolders(legacy));
  assert.deepEqual(written, { version: 1, folders: { styles: ['src/css'], variables: ['src/css'] } });
  // Once both keys exist they are independent.
  const split = parseProjectFolders({ version: 1, folders: { styles: ['src/css'], variables: ['src/tokens'] } });
  assert.deepEqual(foldersFor('variables', split), ['src/tokens']);
  const onlyVariables = parseProjectFolders({ version: 1, folders: { variables: ['styles'] } });
  assert.deepEqual(foldersFor('styles', onlyVariables), ['src', 'public', 'styles'], '`variables` alone never changes the style folders');
  assert.deepEqual(foldersFor('variables', withFolders(legacy, 'variables', undefined)), ['src', 'public', 'styles'], 'reset goes to the default');
  const fresh = withFolders(undefined, 'styles', ['src/css']);
  assert.deepEqual(
    fresh.folders,
    { styles: ['src/css'], variables: ['src', 'public', 'styles'] },
    'choosing styles writes variables out, so they read back unchanged',
  );
  assert.equal(isCustomized('variables', fresh), true, 'scanners see the written-out list as a choice');
  assert.equal(differsFromDefaults('variables', fresh), false, 'but it is not a change the Folders tab offers to reset');
  assert.equal(differsFromDefaults('styles', fresh), true);
  assert.deepEqual(foldersFor('variables', parseProjectFolders(JSON.parse(serializeProjectFolders(fresh)))), ['src', 'public', 'styles']);
  assert.throws(() => parseProjectFolders({ version: 1, folders: { variables: ['lib/css'] } }), /Folders for variables: lib\/css is outside/);
});

test('bad shapes and every bound fail with a message that says why', () => {
  const bad = (input: unknown, message: RegExp) => assert.throws(() => parseProjectFolders(input), message);
  bad(undefined, /Expected object/);
  bad([], /Expected object/);
  bad({ version: 2 }, /Unsupported folder settings version/);
  bad({ version: 1, folders: [] }, /Expected object/);
  bad({ version: 1, folders: { components: 'src/ui' } }, /expected a list/);
  bad({ version: 1, folders: { components: [3] } }, /project-relative path/);
  bad({ version: 1, folders: { components: ['src/ui', 'src/ui'] } }, /already in the list/);
  bad({ version: 1, folders: { components: ['src/ui', 'src/ui/cards'] } }, /already covered by src\/ui/);
  bad({ version: 1, folders: { components: ['src/ui/cards', 'src/ui'] } }, /would cover src\/ui\/cards/);
  bad({ version: 1, folders: { components: ['src/pages/parts'] } }, /inside src\/pages/);
  bad({ version: 1, folders: { layouts: ['src/pages'] } }, /inside src\/pages/);
  bad({ version: 1, folders: { components: ['src'] } }, /src holds the pages too/);
  bad({ version: 1, folders: { components: ['public/components'] } }, /outside src\//);
  bad({ version: 1, folders: { assets: ['assets'] } }, /outside public\/ and src\//);
  bad({ version: 1, folders: { styles: ['lib/css'] } }, /outside src\/ and public\/ and styles\//);
  const tooMany = Array.from({ length: PROJECT_FOLDER_LIMITS.foldersPerKindMax + 1 }, (_, index) => `src/f${index}`);
  bad({ version: 1, folders: { components: tooMany } }, /exceed 16 folders/);
  assert.doesNotThrow(() => parseProjectFolders({ version: 1, folders: { components: tooMany.slice(1) } }), 'exactly the limit fits');

  const folder = (input: unknown, message: RegExp) => assert.throws(() => parseProjectFolder(input), message);
  folder('', /needs a path/);
  folder('/src/ui', /not absolute/);
  folder('C:/site/src', /not a drive/);
  folder('src\\ui', /uses \/ between folders/);
  folder('src//ui', /empty folder name/);
  folder('src/ui/', /empty folder name/);
  folder('src/../etc', /cannot step out/);
  folder('src/./ui', /cannot step out/);
  folder('src/.hidden', /Hidden folders/);
  folder('.stacki', /Hidden folders/);
  folder('src/node_modules', /installed or built/);
  folder('src/dist', /installed or built/);
  folder('src/a"b', /characters a folder path cannot hold/);
  folder('src/a*', /characters a folder path cannot hold/);
  folder('src/trailing ', /cannot end with a space/);
  folder('src/' + 'a'.repeat(PROJECT_FOLDER_LIMITS.segmentCharsMax + 1), /folder name exceeds 64/);
  assert.doesNotThrow(() => parseProjectFolder('src/' + 'a'.repeat(PROJECT_FOLDER_LIMITS.segmentCharsMax)));
  folder('src/' + Array.from({ length: PROJECT_FOLDER_LIMITS.pathSegmentsMax }, () => 'a').join('/'), /at most 8 levels/);
  assert.doesNotThrow(() => parseProjectFolder(['src', ...Array.from({ length: PROJECT_FOLDER_LIMITS.pathSegmentsMax - 1 }, () => 'a')].join('/')));
  const long = 'src/' + Array.from({ length: 4 }, () => 'b'.repeat(60)).join('/');
  assert.ok(long.length > PROJECT_FOLDER_LIMITS.pathCharsMax);
  folder(long, /exceeds 200 characters/);

  assert.equal(readProjectFoldersSource('{broken').kind, 'invalid');
  const huge = readProjectFoldersSource(' '.repeat(PROJECT_FOLDER_LIMITS.fileCharsMax + 1));
  assert.equal(huge.kind, 'invalid');
  assert.match(huge.kind === 'invalid' ? huge.message : '', /exceed 16384 characters/);
  assert.throws(() => validateMetadata('folders', JSON.stringify({ version: 1, folders: { assets: ['../outside'] } })), /cannot step out/);
});

test('keys and panels a newer Stacki wrote are ignored for reading and kept on writing', () => {
  const newer = { version: 1, theme: { accent: 'blue' }, folders: { widgets: ['src/widgets'], pages: ['src/routes'], components: ['src/ui'], __proto__x: 1 } };
  const config = parseProjectFolders(newer);
  assert.deepEqual(foldersFor('components', config), ['src/ui'], 'the panels it knows are read');
  assert.deepEqual(foldersFor('layouts', config), ['src/layouts']);
  const added = addFolder(config, 'layouts', 'src/shells');
  assert.ok(added.ok);
  const written: unknown = JSON.parse(serializeProjectFolders(added.value));
  assert.deepEqual(written, {
    version: 1,
    theme: { accent: 'blue' },
    folders: { components: ['src/ui'], layouts: ['src/layouts', 'src/shells'], widgets: ['src/widgets'], pages: ['src/routes'], __proto__x: 1 },
  });
  const reset = withFolders(withFolders(config, 'components', undefined), 'layouts', undefined);
  assert.deepEqual(JSON.parse(serializeProjectFolders(reset)), {
    version: 1,
    theme: { accent: 'blue' },
    folders: { widgets: ['src/widgets'], pages: ['src/routes'], __proto__x: 1 },
  });
  // A key that names the object prototype stays data, never the prototype.
  const tricky = parseProjectFolders(JSON.parse('{"version":1,"__proto__":{"polluted":true},"folders":{}}'));
  const rewritten: unknown = JSON.parse(serializeProjectFolders(tricky));
  assert.equal(Reflect.get({}, 'polluted'), undefined);
  assert.ok(typeof rewritten === 'object' && rewritten !== undefined);
  assert.deepEqual(Object.keys(rewritten ?? {}), ['version', '__proto__', 'folders']);
});

test('add, remove and reset start from what the panel reads now and round-trip through the file', () => {
  const added = addFolder(undefined, 'components', 'src/ui');
  assert.ok(added.ok);
  assert.deepEqual(foldersFor('components', added.value), ['src/components', 'src/ui'], 'adding keeps the defaults it started from');
  const source = serializeProjectFolders(added.value);
  assert.deepEqual(JSON.parse(source), { version: 1, folders: { components: ['src/components', 'src/ui'] } });
  const reread = readProjectFoldersSource(source);
  assert.equal(reread.kind, 'ready');

  const removed = removeFolder(added.value, 'components', 'src/components');
  assert.deepEqual(foldersFor('components', removed), ['src/ui']);
  const emptied = removeFolder(removed, 'components', 'src/ui');
  assert.deepEqual(foldersFor('components', emptied), [], 'removing the last folder lists none');
  assert.equal(isCustomized('components', emptied), true);
  const reset = withFolders(emptied, 'components', undefined);
  assert.equal(isCustomized('components', reset), false);
  assert.deepEqual(foldersFor('components', reset), ['src/components']);
  assert.deepEqual(JSON.parse(serializeProjectFolders(reset)), { version: 1, folders: {} });

  const refusal = (kind: Parameters<typeof addFolder>[1], folder: string) => {
    const result = addFolder(undefined, kind, folder);
    assert.equal(result.ok, false);
    return result.ok ? '' : result.error;
  };
  assert.match(refusal('components', 'src/components'), /already in the list/);
  assert.match(refusal('assets', 'src/assets'), /already covered by src/);
  assert.match(refusal('assets', 'node_modules'), /installed or built/);
  assert.match(refusal('layouts', '../elsewhere'), /cannot step out/);
  assert.equal(folderChoiceProblem('styles', [], 'styles/tokens'), undefined);
  assert.throws(() => removeFolder(undefined, 'assets', 'src/assets'), /Assertion failed: removeFolder: the folder is in the list/);
});

test('folder helpers answer on both sides of every boundary', () => {
  assert.equal(folderHolding(['src/ui'], 'src/ui/Card.astro'), 'src/ui');
  assert.equal(folderHolding(['src/ui'], 'src/ui'), 'src/ui');
  assert.equal(folderHolding(['src/ui'], 'src/uikit/Card.astro'), undefined, 'a prefix of a name is not a folder');
  assert.equal(folderHolding(['src/ui'], 'src/Card.astro'), undefined);
  assert.equal(isAboveFolder(['src/assets/images'], 'src'), true);
  assert.equal(isAboveFolder(['src/assets/images'], 'src/assets'), true);
  assert.equal(isAboveFolder(['src/assets/images'], 'src/assets/images'), false);
  assert.equal(isAboveFolder(['src/assets/images'], 'src/components'), false);

  assert.equal(componentGroup(['src/components'], 'src/components/Card.astro'), '', 'one folder: its top level is ungrouped, as before');
  assert.equal(componentGroup(['src/components'], 'src/components/cards/Card.astro'), 'cards');
  assert.equal(componentGroup(['src/components', 'src/ui'], 'src/ui/Button.astro'), 'ui');
  assert.equal(componentGroup(['src/components', 'src/ui'], 'src/components/cards/Card.astro'), 'components/cards');
  assert.throws(() => componentGroup(['src/ui'], 'src/other/X.astro'), /Assertion failed: componentGroup/);
});

test('the cms key: no key is automatic detection with every collection shown; files and hidden collections parse, bound and round-trip', () => {
  assert.equal(cmsFilesFor(undefined), undefined, 'no settings: the panel detects its data files, as before');
  assert.equal(cmsFilesFor(EMPTY_PROJECT_FOLDERS), undefined);
  const collections = [{ name: 'blog' }, { name: 'team' }, { name: 'faq' }];
  assert.deepEqual(shownCollections(collections, undefined), collections, 'no settings: every collection shows');

  const config = parseProjectFolders({ version: 1, cms: { files: ['src/consts.ts', 'src/data/site.json'], hiddenCollections: ['team'], later: { x: 1 } } });
  assert.deepEqual(cmsFilesFor(config), ['src/consts.ts', 'src/data/site.json']);
  assert.equal(isCollectionHidden(config, 'team'), true);
  assert.deepEqual(
    shownCollections(collections, config).map((collection) => collection.name),
    ['blog', 'faq'],
    'a hidden collection is absent',
  );
  assert.deepEqual(JSON.parse(serializeProjectFolders(config)), {
    version: 1,
    folders: {},
    cms: { files: ['src/consts.ts', 'src/data/site.json'], hiddenCollections: ['team'], later: { x: 1 } },
  });

  const bad = (cms: unknown, message: RegExp) => assert.throws(() => parseProjectFolders({ version: 1, cms }), message);
  bad([], /Expected object/);
  bad({ files: 'src/consts.ts' }, /CMS files: expected a list/);
  bad({ files: ['src/../consts.ts'] }, /cannot step out/);
  bad({ files: ['/src/consts.ts'] }, /not absolute/);
  bad({ files: ['consts.ts'] }, /outside src\//);
  bad({ files: ['src/logo.png'] }, /not a file the CMS can edit/);
  bad({ files: ['src/env.d.ts'] }, /not a file the CMS can edit/);
  bad({ files: ['src/a.ts', 'src/a.ts'] }, /already in the list/);
  bad({ files: Array.from({ length: PROJECT_FOLDER_LIMITS.cmsFilesMax + 1 }, (_, index) => `src/f${index}.ts`) }, /exceed 64 files/);
  bad({ hiddenCollections: 'team' }, /Hidden collections: expected a list/);
  bad({ hiddenCollections: ['a b'] }, /each is a collection name/);
  bad({ hiddenCollections: ['x'.repeat(PROJECT_FOLDER_LIMITS.collectionNameCharsMax + 1)] }, /each is a collection name/);
  bad({ hiddenCollections: ['team', 'team'] }, /listed twice/);
  bad({ hiddenCollections: Array.from({ length: PROJECT_FOLDER_LIMITS.cmsHiddenCollectionsMax + 1 }, (_, index) => `c${index}`) }, /exceed 256 names/);
});

test('CMS edits start from detection, and resetting and showing again remove the cms key', () => {
  const detected = ['src/consts.ts', 'src/data/links.ts'];
  const added = addCmsFile(undefined, 'src/settings.ts', detected);
  assert.ok(added.ok);
  assert.deepEqual(cmsFilesFor(added.value), ['src/consts.ts', 'src/data/links.ts', 'src/settings.ts'], 'the first add keeps what was found');
  const removed = removeCmsFile(undefined, 'src/consts.ts', detected);
  assert.deepEqual(cmsFilesFor(removed), ['src/data/links.ts'], 'the first remove too');
  const refused = addCmsFile(undefined, 'src/logo.png', detected);
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? '' : refused.error, /choose a .ts, .js, .json or .astro file/);
  const outside = addCmsFile(undefined, '../secrets.ts', detected);
  assert.equal(outside.ok, false);

  const hidden = withCollectionShown(added.value, 'team', { shown: false });
  assert.equal(isCollectionHidden(hidden, 'team'), true);
  assert.deepEqual(cmsFilesFor(hidden), cmsFilesFor(added.value), 'hiding keeps the files');
  const shownAgain = withCollectionShown(hidden, 'team', { shown: true });
  const reset = withCmsFiles(shownAgain, undefined);
  assert.equal(reset.cms, undefined, 'nothing chosen: no cms key');
  assert.deepEqual(JSON.parse(serializeProjectFolders(reset)), { version: 1, folders: {} });
  // Folder edits keep the CMS choices.
  const withComponents = addFolder(hidden, 'components', 'src/ui');
  assert.ok(withComponents.ok);
  assert.equal(isCollectionHidden(withComponents.value, 'team'), true);
});

test('srcDir is read from astro.config as a literal only, and pages follow it', () => {
  assert.equal(sourceDirectoryFromConfig("export default defineConfig({ srcDir: './app' })"), 'app');
  assert.equal(sourceDirectoryFromConfig('export default { srcDir: "site/src/" }'), 'site/src');
  assert.equal(sourceDirectoryFromConfig("export default { site: 'https://example.com' }"), undefined, 'no setting: Astro’s default');
  assert.equal(sourceDirectoryFromConfig("// srcDir: './old'\nexport default {}"), undefined, 'a commented-out setting does not count');
  assert.equal(sourceDirectoryFromConfig('export default { srcDir: `${root}/src` }'), undefined, 'a computed value is not read');
  assert.equal(sourceDirectoryFromConfig("export default { srcDir: '../outside' }"), undefined);
  assert.equal(sourceDirectoryFromConfig("export default { srcDir: '/abs/src' }"), undefined);
  assert.equal(pagesFolderOf(undefined), 'src/pages');
  assert.equal(pagesFolderOf('app'), 'app/pages');
});

test('Astro files are always CMS sources: never data files, refused when picked, ignored in an older saved list', () => {
  const detected = ['src/components/Button.astro', 'src/pages/example-components.astro', 'src/layouts/Base.astro', 'src/consts.ts'];
  assert.equal(isAstroSource('src/pages/example-components.astro'), true);
  assert.equal(isAstroSource('src/consts.ts'), false);
  assert.deepEqual(cmsDataFiles(undefined, detected), ['src/consts.ts'], 'pages, layouts and components are all left out');

  const picked = addCmsFile(undefined, 'src/pages/about.astro', detected);
  assert.equal(picked.ok, false);
  assert.match(picked.ok ? '' : picked.error, /is an Astro file: the CMS includes the open one automatically/);
  const added = addCmsFile(undefined, 'src/settings.ts', detected);
  assert.ok(added.ok);
  assert.deepEqual(cmsFilesFor(added.value), ['src/consts.ts', 'src/settings.ts'], 'seeding leaves Astro files out');

  // Saved by an earlier build, with Astro paths in it: it parses, and they are redundant.
  const older = parseProjectFolders({ version: 1, cms: { files: ['src/components/Button.astro', 'src/pages/index.astro', 'src/consts.ts'] } });
  assert.deepEqual(cmsDataFiles(older, detected), ['src/consts.ts']);
  assert.deepEqual(cmsFilesFor(removeCmsFile(older, 'src/consts.ts', detected)), [], 'the next save drops them');
});
