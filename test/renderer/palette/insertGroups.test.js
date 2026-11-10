// Goal: the insert grid sorts components into sections and blocks, and moves its highlight, by pure rules.
// Methodology: bundle the two pure modules, then feed them the shapes a project produces: a direct
// <section>, a section reached through one or several components, cycles, chains past the depth
// bound, lookalike names, and every edge of a three-column grid.
const test = require('node:test');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const path = require('node:path');
const fs = require('node:fs');
const { repoPath } = require('../../helpers/sources.js');

function bundle(entry, name) {
  const outfile = path.join(repoPath('node_modules/.stacki-test'), `${name}.cjs`);
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  esbuild.buildSync({ entryPoints: [repoPath(entry)], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  return require(outfile);
}

const groups = bundle('src/features/palette/insertGroups.ts', 'insert-groups');
const grid = bundle('src/features/palette/insertGrid.ts', 'insert-grid');

const groupsOf = (components) => {
  const byName = groups.indexByName(components);
  return components.map((component) => groups.insertGroupOf(component, byName));
};

test('a component whose root is a <section> is a section', () => {
  assert.deepEqual(groupsOf([{ name: 'Hero', renderTag: { tag: 'section' } }]), ['sections']);
});

test('a component that opens with a section component is a section, however deep', () => {
  const components = [
    { name: 'Section', renderTag: { tag: 'section' } },
    { name: 'Container', rootComponent: 'Section' },
    { name: 'Hero', rootComponent: 'Container' },
    { name: 'Button', renderTag: { tag: 'button' } },
    { name: 'Tag', renderTag: { prop: 'as', tag: 'span' } },
  ];
  assert.deepEqual(groupsOf(components), ['sections', 'sections', 'sections', 'blocks', 'blocks']);
});

test('a root tag decided by a prop counts when its default is a section', () => {
  assert.deepEqual(groupsOf([{ name: 'Band', renderTag: { prop: 'tag', tag: 'section' } }]), ['sections']);
  assert.deepEqual(groupsOf([{ name: 'Band', renderTag: { prop: 'tag' } }]), ['blocks']);
});

test('a root component the project does not have is a block', () => {
  assert.deepEqual(groupsOf([{ name: 'Hero', rootComponent: 'Missing' }]), ['blocks']);
});

test('negative space: cycles and self reference end as blocks instead of looping', () => {
  assert.deepEqual(
    groupsOf([
      { name: 'A', rootComponent: 'B' },
      { name: 'B', rootComponent: 'A' },
    ]),
    ['blocks', 'blocks'],
  );
  assert.deepEqual(groupsOf([{ name: 'Self', rootComponent: 'Self' }]), ['blocks']);
});

test('the chain depth is bounded: the last component inside the bound counts, the next does not', () => {
  const chain = (length) => {
    const components = [{ name: 'C0', renderTag: { tag: 'section' } }];
    for (let at = 1; at <= length; at++) {
      components.push({ name: `C${at}`, rootComponent: `C${at - 1}` });
    }
    return components;
  };
  const inside = chain(groups.rootChainDepthMax);
  assert.equal(groupsOf(inside).at(-1), 'sections', 'a chain exactly at the bound still finds the section');
  const beyond = chain(groups.rootChainDepthMax + 1);
  assert.equal(groupsOf(beyond).at(-1), 'blocks', 'one component further is past the bound');
});

test('a name used twice resolves to the first one listed', () => {
  const components = [
    { name: 'Card', renderTag: { tag: 'article' } },
    { name: 'Card', renderTag: { tag: 'section' } },
    { name: 'Teaser', rootComponent: 'Card' },
  ];
  assert.deepEqual(groupsOf(components), ['blocks', 'sections', 'blocks']);
});

test('the view: the chosen pill filters, an empty pill yields to the other, and All results orders sections first', () => {
  const item = (label, group) => ({ label, group, cat: group === undefined ? 'elements' : 'components' });
  const ranked = [item('a', 'blocks'), item('b', 'sections'), item('<p>', undefined), item('c', 'blocks'), item('d', 'sections')];
  const sections = grid.insertView(ranked, 'components', 'sections');
  assert.deepEqual(
    sections.shown.map((entry) => entry.label),
    ['b', 'd'],
  );
  assert.deepEqual(sections.counts, { sections: 2, blocks: 2 });
  assert.equal(sections.pill, 'sections');
  const blocks = grid.insertView(ranked, 'components', 'blocks');
  assert.deepEqual(
    blocks.shown.map((entry) => entry.label),
    ['a', 'c'],
  );
  const onlyBlocks = grid.insertView([item('a', 'blocks')], 'components', 'sections');
  assert.equal(onlyBlocks.pill, 'blocks', 'no sections hit, so the blocks that did are shown and marked');
  assert.deepEqual(
    onlyBlocks.shown.map((entry) => entry.label),
    ['a'],
  );
  const nothing = grid.insertView([], 'components', 'sections');
  assert.deepEqual(nothing.counts, { sections: 0, blocks: 0 });
  assert.equal(nothing.pill, 'sections');
  assert.deepEqual(nothing.shown, []);
  const everything = grid.insertView(ranked, 'all', 'blocks');
  assert.deepEqual(
    everything.shown.map((entry) => entry.label),
    ['b', 'd', 'a', 'c', '<p>'],
  );
  assert.equal(everything.counts, undefined);
  assert.equal(everything.pill, undefined);
});

test('the view is capped at the named limit', () => {
  const many = Array.from({ length: grid.insertResultsMax + 25 }, (_, at) => ({ label: `n${at}`, group: 'blocks', cat: 'components' }));
  const view = grid.insertView(many, 'components', 'blocks');
  assert.equal(view.shown.length, grid.insertResultsMax);
  assert.equal(view.counts.blocks, many.length, 'the pill still counts every hit');
  assert.equal(grid.insertView(many, 'elements', 'blocks').shown.length, grid.insertResultsMax);
  assert.equal(grid.insertView(many, 'all', 'blocks').shown.length, grid.insertResultsMax);
});

test('the highlight moves by cards and rows and stays at the edges', () => {
  assert.equal(grid.INSERT_COLUMNS, 3);
  const move = (current, count, direction) => grid.moveHighlight(current, count, direction);
  // Eight cards: rows of 3, 3 and 2.
  assert.equal(move(0, 8, 'right'), 1);
  assert.equal(move(7, 8, 'right'), 7, 'right at the end stays');
  assert.equal(move(0, 8, 'left'), 0, 'left at the start stays');
  assert.equal(move(4, 8, 'left'), 3);
  assert.equal(move(4, 8, 'up'), 1);
  assert.equal(move(1, 8, 'up'), 1, 'up from the first row stays');
  assert.equal(move(1, 8, 'down'), 4);
  assert.equal(move(4, 8, 'down'), 7);
  assert.equal(move(5, 8, 'down'), 7, 'down into a shorter last row lands on its last card');
  assert.equal(move(7, 8, 'down'), 7, 'down from the last row stays');
  assert.equal(move(0, 1, 'down'), 0);
  assert.equal(move(0, 1, 'up'), 0);
});

test('negative space: moving needs a card, and the highlight must be on one', () => {
  assert.throws(() => grid.moveHighlight(0, 0, 'right'), /at least one card/);
  assert.throws(() => grid.moveHighlight(-1, 3, 'right'), /highlight is a position/);
  assert.throws(() => grid.moveHighlight(3, 3, 'right'), /highlight sits on a card/);
});
