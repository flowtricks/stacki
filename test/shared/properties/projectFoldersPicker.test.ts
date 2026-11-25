// Goal: `.stacki/folders.json` can leave data files, single exports and content
// collections out of the binding picker (`cms.pickerExcluded`) without touching
// the CMS panel's own choices; a file without the key shows everything, and
// what is written reads back the same.
// Method: parse the key's known-good shapes, then every known-bad shape and the
// bound just past its limit (pinning each message); query isPickerShown for each
// kind of source, including an export of a left-out file; toggle sources on and
// off and round-trip the result through the serializer, checking that the CMS
// keys beside it are kept and that showing everything again removes the key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECT_FOLDER_LIMITS,
  cmsFilesFor,
  isCollectionHidden,
  isPickerShown,
  parsePickerExclusion,
  parseProjectFolders,
  pickerExclusionText,
  readProjectFoldersSource,
  serializeProjectFolders,
  withCmsFiles,
  withCollectionShown,
  withPickerShown,
} from '#dist/shared/properties/projectFolders.js';

const SITE = { kind: 'export', file: 'src/consts.ts', exported: 'SITE' } as const;
const CONSTS = { kind: 'file', file: 'src/consts.ts' } as const;
const BLOG = { kind: 'collection', name: 'blog' } as const;

test('no key, or no file at all, shows every source in the picker', () => {
  assert.equal(isPickerShown(undefined, SITE), true);
  assert.equal(isPickerShown(undefined, CONSTS), true);
  assert.equal(isPickerShown(undefined, BLOG), true);
  const config = parseProjectFolders({ version: 1, cms: { hiddenCollections: ['blog'] } });
  assert.equal(config.cms?.pickerExcluded, undefined);
  assert.equal(isPickerShown(config, BLOG), true, 'a collection hidden from the CMS panel is still in the picker');
});

test('files, exports and collections parse, and an export goes with its file', () => {
  const config = parseProjectFolders({ version: 1, cms: { pickerExcluded: ['src/data/site.json', 'src/consts.ts#NAV', 'team'] } });
  assert.deepEqual(config.cms?.pickerExcluded, ['src/data/site.json', 'src/consts.ts#NAV', 'team']);
  assert.equal(isPickerShown(config, { kind: 'file', file: 'src/data/site.json' }), false);
  assert.equal(isPickerShown(config, { kind: 'export', file: 'src/data/site.json', exported: 'default' }), false, 'a left-out file hides its exports');
  assert.equal(isPickerShown(config, { kind: 'export', file: 'src/consts.ts', exported: 'NAV' }), false);
  assert.equal(isPickerShown(config, SITE), true, 'only the named export is left out');
  assert.equal(isPickerShown(config, CONSTS), true);
  assert.equal(isPickerShown(config, { kind: 'collection', name: 'team' }), false);
  assert.equal(isPickerShown(config, BLOG), true);
  assert.equal(isCollectionHidden(config, 'team'), false, 'the CMS panel is not affected');
  assert.deepEqual(parsePickerExclusion('src/consts.ts#SITE'), SITE);
  assert.deepEqual(parsePickerExclusion('blog'), BLOG);
  assert.deepEqual(parsePickerExclusion('src/consts.ts'), CONSTS);
  for (const source of [SITE, CONSTS, BLOG]) {
    assert.deepEqual(parsePickerExclusion(pickerExclusionText(source)), source, 'the text reads back as the source');
  }
});

test('the parser refuses every shape that names nothing the picker lists', () => {
  const bad = (pickerExcluded: unknown, message: RegExp) => assert.throws(() => parseProjectFolders({ version: 1, cms: { pickerExcluded } }), message);
  bad('src/consts.ts', /Data picker exclusions: expected a list/);
  bad({ 0: 'blog' }, /expected a list/);
  bad([7], /each is a file, an export or a collection name/);
  bad([undefined], /each is a file, an export or a collection name/);
  bad([''], /an empty entry is not a collection name/);
  bad(['a b'], /a b is not a collection name/);
  bad(['x'.repeat(PROJECT_FOLDER_LIMITS.collectionNameCharsMax + 1)], /is not a collection name/);
  bad(['public/site.json'], /not a data file under src/);
  bad(['src/pages/index.astro'], /not a data file under src/);
  bad(['src/styles/site.css'], /not a data file under src/);
  bad(['src/../consts.ts'], /cannot step out/);
  bad(['/src/consts.ts'], /not absolute/);
  bad(['src/consts.ts#'], /an empty export is not an export name/);
  bad(['src/consts.ts#1st'], /1st is not an export name/);
  bad(['src/consts.ts#a-b'], /a-b is not an export name/);
  bad([`src/consts.ts#${'A'.repeat(PROJECT_FOLDER_LIMITS.exportNameCharsMax + 1)}`], /is not an export name/);
  bad(['blog', 'blog'], /blog is listed twice/);
  bad(
    Array.from({ length: PROJECT_FOLDER_LIMITS.cmsPickerExcludedMax + 1 }, (_, index) => `c${index}`),
    /exceed 512 entries/,
  );
  // The bound itself is fine.
  const most = Array.from({ length: PROJECT_FOLDER_LIMITS.cmsPickerExcludedMax }, (_, index) => `c${index}`);
  assert.equal(parseProjectFolders({ version: 1, cms: { pickerExcluded: most } }).cms?.pickerExcluded?.length, most.length);
  assert.throws(() => parsePickerExclusion('src/consts.ts#'), /an empty export/);
});

test('toggling keeps the other CMS choices, round-trips, and showing everything again removes the key', () => {
  const start = withCollectionShown(withCmsFiles(undefined, ['src/consts.ts']), 'team', { shown: false });
  const off = withPickerShown(withPickerShown(start, SITE, { shown: false }), BLOG, { shown: false });
  assert.deepEqual(off.cms?.pickerExcluded, ['src/consts.ts#SITE', 'blog']);
  assert.deepEqual(cmsFilesFor(off), ['src/consts.ts'], 'the CMS files are kept');
  assert.equal(isCollectionHidden(off, 'team'), true, 'the hidden collections are kept');
  const text = serializeProjectFolders(off);
  const reread = readProjectFoldersSource(text);
  assert.equal(reread.kind, 'ready');
  assert.deepEqual(reread.kind === 'ready' ? reread.config.cms?.pickerExcluded : undefined, ['src/consts.ts#SITE', 'blog']);
  // Toggling a file off and on and the files list reset leave the exclusions alone.
  const reset = withCmsFiles(off, undefined);
  assert.deepEqual(reset.cms?.pickerExcluded, ['src/consts.ts#SITE', 'blog']);
  const back = withPickerShown(withPickerShown(off, SITE, { shown: true }), BLOG, { shown: true });
  assert.equal(back.cms?.pickerExcluded, undefined, 'nothing left out: no pickerExcluded key');
  assert.equal(isPickerShown(back, SITE), true);
  const bare = withPickerShown(withPickerShown(undefined, CONSTS, { shown: false }), CONSTS, { shown: true });
  assert.equal(bare.cms, undefined, 'a project that undoes its only change has no cms key');
  const unknown = parseProjectFolders({ version: 1, cms: { pickerExcluded: ['blog'], later: { x: 1 } } });
  assert.match(serializeProjectFolders(withPickerShown(unknown, CONSTS, { shown: false })), /"later"/, 'a newer key under cms is kept');
});

test('leaving out more than the bound fails loudly rather than writing a file that cannot be read', () => {
  let config: ReturnType<typeof withPickerShown> | undefined;
  for (let index = 0; index < PROJECT_FOLDER_LIMITS.cmsPickerExcludedMax; index++) {
    config = withPickerShown(config, { kind: 'collection', name: `c${index}` }, { shown: false });
  }
  assert.throws(() => withPickerShown(config, BLOG, { shown: false }), /At most 512 sources/);
});
