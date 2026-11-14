// Goal: shared/properties/variableGroups.ts sections custom property names the way the Variables
// panel does, because the panel and the variable picker call this one function.
// Methodology: names mirror the panel's screenshot (selection, button, button-2 and link
// sections, with plain `background` and `text` beside them), asserting the section titles, their
// rows in declaration order, the short labels, how a narrowing keeps the grouping, and that the
// electron module the panel imports re-exports the very same function.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrangeNames, prefixSections, shortLabel } from '#dist/shared/properties/variableGroups.js';
import * as panelGroups from '#dist/electron/project/cssVarGroups.js';

const NAMES = [
  '--background',
  '--background-2',
  '--text',
  '--text-2',
  '--selection-background',
  '--selection-text',
  '--button-background',
  '--button-border',
  '--button-text',
  '--button-2-background',
  '--button-2-border',
  '--button-2-text',
  '--link-text',
  '--link-border',
];

test('the picker and the panel share the one sectioning function', () => {
  assert.equal(panelGroups.prefixSections, prefixSections);
});

test('sections follow the panel: shared leading parts that are not variables themselves', () => {
  const blocks = arrangeNames(NAMES, new Set(NAMES));
  assert.deepEqual(
    blocks.map((block) => block.title),
    [undefined, 'selection', 'button', 'button-2', 'link'],
  );
  assert.deepEqual(blocks[0]?.names, ['--background', '--background-2', '--text', '--text-2']);
  assert.deepEqual(blocks[2]?.names, ['--button-background', '--button-border', '--button-text']);
  assert.deepEqual(blocks[3]?.names, ['--button-2-background', '--button-2-border', '--button-2-text']);
});

test('short labels drop the section prefix, and only that', () => {
  assert.equal(shortLabel('--button-text', 'button'), 'text');
  assert.equal(shortLabel('--button-2-text', 'button-2'), 'text');
  assert.equal(shortLabel('--background', undefined), 'background');
  assert.equal(shortLabel('--text-2', 'button'), 'text-2');
});

test('narrowing hides rows and empty sections but never regroups', () => {
  const shown = new Set(['--button-text', '--link-text', '--text']);
  const blocks = arrangeNames(NAMES, shown);
  assert.deepEqual(
    blocks.map((block) => [block.title, block.names]),
    [
      [undefined, ['--text']],
      ['button', ['--button-text']],
      ['link', ['--link-text']],
    ],
  );
  assert.deepEqual(arrangeNames(NAMES, new Set()), []);
});

test('a scope with no sections is one untitled block in the order given', () => {
  const names = ['--space-1', '--radius', '--ink'];
  assert.deepEqual(arrangeNames(names, new Set(names)), [{ title: undefined, names }]);
});
