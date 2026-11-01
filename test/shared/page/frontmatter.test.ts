// Goal: import source slots are a checked part of the IPC page model.
// Methodology: parse real frontmatter, retain every preservation field, and
// reject missing fields, invalid offsets, flags, and oversized collections.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFrontmatter } from '#dist/shared/page/frontmatterSource.js';
import { parseImportSlots, parseImportSlot, parseImportMember } from '#dist/shared/page/frontmatter.js';
import { LIMITS } from '#dist/shared/core/limits.js';

// Null as a boundary receives it, parsed from JSON: inputs may hold it; our values never do.
const jsonNull: unknown = JSON.parse('null');

const member = { name: 'Card', path: './Card.astro', quote: '"', at: 0 };
const slot = {
  at: 0,
  offset: 0,
  source: 'import Card from "./Card.astro";',
  suffix: ';',
  tail: '\n',
  members: [member],
};

test('real import slots preserve aliases, comments, quote choice, and placement', () => {
  const source = 'const value = 1;\nimport { Card as Panel, type Props } from "./Card.astro";\n';
  const model = readFrontmatter(source);
  assert.ok(model.frontmatterLayout);
  assert.deepEqual(parseImportSlots(model.frontmatterLayout.slots), model.frontmatterLayout.slots);
  assert.deepEqual(parseImportSlot(slot), slot);
});

test('slot and member fields reject malformed values', () => {
  for (const bad of [
    jsonNull,
    [],
    {},
    { ...slot, members: jsonNull },
    { ...slot, source: 1 },
    { ...slot, offset: -1 },
    { ...slot, at: 0.5 },
    { ...slot, tail: false },
    { ...slot, suffix: undefined },
    { ...slot, offset: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(() => parseImportSlot(bad), /ImportSlot/);
  }
  for (const bad of [
    jsonNull,
    { ...member, name: jsonNull },
    { ...member, path: false },
    { ...member, quote: 2 },
    { ...member, at: -1 },
    { ...member, named: 'yes' },
    { ...member, typeOnly: 'yes' },
    { ...member, imported: false },
  ]) {
    assert.throws(() => parseImportMember(bad), /ImportMember/);
  }
});

test('slot arrays and source fields enforce their stated bounds', () => {
  assert.throws(() => parseImportSlots({}), /expected array/);
  assert.throws(() => parseImportSlots(Array.from({ length: LIMITS.importsMax + 1 }, () => slot)), /exceeds limit/);
  assert.throws(
    () =>
      parseImportSlot({
        ...slot,
        members: Array.from({ length: LIMITS.importsMax + 1 }, () => member),
      }),
    /exceeds limit/,
  );
  assert.throws(() => parseImportSlot({ ...slot, source: 'x'.repeat(LIMITS.nodeValueCharsMax + 1) }), /exceeds limit/);
  assert.throws(() => parseImportSlot({ ...slot, offset: LIMITS.ipcFieldCharsMax + 1 }), /outside source bounds/);
});
