// Goal: a typed name becomes the real file name and import identifier the same way everywhere (Rename dialog, Create dialog, new
// folders, CLI): words joined in the project's style, separators of every kind dropped, accents flattened, and anything that cannot be
// part of a name reported by character rather than silently lost.
// Method: a table of typed inputs against the expected PascalCase and dashed results, then the style detectors and the file-name check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectFolderStyle,
  detectNamingStyle,
  identifierOfFileName,
  isComponentFileName,
  normalizeComponentName,
  normalizeFolderPath,
} from '#dist/shared/properties/componentNaming.js';

const TABLE: ReadonlyArray<readonly [string, string, string, readonly string[]]> = [
  ['Accordion Cards', 'AccordionCards', 'accordion-cards', []],
  ['accordion cards', 'AccordionCards', 'accordion-cards', []],
  ['  accordion   cards  ', 'AccordionCards', 'accordion-cards', []],
  ['my-card', 'MyCard', 'my-card', []],
  ['my_card', 'MyCard', 'my-card', []],
  ['my.card', 'MyCard', 'my-card', []],
  ['buttonArrow', 'ButtonArrow', 'button-arrow', []],
  ['ButtonArrow', 'ButtonArrow', 'button-arrow', []],
  ['HERO', 'HERO', 'hero', []],
  ['Card 2', 'Card2', 'card-2', []],
  ['2 cards', '2Cards', '2-cards', []],
  ['héro café', 'HeroCafe', 'hero-cafe', []],
  ['a/b', 'AB', 'a-b', ['/']],
  ['it\'s "ok"', 'ItSOk', 'it-s-ok', ["'", '"']],
  ['card 🙂', 'Card', 'card', ['🙂']],
  ['карточка', '', '', ['к', 'а', 'р', 'т', 'о', 'ч']],
  ['   ', '', '', []],
  ['', '', '', []],
  ['---', '', '', []],
];

test('typed names normalize to the file name and the identifier, naming every unusable character', () => {
  for (const [typed, pascal, kebab, rejected] of TABLE) {
    const asPascal = normalizeComponentName(typed, 'pascal');
    const asKebab = normalizeComponentName(typed, 'kebab');
    assert.equal(asPascal.fileName, pascal, `pascal: ${JSON.stringify(typed)}`);
    assert.equal(asPascal.identifier, pascal, `identifier: ${JSON.stringify(typed)}`);
    assert.equal(asKebab.fileName, kebab, `kebab: ${JSON.stringify(typed)}`);
    assert.equal(asKebab.identifier, pascal, `a dashed file still imports under a PascalCase identifier: ${JSON.stringify(typed)}`);
    assert.deepEqual(asPascal.rejected, rejected, `rejected: ${JSON.stringify(typed)}`);
  }
});

test('a pasted wall of text is bounded, not processed whole', () => {
  const result = normalizeComponentName(`a ${'b'.repeat(100_000)}`, 'pascal');
  assert.ok(result.fileName.length <= 512);
});

test('file names: PascalCase or dashed lowercase, never reserved, always a valid identifier', () => {
  for (const good of ['Card', 'AccordionCards', 'accordion-cards', 'card-2', 'Card2']) {
    assert.equal(isComponentFileName(good), true, good);
  }
  for (const bad of ['', 'card', 'Fragment', 'fragment', 'astro', '2card', 'Card Cards', 'card_cards', '-card', 'card-', 'a--b']) {
    assert.equal(isComponentFileName(bad), bad === 'card', bad);
  }
  assert.equal(identifierOfFileName('accordion-cards'), 'AccordionCards');
  assert.equal(identifierOfFileName('Card'), 'Card');
});

test('the project style is the majority: dashed files make a dashed project, ties stay PascalCase', () => {
  assert.equal(detectNamingStyle(['accordion-cards', 'hero-banner', 'Card']), 'kebab');
  assert.equal(detectNamingStyle(['Card', 'Button', 'hero-banner']), 'pascal');
  assert.equal(detectNamingStyle(['card', 'button']), 'pascal', 'single lowercase words say nothing');
  assert.equal(detectNamingStyle([]), 'pascal');
  assert.equal(detectFolderStyle(['ui', 'forms']), 'kebab');
  assert.equal(detectFolderStyle(['Forms', 'Ui', 'misc']), 'pascal');
  assert.equal(detectFolderStyle([]), 'kebab');
});

test('a new folder path is normalized level by level and reports what it cannot keep', () => {
  assert.deepEqual(normalizeFolderPath('Sign Up Forms', 'kebab'), { path: 'sign-up-forms', rejected: [] });
  assert.deepEqual(normalizeFolderPath('forms / Sign Up', 'kebab'), { path: 'forms/sign-up', rejected: [] });
  assert.deepEqual(normalizeFolderPath('Sign Up', 'pascal'), { path: 'SignUp', rejected: [] });
  assert.deepEqual(normalizeFolderPath('a//b', 'kebab'), { path: 'a/b', rejected: [] });
  assert.deepEqual(normalizeFolderPath('ui*', 'kebab'), { path: 'ui', rejected: ['*'] });
});
