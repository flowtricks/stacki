// Goal: the live line under the rename dialog's name field is decided on the NORMALIZED name: typing "Accordion Cards" is checked as
// AccordionCards, the taken check ignores case and typing style, problems name their cause (empty, a leading digit, a reserved name, a
// character that cannot be kept, a typed extension or slash), the same name in another folder is only a warning, and nothing about the
// current file is a clash with itself.
// Method: bundle the pure model, call it with a generated component list, and compare the answers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'rename-availability.cjs');
buildSync({
  entryPoints: [repoPath('src/features/palette/renameAvailability.ts')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const { renameAvailability, folderInput } = require(output);

const components = [
  { file: 'src/components/Card.astro', name: 'Card' },
  { file: 'src/components/AccordionCards.astro', name: 'AccordionCards' },
  { file: 'src/components/forms/Button.astro', name: 'Button' },
];
const ask = (name, extra = {}) =>
  renameAvailability({ current: 'src/components/Card.astro', name, folder: 'src/components', style: 'pascal', components, ...extra });

test('spaces are allowed while typing: the preview is the normalized path, with a note that spaces were removed', () => {
  const answer = ask('Hero Banner');
  assert.equal(answer.kind, 'available');
  assert.equal(answer.path, 'src/components/HeroBanner.astro');
  assert.equal(answer.change, 'spaces');
  assert.equal(ask('HeroBanner').change, undefined, 'nothing to say when the typed name is already the saved one');
  assert.equal(ask('hero-banner').change, 'other');
});

test('taken is checked on the normalized name, without case', () => {
  for (const typed of ['Accordion Cards', 'accordion cards', 'accordion-cards', 'ACCORDIONCARDS']) {
    const answer = ask(typed);
    assert.equal(answer.kind, 'taken', typed);
    assert.equal(answer.by, 'src/components/AccordionCards.astro');
    assert.equal(answer.path.toLowerCase(), 'src/components/accordioncards.astro');
  }
});

test('the current name and folder is unchanged, even typed differently', () => {
  assert.equal(ask('Card').kind, 'same');
  assert.equal(ask(' card ').kind, 'same');
});

test('problems say what is wrong', () => {
  const key = (answer) => answer.problem?.messageRef?.key;
  assert.equal(key(ask('')), 'palette.name.empty');
  assert.equal(key(ask('   ')), 'palette.name.empty');
  assert.equal(key(ask('---')), 'palette.name.noLetters');
  assert.equal(key(ask('2 cards')), 'palette.name.startsWithNumber');
  assert.equal(key(ask('fragment')), 'palette.name.reserved');
  assert.equal(key(ask('a/b')), 'palette.rename.separator');
  assert.equal(key(ask('Card.astro')), 'palette.rename.extension');
  const bad = ask('card 🙂');
  assert.equal(key(bad), 'palette.rename.badCharacter');
  assert.equal(bad.problem.messageRef.params.character, '🙂');
  assert.equal(ask('Hero Banner!').kind, 'invalid');
});

test('a dashed project saves dashed file names, and the same name in another folder is a warning', () => {
  const dashed = ask('Accordion Cards 2', { style: 'kebab' });
  assert.equal(dashed.path, 'src/components/accordion-cards-2.astro');
  const twin = ask('Button');
  assert.equal(twin.kind, 'available');
  assert.equal(twin.sameNameIn, 'src/components/forms/Button.astro');
});

test('a new folder is normalized in the project folder style and names what it cannot keep', () => {
  assert.deepEqual(folderInput('Sign Up', 'kebab').path, 'sign-up');
  assert.equal(folderInput('Sign Up', 'kebab').problem, undefined);
  assert.equal(folderInput('', 'kebab').problem.messageRef.key, 'palette.rename.folderInvalid');
  assert.equal(folderInput('a*b', 'kebab').problem.messageRef.params.character, '*');
});
