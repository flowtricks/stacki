// Goal: the Instructions panel's search keeps exactly the skills, rules and docs a query means,
// shows a folder only while something under it matches, and leaves a section empty (so the panel
// hides it) when nothing in it does.
// Methodology: run the real module (src/features/instructions/instructionsModel.ts) through the
// app's bundler on hand-made sections: a match by name, by description, by path and by folder, words
// in any order, accents and case, a query of spaces, and a query nothing matches.
const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../../helpers/rendererModule')('src/features/instructions/instructionsModel.ts');

const file = (path) => ({ kind: 'file', path, label: path.split('/').at(-1), entry: { path } });
const SECTIONS = {
  skills: [
    { path: '.claude/skills/deploy/SKILL.md', name: 'deploy', description: 'Ship the Éclair release', valid: true },
    { path: '.claude/skills/review/SKILL.md', name: 'review', description: 'Read a diff', valid: true },
  ],
  rules: [
    { kind: 'folder', path: '.claude/rules', label: '.claude/rules', children: [file('.claude/rules/testing.md'), file('.claude/rules/style.md')] },
    { kind: 'folder', path: '.cursor/rules', label: '.cursor/rules', children: [file('.cursor/rules/naming.mdc')] },
  ],
  docs: [file('docs/Releases.md')],
};
const rulePaths = (sections) => sections.rules.flatMap((folder) => folder.children.map((child) => child.path));

test('a skill is found by name and by description, ignoring case and accents', () => {
  assert.deepEqual(
    model.filterSections(SECTIONS, 'DEPLOY').skills.map((skill) => skill.name),
    ['deploy'],
  );
  assert.deepEqual(
    model.filterSections(SECTIONS, 'eclair').skills.map((skill) => skill.name),
    ['deploy'],
  );
});

test('a rule or doc is found by its path; a folder stays only with a match under it', () => {
  const found = model.filterSections(SECTIONS, 'testing');
  assert.deepEqual(rulePaths(found), ['.claude/rules/testing.md']);
  assert.equal(found.rules.length, 1);
  assert.equal(model.filterSections(SECTIONS, 'cursor').rules.length, 1);
  assert.equal(model.filterSections(SECTIONS, 'releases').docs.length, 1);
});

test('words may come in any order and all must match', () => {
  assert.deepEqual(rulePaths(model.filterSections(SECTIONS, 'md testing')), ['.claude/rules/testing.md']);
  assert.deepEqual(rulePaths(model.filterSections(SECTIONS, 'testing naming')), []);
});

test('a section with no match is empty and the counts follow the matches', () => {
  const found = model.filterSections(SECTIONS, 'review');
  assert.equal(found.skills.length, 1);
  assert.equal(model.countFiles(found.rules), 0);
  assert.equal(model.countFiles(found.docs), 0);
  assert.equal(model.countFiles(model.filterSections(SECTIONS, 'rules').rules), 3);
});

test('a query of spaces or nothing found keeps nothing', () => {
  for (const query of ['', '   ', 'zzzzz']) {
    const found = model.filterSections(SECTIONS, query);
    assert.equal(found.skills.length, 0);
    assert.equal(found.rules.length, 0);
    assert.equal(found.docs.length, 0);
  }
});
