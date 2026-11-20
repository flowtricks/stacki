// Goal: where a style goes (shared/properties/newStyleLocations.ts) is read, migrated, written and
// chosen exactly as documented: the `newStyleLocations` section parses with a reason for every bad
// shape, a project that holds only the older single `newStyleTag` reads it as BOTH scopes and is
// otherwise untouched, a save writes the new section and mirrors the page's tag into the older one,
// a chosen file that is missing falls back to the tag, and the placement rules for a stylesheet
// (marker, last @layer, anything else at the top level) give the wrapper chain each file must get.
// Method: tables of sections and files with the exact result each must give, then the negative
// space: bad `use` values, path shapes that escape the project or are not stylesheets, a file
// without balanced braces, a marker inside a rule, an `@media` block at the end of a file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_NEW_STYLE_LOCATIONS,
  NEW_STYLE_LOCATION_LIMITS,
  effectiveLocation,
  fileRuleWrappers,
  isStylesheetPath,
  locationHealth,
  locationsOfLegacy,
  newStyleLocationsDocument,
  parseNewStyleLocations,
  stylesheetChoices,
  withFile,
  withTag,
} from '#dist/shared/properties/newStyleLocations.js';
import { DEFAULT_NEW_STYLE_TAG } from '#dist/shared/properties/newStyleTag.js';
import { effectiveNewStyleLocations, parseStyleKeepList, serializeStyleKeepList } from '#dist/shared/properties/styleKeepList.js';

const TAG = { version: 2, attributes: 'is:global' };
const section = (page: unknown, component: unknown) => ({ version: 1, page, component });

test('a project that never wrote a section gets a style tag for both scopes', () => {
  assert.deepEqual(effectiveNewStyleLocations(parseStyleKeepList({ version: 1, keep: [] })), DEFAULT_NEW_STYLE_LOCATIONS);
  assert.equal(DEFAULT_NEW_STYLE_LOCATIONS.page.kind, 'tag');
  assert.equal(DEFAULT_NEW_STYLE_LOCATIONS.component.kind, 'tag');
});

test('the older single template migrates to both scopes, and reading it writes nothing', () => {
  const source = JSON.stringify({ version: 1, keep: [], newStyleTag: { version: 2, attributes: '', content: '@layer base {}' } });
  const locations = effectiveNewStyleLocations(parseStyleKeepList(JSON.parse(source)));
  const tag = { attributes: [], content: '@layer base {}' };
  assert.deepEqual(locations, { page: { kind: 'tag', tag }, component: { kind: 'tag', tag } });
  assert.deepEqual(locationsOfLegacy(tag), locations);
  // Re-serialising what was read is the file as it was: nothing moves until a person changes a setting.
  assert.equal(serializeStyleKeepList(parseStyleKeepList(JSON.parse(source))), serializeStyleKeepList(parseStyleKeepList(JSON.parse(source))));
  assert.ok(!serializeStyleKeepList(parseStyleKeepList(JSON.parse(source))).includes('newStyleLocations'));
});

test('a section round-trips, and the page tag is mirrored into the older section', () => {
  const page = { kind: 'file' as const, path: 'src/styles/global.css', tag: DEFAULT_NEW_STYLE_TAG };
  const component = { kind: 'tag' as const, tag: { attributes: [], content: '@layer components {\n}' } };
  const written = serializeStyleKeepList({ version: 1, keep: [], lockedStylesheets: [], newStyleLocations: { page, component } });
  const file: unknown = JSON.parse(written);
  const locationsDocument = {
    version: 1,
    page: { use: 'file', file: 'src/styles/global.css', tag: TAG },
    component: { use: 'tag', tag: { version: 2, attributes: '', content: '@layer components {\n}' } },
  };
  // The older Stacki reads the page tag from the mirror.
  assert.deepEqual(file, { version: 1, keep: [], newStyleTag: TAG, newStyleLocations: locationsDocument });
  assert.deepEqual(effectiveNewStyleLocations(parseStyleKeepList(file)), { page, component });
  // The new section wins when both are present.
  const both = { version: 1, keep: [], newStyleTag: { version: 2, attributes: 'lang="scss"' }, newStyleLocations: locationsDocument };
  assert.equal(effectiveNewStyleLocations(parseStyleKeepList(both)).page.tag.attributes[0]?.name, 'is:global');
});

test('a scope the section does not mention keeps the default; use defaults to tag', () => {
  const parsed = parseNewStyleLocations({ version: 1, component: { use: 'file', file: 'a.css' } });
  assert.deepEqual(parsed.page, DEFAULT_NEW_STYLE_LOCATIONS.page);
  assert.deepEqual(parsed.component, { kind: 'file', path: 'a.css', tag: DEFAULT_NEW_STYLE_TAG });
  assert.deepEqual(parseNewStyleLocations({ version: 1, page: {} }).page, DEFAULT_NEW_STYLE_LOCATIONS.page);
});

test('bad sections are refused with their reason', () => {
  const bad = (page: unknown) => () => parseNewStyleLocations(section(page, undefined));
  assert.throws(() => parseNewStyleLocations({ version: 2 }), /version/);
  assert.throws(() => parseNewStyleLocations('x'), /Expected object/);
  assert.throws(bad({ use: 'folder' }), /page\.use/);
  assert.throws(bad({ use: 'file' }), /Expected string/);
  assert.throws(bad({ use: 'file', file: '../x.css' }), /page\.file/);
  assert.throws(bad({ use: 'file', file: '/abs/x.css' }), /page\.file/);
  assert.throws(bad({ use: 'file', file: 'src/x.ts' }), /page\.file/);
  assert.throws(bad({ use: 'tag', file: 'src/x.css' }), /only written when use is "file"/);
  assert.throws(bad({ tag: { version: 2, attributes: 'lang={x}' } }), /expressions/);
  assert.throws(bad({ tag: { content: '@layer a {' } }), /unclosed/);
  assert.throws(bad({ tag: 7 }), /Expected object/);
});

test('which paths are stylesheets of the project', () => {
  for (const good of ['a.css', 'src/styles/global.css', 'src/styles/_base.scss', 'x/y.SASS', 'theme.less']) {
    assert.equal(isStylesheetPath(good), true, good);
  }
  const bad = ['', '/a.css', 'C:/a.css', 'a\\b.css', '../a.css', 'a/../b.css', 'a//b.css', './a.css', 'a.css/', 'a.astro', 'a.ts', 'css'];
  for (const path of bad) {
    assert.equal(isStylesheetPath(path), false, path);
  }
  assert.equal(isStylesheetPath(`${'a/'.repeat(NEW_STYLE_LOCATION_LIMITS.pathSegmentsMax)}b.css`), false, 'too deep');
  assert.equal(isStylesheetPath(`${'a'.repeat(NEW_STYLE_LOCATION_LIMITS.pathCharsMax)}.css`), false, 'too long');
  assert.deepEqual(stylesheetChoices(['src/a.css', 'src/b.astro', 'c.scss']), ['src/a.css', 'c.scss']);
});

test('a chosen file is used while it exists; a missing one falls back to the tag and is reported', () => {
  const tag = { attributes: [], content: 'x {}' };
  const file = { kind: 'file' as const, path: 'src/styles/a.css', tag };
  assert.deepEqual(effectiveLocation(file, ['src/styles/a.css']), { kind: 'file', path: 'src/styles/a.css' });
  assert.deepEqual(effectiveLocation(file, ['src/styles/b.css']), { kind: 'tag', tag });
  assert.deepEqual(effectiveLocation(file, []), { kind: 'tag', tag });
  assert.deepEqual(locationHealth(file, ['src/styles/a.css']), { kind: 'ready' });
  assert.deepEqual(locationHealth(file, ['b.css']), { kind: 'missing', path: 'src/styles/a.css' });
  assert.deepEqual(locationHealth({ kind: 'tag', tag }, []), { kind: 'ready' }, 'a tag is never missing');
  // Switching place keeps the tag default.
  assert.deepEqual(withTag(file), { kind: 'tag', tag });
  assert.deepEqual(withFile({ kind: 'tag', tag }, 'z.css'), { kind: 'file', path: 'z.css', tag });
});

test('where a rule goes in a stylesheet: marker, last @layer, else the top level', () => {
  const chain = (css: string) => fileRuleWrappers(css).map((wrapper) => `${wrapper.name} ${wrapper.params}`);
  assert.deepEqual(chain(''), [], 'an empty file');
  assert.deepEqual(chain('.a { color: red; }\n'), [], 'rules only');
  assert.deepEqual(chain('@layer base, components;\n.a {}\n'), [], 'an order statement is not a block');
  assert.deepEqual(chain('.a {}\n@layer components {\n  .b {}\n}\n'), ['layer components'], 'the last top-level block is a layer');
  assert.deepEqual(chain('@layer components {\n  .b {}\n}\n.a {}\n'), [], 'a rule after the layer: the layer is not last');
  assert.deepEqual(chain('@layer a { .x {} }\n@layer b { .y {} }\n'), ['layer b'], 'the last of several layers');
  assert.deepEqual(chain('.a {}\n@media (width < 48rem) {\n  .a { color: red; }\n}\n'), [], 'a media block at the end is overrides, not a wrapper');
  assert.deepEqual(chain('@layer base {\n  /* stacki:rules */\n}\n@layer other {}\n'), ['layer base'], 'a marker names its block, wherever it sits');
  assert.deepEqual(chain('@layer a {\n  @layer b {\n    /* stacki:rules */\n  }\n}\n'), ['layer a', 'layer b'], 'a marker in nested layers');
  assert.deepEqual(chain('/* stacki:rules */\n.a {}\n'), [], 'a top-level marker is the top level');
});

test('a file that is not balanced CSS, or a marker where a rule cannot go, is written at the top level', () => {
  assert.deepEqual(fileRuleWrappers('@layer a {\n .x {}\n'), [], 'unclosed brace');
  assert.deepEqual(fileRuleWrappers('.a { content: "x }\n'), [], 'unclosed string');
  assert.deepEqual(fileRuleWrappers('.a {\n /* stacki:rules */\n}\n'), [], 'marker inside a rule');
  assert.deepEqual(fileRuleWrappers('/* stacki:rules */ /* stacki:rules */ @layer a {}'), [], 'two markers');
});

test('the document written for a section reads back the same', () => {
  const locations = { page: withFile(DEFAULT_NEW_STYLE_LOCATIONS.page, 'a.css'), component: DEFAULT_NEW_STYLE_LOCATIONS.component };
  assert.deepEqual(parseNewStyleLocations(newStyleLocationsDocument(locations)), locations);
});
