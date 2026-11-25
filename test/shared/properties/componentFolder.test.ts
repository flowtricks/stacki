// Goal: a folder typed in the Create component (and Rename) dialog becomes the same normalized path below the components root
// everywhere, or is refused with the reason a person needs: a path that climbs out with `..`, one that starts at the disk, an empty
// level, a character no folder may hold, or one too long or too deep. Nested folders are fine, slashes are normalized, and a level
// that differs from an existing folder only in case takes the existing spelling. Main's own check (componentFolderProblem and the
// boundary parser) refuses the same structural problems for a folder chosen from the list.
// Method: tables of typed inputs against the expected path or problem kind, in both naming styles, then the structural check and
// the boundary parser on the shapes that must cross into main and the ones that must not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { componentFolderProblem, parseComponentSubfolder, parseTypedFolderPath } from '#dist/shared/properties/componentNaming.js';

const ACCEPTED: ReadonlyArray<readonly [string, 'pascal' | 'kebab', string]> = [
  ['Form', 'pascal', 'Form'],
  ['form', 'pascal', 'Form'],
  ['Global/Layout', 'pascal', 'Global/Layout'],
  ['global layout/hero cards', 'pascal', 'GlobalLayout/HeroCards'],
  ['Global\\Layout\\', 'pascal', 'Global/Layout'],
  ['  Global/Layout/  ', 'pascal', 'Global/Layout'],
  ['Sign Up', 'kebab', 'sign-up'],
  ['Global/Layout', 'kebab', 'global/layout'],
];

test('a typed folder is normalized level by level, nested levels and all', () => {
  for (const [typed, style, expected] of ACCEPTED) {
    const parsed = parseTypedFolderPath(typed, style);
    assert.equal(parsed.ok, true, `${typed} is accepted`);
    if (parsed.ok) {
      assert.equal(parsed.value, expected, `${typed} in ${style}`);
    }
  }
});

const REFUSED: ReadonlyArray<readonly [string, string]> = [
  ['', 'empty'],
  ['   ', 'empty'],
  ['/Global', 'absolute'],
  ['\\Global', 'absolute'],
  ['C:\\Users\\x', 'absolute'],
  ['~/Global', 'absolute'],
  ['..', 'parent'],
  ['../pages', 'parent'],
  ['Global/../../pages', 'parent'],
  ['Global/./Layout', 'parent'],
  ['Global//Layout', 'empty-level'],
  ['Global/ /Layout', 'empty-level'],
  ['Global/---', 'empty-level'],
  ['Glo*bal', 'character'],
  ['Global/La:yout', 'character'],
];

test('a typed folder that climbs out, starts at the disk or has an empty level or a bad character is refused with its reason', () => {
  for (const [typed, kind] of REFUSED) {
    const parsed = parseTypedFolderPath(typed, 'pascal');
    assert.equal(parsed.ok, false, `${JSON.stringify(typed)} is refused`);
    if (!parsed.ok) {
      assert.equal(parsed.error.kind, kind, `${JSON.stringify(typed)} is refused as ${kind}`);
    }
  }
});

test('the refused character is named so the dialog can say which one', () => {
  const parsed = parseTypedFolderPath('Glo*bal', 'pascal');
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.deepEqual(parsed.error, { kind: 'character', character: '*' });
  }
});

test('a level that differs from an existing folder only in case takes the existing spelling', () => {
  const existing = ['Global', 'Global/Layout', 'forms'];
  const folded = parseTypedFolderPath('global/layout', 'pascal', existing);
  assert.equal(folded.ok, true);
  if (folded.ok) {
    assert.equal(folded.value, 'Global/Layout', 'both levels fold onto the existing folders');
  }
  const partly = parseTypedFolderPath('GLOBAL/Hero', 'pascal', existing);
  assert.equal(partly.ok, true);
  if (partly.ok) {
    assert.equal(partly.value, 'Global/Hero', 'the existing level folds and the new one keeps its typed spelling');
  }
  const lower = parseTypedFolderPath('Forms', 'pascal', existing);
  assert.equal(lower.ok, true);
  if (lower.ok) {
    assert.equal(lower.value, 'forms', 'a lowercase folder on disk keeps its lowercase spelling');
  }
});

test('a folder that is too deep or too long is refused', () => {
  const deep = Array.from({ length: 40 }, (_, index) => `Level${index}`).join('/');
  const tooDeep = componentFolderProblem(deep);
  assert.equal(tooDeep?.kind, 'too-deep');
  const tooLong = componentFolderProblem('A'.repeat(600));
  assert.equal(tooLong?.kind, 'too-long');
});

test('main accepts the root and any folder spelled as it is on disk, and refuses the structural problems', () => {
  assert.equal(componentFolderProblem(''), undefined, 'the root itself');
  assert.equal(componentFolderProblem('Global/Layout'), undefined);
  assert.equal(componentFolderProblem('_partials/ui.kit'), undefined, 'a folder a person made by hand keeps its own characters');
  assert.equal(componentFolderProblem('../pages')?.kind, 'parent');
  assert.equal(componentFolderProblem('/etc')?.kind, 'absolute');
  assert.equal(componentFolderProblem('Global\\Layout')?.kind, 'absolute');
  assert.equal(componentFolderProblem('Global//Layout')?.kind, 'empty-level');
  assert.equal(componentFolderProblem('Global/')?.kind, 'empty-level');
  assert.equal(componentFolderProblem('Glo|bal')?.kind, 'character');
  assert.equal(componentFolderProblem('Glo\u0000bal')?.kind, 'character');
});

test('the boundary parser passes a usable folder through and throws on the rest', () => {
  assert.equal(parseComponentSubfolder(''), '');
  assert.equal(parseComponentSubfolder('Global/Layout'), 'Global/Layout');
  assert.throws(() => parseComponentSubfolder('../pages'), /not a folder under the components folder \(parent\)/);
  assert.throws(() => parseComponentSubfolder('/etc'), /\(absolute\)/);
  assert.throws(() => parseComponentSubfolder(7), /A component folder is a string/);
  assert.throws(() => parseComponentSubfolder(undefined), /A component folder is a string/);
});
